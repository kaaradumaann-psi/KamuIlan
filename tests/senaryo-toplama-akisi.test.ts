/**
 * AŞAMA 4 — Toplama/kayıt akışı senaryoları (uçtan uca, sahte adaptör).
 *
 * Kaynak → HTTP yerine sahte adaptör → ayrıştırma/normalizasyon → sınıflandırma
 * → doğrulama → tekilleştirme → DB → görev geçmişi zinciri gerçek kodla çalışır;
 * yalnız ağ katmanı taklit edilir (hiçbir gerçek kaynağa istek atılmaz).
 *
 * | # | Senaryo                                   | Beklenen                                              |
 * |---|-------------------------------------------|-------------------------------------------------------|
 * | 1 | Erişilemeyen kaynak                       | tarama 'failed', UYDURMA İLAN YOK, hata türü kayıtlı  |
 * | 2 | Çerez/onay modalı iskeleti                | ilan sayılmaz (ret), depoya yazılmaz                  |
 * | 3 | Yalnız başlık/bağlantı                    | yayımlanmaz; inceleme kuyruğuna düşer                 |
 * | 4 | Süresi geçmiş ilan                        | durum 'closed', aktif listede ve öneride YOK          |
 * | 5 | Tarih yok / çelişkili tarih               | "Başvuru açık" DENMEZ (durum belirsiz)                |
 * | 6 | Aynı ilan ikinci kaynakta                 | tek kayıt; ÖZGÜN başvuru bağlantısı korunur           |
 * | 7 | AI sağlayıcı hatası (503)                 | ilan kaydı bozulmaz, hata telemetriye yazılır         |
 * | 8 | Kayıt bazlı işleme hatası                 | tarama durmaz; kaynak+aşama+hata sınıfı loglanır      |
 * | 9 | Aynı taramanın tekrarı                    | kopya/çift kayıt yok (tekrar güvenli)                 |
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger, type Logger } from '../src/lib/logger';
import { getEnv, resetEnvCache, type Env } from '../src/config/env';
import { JOB_STATUS_LABELS } from '../src/domain/types';
import type { RawAnnouncement } from '../src/domain';

import { runSourceScrape } from '../src/ingest/pipeline';
import { selectCandidates } from '../src/ai/candidates';
import { toPublicJobSummary } from '../src/server/serializers';
import { createLlmClassificationGate, type LlmClassificationGate } from '../src/ai/classifier';
import { AdapterStructureError, AdapterUnavailableError } from '../src/sources/errors';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../src/sources/types';
import type { SourceDefinition } from '../src/config/sources';
import { TEST_SOURCE_KEY, ikinciKaynakYayini, sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const WORKER = 'worker-toplama';
const LOGGER = createLogger('senaryo-toplama', { level: 'silent' });

const TEST_DEFINITION: SourceDefinition = {
  key: TEST_SOURCE_KEY,
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
  allowedHosts: ['ornek.test', 'ornek2.test'],
  tags: ['test'],
};

const TEST_DEFINITION_2: SourceDefinition = {
  ...TEST_DEFINITION,
  key: 'test-kaynak-2',
  name: 'Test Kaynağı 2',
  listingUrl: 'https://ornek2.test/ilanlar',
  allowedHosts: ['ornek2.test'],
};

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-toplama-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function seedSource(repos: Repos, definition = TEST_DEFINITION) {
  await repos.sources.seed([definition]);
  const source = await repos.sources.getByKey(definition.key);
  if (!source) throw new Error('kaynak oluşturulamadı');
  return source;
}

function fakeAdapter(options: {
  items?: RawAnnouncement[];
  fail?: Error;
  notes?: string[];
  coverage?: AdapterRunResult['coverage'];
}): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Test listesi',
    method: 'html-list',
    notes: 'Testlerde kullanılan sahte adaptör; ağa çıkmaz.',
    run: async (_ctx: AdapterContext): Promise<AdapterRunResult> => {
      if (options.fail) throw options.fail;
      return {
        items: options.items ?? [],
        requestCount: 1,
        notes: options.notes ?? [],
        etag: null,
        lastModified: null,
        notModified: false,
        httpStatuses: [200],
        ...(options.coverage ? { coverage: options.coverage } : {}),
      };
    },
  };
}

/** Log çağrılarını yakalayan sahte logger (üretimde pino kullanılır). */
function captureLogger(): { logger: Logger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const record = (fields: unknown, message?: unknown) => {
    if (typeof fields === 'object' && fields !== null) entries.push(fields as Record<string, unknown>);
    else entries.push({ message: String(fields) });
    void message;
  };
  const logger = {
    info: record,
    warn: record,
    error: record,
    debug: record,
    fatal: record,
    trace: record,
    child: () => logger,
  } as unknown as Logger;
  return { logger, entries };
}

