/**
 * Uçtan uca LLM entegrasyonu: gerçek tarama hattı (runSourceScrape) + sahte adaptör +
 * sahte LLM sağlayıcısı. Ağa çıkılmaz; bildirim gönderilmez (yalnızca kuyruğa yazım).
 *
 * Kanıtlanan sözleşmeler:
 *  - Kuralların `review` dediği gerçek alım, kanıtı doğrulanınca ilana dönüşür ve YALNIZCA
 *    o bildirim kuyruğuna girer; süreç duyurusu ilanlaşmaz ve bildirim üretmez.
 *  - Kanıtlı haber reddi ilan oluşturmaz; tarama belleğine `rejected` yazılır (açlık yok).
 *  - Sağlayıcı çökerse hiçbir belirsiz kayıt otomatik onaylanmaz; inceleme kuyruğuna
 *    LLM görüşü (hata) ile düşer ve normal ilan listesine sızmaz.
 *  - Tekrarlanan taramada önbellek çalışır: yeni API çağrısı yok, mükerrer kayıt yok.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc, ReviewQueueDoc, SourceDoc, SourceItemDecisionDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { getEnv, resetEnvCache } from '../src/config/env';
import type { SourceDefinition } from '../src/config/sources';
import type { SourceAdapter } from '../src/sources/types';
import type { RawAnnouncement } from '../src/domain';
import { runSourceScrape } from '../src/ingest/pipeline';
import { createLlmClassificationGate, disabledLlmGate } from '../src/ai/classifier';
import type { LlmFetch } from '../src/ai/llm';
import { hashPassword } from '../src/server/passwords';
import { classify } from '../src/classification/engine';
import { buildJobDocument } from '../src/ingest/jobs-service';
import { reclassifyJob } from '../src/ingest/reclassify';

const NOW = new Date('2026-10-15T09:00:00+03:00');
const LOGGER = createLogger('llm-ingest-test', { level: 'silent' });

const DEFINITION: SourceDefinition = {
  key: 'test-llm-kaynak',
  name: 'Test Kurumu Duyuruları',
  group: 'kurum',
  sourceType: 'institution-page',
  institution: 'Test Kurumu',
  homepageUrl: 'https://ornek.test/',
  listingUrl: 'https://ornek.test/duyurular',
  adapterKey: 'test-llm-adapter',
  method: 'html-list',
  status: 'method-defined',
  statusNote: 'Yalnızca testler için.',
  lastVerifiedAt: null,
  verificationEvidence: 'tests/llm-ingest.test.ts',
  coverageNote: 'Test.',
  enabled: true,
  intervalMinutes: 60,
  minRequestIntervalMs: 0,
  maxConcurrency: 1,
  allowedHosts: ['ornek.test'],
  tags: ['test'],
};

/** Kuralların review dediği üç gerçekçi durum: belirsiz başlıklı alım, kadro geçen haber, sınav duyurusu. */
const ITEMS: RawAnnouncement[] = [
  {
    sourceKey: DEFINITION.key,
    sourceItemId: 'item-ilan',
    url: 'https://ornek.test/duyuru/item-ilan',
    title: 'Önemli Duyuru',
    bodyText:
      'Kurumumuz merkez teşkilatında istihdam edilmek üzere 5 (beş) sözleşmeli personel alımı yapılacaktır. ' +
      'Başvurular 01.11.2026 - 15.11.2026 tarihleri arasında e-Devlet üzerinden alınacaktır. ' +
      'Adayların lisans mezunu olması ve KPSS P3 puan türünden en az 70 puan almış olması gerekmektedir.',
    bodyTextSource: 'detail',
    institution: 'Test Kurumu',
    publishedAt: '2026-10-15',
    attachments: [],
    extractionConfidence: 0.6,
  },
  {
    sourceKey: DEFINITION.key,
    sourceItemId: 'item-haber',
    url: 'https://ornek.test/duyuru/item-haber',
    title: 'Üniversitemiz akademik birimlerine ziyaret',
    // Gövdede "kadro/istihdam/personel alımı planları" geçtiği için kurallar review der;
    // aslında bir ziyaret haberidir (yanlış kabul riski taşıyan gerçek dünya örneği).
    bodyText:
      'Rektörümüz, üniversitemiz akademik birimlerini ziyaret ederek kadro planlaması hakkında görüş alışverişinde bulunmuştur. ' +
      'Ziyaret kapsamında yapılan toplantıda önümüzdeki döneme ilişkin personel alımı planları değerlendirilmiştir. ' +
      'Basın ve halkla ilişkiler birimi tarafından paylaşılmıştır.',
    bodyTextSource: 'detail',
    institution: 'Test Kurumu',
    publishedAt: '2026-10-15',
    attachments: [],
    extractionConfidence: 0.5,
  },
  {
    sourceKey: DEFINITION.key,
    sourceItemId: 'item-surec',
    url: 'https://ornek.test/duyuru/item-surec',
    title: 'Destek personeli alımı sınav duyurusu',
    // Yeni alım mı, mevcut alımın sınav aşaması mı belirsiz → kurallar review der.
    bodyText:
      'Sözleşmeli destek personeli alımı kapsamında yapılacak sınava ilişkin bilgiler aşağıda yer almaktadır. ' +
      'Sözlü sınav sonuçları kurum internet sitesinde ilan edilecektir. Adaylara ayrıca tebligat yapılmayacaktır.',
    bodyTextSource: 'detail',
    institution: 'Test Kurumu',
    publishedAt: '2026-10-15',
    attachments: [],
    extractionConfidence: 0.6,
  },
];

