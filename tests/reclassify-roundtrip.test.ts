import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { classify } from '../src/classification/engine';
import { FileStore } from '../src/db/file-store';
import type { JobDoc } from '../src/db/schemas';
import type { RawAnnouncement } from '../src/domain';
import { buildJobDocument } from '../src/ingest/jobs-service';
import {
  applyReclassification,
  buildReport,
  planReclassification,
  readJobsBackup,
  restoreJobsFromBackup,
  sameJobDoc,
  writeJobsBackup,
} from '../src/ingest/reclassify-batch';
import { reclassifyJob } from '../src/ingest/reclassify';
import { createRepos } from '../src/db/repos';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const GENERIC_BODY =
  'Duyuru metni aşağıda yer almaktadır. Ayrıntılı bilgi için kurum internet sitesini ziyaret ediniz.';

let dir: string;
let store: FileStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-roundtrip-'));
  store = new FileStore(dir);
  await store.init();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function jobFor(
  id: string,
  title: string,
  body: string,
  decision: 'accept' | 'reject' = 'accept',
  legacyWithoutKind = false,
): JobDoc {
  const raw = {
    sourceKey: 'ilan-gov-tr-api-personel',
    sourceItemId: id,
    title,
    url: `https://www.ilan.gov.tr/ilan/${id}`,
    attachments: [],
    bodyText: body,
    institution: 'Test Kurumu',
    publishedAt: '2026-10-10',
  } as unknown as RawAnnouncement;
  const classification = classify({ title, body });
  const doc = buildJobDocument(raw, { ...classification, decision }, { now: NOW, provenance: 'scraped' });
  if (legacyWithoutKind) {
    delete (doc.classification as { kind?: string }).kind;
  }
  return {
    ...doc,
    id,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    version: 1,
  } as unknown as JobDoc;
}

async function seedWorld(): Promise<JobDoc[]> {
  const jobs: JobDoc[] = [
    // Eski (kind alanı olmayan) süreç duyurusu: akışta kalmalı, türü process olmalı.
    jobFor(
      'job-kura',
      'Karayolları Genel Müdürlüğü 50 İşçi Alımına İlişkin Noter Kurası Duyurusu',
      GENERIC_BODY,
      'accept',
      true,
    ),
    // Basın duyurusu olarak kabul edilmiş eski kayıt: akıştan çıkmalı.
    jobFor('job-basin', 'Bank Mellat Basın Duyurusu', 'Banka basın duyurusu metni.', 'accept'),
    // Gerçek iş ilanı: değişmemeli.
    jobFor(
      'job-ilan',
      'Sözleşmeli Bilişim Personeli Alımı İlanı',
      'Sözleşmeli bilişim personeli alımı yapılacaktır. Başvurular 20.10.2026 tarihine kadar yapılacaktır.',
      'accept',
    ),
    // Durumu değişecek (bitmiş başvuru) ve statusReason alanı olmayan kayıt.
    (() => {
      const job = jobFor(
        'job-biten',
        'Sözleşmeli Bilişim Personeli Alımı İlanı',
        'Sözleşmeli bilişim personeli alımı yapılacaktır. Başvurular 20.10.2026 tarihine kadar yapılacaktır.',
        'accept',
      );
      job.status = 'active';
      // Son başvuru (2026-10-01) yayım tarihinden sonra olmalı; aksi halde veri hatası sayılır.
      job.publishedAt = '2026-09-15';
      job.applicationEndDate = '2026-10-01';
      delete (job as { statusReason?: string }).statusReason;
      return job;
    })(),
  ];
  for (const job of jobs) await store.insertOne('jobs', job);
  return jobs;
}

