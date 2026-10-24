/**
 * Kişisel eşleştirme: ana sayfa "Size uygun ilanlar" ile e-posta bildirimleri
 * AYNI kuralla (`matchJobFilters`) çalışır.
 *
 * Kapsam:
 *  - Birden çok unvan/anahtar kelimenin HEPSİ kullanılır (eskiden yalnız ilki).
 *  - Unvan, ilan başlığının yanında çıkarılan unvanlarda ve kadro tablosunda aranır.
 *  - Öneri listesindeki bölüm adı çıkarıcının kısa adıyla eşleşir.
 *  - İlanda belirtilmeyen il/öğrenim/KPSS koşulu ilanı elemez (gerekçede yazılır).
 *  - `/api/jobs/for-me`: oturum ister, yalnız açık iş ilanlarını son güne göre döner.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/passwords';
import {
  hasActiveFilters,
  matchJobFilters,
  matchPreferenceToJob,
  type PreferenceFilters,
} from '../src/notifications/matcher';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const SCOPE = { includeWorkerJobs: true, includeAcademicJobs: true };
const EMAIL = 'eslesme@ornek.test';
const PASSWORD = 'CokGuvenliSifre123';

function filters(overrides: Partial<PreferenceFilters> = {}): PreferenceFilters {
  return {
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
    ...overrides,
  };
}

let seq = 0;
function job(
  overrides: Omit<Partial<JobDoc>, 'requirements'> & { requirements?: Partial<JobDoc['requirements']> } = {},
): JobDoc {
  seq += 1;
  const at = '2026-10-10T09:00:00.000Z';
  const { requirements, ...rest } = overrides;
  return {
    id: `job_eslesme${String(seq).padStart(6, '0')}`,
    title: 'Sözleşmeli Personel Alım İlanı',
    titleNormalized: 'sozlesmeli personel alim ilani',
    institution: 'Örnek Devlet Hastanesi',
    institutionNormalized: 'ornek devlet hastanesi',
    unit: null,
    employmentType: 'sozlesmeli',
    status: 'active',
    statusReason: '',
    city: 'Ankara',
    cityNormalized: 'ankara',
    district: null,
    quota: 3,
    applicationStartAt: null,
    applicationEndAt: null,
    applicationEndDate: '2026-10-30',
    publishedAt: '2026-10-10',
    detailUrl: `https://ornek.gov.tr/duyuru/${seq}`,
    normalizedUrl: `https://ornek.gov.tr/duyuru/${seq}`,
    applicationUrl: null,
    applicationMethod: null,
    attachments: [],
    requirements: {
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      kpssYear: null,
      qualificationCodes: [],
      minAge: null,
      maxAge: null,
      certificates: [],
      minExperienceYears: null,
      foreignLanguages: [],
      specialConditions: [],
      ...requirements,
    },
    titles: [],
    openings: [],
    textExcerpt: 'Kurumumuza sözleşmeli personel alınacaktır.',
    textNormalized: 'kurumumuza sozlesmeli personel alinacaktir',
    originalRefNo: null,
    sourceKeys: ['resmigazete-cestili-ilanlar'],
    primarySourceKey: 'resmigazete-cestili-ilanlar',
    classification: {
      decision: 'accept',
      kind: 'job',
      employmentType: 'sozlesmeli',
      confidence: 0.9,
      reasons: [],
      rules: [],
      negativeSignals: [],
      version: 'test',
      classifiedAt: at,
      contentType: 'job',
    },
    extractionConfidence: 0.9,
    fieldSources: {},
    evidence: {},
    uncertainties: [],
    provenance: 'scraped',
    contentHash: String(seq).padStart(64, 'a'),
    dedupeKey: String(seq).padStart(64, 'b'),
    version: 1,
    firstSeenAt: at,
    lastSeenAt: at,
    lastVerifiedAt: null,
    createdAt: at,
    updatedAt: at,
    ...rest,
  } as JobDoc;
}

const match = (f: PreferenceFilters, j: JobDoc) => matchJobFilters(f, j, NOW, SCOPE);

describe('matchJobFilters', () => {
  it('birden çok unvanın hepsini dener (yalnız ilki değil)', () => {
    const ebe = job({ title: 'Ebe Alımı' });
    expect(match(filters({ titles: ['Hemşire', 'Ebe'] }), ebe).matched).toBe(true);
    expect(match(filters({ titles: ['Hemşire', 'Zabıta'] }), ebe).matched).toBe(false);
  });

  it('unvanı çıkarılan unvanlarda ve kadro tablosunda da arar', () => {
    const viaTitles = job({ titles: ['Hemşire'] });
    expect(match(filters({ titles: ['hemşire'] }), viaTitles).matched).toBe(true);
    const viaOpenings = job({
      openings: [
        { title: 'Tekniker', quota: 2, serviceClass: null, degree: null, qualification: null, evidence: '' },
      ],
    });
    expect(match(filters({ titles: ['TEKNİKER'] }), viaOpenings).matched).toBe(true);
  });

  it('birden çok anahtar kelimenin herhangi biri yeter; kurum adında da arar', () => {
    const j = job();
    expect(match(filters({ keywords: ['mühendis', 'hastane'] }), j).matched).toBe(true);
    expect(match(filters({ keywords: ['mühendis', 'zabıta'] }), j).matched).toBe(false);
  });

  it('öneri listesindeki bölüm adı çıkarıcının kısa adıyla ve metinle eşleşir', () => {
    const short = job({ requirements: { departments: ['Fizyoterapi'] } });
    expect(match(filters({ departments: ['Fizyoterapi ve Rehabilitasyon'] }), short).matched).toBe(true);
    const inText = job({ textExcerpt: 'Hemşirelik lisans mezunu adaylar başvurabilir.' });
    expect(match(filters({ departments: ['Hemşirelik'] }), inText).matched).toBe(true);
    expect(match(filters({ departments: ['Hukuk'] }), inText).matched).toBe(false);
  });

  it('il: Türkçe duyarsız eşleşir; il belirtmeyen ilan elenmez, farklı il elenir', () => {
    expect(match(filters({ cities: ['ANKARA'] }), job()).matched).toBe(true);
    const nationwide = match(filters({ cities: ['İzmir'] }), job({ city: null }));
    expect(nationwide.matched).toBe(true);
    expect(nationwide.reasons).toContain('il belirtilmemiş');
    expect(match(filters({ cities: ['İzmir'] }), job()).matched).toBe(false);
  });

  it('öğrenim: belirtilmemişse elenmez, farklı düzey elenir', () => {
    expect(match(filters({ educationLevels: ['lisans'] }), job()).matched).toBe(true);
    const onlyHigh = job({ requirements: { educationLevels: ['ortaogretim'] } });
    expect(match(filters({ educationLevels: ['lisans'] }), onlyHigh).matched).toBe(false);
  });

  it('KPSS: türü/puanı belirtmeyen ilan elenmez; kullanıcı puanının üstündeki taban elenir', () => {
    expect(match(filters({ kpssScoreTypes: ['P3'], kpssMinScore: 70 }), job()).matched).toBe(true);
    const p93 = job({ requirements: { kpssScoreTypes: ['P93'] } });
    expect(match(filters({ kpssScoreTypes: ['P3'] }), p93).matched).toBe(false);
    const high = job({ requirements: { kpssMinScore: 80 } });
    expect(match(filters({ kpssMinScore: 70 }), high).matched).toBe(false);
    const low = job({ requirements: { kpssMinScore: 60 } });
    expect(match(filters({ kpssMinScore: 70 }), low).matched).toBe(true);
  });

  it('kategoriler VE ile bağlanır', () => {
    const j = job({ title: 'Hemşire Alımı', city: 'Ankara' });
    expect(match(filters({ titles: ['Hemşire'], cities: ['Ankara'] }), j).matched).toBe(true);
    expect(match(filters({ titles: ['Hemşire'], cities: ['Bursa'] }), j).matched).toBe(false);
  });

  it('işçi/akademik kapsam ayarlarına uyar', () => {
    const worker = job({ employmentType: 'kamu-isci' });
    expect(matchJobFilters(filters(), worker, NOW, { ...SCOPE, includeWorkerJobs: false }).matched).toBe(false);
  });

  it('hasActiveFilters: yalnız KPSS puanı da tercihtir; boşluklar sayılmaz', () => {
    expect(hasActiveFilters(filters())).toBe(false);
    expect(hasActiveFilters(filters({ keywords: [' '] }))).toBe(false);
    expect(hasActiveFilters(filters({ kpssMinScore: 70 }))).toBe(true);
  });

  it('bildirim eşleştiricisi aynı filtre kuralını kullanır', () => {
    const preference = {
      enabled: true,
      paused: false,
      onlyNewJobs: true,
      notifyOnChanges: true,
      includeWorkerJobs: true,
      includeAcademicJobs: true,
      filters: filters({ titles: ['Zabıta', 'Ebe'] }),
    } as Parameters<typeof matchPreferenceToJob>[0]['preference'];
    const result = matchPreferenceToJob({ preference, job: job({ title: 'Ebe Alımı' }), kind: 'new-job', now: NOW });
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('unvan: Ebe');
  });
});

describe('GET /api/jobs/for-me', () => {
  let dir: string;
  let store: FileStore;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ repos: Repos; userId: string; headers: Record<string, string> }> {
    dir = mkdtempSync(join(tmpdir(), 'kamuilan-for-me-'));
    store = new FileStore(dir);
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    const password = await hashPassword(PASSWORD);
    const { user } = await repos.users.create({
      email: EMAIL,
      passwordHash: password.hash,
      passwordSalt: password.salt,
      emailVerified: true,
    });
    app = await buildApp({ repos, logger: createLogger('for-me-test', { level: 'silent' }), disableRateLimit: true });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const session = login.cookies.find((c) => c.name === 'kamuilan_session')?.value ?? '';
    const csrf = login.cookies.find((c) => c.name === 'kamuilan_csrf')?.value ?? '';
    return { repos, userId: user.id, headers: { cookie: `kamuilan_session=${session}; kamuilan_csrf=${csrf}` } };
  }

  it('oturumsuz istek reddedilir', async () => {
    await setup();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs/for-me' });
    expect(response.statusCode).toBe(401);
  });

  it('tercih yoksa kişiselleştirme yok', async () => {
    const { headers } = await setup();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs/for-me', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ personalized: false, total: 0, items: [] });
  });

  it('yalnız güncel (açık/yakında/tarihsiz), kabul edilmiş iş ilanlarını eşleştirir; son güne göre sıralar, sayfalar', async () => {
    const { repos, userId, headers } = await setup();
    const docs = [
      job({ title: 'Hemşire Alımı', applicationEndDate: '2026-10-28' }),
      job({ title: 'Ebe Alımı', applicationEndDate: '2026-10-20' }),
      job({ title: 'Hemşire Alımı (süresiz)', applicationEndDate: null, status: 'unknown' }),
      job({ title: 'Zabıta Memuru Alımı' }),
      job({ title: 'Hemşire Alımı (kapandı)', status: 'closed' }),
      job({ title: 'Hemşire Alımı (iptal)', status: 'cancelled' }),
      job({
        title: 'Hemşire Alımı (inceleme)',
        classification: { ...job().classification, decision: 'review' },
      }),
      job({ title: 'Hemşire Alımı sonuç duyurusu', classification: { ...job().classification, kind: 'process' } }),
    ];
    for (const doc of docs) await store.insertOne('jobs', doc);
    await repos.notifications.upsertPreference(userId, { filters: filters({ titles: ['Hemşire', 'Ebe'] }) });

    const response = await app!.inject({ method: 'GET', url: '/api/jobs/for-me?pageSize=2', headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      personalized: boolean;
      total: number;
      pages: number;
      items: { title: string; matchReasons: string[] }[];
    };
    expect(body.personalized).toBe(true);
    expect(body.total).toBe(3);
    expect(body.pages).toBe(2);
    expect(body.items.map((item) => item.title)).toEqual(['Ebe Alımı', 'Hemşire Alımı']);
    expect(body.items[0]?.matchReasons).toContain('unvan: Ebe');

    const second = await app!.inject({ method: 'GET', url: '/api/jobs/for-me?pageSize=2&page=2', headers });
    expect((second.json() as typeof body).items.map((item) => item.title)).toEqual(['Hemşire Alımı (süresiz)']);
  });

  it('bildirimler kapalı olsa da ekranda eşleşme gösterilir', async () => {
    const { repos, userId, headers } = await setup();
    await store.insertOne('jobs', job({ title: 'Hemşire Alımı' }));
    await repos.notifications.upsertPreference(userId, {
      enabled: false,
      filters: filters({ titles: ['Hemşire'] }),
    });
    const response = await app!.inject({ method: 'GET', url: '/api/jobs/for-me', headers });
    expect((response.json() as { total: number }).total).toBe(1);
  });

  it('geçersiz sayfa boyutu 400 döner', async () => {
    const { headers } = await setup();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs/for-me?pageSize=500', headers });
    expect(response.statusCode).toBe(400);
  });
});