const MODEL_RESPONSES: Record<string, unknown> = {
  'item-ilan': {
    karar: 'ilan',
    icerikTuru: 'personnel_recruitment',
    istihdamTuru: 'sozlesmeli',
    guven: 0.92,
    ozet: 'Sözleşmeli personel alımı başvuru tarihleri ve şartlarıyla duyuruluyor.',
    kanitlar: {
      alimIfadesi: 'sözleşmeli personel alımı yapılacaktır',
      basvuruTarihi: '01.11.2026 - 15.11.2026 tarihleri arasında',
      kontenjan: '5 (beş)',
    },
  },
  'item-haber': {
    karar: 'ilan-degil',
    icerikTuru: 'news',
    istihdamTuru: 'belirsiz',
    guven: 0.9,
    ozet: 'Rektörün birim ziyareti haberi; yeni bir personel alımı duyurusu değil.',
    kanitlar: { olumsuzKanit: 'ziyaret ederek kadro planlaması hakkında görüş alışverişinde bulunmuştur' },
  },
  'item-surec': {
    karar: 'surec',
    icerikTuru: 'personnel_process_announcement',
    istihdamTuru: 'belirsiz',
    guven: 0.85,
    ozet: 'Duyurulan alımın sözlü sınav aşaması; yeni başvuru fırsatı değil.',
    kanitlar: { surecIfadesi: 'sözlü sınav sonuçları kurum internet sitesinde ilan edilecektir' },
  },
};

function scriptedLlmFetch(state: { calls: number; mode: 'normal' | 'down' }): LlmFetch {
  return async (_url, init) => {
    state.calls += 1;
    if (state.mode === 'down') {
      return { status: 500, text: async () => '{"error":"provider down"}' };
    }
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    const userMessage = body.messages.find((message) => message.role === 'user')?.content ?? '';
    const key = Object.keys(MODEL_RESPONSES).find((id) => userMessage.includes(ITEMS.find((i) => i.sourceItemId === id)?.title ?? '\u0000'));
    const payload = key ? MODEL_RESPONSES[key] : { karar: 'belirsiz', icerikTuru: 'uncertain', guven: 0.3, ozet: 'Karar verilemedi.', kanitlar: {} };
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
          usage: { prompt_tokens: 200, completion_tokens: 80 },
        }),
    };
  };
}

function adapterReturning(items: RawAnnouncement[]): SourceAdapter {
  return {
    key: 'test-llm-adapter',
    label: 'Test LLM adaptörü',
    method: 'html-list',
    notes: 'test',
    run: async () => ({
      items,
      requestCount: 1,
      notes: [],
      etag: null,
      lastModified: null,
      notModified: false,
      coverage: { status: 'complete' as const, note: 'Test kapsamı.' },
    }),
  };
}

let dir: string;
let store: FileStore;
let repos: Repos;
let source: SourceDoc;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-llm-ingest-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed([DEFINITION]);
  const doc = await repos.sources.getByKey(DEFINITION.key);
  if (!doc) throw new Error('test kaynağı oluşturulamadı');
  source = doc;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  resetEnvCache();
});

function gateEnv() {
  return getEnv({
    NODE_ENV: 'test',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: 'https://llm.test/v1',
    LLM_API_KEY: 'sk-test-ingest',
    LLM_CLASSIFIER_MODEL: 'test-model',
    LLM_MAX_CALLS_PER_RUN: '10',
    LLM_DAILY_CALL_LIMIT: '100',
    LLM_RETRY_MAX: '0',
    LLM_MAX_CONCURRENCY: '2',
  });
}

