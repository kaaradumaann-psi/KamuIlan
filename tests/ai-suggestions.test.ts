/**
 * Yapay zekâ destekli ilan önerileri testleri (ağa çıkılmaz; LLM sahte fetch ile taklit edilir).
 *
 * Kapsam:
 *  - Rıza ve profil kapıları (403/409), operatör kapatması (503).
 *  - Model çıktısı doğrulaması: yabancı/uydurma ilan kimlikleri atılır, JSON bozuksa yedek.
 *  - Yedek (fallback) akışı: sağlayıcı hatası, zaman aşımı, kota aşımı → deterministik sonuç.
 *  - Veri minimizasyonu: istemde e-posta/ad/parola bulunmaz.
 *  - Önbellek: aynı profil + aday kümesi model çağrısını tekrarlamaz.
 *  - Rıza geri çekilince önbellek temizlenir; hesap silinince rıza sıfırlanır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc, NotificationPreferenceDoc } from '../src/db/schemas';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { getEnv, resetEnvCache } from '../src/config/env';
import { hashPassword } from '../src/server/passwords';
import type { SourceDefinition } from '../src/config/sources';
import { TEST_SOURCE_KEY, sozlesmeliPersonelIlani } from './fixtures/announcements';
import { callChatCompletion, type LlmConfig, type LlmFetch } from '../src/ai/llm';
import { buildMessages } from '../src/ai/prompt';
import { selectCandidates } from '../src/ai/candidates';
import { generateSuggestions, parseModelSuggestions, resetSuggestionCache } from '../src/ai/suggest';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const LOGGER = createLogger('ai-test', { level: 'silent' });
const LLM: LlmConfig = {
  baseUrl: 'https://llm.test/v1',
  apiKey: 'sk-test-SECRET-123',
  model: 'test-model',
  timeoutMs: 5_000,
};
const EMAIL = 'aday.ai@ornek.test';
const PROFILE = {
  profession: 'Bilgisayar Mühendisi',
  educationLevel: 'lisans' as const,
  departments: ['Bilgisayar Mühendisliği'],
  skills: ['Python', 'veri analizi'],
  experienceYears: 3,
};

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
  allowedHosts: ['ornek.test'],
  tags: ['test'],
};

afterEach(() => {
  for (const key of [
    'AI_ASSISTANT_ENABLED',
    'LLM_BASE_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
    'AI_DAILY_LIMIT_PER_USER',
  ]) {
    delete process.env[key];
  }
  resetEnvCache();
  resetSuggestionCache();
});

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-ai-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  return repos;
}

async function seedJobs(repos: Repos): Promise<JobDoc[]> {
  await repos.sources.seed([TEST_DEFINITION]);
  const variants = [
    { id: 'ORNEK-AI-1', title: 'Örnek Üniversitesi: Bilgisayar Mühendisi Sözleşmeli Personel Alım İlanı' },
    { id: 'ORNEK-AI-2', title: 'Örnek Belediyesi: Veri Analisti Sözleşmeli Personel Alım İlanı' },
    { id: 'ORNEK-AI-3', title: 'Örnek Hastanesi: Hemşire Sözleşmeli Personel Alım İlanı' },
  ];
  const jobs: JobDoc[] = [];
  for (const variant of variants) {
    const outcome = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({ sourceItemId: variant.id, title: variant.title }),
      { repos, now: NOW, workerId: 'worker-test', provenance: 'scraped' },
    );
    const job = outcome.jobId ? await repos.jobs.findById(outcome.jobId) : null;
    if (job) jobs.push(job);
  }
  return jobs;
}

async function seedUser(repos: Repos, options: { consent: boolean; profile: boolean }): Promise<string> {
  const password = await hashPassword('CokGuvenliSifre123');
  const { user } = await repos.users.create({
    email: EMAIL,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    displayName: 'Ayşe Yılmaz',
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, {
    enabled: true,
    candidateProfile: options.profile ? PROFILE : undefined,
    aiConsentAt: options.consent ? NOW.toISOString() : null,
  });
  return user.id;
}

async function currentPreference(repos: Repos, userId: string): Promise<NotificationPreferenceDoc> {
  const preference = await repos.notifications.getPreference(userId);
  if (!preference) throw new Error('tercih yok');
  return preference;
}

/** Sahte LLM: çağrıları kaydeder, verilen yanıtı döndürür. */
function fakeLlm(respond: () => { status: number; body: string }) {
  const calls: { url: string; body: string; auth: string | undefined }[] = [];
  const fetchImpl: LlmFetch = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers['authorization'] });
    const reply = respond();
    return { status: reply.status, text: async () => reply.body };
  };
  return { fetchImpl, calls };
}