describe('süreç duyurusu türü (kind) ve yeniden sınıflandırma', () => {
  it('eski kaydı process türüne çevirir, akışta bırakır; basın kaydını çıkarır', async () => {
    const jobs = await seedWorld();
    const { summary } = planReclassification(jobs, NOW);
    expect(summary.keptAsProcess).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.acceptedJobs).toBe(2);
    expect(summary.kindChanged).toBe(1);

    const kura = reclassifyJob(jobs[0] as JobDoc, NOW);
    expect(kura.decisionTo).toBe('accept');
    expect(kura.kindFrom).toBe('job');
    expect(kura.kindTo).toBe('process');
    expect(kura.patch.classification?.kind).toBe('process');
  });

  it('değişiklik olmayan iş ilanı idempotenttir (patch boş)', async () => {
    const jobs = await seedWorld();
    const ilan = jobs.find((job) => job.id === 'job-ilan') as JobDoc;
    const result = reclassifyJob(ilan, NOW);
    expect(result.changed).toBe(false);
    expect(result.kindTo).toBe('job');
  });

  it('rapor yalnızca okur, kayıt bazlı satırlar üretir', async () => {
    const jobs = await seedWorld();
    const { planned } = planReclassification(jobs, NOW);
    const rows = await buildReport(store, planned);
    expect(rows).toHaveLength(jobs.length);
    const kura = rows.find((row) => row.id === 'job-kura');
    expect(kura).toMatchObject({ oldDecision: 'accept', newDecision: 'accept', kind: 'process' });
    expect(kura?.excerpt.length).toBeLessThanOrEqual(600);
    const basin = rows.find((row) => row.id === 'job-basin');
    expect(basin?.newDecision).toBe('reject');
    expect(basin?.rules.length).toBeGreaterThan(0);
    // Rapor çağrısı veritabanını değiştirmez.
    expect((await store.findOne('jobs', { id: 'job-kura' }))?.classification.kind).toBeUndefined();
  });

  it('uygula → yedekten geri yükle → birebir eşleşme (round trip)', async () => {
    const original = await seedWorld();
    const backupPath = writeJobsBackup(dir, original, NOW, 'before-reclassify');
    expect(readFileSync(backupPath, 'utf8')).toContain('job-kura');

    const { planned } = planReclassification(original, NOW);
    const { written } = await applyReclassification(store, planned, NOW);
    expect(written).toBeGreaterThanOrEqual(3);

    const afterApply = (await store.find('jobs', {}, { limit: 100 })) as JobDoc[];
    const kura = afterApply.find((job) => job.id === 'job-kura');
    expect(kura?.classification.kind).toBe('process');
    expect(kura?.classification.decision).toBe('accept');
    expect(afterApply.find((job) => job.id === 'job-basin')?.classification.decision).toBe('reject');
    expect(afterApply.find((job) => job.id === 'job-biten')?.status).toBe('closed');

    // Geri yükleme dry-run: yazmaz.
    const backup = readJobsBackup(backupPath);
    const dry = await restoreJobsFromBackup(store, backup, { apply: false });
    expect(dry.wouldRestore).toBeGreaterThan(0);
    expect(dry.restored).toBe(0);
    expect(await store.findOne('jobs', { id: 'job-basin' })).toMatchObject({
      classification: expect.objectContaining({ decision: 'reject' }),
    });

    // Geri yükleme: yedekteki kayıtlarla birebir aynı olmalı.
    const restored = await restoreJobsFromBackup(store, backup, { apply: true });
    expect(restored.restored).toBe(dry.wouldRestore);
    expect(restored.missingInStore).toEqual([]);
    const afterRestore = (await store.find('jobs', {}, { limit: 100 })) as JobDoc[];
    for (const doc of original) {
      const current = afterRestore.find((job) => job.id === doc.id);
      expect(current).toBeDefined();
      expect(sameJobDoc(current, doc)).toBe(true);
    }
    // Eklenen alan (statusReason) yedekte yoksa geri alınmış olmalı.
    // Bellekte undefined olarak kalabilir; kalıcı dosyada alan bulunmamalı.
    const persisted = JSON.parse(readFileSync(join(dir, 'kamuilan.json'), 'utf8')) as {
      collections: { jobs: Array<Record<string, unknown>> };
    };
    const biten = persisted.collections.jobs.find((job) => job.id === 'job-biten');
    expect(biten).toBeDefined();
    expect(biten).not.toHaveProperty('statusReason');
    // Kind alanı olmayan eski kayıt tekrar olmamalı.
    expect(afterRestore.find((job) => job.id === 'job-kura')?.classification.kind).toBeUndefined();

    // İkinci geri yükleme: fark yok.
    const again = await restoreJobsFromBackup(store, backup, { apply: true });
    expect(again.wouldRestore).toBe(0);
    expect(again.restored).toBe(0);
  });

  it('yedek dosyası kimliksiz kayıt içeriyorsa reddedilir', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ title: 'x' }]));
    expect(() => readJobsBackup(bad)).toThrow(/kimliği/);
  });
});

describe('tür filtresi (kind) arama', () => {
  it('süreç filtresi yalnızca süreç duyurularını, iş filtresi eski kayıtlar dahil iş ilanlarını döndürür', async () => {
    const jobs = await seedWorld();
    // jobs[0] eski (kind alanı yok) süreç duyurusu: süreç filtresi onu bulmalı, değilse iş ilanı olmalı.
    const repos = createRepos(store);
    const { planned } = planReclassification(jobs, NOW);
    await applyReclassification(store, planned, NOW);

    const processOnly = await repos.jobs.search({ kind: 'process' }, { page: 1, pageSize: 50 });
    expect(processOnly.items.map((job) => job.id)).toEqual(['job-kura']);

    const jobOnly = await repos.jobs.search({ kind: 'job' }, { page: 1, pageSize: 50 });
    const ids = jobOnly.items.map((job) => job.id).sort();
    expect(ids).toEqual(['job-biten', 'job-ilan']);

    const all = await repos.jobs.search({}, { page: 1, pageSize: 50 });
    expect(all.items.map((job) => job.id).sort()).toEqual(['job-biten', 'job-ilan', 'job-kura']);
  });
});