async function subscribedUser(): Promise<void> {
  const password = await hashPassword('CokGuvenliSifre123');
  const { user } = await repos.users.create({
    email: 'llm-aday@ornek.test',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, {
    enabled: true,
    onlyNewJobs: false,
    notifyOnChanges: true,
    filters: {
      keywords: [],
      titles: [],
      institutions: [],
      cities: [],
      employmentTypes: [],
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      minDaysUntilDeadline: null,
    },
  });
}

describe('LLM kapısı gerçek tarama hattında', () => {
  it('belirsiz alımı ilana çevirir, haberi reddeder, süreci ayrı tutar; bildirim yalnızca ilandan', async () => {
    await subscribedUser();
    const state = { calls: 0, mode: 'normal' as const };
    const gate = createLlmClassificationGate({
      repos,
      env: gateEnv(),
      logger: LOGGER,
      fetchImpl: scriptedLlmFetch(state),
      retryBackoffMs: 1,
    });

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: 'w-llm-test',
      adapter: adapterReturning(ITEMS),
      llmGate: gate,
      now: NOW,
    });

    expect(result.status).toBe('success');
    expect(result.llm.enabled).toBe(true);
    expect(result.llm.calls).toBe(3);
    expect(result.llm.upgradedToJob).toBe(1);
    expect(result.llm.upgradedToProcess).toBe(1);
    expect(result.llm.rejected).toBe(1);
    expect(result.jobsCreated).toBe(2); // ilan + süreç duyurusu
    expect(result.itemsRejected).toBe(1); // haber
    expect(result.itemsReview).toBe(0);

    const jobs: JobDoc[] = await repos.store.find('jobs', {});
    expect(jobs).toHaveLength(2);
    const jobIlan = jobs.find((job) => job.title === 'Önemli Duyuru');
    const jobSurec = jobs.find((job) => job.title.includes('sınav duyurusu'));
    expect(jobIlan?.classification.kind).toBe('job');
    expect(jobIlan?.classification.contentType).toBe('personnel_recruitment');
    expect(jobIlan?.classification.llm?.evidenceVerified).toBe(true);
    expect(jobIlan?.classification.rules).toContain('llm.kanitli-kabul');
    expect(jobSurec?.classification.kind).toBe('process');
    expect(jobSurec?.classification.contentType).toBe('personnel_process_announcement');

    // Haber ilan olmadı; tarama belleğine rejected yazıldı (sonraki taramada bütçeyi yemez).
    const decisions: SourceItemDecisionDoc[] = await repos.jobs.listSourceItemDecisions(DEFINITION.key);
    const haberDecision = decisions.find((d) => d.sourceItemId === 'item-haber');
    expect(haberDecision?.decision).toBe('rejected');

    // Bildirim: yalnızca personel ilanı kuyruğa girdi; süreç duyurusu girmedi.
    expect(result.notificationsQueued).toBe(1);

    // Tarama notu LLM özetini içerir (kaynak sağlığı görünürlüğü).
    expect(result.notes.join(' ')).toContain('LLM kapısı');
  });

  it('sağlayıcı çökerken hiçbir belirsiz kayıt otomatik onaylanmaz; incelemede kalır', async () => {
    const state = { calls: 0, mode: 'down' as const };
    const gate = createLlmClassificationGate({
      repos,
      env: gateEnv(),
      logger: LOGGER,
      fetchImpl: scriptedLlmFetch(state),
      retryBackoffMs: 1,
    });

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: 'w-llm-down',
      adapter: adapterReturning(ITEMS),
      llmGate: gate,
      now: NOW,
    });

    expect(result.jobsCreated).toBe(0);
    expect(result.itemsReview).toBe(3);
    expect(result.llm.errors).toBe(3);

    // İnceleme kuyruğunda LLM görüşü (hata) görünüyor; insan kararı bekleniyor.
    const queue: ReviewQueueDoc[] = await repos.review.list({ kind: 'classification' });
    expect(queue.length).toBe(3);
    const payloads = queue.map((item) => item.payload as { llmOpinion?: { verdict?: string } });
    expect(payloads.every((payload) => payload.llmOpinion?.verdict === 'hata')).toBe(true);

    // Normal ilan listesine sızmadı.
    const jobs: JobDoc[] = await repos.store.find('jobs', {});
    expect(jobs).toHaveLength(0);
  });

  it('tekrarlanan taramada önbellek çalışır: yeni API çağrısı ve mükerrer kayıt yok', async () => {
    const state = { calls: 0, mode: 'normal' as const };
    const fetchImpl = scriptedLlmFetch(state);
    const env = gateEnv();

    const firstGate = createLlmClassificationGate({ repos, env, logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
    const first = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: 'w-llm-1',
      adapter: adapterReturning(ITEMS),
      llmGate: firstGate,
      now: NOW,
    });
    expect(first.jobsCreated).toBe(2);
    expect(state.calls).toBe(3);

    // İkinci koşu: aynı içerik → önbellek isabeti, API çağrısı YOK, aynı kararlar.
    const secondGate = createLlmClassificationGate({ repos, env, logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
    const second = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: 'w-llm-2',
      adapter: adapterReturning(ITEMS),
      llmGate: secondGate,
      now: new Date(NOW.getTime() + 3_600_000),
    });
    expect(state.calls).toBe(3); // yeni çağrı yapılmadı
    expect(second.llm.cacheHits).toBe(3);
    expect(second.jobsCreated).toBe(0);

    // Mükerrer kayıt oluşmadı: hâlâ 2 ilan var.
    const jobs: JobDoc[] = await repos.store.find('jobs', {});
    expect(jobs).toHaveLength(2);
    // Haber ikinci koşuda da reddedildi (önbellekli karar idempotent).
    expect(second.itemsRejected).toBe(1);
  });

  it('kapı kapalıyken (varsayılan) davranış değişmez: belirsiz kayıtlar incelemede kalır', async () => {
    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: 'w-llm-off',
      adapter: adapterReturning(ITEMS),
      llmGate: disabledLlmGate(),
      now: NOW,
    });

    expect(result.llm.enabled).toBe(false);
    expect(result.jobsCreated).toBe(0);
    expect(result.itemsReview).toBe(3);
    const jobs: JobDoc[] = await repos.store.find('jobs', {});
    expect(jobs).toHaveLength(0);
  });
});