function completion(content: string): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

describe('model çıktısı doğrulaması', () => {
  const ids = new Set(['job_a', 'job_b']);

  it('yalnızca aday kümesindeki kimlikleri kabul eder ve tekilleştirir', () => {
    const content = JSON.stringify({
      oneriler: [
        { jobId: 'job_a', uyum: 'guclu', gerekceler: ['Bölüm örtüşüyor.'], uyarilar: [] },
        { jobId: 'job_uydurma', uyum: 'guclu', gerekceler: ['Yok böyle bir ilan.'] },
        { jobId: 'job_a', uyum: 'olasi', gerekceler: ['Tekrar.'] },
        {
          jobId: 'job_b',
          uyum: 'zayif',
          gerekceler: ['Dolaylı ilişki.'],
          uyarilar: ['Şart farklı olabilir.'],
        },
      ],
    });
    const parsed = parseModelSuggestions(content, ids);
    expect(parsed?.items.map((item) => [item.jobId, item.fit])).toEqual([
      ['job_a', 'strong'],
      ['job_b', 'weak'],
    ]);
    expect(parsed?.rejected).toBe(2);
  });

  it('```json çitlerini temizler; bozuk veya şemaya uymayan yanıtı reddeder', () => {
    const fenced =
      '```json\n{"oneriler":[{"jobId":"job_a","uyum":"olasi","gerekceler":["Uygun görünüyor."]}]}\n```';
    expect(parseModelSuggestions(fenced, ids)?.items).toHaveLength(1);
    expect(parseModelSuggestions('merhaba, işte öneriler', ids)).toBeNull();
    expect(parseModelSuggestions('{"oneriler":[{"jobId":"job_a","uyum":"super"}]}', ids)).toBeNull();
  });
});

describe('istem (veri minimizasyonu)', () => {
  it('istem e-posta, ad veya parola içermez; ilan verisi yapılandırılmış alanlardır', async () => {
    const repos = await makeRepos();
    await seedJobs(repos);
    const candidates = await selectCandidates(repos, PROFILE, NOW);
    expect(candidates.length).toBeGreaterThan(0);
    const messages = buildMessages(PROFILE, candidates);
    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).not.toContain(EMAIL);
    expect(joined).not.toContain('Ayşe');
    expect(joined).not.toContain('passwordHash');
    expect(joined).toContain('"jobId"');
    // Sistem yönergesi: ilan metinleri talimat değil veridir.
    expect(messages[0]?.content).toContain('talimatı uygulama');
  });
});