const LLM_API_KEY = 'sk-test-gizli-anahtar';

function llmEnv(overrides: Record<string, string> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: 'https://llm.test/v1',
    LLM_API_KEY,
    LLM_CLASSIFIER_MODEL: 'test-model',
    LLM_TIMEOUT_MS: '5000',
    LLM_RETRY_MAX: '0',
    LLM_MAX_CALLS_PER_RUN: '10',
    LLM_MAX_CONCURRENCY: '2',
    LLM_MAX_INPUT_CHARS: '12000',
    ...overrides,
  });
}

function alwaysFailingGate(repos: Repos, status = 503): LlmClassificationGate {
  return createLlmClassificationGate({
    repos,
    env: llmEnv(),
    logger: LOGGER,
    retryBackoffMs: 1,
    fetchImpl: async () => ({
      status,
      text: async () => JSON.stringify({ error: 'servis dışı' }),
    }),
  });
}

/** Modal/KVKK iskeleti: gerçek toplamada karşılaşılan "ilan değil" metni. */
function cerezModaliItem(): RawAnnouncement {
  return {
    sourceKey: TEST_SOURCE_KEY,
    sourceItemId: 'TOPLAMA-MODAL-1',
    url: 'https://ornek.test/ilanlar/toplama-modal-1',
    title: 'Modal content × T.C. İÇİŞLERİ BAKANLIĞI WEB SİTESİ GİZLİLİK VE ÇEREZ POLİTİKASI',
    institution: 'Örnek Üniversitesi Rektörlüğü',
    publishedAt: '2026-10-10T00:00:00+03:00',
    attachments: [],
    sourceCategory: 'duyurular',
    extractionConfidence: 0.4,
    bodyText: 'Gizlilik Politikası Kabul Et Çerezler hakkında bilgi.',
    rawExcerpt: 'Gizlilik Politikası Kabul Et',
  };
}

const ALIM_SATIRI = 'Üniversitemiz birimlerinde istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır.';

/**
 * Kural motorunun "review" dediği kayıt: başlıkta doğrudan alım ifadesi yok,
 * gövdede kanıt var. Sınıflandırma kapısı YALNIZCA bu durumda çalışır.
 */
function incelemeyeDusen(sourceItemId: string): RawAnnouncement {
  return {
    sourceKey: TEST_SOURCE_KEY,
    sourceItemId,
    url: `https://ornek.test/duyuru/${sourceItemId}`,
    title: 'Önemli Duyuru',
    sourceCategory: 'duyurular',
    institution: 'Örnek Üniversitesi Rektörlüğü',
    publishedAt: '2026-10-12T00:00:00+03:00',
    attachments: [],
    extractionConfidence: 0.5,
    bodyText:
      'Üniversitemiz birimlerinde istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır. ' +
      'Alınacak personel: Hemşire, Sağlık Teknikeri. Kontenjan: 25 kişi. ' +
      'Başvurular 20.10.2026 - 30.10.2026 tarihleri arasında Kariyer Kapısı üzerinden alınacaktır. ' +
      'Adayların lisans mezunu olması ve 2026 yılı KPSS P3 puanına sahip olması gerekmektedir.',
    rawExcerpt: 'Sözleşmeli personel alımı yapılacaktır.',
  };
}

afterEach(() => {
  resetEnvCache();
});

