import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createId, sha256Hex } from '../src/domain/ids';
import { jobContentFingerprint } from '../src/domain/job-content-fingerprint';
import { makeExcerpt, normalizeTr } from '../src/domain/text';
import { FileStore } from '../src/db/file-store';
import { PostgresStore, type PostgresPoolLike, type PostgresQueryable } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { createRepos } from '../src/db/repos';
import type { JobSourceDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { migrateCapturedTextMetadata } from '../src/db/migrations/captured-text-metadata';
import { migrateJobTextMinimization } from '../src/db/migrations/job-text-minimization';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

function pglitePool(db: PGlite): PostgresPoolLike {
  const query = async <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    const result = await db.query(text, values ?? []);
    return {
      rows: result.rows as R[],
      rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null,
    };
  };
  const queryable: PostgresQueryable = { query };
  return {
    query: queryable.query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => {
      await db.close();
    },
  };
}

describe('kaynak metni minimizasyonu göçü', () => {
  it('eski gövdeleri temizler, karakter sayısı/durumu korur ve yinelenince değişiklik yapmaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-capture-migration-')));
    await store.init();

    const capturedText = 'Eski yakalanmış duyuru metni ve iletişim bilgileri.';
    const rawExcerpt = 'Eski, artık kullanılmayan kaynak alıntısı.';
    const legacyLink = {
      id: createId('jsrc'),
      jobId: createId('job'),
      sourceKey: 'test-kaynak',
      sourceItemId: 'legacy-1',
      url: 'https://ornek.test/ilan/legacy-1',
      title: 'Örnek personel alım ilanı',
      institution: 'Örnek Kurum',
      sourceCategory: 'personel alımı',
      publishedAt: null,
      rawContentHash: 'abcdef0123456789',
      rawExcerpt,
      capturedText,
      capturedTextStatus: 'captured',
      attachments: [],
      active: true,
      firstSeenAt: '2026-10-14T09:00:00+03:00',
      lastSeenAt: '2026-10-14T09:00:00+03:00',
    } as unknown as JobSourceDoc;
    await store.insertOne('jobSources', legacyLink);

    const firstRun = await migrateCapturedTextMetadata(store);
    expect(firstRun).toEqual({
      scanned: 1,
      updated: 1,
      capturedBodiesCleared: 1,
      rawExcerptsCleared: 1,
      rawContentHashesCleared: 1,
      countsBackfilled: 1,
      statusesBackfilled: 0,
    });

    const migrated = await store.findOne('jobSources', { id: legacyLink.id });
    const migratedLegacy = migrated as unknown as Record<string, unknown>;
    expect(migratedLegacy['capturedText']).toBe('');
    expect(migratedLegacy['rawExcerpt']).toBe('');
    expect(migratedLegacy['rawContentHash']).toBe('');
    expect(migrated?.capturedTextCharacterCount).toBe(capturedText.length);
    expect(migrated?.capturedTextStatus).toBe('captured');

    const secondRun = await migrateCapturedTextMetadata(store);
    expect(secondRun).toMatchObject({
      scanned: 1,
      updated: 0,
      capturedBodiesCleared: 0,
      rawExcerptsCleared: 0,
      rawContentHashesCleared: 0,
      countsBackfilled: 0,
      statusesBackfilled: 0,
    });
    await store.close();
  });

  it('eski ilan metni, arama kopyası, kanıtlar, inceleme alıntısı ve sürüm anlık görüntülerini sınırlar ve redakte eder', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-job-text-migration-')));
    await store.init();
    const now = new Date('2026-10-14T09:00:00+03:00');
    const repos = createRepos(store, fixedClock(now));
    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now,
      workerId: 'migration-test',
      provenance: 'sample',
    });
    expect(outcome.action).toBe('created');
    const job = await repos.jobs.findById(outcome.jobId as string);
    expect(job).toBeTruthy();

    const privateEmail = 'historic.notice@example.gov.tr';
    const privatePhone = '+90 (312) 555-12-34';
    const legacyBody = `Eski ilan metni: ${privateEmail}; telefon ${privatePhone}. ${'Ayrıntı '.repeat(500)}`;
    const unsafeHash = sha256Hex(`${job?.title}|${legacyBody}|${job?.applicationEndAt ?? ''}|${job?.quota ?? ''}`);
    await store.updateOne('jobs', { id: job?.id }, {
      textExcerpt: legacyBody,
      textNormalized: normalizeTr(legacyBody),
      evidence: { contact: legacyBody },
      fieldSources: { contact: { kind: 'detail', snippet: legacyBody } },
      contentHash: unsafeHash,
    });

    const revisionId = createId('rev');
    await store.insertOne('jobRevisions', {
      id: revisionId,
      jobId: job?.id as string,
      version: 2,
      changeTypes: ['content'],
      changedFields: ['textExcerpt'],
      previous: {
        textExcerpt: legacyBody,
        textNormalized: normalizeTr(legacyBody),
        evidence: { contact: legacyBody },
        fieldSources: { contact: { kind: 'detail', snippet: legacyBody } },
      },
      current: { textExcerpt: legacyBody, textNormalized: normalizeTr(legacyBody) },
      summary: 'İlan metni güncellendi.',
      sourceKey: 'test-kaynak',
      createdAt: now.toISOString(),
    });
    const reviewId = createId('rev');
    await store.insertOne('reviewQueue', {
      id: reviewId,
      kind: 'classification',
      sourceKey: 'test-kaynak',
      status: 'open',
      title: 'Örnek ilan incelemesi',
      url: 'https://ornek.test/ilan/inceleme',
      reason: 'İnsan incelemesi gerekiyor.',
      confidence: 0.5,
      payload: { sourceItemId: 'historic-1', excerpt: legacyBody },
      candidateJobIds: [],
      createdAt: now.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    });

    const firstRun = await migrateJobTextMinimization(store);
    expect(firstRun).toMatchObject({
      jobsScanned: 1,
      jobsUpdated: 1,
      excerptsSanitized: 1,
      searchCopiesRebuilt: 1,
      fieldSnippetsSanitized: 1,
      hashesRebuilt: 1,
      reviewItemsScanned: 1,
      reviewExcerptsSanitized: 1,
      revisionsScanned: 2,
      revisionSnapshotsSanitized: 2,
    });

    const safeJob = await repos.jobs.findById(job?.id as string);
    expect(safeJob?.textExcerpt).not.toContain(privateEmail);
    expect(safeJob?.textExcerpt).not.toContain(privatePhone);
    expect(safeJob?.textExcerpt.length).toBeLessThanOrEqual(2_500);
    expect(safeJob?.textNormalized).toBe(normalizeTr(safeJob?.textExcerpt ?? ''));
    expect(safeJob?.contentHash).toBe(jobContentFingerprint({
      title: job?.title as string,
      textExcerpt: safeJob?.textExcerpt as string,
      applicationEndAt: job?.applicationEndAt ?? null,
      quota: job?.quota ?? null,
    }));
    expect(safeJob?.contentHash).not.toBe(unsafeHash);
    expect(JSON.stringify(safeJob?.evidence)).not.toContain(privateEmail);
    expect(JSON.stringify(safeJob?.fieldSources)).not.toContain(privatePhone);

    const safeReview = await store.findOne('reviewQueue', { id: reviewId });
    const safeReviewExcerpt = (safeReview?.payload['excerpt'] as string) ?? '';
    expect(safeReviewExcerpt).not.toContain(privateEmail);
    expect(safeReviewExcerpt).not.toContain(privatePhone);
    expect(safeReviewExcerpt.length).toBeLessThanOrEqual(1_500);

    const revisions = await repos.jobs.listRevisions(job?.id as string);
    const sanitizedRevision = revisions.find((revision) => revision.id === revisionId);
    expect(JSON.stringify(sanitizedRevision?.previous)).not.toContain(privateEmail);
    expect(JSON.stringify(sanitizedRevision?.current)).not.toContain(privatePhone);

    const secondRun = await migrateJobTextMinimization(store);
    expect(secondRun.jobsUpdated).toBe(0);
    expect(secondRun.reviewExcerptsSanitized).toBe(0);
    expect(secondRun.revisionSnapshotsSanitized).toBe(0);
    await store.close();
  });

  it('Postgres JSONB deposunda alıntı/gövde yamalarını uygular ve güvenle tekrar çalışır', async () => {
    const database = new PGlite();
    const store = new PostgresStore({
      connectionString: 'postgres://isolated-migration-test',
      tablePrefix: 'kamuilan_migration_test',
      pool: pglitePool(database),
    });

    try {
      await store.init();
      await store.ensureIndexes(INDEXES);
      const privateEmail = 'pglite.notice@example.test';
      const privatePhone = '+90 (312) 555-98-76';
      const body = `Eski içerik ${privateEmail}; iletişim ${privatePhone}. ${'Ayrıntı '.repeat(450)}`;
      const jobId = createId('job');
      const linkId = createId('jsrc');
      const reviewId = createId('rev');
      const revisionId = createId('rev');

      await store.insertOne('jobSources', {
        id: linkId,
        jobId,
        sourceKey: 'pglite-test',
        sourceItemId: 'historic-1',
        capturedText: body,
        rawExcerpt: body,
        rawContentHash: sha256Hex(body),
        capturedTextStatus: 'captured',
        capturedTextCharacterCount: 0,
      } as unknown as JobSourceDoc);
      await store.insertOne('jobs', {
        id: jobId,
        title: 'Örnek personel alım ilanı',
        applicationEndAt: null,
        quota: null,
        textExcerpt: body,
        textNormalized: normalizeTr(body),
        evidence: { contact: body },
        fieldSources: { contact: { kind: 'detail', snippet: body } },
        contentHash: 'legacy-body-hash',
      } as never);
      await store.insertOne('reviewQueue', {
        id: reviewId,
        payload: { sourceItemId: 'historic-1', excerpt: body },
      } as never);
      await store.insertOne('jobRevisions', {
        id: revisionId,
        jobId,
        previous: { textExcerpt: body, evidence: { contact: body } },
        current: { textExcerpt: body, fieldSources: { contact: { snippet: body } } },
      } as never);

      const captureResult = await migrateCapturedTextMetadata(store);
      const jobResult = await migrateJobTextMinimization(store);
      expect(captureResult).toMatchObject({ scanned: 1, updated: 1, countsBackfilled: 1 });
      expect(jobResult).toMatchObject({ jobsScanned: 1, jobsUpdated: 1, reviewExcerptsSanitized: 1 });

      const safeLink = await store.findOne('jobSources', { id: linkId });
      expect((safeLink as unknown as Record<string, unknown>)['capturedText']).toBe('');
      expect((safeLink as unknown as Record<string, unknown>)['rawExcerpt']).toBe('');
      expect(safeLink?.capturedTextCharacterCount).toBe(makeExcerpt(body, 100_000).length);

      const safeJob = await store.findOne('jobs', { id: jobId });
      expect(safeJob?.textExcerpt).not.toContain(privateEmail);
      expect(safeJob?.textExcerpt).not.toContain(privatePhone);
      expect(safeJob?.textNormalized).toBe(normalizeTr(safeJob?.textExcerpt ?? ''));

      const safeReview = await store.findOne('reviewQueue', { id: reviewId });
      expect(JSON.stringify(safeReview?.payload)).not.toContain(privateEmail);
      const safeRevision = await store.findOne('jobRevisions', { id: revisionId });
      expect(JSON.stringify(safeRevision?.previous)).not.toContain(privatePhone);
      expect(JSON.stringify(safeRevision?.current)).not.toContain(privateEmail);

      expect((await migrateCapturedTextMetadata(store)).updated).toBe(0);
      expect((await migrateJobTextMinimization(store)).jobsUpdated).toBe(0);
    } finally {
      await store.close();
    }
  });
});