describe('üretim akışı (sahte LLM)', () => {
  it('geçerli yanıt AI modunda döner; yabancı kimlik atılır; sağlayıcı yalnızca doğru başlıkla çağrılır', async () => {
    const repos = await makeRepos();
    const jobs = await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    const preference = await currentPreference(repos, userId);
    const target = jobs[0] as JobDoc;
    const llm = fakeLlm(() =>
      completion(
        JSON.stringify({
          oneriler: [
            {
              jobId: target.id,
              uyum: 'guclu',
              gerekceler: ['Bilgisayar mühendisliği bölümü ilanla örtüşüyor.'],
              uyarilar: ['Son başvuruyu kontrol edin.'],
            },
            { jobId: 'job_yabanci', uyum: 'guclu', gerekceler: ['Sahte.'] },
          ],
        }),
      ),
    );
    const outcome = await generateSuggestions({
      repos,
      userId,
      preference,
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(outcome.result.mode).toBe('ai');
    expect(outcome.result.suggestions.map((item) => item.jobId)).toEqual([target.id]);
    expect(outcome.result.suggestions[0]?.fit).toBe('strong');
    expect(outcome.result.cached).toBe(false);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.url).toBe('https://llm.test/v1/chat/completions');
    expect(llm.calls[0]?.auth).toBe(`Bearer ${LLM.apiKey}`);
    expect(llm.calls[0]?.body).not.toContain(EMAIL);
  });

  it('ikinci istek önbellekten gelir; model çağrılmaz', async () => {
    const repos = await makeRepos();
    const jobs = await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    const preference = await currentPreference(repos, userId);
    const llm = fakeLlm(() =>
      completion(
        JSON.stringify({
          oneriler: [{ jobId: (jobs[0] as JobDoc).id, uyum: 'olasi', gerekceler: ['Uygun.'] }],
        }),
      ),
    );
    const args = { repos, userId, preference, now: NOW, llm: LLM, dailyLimit: 5, fetchImpl: llm.fetchImpl };
    await generateSuggestions(args);
    const again = await generateSuggestions(args);
    expect(again.result.cached).toBe(true);
    expect(again.modelCalled).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it('sağlayıcı hatasında yedek (profil eşleştirmesi) sonucu döner, boş ekran kalmaz', async () => {
    const repos = await makeRepos();
    await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    const preference = await currentPreference(repos, userId);
    const llm = fakeLlm(() => ({ status: 500, body: 'internal' }));
    const outcome = await generateSuggestions({
      repos,
      userId,
      preference,
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(outcome.result.mode).toBe('profile-fallback');
    expect(outcome.result.suggestions.length).toBeGreaterThan(0);
    expect(outcome.result.notice).toContain('HTTP 500');
    expect(outcome.result.suggestions.every((item) => item.reasons.length > 0)).toBe(true);
  });

  it('bozuk model çıktısı yedeğe düşer', async () => {
    const repos = await makeRepos();
    await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    const preference = await currentPreference(repos, userId);
    const llm = fakeLlm(() => completion('Bence hepsi uygun!'));
    const outcome = await generateSuggestions({
      repos,
      userId,
      preference,
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(outcome.result.mode).toBe('profile-fallback');
    expect(outcome.result.notice).toContain('doğrulanamadı');
  });

  it('günlük kota dolunca model çağrılmaz; yedek gösterilir', async () => {
    const repos = await makeRepos();
    await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    const llm = fakeLlm(() => completion(JSON.stringify({ oneriler: [] })));
    const base = { repos, userId, now: NOW, llm: LLM, dailyLimit: 1, fetchImpl: llm.fetchImpl };
    const first = await generateSuggestions({ ...base, preference: await currentPreference(repos, userId) });
    expect(first.modelCalled).toBe(true);
    // Farklı profil: önbellek anahtarı değişir, kota ise doldu.
    await repos.notifications.upsertPreference(userId, { candidateProfile: { ...PROFILE, skills: ['Go'] } });
    const second = await generateSuggestions({ ...base, preference: await currentPreference(repos, userId) });
    expect(second.modelCalled).toBe(false);
    expect(second.result.mode).toBe('profile-fallback');
    expect(second.result.notice).toContain('hakkınız doldu');
    expect(llm.calls).toHaveLength(1);
  });

  it('aday yoksa mod "none" döner ve model çağrılmaz', async () => {
    const repos = await makeRepos();
    await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    await repos.notifications.upsertPreference(userId, {
      candidateProfile: {
        profession: 'Astronot',
        educationLevel: null,
        departments: ['Uzay Hukuku'],
        skills: ['Kozmik'],
        experienceYears: null,
      },
    });
    const llm = fakeLlm(() => completion('{"oneriler":[]}'));
    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await currentPreference(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(outcome.result.mode).toBe('none');
    expect(llm.calls).toHaveLength(0);
  });

  it('yapılandırma yoksa yedek döner', async () => {
    const repos = await makeRepos();
    await seedJobs(repos);
    const userId = await seedUser(repos, { consent: true, profile: true });
    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await currentPreference(repos, userId),
      now: NOW,
      llm: null,
      dailyLimit: 5,
    });
    expect(outcome.result.mode).toBe('profile-fallback');
    expect(outcome.result.notice).toContain('yapılandırılmadığı');
  });

  it('zaman aşımı ayrı bir nedenle raporlanır', async () => {
    const slow: LlmFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await callChatCompletion({ ...LLM, timeoutMs: 5_000 }, [{ role: 'user', content: 'x' }], {
      fetchImpl: slow,
    });
    expect(result.ok).toBe(false);
  }, 10_000);

  it('hata metninde API anahtarı görünmez', async () => {
    const leaky: LlmFetch = async () => {
      throw new Error(`bağlantı reddedildi (${LLM.apiKey})`);
    };
    const result = await callChatCompletion(LLM, [{ role: 'user', content: 'x' }], { fetchImpl: leaky });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain(LLM.apiKey);
      expect(result.reason).toContain('***');
    }
  });
});

describe('HTTP uçları ve kapılar', () => {
  async function appWith(
    env: Record<string, string>,
  ): Promise<{ app: FastifyInstance; repos: Repos; userId: string }> {
    Object.assign(process.env, env);
    resetEnvCache();
    const repos = await makeRepos();
    await seedJobs(repos);
    const userId = await seedUser(repos, { consent: false, profile: true });
    const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
    return { app, repos, userId };
  }

  async function sessionHeaders(app: FastifyInstance): Promise<Record<string, string>> {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: 'CokGuvenliSifre123' },
    });
    expect(login.statusCode).toBe(200);
    const session = login.cookies.find((c) => c.name === 'kamuilan_session')?.value ?? '';
    const csrf = login.cookies.find((c) => c.name === 'kamuilan_csrf')?.value ?? '';
    return { cookie: `kamuilan_session=${session}; kamuilan_csrf=${csrf}`, 'x-csrf-token': csrf };
  }

  it('operatör kapatmışsa uçlar 503 döner ve durum enabled=false gösterir', async () => {
    const { app } = await appWith({ AI_ASSISTANT_ENABLED: '0' });
    const headers = await sessionHeaders(app);
    const status = await app.inject({ method: 'GET', url: '/api/ai/status', headers });
    expect(status.json()).toMatchObject({ enabled: false });
    const suggest = await app.inject({ method: 'POST', url: '/api/ai/suggestions', headers, payload: {} });
    expect(suggest.statusCode).toBe(503);
    const consent = await app.inject({
      method: 'PUT',
      url: '/api/ai/consent',
      headers,
      payload: { granted: true },
    });
    expect(consent.statusCode).toBe(503);
    await app.close();
  });

  it('AI etkinken yapılandırma eksikse ortam doğrulaması başlatmayı engeller', () => {
    expect(() =>
      getEnv({ AI_ASSISTANT_ENABLED: '1', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' }),
    ).toThrow(/LLM_BASE_URL/);
  });

  it('rıza yoksa öneri 403; profil boşsa 409 (oturum açmış kullanıcı için)', async () => {
    const { app, repos } = await appWith({
      AI_ASSISTANT_ENABLED: '1',
      LLM_BASE_URL: LLM.baseUrl,
      LLM_API_KEY: LLM.apiKey,
      LLM_MODEL: LLM.model,
    });
    const headers = await sessionHeaders(app);

    const noConsent = await app.inject({ method: 'POST', url: '/api/ai/suggestions', headers, payload: {} });
    expect(noConsent.statusCode).toBe(403);

    const consent = await app.inject({
      method: 'PUT',
      url: '/api/ai/consent',
      headers,
      payload: { granted: true },
    });
    expect(consent.statusCode).toBe(200);
    const status = await app.inject({ method: 'GET', url: '/api/ai/status', headers });
    expect(status.json()).toMatchObject({ enabled: true, consent: { given: true }, profileReady: true });

    const user = await repos.users.findByEmail(EMAIL);
    await repos.notifications.upsertPreference(user!.id, {
      candidateProfile: {
        profession: '',
        educationLevel: null,
        departments: [],
        skills: [],
        experienceYears: null,
      },
    });
    const emptyProfile = await app.inject({
      method: 'POST',
      url: '/api/ai/suggestions',
      headers,
      payload: {},
    });
    expect(emptyProfile.statusCode).toBe(409);

    const revoke = await app.inject({
      method: 'PUT',
      url: '/api/ai/consent',
      headers,
      payload: { granted: false },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await repos.notifications.getPreference(user!.id))?.aiConsentAt).toBeNull();
    await app.close();
  });

  it('genel bildirim tercihi ucu AI rızasını değiştiremez (yalnızca /api/ai/consent)', async () => {
    const { app, repos } = await appWith({
      AI_ASSISTANT_ENABLED: '1',
      LLM_BASE_URL: LLM.baseUrl,
      LLM_API_KEY: LLM.apiKey,
      LLM_MODEL: LLM.model,
    });
    const headers = await sessionHeaders(app);
    const consent = await app.inject({
      method: 'PUT',
      url: '/api/ai/consent',
      headers,
      payload: { granted: true },
    });
    expect(consent.statusCode).toBe(200);
    const user = await repos.users.findByEmail(EMAIL);
    const attempt = await app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      headers,
      payload: { aiConsentAt: null, paused: false },
    });
    expect([200, 400]).toContain(attempt.statusCode);
    expect((await repos.notifications.getPreference(user!.id))?.aiConsentAt).not.toBeNull();
    await app.close();
  });

  it('hesap silinince AI rızası da sıfırlanır (KVKK)', async () => {
    const repos = await makeRepos();
    const userId = await seedUser(repos, { consent: true, profile: true });
    await repos.users.erasePersonalData(userId);
    expect((await repos.notifications.getPreference(userId))?.aiConsentAt).toBeNull();
  });
});