describe('AŞAMA 4.1 — erişilemeyen kaynak ve iskelet gürültüsü', () => {
  it('1) tarama başarısız olursa sağlık bilgisi ve hata türü kaydedilir, uydurma ilan YAZILMAZ', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ fail: new AdapterUnavailableError(source.key, 'Kaynak ağdan erişilemedi', 'canlı doğrulama yok') }),
      logger: LOGGER,
    });

    expect(result.status).toBe('skipped');
    expect(result.jobsCreated).toBe(0);
    expect((await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).total).toBe(0);
    expect(result.errors.join(' ')).toContain('erişilemedi');

    const run = await repos.runs.lastRun(source.key);
    expect(run?.status).toBe('skipped');
    expect(run?.itemsFound).toBe(0);
    const refreshed = await repos.sources.getByKey(source.key);
    expect(refreshed?.health.consecutiveFailures).toBe(1);
    expect(refreshed?.health.lastErrorType).toBe('unavailable');
    expect(refreshed?.health.lastErrorMessage).toContain('erişilemedi');
  });

  it('kaynak yapısı değiştiğinde (HTML değişmiş) hata kaydedilir ve durum "structure" olur', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ fail: new AdapterStructureError(source.key, 'Liste yapısı tanınmadı', '0 bağlantı') }),
      logger: LOGGER,
    });

    expect(result.status).toBe('failed');
    expect(result.errors.join(' ')).toContain('Liste yapısı tanınmadı');
    expect((await repos.sources.getByKey(source.key))?.health.lastErrorType).toBe('structure');
    expect((await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).total).toBe(0);
  });

  it('2) çerez/KVKK modalı ilan sayılmaz: ne kayıt ne inceleme kuyruğu üretilir', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [cerezModaliItem()] }),
      logger: LOGGER,
    });

    expect(result.itemsFound).toBe(1);
    expect(result.itemsRejected).toBe(1);
    expect(result.jobsCreated).toBe(0);
    expect(result.itemsReview).toBe(0);
    expect((await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).total).toBe(0);
    expect((await repos.review.countOpen()).total).toBe(0);
  });

  it('3) başlık ve bağlantı TEK BAŞINA kanıt değildir: gövdesiz kayıt yayımlanmaz', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({
        items: [
          {
            ...sozlesmeliPersonelIlani({
              sourceItemId: 'TOPLAMA-BASLIK-1',
              title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
              bodyText: '',
              rawExcerpt: '',
            }),
          },
        ],
      }),
      logger: LOGGER,
    });

    expect(result.jobsCreated).toBe(0);
    expect(result.itemsReview).toBe(1);
    expect((await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).total).toBe(0);
    const queue = await repos.review.list({ kind: 'classification' }, 10);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reason).toMatch(/Belge metni çıkarılamadı|doğrulan/i);
  });
});