describe('jobs:reclassify — LLM denetim izi korunur', () => {
  it('kural güncellemesiyle düşürülen kayıtta classification.llm ve contentType kaybolmaz', () => {
    const NEWS_BODY =
      'Başkan Özvar, üniversitelerin sınav takvimine dikkat etmesi gerektiğini belirtti. Basın birimi tarafından paylaşılmıştır. Kurum internet sitesinde yayımlanan haber metni. Ayrıntılar için kurum sayfasını ziyaret ediniz.';
    const raw = {
      sourceKey: 'kamu-test',
      sourceItemId: 'reclass-1',
      title: "Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere sınav uyarısı",
      url: 'https://kamu.test/reclass-1',
      attachments: [],
      bodyText: NEWS_BODY,
      institution: 'Örnek Üniversitesi',
      publishedAt: '2026-10-01',
    } as unknown as RawAnnouncement;
    // Geçmişte kapıdan geçmiş (LLM denetim izi olan) bir kabul kaydı:
    const classification = { ...classify({ title: raw.title, body: raw.bodyText }), decision: 'accept' as const };
    classification.llm = {
      model: 'mock-model',
      promptVersion: 'kamuilan-sinif-v1',
      verdict: 'ilan',
      confidence: 0.9,
      evidenceVerified: true,
      cacheHit: false,
      analyzedAt: '2026-10-01T10:00:00.000Z',
    };
    classification.contentType = 'personnel_recruitment';
    const createdAt = new Date('2026-10-01T12:00:00Z').toISOString();
    const draft = buildJobDocument(raw, classification, {
      now: new Date('2026-10-01T12:00:00Z'),
      provenance: 'scraped',
    });
    const doc = {
      ...draft,
      id: 'reclass-1',
      createdAt,
      updatedAt: createdAt,
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      version: 1,
    } as unknown as JobDoc;

    // Güncel kurallar başlığı açık haber olarak reddediyor → yama classification üretmeli.
    const result = reclassifyJob(doc, new Date('2026-10-14T09:00:00Z'));
    const patch = result.patch;
    expect(patch.classification).toBeDefined();
    if (patch.classification) {
      expect(patch.classification.decision).toBe('reject');
      // LLM denetim izi tarihsel kayıttır; yeniden sınıflandırma onu silmemeli.
      expect(patch.classification.llm).toEqual(classification.llm);
      expect(patch.classification.contentType).toBe('news');
    }
  });
});
