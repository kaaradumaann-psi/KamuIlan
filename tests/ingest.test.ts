/**
 * Kabul hattı testleri: kaydetme, sürümleme, tekilleştirme, inceleme kuyruğu,
 * bildirim olayları, kilit ve kaynak hatası davranışı.
 *
 * Hiçbir test gerçek kaynağa istek atmaz: sahte adaptör/fetcher kullanılır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { runSourceScrape } from '../src/ingest/pipeline';
import { queueNotificationsForJob } from '../src/notifications/service';
import { createLogger } from '../src/lib/logger';
import { AdapterStructureError } from '../src/sources/errors';
import type { SourceDefinition } from '../src/config/sources';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../src/sources/types';
import type { RawAnnouncement } from '../src/domain';
import type { SourceDoc } from '../src/db/schemas';
import {
  belirsizDuyuru,
  benzerBaslikliFarkliIlan,
  ihaleIlani,
  ikinciKaynakYayini,
  iptalDuyurusu,
  sonucDuyurusu,
  sozlesmeliPersonelIlani,
} from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const WORKER = 'worker-test-1';

async function makeRepos(): Promise<Repos> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuradar-ingest-'));
  const store = new FileStore(dir);
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function apply(repos: Repos, item: RawAnnouncement, provenance: 'scraped' | 'sample' = 'sample') {
  return applyRawAnnouncement(item, { repos, now: NOW, workerId: WORKER, provenance });
}

const TEST_DEFINITION: SourceDefinition = {
  key: 'test-liste-kaynagi',
  name: 'Test Kaynağı',
  group: 'kurum',
  sourceType: 'institution-page',
  institution: 'Test Kurumu',
  homepageUrl: 'https://ornek.test/',
  listingUrl: 'https://ornek.test/ilanlar',
  adapterKey: 'test-liste',
  method: 'html-list',
  status: 'method-defined',
  statusNote: 'Yalnızca testler için sahte kaynak tanımı.',
  lastVerifiedAt: null,
  verificationEvidence: 'Testlerde canlı erişim yapılmaz.',
  coverageNote: 'Test kapsamı.',
  enabled: true,
  intervalMinutes: 60,
  minRequestIntervalMs: 0,
  maxConcurrency: 1,
  allowedHosts: ['ornek.test'],
  tags: ['test'],
};

async function seedSource(repos: Repos): Promise<SourceDoc> {
  await repos.sources.seed([TEST_DEFINITION]);
  const source = await repos.sources.getByKey(TEST_DEFINITION.key);
  if (!source) throw new Error('Test kaynağı oluşturulamadı');
  return source;
}

function fakeAdapter(items: RawAnnouncement[], notes: string[] = []): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Test listesi',
    method: 'html-list',
    notes: 'Testlerde kullanılan sahte adaptör; ağa çıkmaz.',
    run: async (_ctx: AdapterContext): Promise<AdapterRunResult> => ({
      items,
      requestCount: 1,
      notes,
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses: [200],
    }),
  };
}

describe('kapsam raporu', () => {
  it('demo/örnek veri kaydını kapsam sayılarına katmaz', async () => {
    const repos = await makeRepos();
    await repos.sources.seed([
      TEST_DEFINITION,
      {
        ...TEST_DEFINITION,
        key: 'demo-ornek-veri',
        name: 'Demo — örnek veri (gerçek kaynak değildir)',
        adapterKey: 'manual-entry',
        method: 'manual-entry',
        status: 'disabled',
        enabled: false,
        tags: ['demo', 'ornek-veri'],
      },
    ]);

    const coverage = await repos.sources.coverage();
    expect(coverage.sources.map((entry) => entry.key)).toEqual(['test-liste-kaynagi']);
    expect(coverage.summary.total).toBe(1);
    expect(coverage.summary.enabled).toBe(1);
  });
});

describe('kabul hattı — kayıt ve sürümleme', () => {
  it('gerçek personel alım ilanını kabul eder ve kaydeder', async () => {
    const repos = await makeRepos();
    const outcome = await apply(repos, sozlesmeliPersonelIlani());

    expect(outcome.action).toBe('created');
    expect(outcome.jobId).toBeTruthy();

    const job = await repos.jobs.findById(outcome.jobId as string);
    expect(job).not.toBeNull();
    expect(job?.classification.decision).toBe('accept');
    expect(job?.provenance).toBe('sample');
    expect(job?.institution).toContain('Örnek Üniversitesi');
    expect(job?.applicationEndDate).toBe('2026-10-30');
    expect(job?.quota).toBe(25);
    expect(job?.requirements.kpssMinScore).toBe(70);
    expect(job?.requirements.educationLevels.length).toBeGreaterThan(0);
    expect(job?.attachments.length).toBe(1);

    const revisions = await repos.jobs.listRevisions(job?.id ?? '');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.changeTypes).toContain('new');

    const links = await repos.jobs.listSourceLinks(job?.id ?? '');
    expect(links).toHaveLength(1);
    expect(links[0]?.sourceItemId).toBe('ORNEK-2026-0001');
  });

  it('ihale ve sonuç duyurularını reddeder, ilan oluşturmaz', async () => {
    const repos = await makeRepos();
    const ihale = await apply(repos, ihaleIlani());
    const sonuc = await apply(repos, sonucDuyurusu());

    expect(ihale.action).toBe('rejected');
    expect(sonuc.action).toBe('rejected');
    expect(await repos.store.count('jobs', {})).toBe(0);
    expect(await repos.review.countOpen()).toEqual({ total: 0, classification: 0, dedupe: 0, extraction: 0 });
  });

  it('belirsiz kaydı inceleme kuyruğuna koyar, sessizce silmez', async () => {
    const repos = await makeRepos();
    const outcome = await apply(repos, belirsizDuyuru());

    expect(outcome.action).toBe('review');
    expect(outcome.reviewId).toBeTruthy();
    expect(await repos.store.count('jobs', {})).toBe(0);

    const open = await repos.review.countOpen();
    expect(open.classification).toBe(1);
    const items = await repos.review.list({ kind: 'classification' });
    expect(items[0]?.reason.length).toBeGreaterThan(3);
    expect(items[0]?.payload).toHaveProperty('excerpt');
  });

  it('aynı kaynak aynı ilanı yeniden görünce yeni kayıt ve sürüm oluşturmaz', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());
    const second = await apply(repos, sozlesmeliPersonelIlani());

    expect(first.action).toBe('created');
    expect(second.action).toBe('merged');
    expect(second.jobId).toBe(first.jobId);
    expect(await repos.store.count('jobs', {})).toBe(1);
    expect(await repos.jobs.listRevisions(first.jobId as string)).toHaveLength(1);
    expect(second.revisionCreated).toBe(false);
  });

  it('son başvuru tarihi değişince yeni sürüm ve değişiklik kaydı oluşur', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());

    const guncellenmis = sozlesmeliPersonelIlani({
      bodyText: (sozlesmeliPersonelIlani().bodyText ?? '').replace('30.10.2026', '07.11.2026'),
    });
    const second = await apply(repos, guncellenmis);

    expect(second.action).toBe('updated');
    expect(second.jobId).toBe(first.jobId);
    expect(second.changes).toContain('applicationEndAt');

    const job = await repos.jobs.findById(first.jobId as string);
    expect(job?.applicationEndDate).toBe('2026-11-07');
    expect(job?.version).toBe(2);

    const revisions = await repos.jobs.listRevisions(first.jobId as string);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.changeTypes).toContain('deadline');
    expect(revisions[0]?.summary).toContain('son başvuru');
    expect(await repos.store.count('jobs', {})).toBe(1);
  });

  it('aynı ilanı ikinci kaynakta görünce tek ilanda birleştirir ve tüm kaynakları saklar', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());
    const second = await apply(repos, ikinciKaynakYayini());

    expect(second.action).toBe('merged');
    expect(second.jobId).toBe(first.jobId);
    expect(await repos.store.count('jobs', {})).toBe(1);

    const job = await repos.jobs.findById(first.jobId as string);
    expect(job?.sourceKeys).toHaveLength(2);
    const links = await repos.jobs.listSourceLinks(first.jobId as string);
    expect(links.map((link) => link.sourceKey).sort()).toEqual(['test-kaynak', 'test-kaynak-2']);
  });

  it('benzer başlıklı FARKLI ilanı otomatik birleştirmez', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());
    const other = await apply(repos, benzerBaslikliFarkliIlan());

    expect(other.action).not.toBe('merged');
    expect(other.action).not.toBe('updated');
    if (other.action === 'review') {
      const items = await repos.review.list({ kind: 'dedupe' });
      expect(items).toHaveLength(1);
      expect(items[0]?.candidateJobIds).toContain(first.jobId);
    } else {
      expect(other.jobId).not.toBe(first.jobId);
      expect(await repos.store.count('jobs', {})).toBe(2);
    }
    // İlk ilan bozulmadan kalır.
    const original = await repos.jobs.findById(first.jobId as string);
    expect(original?.title).toContain('Sözleşmeli Personel Alım İlanı');
    expect(original?.requirements.kpssMinScore).toBe(70);
    expect(original?.applicationEndDate).toBe('2026-10-30');
  });

  it('iptal duyurusu mevcut ilanı kapatır ve sürüm yazar', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());
    const outcome = await apply(repos, iptalDuyurusu());

    expect(outcome.action).toBe('withdrawal-signal');
    expect(outcome.jobId).toBe(first.jobId);

    const job = await repos.jobs.findById(first.jobId as string);
    expect(job?.status).toBe('cancelled');
    expect(job?.statusReason).toContain('geri çekildi');

    const revisions = await repos.jobs.listRevisions(first.jobId as string);
    expect(revisions[0]?.changeTypes).toContain('withdrawn');
  });
});

describe('bildirim olayları', () => {
  async function prepareUser(
    repos: Repos,
    options: { email: string; verified: boolean; paused?: boolean; titles?: string[] },
  ) {
    const { user } = await repos.users.create({
      email: options.email,
      passwordHash: 'scrypt$test-hash-value',
      passwordSalt: 'test-salt-value',
      emailVerified: options.verified,
    });
    await repos.notifications.upsertPreference(user.id, {
      paused: options.paused ?? false,
      onlyNewJobs: false,
      filters: { titles: options.titles ?? [] },
    });
    return user;
  }

  it('eşleşen doğrulanmış kullanıcı için tek olay ve tek outbox kaydı üretir', async () => {
    const repos = await makeRepos();
    await prepareUser(repos, { email: 'uygun@ornek.test', verified: true });
    await prepareUser(repos, { email: 'dogrulanmamis@ornek.test', verified: false });
    await prepareUser(repos, { email: 'duraklatilan@ornek.test', verified: true, paused: true });
    await prepareUser(repos, { email: 'eslesmeyen@ornek.test', verified: true, titles: ['Astronot'] });

    const outcome = await apply(repos, sozlesmeliPersonelIlani());
    const job = await repos.jobs.findById(outcome.jobId as string);
    const result = await queueNotificationsForJob({
      repos,
      job: job!,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'KamuRadar',
    });

    expect(result.queued).toBe(1);
    expect(result.skippedUnverified).toBe(1);
    expect(result.matched).toBe(1);

    const outbox = await repos.outbox.list({}, 50);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.toEmail).toBe('uygun@ornek.test');
    expect(outbox[0]?.status).toBe('pending');
    expect(outbox[0]?.subject).toContain('Örnek Üniversitesi');
    expect(String((outbox[0]?.payload as Record<string, unknown>)['detailUrl'])).toContain('ornek.test');

    // Aynı ilan tekrar işlense bile ikinci e-posta kuyruğa girmez.
    const tekrar = await queueNotificationsForJob({
      repos,
      job: job!,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'KamuRadar',
    });
    expect(tekrar.queued).toBe(0);
    expect(tekrar.alreadyExists).toBe(1);
    expect(await repos.outbox.list({}, 50)).toHaveLength(1);
  });

  it('duraklatılmış veya abonelikten çıkmış kullanıcıya e-posta üretmez', async () => {
    const repos = await makeRepos();
    const user = await prepareUser(repos, { email: 'abone@ornek.test', verified: true });
    await repos.notifications.upsertPreference(user.id, { paused: true });

    const outcome = await apply(repos, sozlesmeliPersonelIlani());
    const job = await repos.jobs.findById(outcome.jobId as string);
    const result = await queueNotificationsForJob({
      repos,
      job: job!,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'KamuRadar',
    });

    expect(result.matched).toBe(0);
    expect(result.queued).toBe(0);
    expect(await repos.outbox.list({}, 50)).toHaveLength(0);
  });
});

describe('tarama hattı', () => {
  it('tarama kaydı, sağlık bilgisi ve bildirimleri tek akışta üretir', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const { user } = await repos.users.create({
      email: 'kullanici@ornek.test',
      passwordHash: 'scrypt$test-hash-value',
      passwordSalt: 'test-salt-value',
      emailVerified: true,
    });
    await repos.notifications.upsertPreference(user.id, { filters: {} });

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter([sozlesmeliPersonelIlani({ sourceKey: source.key })]),
      logger: createLogger('test', { level: 'silent' }),
    });

    expect(result.status).toBe('success');
    expect(result.jobsCreated).toBe(1);
    expect(result.notificationsQueued).toBe(1);
    expect(result.errors).toHaveLength(0);

    const run = await repos.runs.lastRun(source.key);
    expect(run?.status).toBe('success');
    expect(run?.itemsFound).toBe(1);
    expect(run?.workerId).toBe(WORKER);

    const refreshed = await repos.sources.getByKey(source.key);
    expect(refreshed?.health.totalRuns).toBe(1);
    expect(refreshed?.health.consecutiveFailures).toBe(0);
    expect(refreshed?.health.lastSuccessAt).toBe(NOW.toISOString());
    expect(await repos.outbox.list({}, 10)).toHaveLength(1);
  });

  it('aynı kaynağı eşzamanlı iki kez taramaz (kilit)', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const acquired = await repos.locks.acquire(`scrape:${source.key}`, 'diger-worker', 60_000);
    expect(acquired).toBe(true);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: 'worker-test-2',
      adapter: fakeAdapter([sozlesmeliPersonelIlani({ sourceKey: source.key })]),
      logger: createLogger('test', { level: 'silent' }),
    });

    expect(result.status).toBe('locked');
    expect(result.locked).toBe(true);
    expect(await repos.store.count('jobs', {})).toBe(0);
    const runs = await repos.runs.list({ sourceKey: source.key });
    expect(runs[0]?.status).toBe('locked');
  });

  it('kaynak yapısı değişince hata kaydeder ve mevcut ilanları SİLMEZ', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const first = await apply(repos, sozlesmeliPersonelIlani({ sourceKey: source.key }));

    const failing: SourceAdapter = {
      key: 'test-liste',
      label: 'Test listesi',
      method: 'html-list',
      notes: 'Testlerde kullanılan hatalı adaptör; kaynak yapısı değişimini taklit eder.',
      run: async () => {
        throw new AdapterStructureError('test-liste', 'Beklenen ilan tablosu bulunamadı; sayfa yapısı değişmiş olabilir.');
      },
    };

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      adapter: failing,
      logger: createLogger('test', { level: 'silent' }),
    });

    expect(result.status).toBe('failed');
    expect(result.errors[0]).toContain('yapısı');

    const run = await repos.runs.lastRun(source.key);
    expect(run?.status).toBe('failed');
    expect(run?.result).toContain('yapısı');

    const refreshed = await repos.sources.getByKey(source.key);
    expect(refreshed?.health.consecutiveFailures).toBe(1);
    expect(refreshed?.health.lastErrorMessage).toContain('yapısı');

    // İlan silinmedi.
    const job = await repos.jobs.findById(first.jobId as string);
    expect(job).not.toBeNull();
    expect(await repos.store.count('jobs', {})).toBe(1);
  });
});