describe('AŞAMA 4.2 — tarih ve durum kuralları', () => {
  const gecmisIlani = (sourceItemId: string): RawAnnouncement => ({
    sourceKey: TEST_SOURCE_KEY,
    sourceItemId,
    url: `https://ornek.test/ilanlar/${sourceItemId}`,
    title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı (Hemşire)',
    institution: 'Örnek Üniversitesi Rektörlüğü',
    publishedAt: '2026-09-01T00:00:00+03:00',
    attachments: [],
    sourceCategory: 'personel alimi',
    extractionConfidence: 0.5,
    bodyText:
      `${ALIM_SATIRI}\nAlınacak personel: Hemşire.\nKontenjan: 3 kişi.\n` +
      "Başvurular 20.09.2026 tarihinde saat 09:00'da başlayacak olup 01.10.2026 tarihinde saat 23:59'da sona erecektir.\n",
    rawExcerpt: 'Sözleşmeli personel alımı yapılacaktır.',
  });

  it("4) süresi geçmiş ilan 'closed' olur; aktif listede ve öneri havuzunda görünmez", async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [gecmisIlani('TOPLAMA-GECMIS-1')] }),
      logger: LOGGER,
    });
    expect(result.jobsCreated).toBe(1);

    const page = await repos.jobs.search({}, { pageSize: 20, sort: 'newest' });
    const job = page.items[0];
    expect(job?.status).toBe('closed');
    expect(job?.applicationEndDate).toBe('2026-10-01');
    const summary = job ? toPublicJobSummary(job, NOW) : null;
    expect(summary?.statusLabel).toBe(JOB_STATUS_LABELS.closed);
    expect(summary?.statusLabel).not.toBe(JOB_STATUS_LABELS.active);

    const aktif = await repos.jobs.search({ status: ['active', 'upcoming'] }, { pageSize: 20, sort: 'newest' });
    expect(aktif.total).toBe(0);

    const candidates = await selectCandidates(
      repos,
      { profession: 'Hemşire', educationLevel: 'lisans', departments: [], skills: [], experienceYears: null },
      NOW,
    );
    expect(candidates).toHaveLength(0);
  });

  it("5) tarih yoksa veya tarih yayımla çelişiyorsa 'Başvuru açık' denmez", async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);

    const tarihsiz: RawAnnouncement = {
      sourceKey: TEST_SOURCE_KEY,
      sourceItemId: 'TOPLAMA-TARIHSIZ-1',
      url: 'https://ornek.test/ilanlar/toplama-tarihsiz-1',
      title: 'Örnek Belediyesinden: Sözleşmeli Personel Alım İlanı (Tekniker)',
      institution: 'Örnek Belediyesi',
      publishedAt: '2026-10-10T00:00:00+03:00',
      attachments: [],
      sourceCategory: 'personel alimi',
      extractionConfidence: 0.5,
      bodyText: `${ALIM_SATIRI}\nAlınacak personel: Tekniker.\nKontenjan: 5 kişi.\nBaşvuru şartları: Ön lisans mezunu olmak.\n`,
      rawExcerpt: 'Sözleşmeli personel alımı yapılacaktır.',
    };

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [tarihsiz] }),
      logger: LOGGER,
    });
    expect(result.jobsCreated).toBe(1);
    const job = (await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).items[0];
    expect(job?.status).toBe('unknown');
    expect(job?.applicationEndDate).toBeNull();
    expect(job ? toPublicJobSummary(job, NOW).statusLabel : null).toBe(JOB_STATUS_LABELS.unknown);
  });
});

