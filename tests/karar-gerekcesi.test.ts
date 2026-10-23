/**
 * Tarama belleği karar GEREKÇESİ (sourceItemDecisions.reasons/rules/confidence).
 *
 * Önceden ret/inceleme kaydı yalnız başlık + URL tutuyordu; "bu ilan neden
 * reddedildi?" sorusu sınıflandırma yeniden çalıştırılmadan cevaplanamıyordu.
 * Gerekçe hem dosya deposunda hem gerçek Postgres (PGlite) deposunda saklanır;
 * Postgres JSONB `data` sütunu kullandığından DDL göçü gerekmez.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { PostgresStore, type PostgresPoolLike } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { createRepos, type Repos } from '../src/db/repos';
import { sourceItemDecisionSchema } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement, LISTING_PAGE_REJECTION_RULE } from '../src/ingest/jobs-service';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import { SOURCE_DEFINITIONS } from '../src/config/sources';

const NOW = new Date('2026-10-23T09:00:00.000Z');

async function fileRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-gerekce-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

const ihaleBody =
  'Kurumumuzun ihtiyacı olan doğalgaz alımı 4734 sayılı Kamu İhale Kanunu hükümlerine göre açık ihale usulü ile yapılacaktır. Teklifler ihale komisyonuna sunulur.';

describe('ret/inceleme kararının gerekçesi', () => {
  it('sınıflandırma reddi kural kimlikleri ve açıklamalarla kaydedilir', async () => {
    const repos = await fileRepos();
    const outcome = await applyRawAnnouncement(
      {
        sourceKey: 'test-gerekce',
        sourceItemId: 'ihale-1',
        url: 'https://ornek.test/duyuru/ihale-1',
        title: 'Kurum doğalgaz alımı ihalesi ilanı duyurusu',
        bodyText: ihaleBody,
        bodyTextSource: 'detail',
        attachments: [],
        sourceCategory: 'kurum duyurusu',
        extractionConfidence: 0.5,
      },
      { repos, now: NOW, workerId: 'w', provenance: 'sample' },
    );
    expect(outcome.action).toBe('rejected');
    const decision = await repos.jobs.findSourceItemDecision('test-gerekce', 'ihale-1');
    expect(decision?.decision).toBe('rejected');
    expect(decision?.rules).toEqual(outcome.classification.rules);
    expect(decision?.rules?.length).toBeGreaterThan(0);
    expect(decision?.reasons).toEqual(outcome.classification.reasons);
    expect(decision?.reasons?.length).toBeGreaterThan(0);
    expect(decision?.confidence).toBe(outcome.classification.confidence);
    expect(decision?.classificationVersion).toBe(CLASSIFICATION_VERSION);
  });

  it('liste sayfası reddi kendi kuralını taşır', async () => {
    const repos = await fileRepos();
    const listing = SOURCE_DEFINITIONS[0]!;
    const outcome = await applyRawAnnouncement(
      {
        sourceKey: listing.key,
        sourceItemId: 'liste',
        url: listing.listingUrl,
        title: 'Duyurular',
        attachments: [],
        extractionConfidence: 0.2,
      },
      { repos, now: NOW, workerId: 'w', provenance: 'sample' },
    );
    expect(outcome.action).toBe('rejected');
    const decision = await repos.jobs.findSourceItemDecision(listing.key, 'liste');
    expect(decision?.rules?.[0]).toBe(LISTING_PAGE_REJECTION_RULE);
    expect(decision?.reasons?.[0]).toMatch(/liste\/dizin sayfası/);
  });

  it('karar güncellenince gerekçe yeni kararınkiyle değişir; sınırlar uygulanır', async () => {
    const repos = await fileRepos();
    const base = {
      sourceKey: 'test-guncelle',
      sourceItemId: 'k-1',
      capturedTextStatus: 'captured' as const,
      title: 'Bir duyuru',
      url: 'https://ornek.test/k-1',
      classificationVersion: CLASSIFICATION_VERSION,
    };
    await repos.jobs.recordSourceItemDecision({
      ...base,
      decision: 'review',
      reasons: ['ilk gerekçe'],
      rules: ['eski.kural'],
      confidence: 0.4,
    });
    const updated = await repos.jobs.recordSourceItemDecision({
      ...base,
      decision: 'rejected',
      reasons: ['  yeni gerekçe ', 'yeni gerekçe', 'x'.repeat(900), ...Array.from({ length: 30 }, (_, i) => `r${i}`)],
      rules: ['ret.ihale'],
      confidence: 3,
    });
    expect(updated.decision).toBe('rejected');
    expect(updated.rules).toEqual(['ret.ihale']);
    expect(updated.reasons?.[0]).toBe('yeni gerekçe');
    expect(updated.reasons?.[1]).toHaveLength(500);
    expect(updated.reasons).toHaveLength(20);
    expect(updated.confidence).toBe(1);
    expect(() => sourceItemDecisionSchema.parse(updated)).not.toThrow();
  });

  it('gerekçesiz eski kayıt şemadan geçer (geriye uyum)', () => {
    expect(() =>
      sourceItemDecisionSchema.parse({
        id: 'sid_eskikayit0001',
        sourceKey: 'eski',
        sourceItemId: '1',
        decision: 'rejected',
        capturedTextStatus: 'listing-only',
        title: 'Eski kayıt',
        url: 'https://ornek.test/1',
        classificationVersion: '2026.10.6',
        firstSeenAt: NOW.toISOString(),
        lastSeenAt: NOW.toISOString(),
      }),
    ).not.toThrow();
  });
});

describe('Postgres (PGlite) deposunda gerekçe', () => {
  let pglite: PGlite;
  let store: PostgresStore;

  beforeAll(async () => {
    pglite = new PGlite();
    const query = async <R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }> => {
      const result = await pglite.query(text, values ?? []);
      return {
        rows: result.rows as R[],
        rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null,
      };
    };
    const pool: PostgresPoolLike = {
      query,
      connect: async () => ({ query, release: () => undefined }),
      end: async () => {
        await pglite.close();
      },
    };
    store = new PostgresStore({
      connectionString: 'postgres://gerekce-yerel-test',
      tablePrefix: 'kamuilan_gerekce',
      pool,
    });
    await store.init();
    await store.ensureIndexes(INDEXES);
  });

  afterAll(async () => {
    await store.close();
  });

  it('gerekçe JSONB içinde yazılır, okunur ve güncellenir', async () => {
    const repos = createRepos(store, fixedClock(NOW));
    const base = {
      sourceKey: 'pg-gerekce',
      sourceItemId: 'p-1',
      capturedTextStatus: 'captured' as const,
      title: 'İhale duyurusu',
      url: 'https://ornek.test/p-1',
      classificationVersion: CLASSIFICATION_VERSION,
    };
    await repos.jobs.recordSourceItemDecision({
      ...base,
      decision: 'rejected',
      reasons: ['İhale/satın alma duyurusu'],
      rules: ['ret.ihale'],
      confidence: 0.9,
    });
    const read = await repos.jobs.findSourceItemDecision('pg-gerekce', 'p-1');
    expect(read?.reasons).toEqual(['İhale/satın alma duyurusu']);
    expect(read?.rules).toEqual(['ret.ihale']);
    expect(read?.confidence).toBe(0.9);

    await repos.jobs.recordSourceItemDecision({
      ...base,
      decision: 'review',
      reasons: ['Belirsiz'],
      rules: ['belirsiz'],
      confidence: 0.5,
    });
    const listed = await repos.jobs.listSourceItemDecisions('pg-gerekce');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.decision).toBe('review');
    expect(listed[0]?.reasons).toEqual(['Belirsiz']);
    expect(listed[0]?.rules).toEqual(['belirsiz']);
  });
});