describe('AŞAMA 4.3 — tekilleştirme, bağlantı ve AI hatası', () => {
  it('6) ikinci kaynakta yayımlanan aynı ilan tek kayda birleşir; başvuru bağlantısı korunur', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const source2 = await seedSource(repos, TEST_DEFINITION_2);

    const birinci = sozlesmeliPersonelIlani({
      sourceKey: source.key,
      sourceItemId: 'TOPLAMA-LINK-1',
      bodyText: `${sozlesmeliPersonelIlani().bodyText}\nBaşvuru adresi: https://kariyerkapisi.cbiko.gov.tr/ilan/1234\n`,
    });
    await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [birinci] }),
      logger: LOGGER,
    });

    const job = (await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).items[0];
    expect(job).toBeDefined();
    const originalUrl = job?.applicationUrl ?? null;
    const originalDetail = job?.detailUrl;

    const ikinci = ikinciKaynakYayini({
      sourceKey: source2.key,
      sourceItemId: 'TOPLAMA-LINK-9001',
      url: 'https://ornek2.test/ilan/9001',
    });
    const secondRun = await runSourceScrape({
      repos,
      source: source2,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [ikinci] }),
      logger: LOGGER,
    });

    expect(secondRun.jobsCreated).toBe(0);
    expect(secondRun.itemsMerged).toBe(1);
    const merged = (await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).items;
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceKeys.sort()).toEqual([source.key, source2.key].sort());
    // Özgün kaynağın bağlantıları toplayıcı kaynakla EZİLMEZ.
    expect(merged[0]?.detailUrl).toBe(originalDetail);
    expect(merged[0]?.applicationUrl ?? null).toBe(originalUrl);
  });

  it('7) AI sağlayıcı hatası ilan kaydını bozmaz: kural kanıtıyla kayıt sürer, hata telemetriye yazılır', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const gate = alwaysFailingGate(repos);

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({
        items: [
          // Kural motoru kabul eder → kapı hiç çağrılmaz.
          sozlesmeliPersonelIlani({ sourceKey: source.key, sourceItemId: 'TOPLAMA-AI-OK' }),
          // Kural motoru belirsiz der → kapı çağrılır → 503 → insan incelemesi.
          incelemeyeDusen('TOPLAMA-AI-503'),
        ],
      }),
      logger: LOGGER,
      llmGate: gate,
    });

    expect(result.jobsCreated).toBe(1);
    expect(result.itemsReview).toBe(1);
    expect(result.llm.errors).toBeGreaterThanOrEqual(1);
    expect(result.notes.join(' ')).toContain('LLM kapısı');

    const job = (await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).items[0];
    expect(job?.title).not.toBe('Önemli Duyuru');
    expect(job?.quota).toBe(25);
    expect(job?.applicationEndDate).toBe('2026-10-30');
    // Sağlayıcı hatası ilanın KURAL tabanlı sınıflandırmasını geri almaz.
    expect(job?.classification.decision).toBe('accept');

    const rows = await repos.store.find('llmAnalyses', {}, { limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.status).toBe('error');
    expect(JSON.stringify(rows[0])).not.toContain(LLM_API_KEY);
    // Sağlayıcı hatası insan incelemesinde GÖRÜNÜR olmalı (sessizce yutulmaz).
    const queue = await repos.review.list({ kind: 'classification' }, 10);
    const opinion = (queue[0]?.payload as { llmOpinion?: { verdict?: string } } | undefined)?.llmOpinion;
    expect(opinion?.verdict).toBe('hata');
  });

  it('8) kayıt bazlı işleme hatası taramayı durdurmaz ve loglarda kaynak+aşama bulunur', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const { logger, entries } = captureLogger();

    let calls = 0;
    const patlayanGate: LlmClassificationGate = {
      evaluate: async () => {
        calls += 1;
        throw new Error('kapı beklenmedik şekilde çöktü');
      },
      summary: () => ({
        enabled: true,
        calls: 0,
        cacheHits: 0,
        upgradedToJob: 0,
        upgradedToProcess: 0,
        rejected: 0,
        keptReview: 0,
        blocked: 0,
        invalid: 0,
        errors: 1,
      }),
    };

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({
        items: [
          // Kural motoru 'review' der → kapı çalışır → hata → bu kayıt düşer.
          incelemeyeDusen('TOPLAMA-HATA-1'),
          // Bu kayıt kural kanıtıyla kabul edilir; kapıya hiç gidilmez.
          sozlesmeliPersonelIlani({ sourceItemId: 'TOPLAMA-HATA-2' }),
        ],
      }),
      logger,
      llmGate: patlayanGate,
    });

    expect(calls).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('kapı beklenmedik şekilde çöktü');
    expect(result.status).toBe('partial');
    expect(result.jobsCreated).toBe(1);

    const errorLog = entries.find((entry) => entry.stage === 'item');
    expect(errorLog).toBeDefined();
    expect(errorLog?.sourceKey).toBe(source.key);
    expect(String(errorLog?.url)).toContain('TOPLAMA-HATA-1');

    const health = await repos.sources.getByKey(source.key);
    expect(health?.health.lastErrorType).toBe('item');
  });

  it('9) aynı tarama tekrarlanırsa kopya oluşmaz (tekrar güvenli)', async () => {
    const repos = await makeRepos();
    const source = await seedSource(repos);
    const item = sozlesmeliPersonelIlani({ sourceKey: source.key });

    const first = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [item] }),
      logger: LOGGER,
    });
    const firstJob = (await repos.jobs.search({}, { pageSize: 20, sort: 'newest' })).items[0];

    const second = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      adapter: fakeAdapter({ items: [item] }),
      logger: LOGGER,
    });

    expect(first.jobsCreated).toBe(1);
    expect(second.jobsCreated).toBe(0);
    expect(second.itemsMerged).toBe(1);
    const page = await repos.jobs.search({}, { pageSize: 20, sort: 'newest' });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(firstJob?.id);
    expect(page.items[0]?.sourceKeys).toEqual([source.key]);
  });
});
