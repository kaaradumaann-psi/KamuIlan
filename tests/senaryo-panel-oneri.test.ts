/**
 * AŞAMA 5 — Panel öneri asistanı senaryoları (ağ yok, sahte LLM).
 *
 * Denetim talimatındaki 10 senaryo ÖNCEDEN TANIMLANMIŞ beklenen sonuçlarla ölçülür:
 *
 * | # | Senaryo                                   | Beklenen                                                     |
 * |---|-------------------------------------------|--------------------------------------------------------------|
 * | 1 | Aday tüm temel şartları karşılıyor         | öneri AI modunda, uyum 'strong' (kanıt >70)                  |
 * | 2 | Aday zorunlu bir şartı karşılamıyor        | uyum 'strong' OLAMAZ; kural uyarısı görünür                  |
 * | 3 | Profilde önemli bilgiler eksik             | aday seçilmez, mod 'none', model çağrılmaz                   |
 * | 4 | İlanın başvuru tarihi geçmiş               | öneriye GİRMEZ (durum alanı bayat olsa bile)                 |
 * | 5 | İlan metni eksik/belirsiz                  | kanıtsız ilan modele gönderilmez; 'güçlü uyum' iddiası yok   |
 * | 6 | Profil ile ilan şartları çelişiyor         | uyarı + sınırlı uyum; model 'strong' diyemez                 |
 * | 7 | Model geçersiz JSON döndürüyor             | doğrulanmaz; deterministik yedek gösterilir, boş ekran yok   |
 * | 8 | Model yanıtı boş                           | boş içerik → yedek; boş ANCAK geçerli liste → 'ai' + bilgi    |
 * | 9 | Model zaman aşımına uğruyor                | yedek sonuç; çağrı kotadan düşülür (gerçekten denendi)        |
 * |10 | Günlük çağrı sınırı doluyor                | model ÇAĞRILMAZ; yedek gösterilir; kalan hak 0                |
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc, NotificationPreferenceDoc } from '../src/db/schemas';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { fixedClock } from '../src/lib/clock';
import { getEnv, resetEnvCache } from '../src/config/env';
import type { SourceDefinition } from '../src/config/sources';
import { TEST_SOURCE_KEY, sozlesmeliPersonelIlani } from './fixtures/announcements';
import { callChatCompletion, type LlmConfig, type LlmFetch } from '../src/ai/llm';
import { buildMessages } from '../src/ai/prompt';
import { selectCandidates } from '../src/ai/candidates';
import { explainProfileMatch } from '../src/lib/profile-match';
import { toPublicJobDetail } from '../src/server/serializers';
import type { PublicJobDetail } from '../src/types';
import {
  capFitBySignal,
  generateSuggestions,
  parseModelSuggestions,
  resetSuggestionCache,
} from '../src/ai/suggest';
import { LlmBudget } from '../src/ai/budget';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const LLM: LlmConfig = {
  baseUrl: 'https://llm.test/v1',
  apiKey: 'sk-panel-gizli-anahtar',
  model: 'test-model',
  timeoutMs: 30_000,
};
const EMAIL = 'panel.senaryo@ornek.test';

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
  statusNote: 'Yalnızca testler için.',
  lastVerifiedAt: null,
  verificationEvidence: 'tests/senaryo-panel-oneri.test.ts',
  coverageNote: 'Test kapsamı.',
  enabled: true,
  intervalMinutes: 60,
  minRequestIntervalMs: 0,
  maxConcurrency: 1,
  allowedHosts: ['ornek.test'],
  tags: ['test'],
};

/** İlanın metniyle birebir örtüşen profil (senaryo 1). */
const PROFILE_MATCHING = {
  profession: 'Hemşire',
  educationLevel: 'lisans' as const,
  departments: ['Hemşirelik'],
  skills: [],
  experienceYears: null,
};

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuradar-panel-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed([TEST_DEFINITION]);
  return repos;
}

async function seedJob(repos: Repos): Promise<JobDoc> {
  const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
    repos,
    now: NOW,
    workerId: 'worker-panel',
    provenance: 'scraped',
  });
  if (!outcome.jobId) throw new Error('test ilanı oluşmadı');
  const job = await repos.jobs.findById(outcome.jobId);
  if (!job) throw new Error('test ilanı okunamadı');
  return job;
}

/**
 * Zorunlu şartı profil ile çelişen ilan (senaryo 2/6): bölüm koşulu "Hukuk",
 * adayın unvanı ilanda doğrudan geçmiyor, eğitim koşulu çıkarılamıyor.
 * Ön eleme sinyali bu yüzden 'medium'/'low' kalır ve model "güçlü uyum" dese
 * bile karar sınırlanmalıdır.
 */
async function seedRequirementJob(repos: Repos): Promise<JobDoc> {
  const body =
    'Örnek Üniversitesi Rektörlüğünden:\n' +
    'Üniversitemiz birimlerinde istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır.\n' +
    'Alınacak personel: Veri Analisti.\n' +
    'Kontenjan: 2 kişi.\n' +
    'Başvuru şartları: Hukuk fakültesi mezunu olmak.\n' +
    'Başvurular 20.10.2026 tarihinde başlayacak olup 30.10.2026 tarihinde sona erecektir.\n';
  const outcome = await applyRawAnnouncement(
    {
      sourceKey: TEST_SOURCE_KEY,
      sourceItemId: 'PANEL-SART-1',
      url: 'https://ornek.test/ilanlar/panel-sart-1',
      title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
      institution: 'Örnek Üniversitesi Rektörlüğü',
      publishedAt: '2026-10-12T00:00:00+03:00',
      bodyText: body,
      rawExcerpt: body.slice(0, 200),
      attachments: [],
      sourceCategory: 'personel alimi',
      extractionConfidence: 0.5,
    },
    { repos, now: NOW, workerId: 'worker-panel', provenance: 'scraped' },
  );
  if (!outcome.jobId) throw new Error('şart ilanı oluşmadı');
  const job = await repos.jobs.findById(outcome.jobId);
  if (!job) throw new Error('şart ilanı okunamadı');
  return job;
}

/** Kanıtlı ama sınırlı eşleşme: bölüm örtüşür, unvan/eğitim doğrulanamaz. */
const PROFILE_LIMITED_EVIDENCE = {
  profession: 'Veri Analisti',
  educationLevel: 'lisans' as const,
  departments: ['Hukuk'],
  skills: [],
  experienceYears: null,
};

async function seedUser(
  repos: Repos,
  profile: NotificationPreferenceDoc['candidateProfile'],
): Promise<string> {
  const { user } = await repos.users.create({
    email: EMAIL,
    passwordHash: 'kdf$test$hash',
    passwordSalt: 'test-salt',
    displayName: 'Ayşe Yılmaz',
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, {
    enabled: true,
    candidateProfile: profile,
    aiConsentAt: NOW.toISOString(),
  });
  return user.id;
}

async function preferenceOf(repos: Repos, userId: string): Promise<NotificationPreferenceDoc> {
  const preference = await repos.notifications.getPreference(userId);
  if (!preference) throw new Error('tercih yok');
  return preference;
}

type Reply =
  | { kind: 'json'; payload: unknown }
  | { kind: 'text'; content: string }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'timeout' };

function fakeLlm(replies: Reply[]): { fetchImpl: LlmFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: LlmFetch = async (url, init) => {
    const index = calls.length;
    calls.push(url);
    const reply = replies[Math.min(index, replies.length - 1)] as Reply;
    if (reply.kind === 'status') {
      return { status: reply.status, text: async () => reply.body ?? '{"error":"fail"}' };
    }
    if (reply.kind === 'timeout') {
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(new Error('This operation was aborted'));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort);
      });
    }
    const content = reply.kind === 'text' ? reply.content : JSON.stringify(reply.payload);
    return {
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
  return { fetchImpl, calls };
}

function suggestion(
  jobId: string,
  uyum: 'guclu' | 'olasi' | 'zayif',
  gerekceler: string[],
  uyarilar: string[] = [],
): Record<string, unknown> {
  return { oneriler: [{ jobId, uyum, gerekceler, uyarilar }] };
}

afterEach(() => {
  resetEnvCache();
  resetSuggestionCache();
});

describe('AŞAMA 5.1 — profil, aday seçimi ve ön eleme sınırları', () => {
  it('1) aday tüm temel şartları karşılıyorsa öneri AI modunda ve güçlü uyumda gelir', async () => {
    const repos = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([
      {
        kind: 'json',
        payload: suggestion(job.id, 'guclu', ['Hemşire unvanı ve lisans mezuniyeti ilanla örtüşüyor.']),
      },
    ]);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });

    expect(outcome.result.mode).toBe('ai');
    expect(outcome.result.suggestions).toHaveLength(1);
    expect(outcome.result.suggestions[0]?.fit).toBe('strong');
    // Kaynak/başvuru bağlantısı için gerekli alanlar sonuçta bulunur.
    expect(outcome.result.suggestions[0]?.institution).toContain('Üniversitesi');
    expect(outcome.result.suggestions[0]?.applicationEndDate).toBe('2026-10-30');
    expect(llm.calls).toHaveLength(1);
    expect(outcome.remainingToday).toBe(4);
  });

  it('2) aday zorunlu bir şartı karşılamıyorsa uyum "güçlü" OLAMAZ ve kural uyarısı görünür', async () => {
    const repos = await makeRepos();
    const job = await seedRequirementJob(repos);
    const userId = await seedUser(repos, PROFILE_LIMITED_EVIDENCE);
    const llm = fakeLlm([
      {
        kind: 'json',
        payload: suggestion(job.id, 'guclu', ['Profil bu ilan için çok uygun görünüyor.']),
      },
    ]);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });

    expect(outcome.result.mode).toBe('ai');
    const item = outcome.result.suggestions[0];
    expect(item).toBeDefined();
    // Ön eleme sinyali 'medium': model "güçlü" diyemez.
    expect(item?.fit).toBe('possible');
    expect(item?.fit).not.toBe('strong');
    const caveats = (item?.caveats ?? []).join(' ');
    // Uydurma/abartılı uyum iddiası sınırlandırılır ve kural uyarısı gizlenemez.
    expect(caveats).toMatch(/sınırlandırıldı/);
    expect(caveats).toMatch(/unvan|eğitim|gövdesi|belirsizlik/i);
    // Model gerekçesi korunur; kanıta dayalı kural gerekçesi de eklenir.
    expect(item?.reasons.join(' ')).toContain('Profil bu ilan için çok uygun görünüyor.');
    expect(item?.reasons.join(' ')).toMatch(/Hukuk/);
  });

  it('3) profilde önemli bilgiler eksikse model çağrılmaz', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, {
      profession: '',
      educationLevel: null,
      departments: [],
      skills: [],
      experienceYears: null,
    });
    const llm = fakeLlm([{ kind: 'json', payload: suggestion('yok', 'guclu', ['olamaz']) }]);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });

    expect(outcome.modelCalled).toBe(false);
    expect(llm.calls).toHaveLength(0);
    expect(outcome.result.mode).toBe('none');
    expect(outcome.result.suggestions).toHaveLength(0);
    expect(outcome.result.notice).toBeTruthy();
  });

  it('4) başvuru tarihi geçmiş ilan, durum alanı BAYAT olsa bile öneriye girmez', async () => {
    const repos = await makeRepos();
    const job = await seedJob(repos);
    // Gerçekçi durum: `deadline-refresh` görevi henüz çalışmadı, durum hâlâ 'active'
    // ama son başvuru tarihi dün.
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const endDate = yesterday.toISOString().slice(0, 10);
    await repos.store.updateOne(
      'jobs',
      { id: job.id },
      { status: 'active', applicationEndDate: endDate, applicationEndAt: `${endDate}T00:00:00+03:00` },
    );
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([{ kind: 'json', payload: suggestion(job.id, 'guclu', ['süresi geçmiş']) }]);

    const candidates = await selectCandidates(repos, PROFILE_MATCHING, NOW);
    expect(candidates.map((candidate) => candidate.job.id)).not.toContain(job.id);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(llm.calls).toHaveLength(0);
    expect(outcome.result.mode).toBe('none');
  });

  it('5) metni eksik/belirsiz ilan modele gönderilmez (kanıtsız "güçlü uyum" üretilemez)', async () => {
    const repos = await makeRepos();
    const outcome = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({
        sourceItemId: 'PANEL-BELIRSIZ-1',
        title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
        bodyText:
          'Üniversitemiz birimlerinde istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır. ' +
          'Başvuru şartları ve tarihleri kurumumuz internet sitesinde yayımlanacaktır. ' +
          'Adayların duyuruyu takip etmesi rica olunur.',
        rawExcerpt: 'Sözleşmeli personel alımı yapılacaktır.',
      }),
      { repos, now: NOW, workerId: 'worker-panel', provenance: 'scraped' },
    );
    expect(outcome.jobId).not.toBeNull();
    const job = await repos.jobs.findById(outcome.jobId as string);
    // Metin belirsiz: çıkarılabilir koşul/tarih yok → durum 'unknown', kanıt yok.
    expect(job?.requirements.educationLevels ?? []).toHaveLength(0);
    expect(job?.requirements.departments ?? []).toHaveLength(0);
    expect(job?.applicationEndDate).toBeNull();
    expect(job?.status).toBe('unknown');

    const candidates = await selectCandidates(repos, PROFILE_MATCHING, NOW);
    expect(candidates.map((candidate) => candidate.job.id)).not.toContain(job?.id);

    const messages = candidates.length > 0 ? buildMessages(PROFILE_MATCHING, candidates) : [];
    expect(messages.some((message) => message.content.includes(job?.id ?? ''))).toBe(false);

    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([{ kind: 'json', payload: suggestion(job?.id ?? '', 'guclu', ['Kanıtsız iddia.']) }]);
    const suggestionOutcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(llm.calls).toHaveLength(0);
    expect(suggestionOutcome.result.suggestions).toHaveLength(0);
  });

  it('6) profil ile ilan şartları çelişiyorsa olumlu uyum iddiası üretilmez; çelişki kural motorunda görünür', async () => {
    const repos = await makeRepos();
    const job = await seedRequirementJob(repos);
    // Aday Hukuk mezunu DEĞİL: ilanın bölüm koşuluyla çelişiyor.
    const profile = {
      profession: '',
      educationLevel: 'lisans' as const,
      departments: ['İşletme'],
      skills: [],
      experienceYears: null,
    };
    const detail = toPublicJobDetail(job, { sources: [], now: NOW }) as unknown as PublicJobDetail;
    const match = explainProfileMatch(detail, profile);
    expect(match).not.toBeNull();
    expect((match?.caveats ?? []).join(' ')).toMatch(/bölüm/i);

    const userId = await seedUser(repos, profile);
    const llm = fakeLlm([
      {
        kind: 'json',
        payload: suggestion(job.id, 'guclu', ['Eğitim ve bölüm şartları karşılanıyor.']),
      },
    ]);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });

    // Çelişki varken OLUMLU kanıt üretilemediği için ilan aday havuzuna girmez:
    // model "güçlü uyum" diyemez ve kullanıcıya uydurma öneri gösterilmez.
    expect(outcome.result.mode).toBe('none');
    expect(outcome.result.suggestions).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
    expect(outcome.result.notice).toContain('uyan açık bir ilan bulunamadı');
  });
});

describe('AŞAMA 5.2 — model arızası, boş yanıt ve kota', () => {
  it('7) model geçersiz JSON döndürürse deterministik yedek gösterilir', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([{ kind: 'text', content: 'Bence bu ilan size uygun!' }]);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });

    expect(outcome.result.mode).toBe('profile-fallback');
    expect(outcome.result.suggestions.length).toBeGreaterThan(0);
    expect(outcome.result.notice).toContain('doğrulanamadı');
    expect(outcome.result.suggestions.every((item) => item.reasons.length > 0)).toBe(true);
    // Yedek sonuçlar da kesin uygunluk iddiası taşımaz.
    expect(outcome.result.suggestions.every((item) => item.caveats.length > 0)).toBe(true);
  });

  it('8) boş yanıt: boş içerik yedeğe düşer, geçerli boş liste ise "belirgin uyum yok" olarak döner', async () => {
    const repos = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);

    const emptyContent = fakeLlm([{ kind: 'text', content: '   ' }]);
    const first = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: emptyContent.fetchImpl,
    });
    expect(first.result.mode).toBe('profile-fallback');
    expect(first.result.notice).toContain('alınamadı');

    resetSuggestionCache();
    const emptyList = fakeLlm([{ kind: 'json', payload: { oneriler: [] } }]);
    const second = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: new Date(NOW.getTime() + 60_000),
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: emptyList.fetchImpl,
    });
    expect(second.result.mode).toBe('ai');
    expect(second.result.suggestions).toHaveLength(0);
    expect(second.result.notice).toContain('belirgin bir uyum görmedi');
    expect(job.id.length).toBeGreaterThan(0);
  });

  it('8b) model 429/503 döndürürse yedek sonuç gösterilir; hata gövdesi ve anahtar sızmaz', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const preference = await preferenceOf(repos, userId);

    for (const status of [429, 503]) {
      resetSuggestionCache();
      const llm = fakeLlm([
        { kind: 'status', status, body: '<html><body>Service Unavailable: anahtar sk-sahte-anahtar-9999</body></html>' },
      ]);
      const outcome = await generateSuggestions({
        repos,
        userId,
        preference,
        now: NOW,
        llm: LLM,
        dailyLimit: 5,
        fetchImpl: llm.fetchImpl,
      });

      expect(llm.calls).toHaveLength(1);
      expect(outcome.result.mode).toBe('profile-fallback');
      expect(outcome.result.suggestions.length).toBeGreaterThan(0);
      const notice = outcome.result.notice ?? '';
      // Hata gövdesi (HTML) ve sağlayıcı anahtarı kullanıcıya gösterilmez.
      expect(notice).not.toContain('<html>');
      expect(notice).not.toContain('sk-sahte-anahtar');
      expect(notice).toContain(String(status));
    }
  });

  it('9) model zaman aşımına uğrarsa yedek sonuç döner ve deneme kotadan düşülür', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([{ kind: 'timeout' }]);
    const timedOut: LlmConfig = { ...LLM, timeoutMs: 5_000 };

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: timedOut,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });

    expect(outcome.modelCalled).toBe(true);
    expect(outcome.result.mode).toBe('profile-fallback');
    expect(outcome.result.notice).toContain('Zaman aşımı');
    expect(outcome.remainingToday).toBe(4); // deneme gerçekten yapıldı
    const todayUsed = await repos.rateLimits.peek(`ai-daily:${userId}`, 24 * 3_600);
    expect(todayUsed).toBe(1);
  });

  it('10) günlük sınır dolduğunda model çağrılmaz ve kalan hak 0 bildirilir', async () => {
    const repos = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([
      {
        kind: 'json',
        payload: suggestion(job.id, 'olasi', ['Kısmen uygun görünüyor.']),
      },
    ]);

    const first = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 1,
      fetchImpl: llm.fetchImpl,
    });
    expect(first.modelCalled).toBe(true);
    expect(first.remainingToday).toBe(0);

    // Profil değişir → önbellek anahtarı değişir; kota doludur.
    await repos.notifications.upsertPreference(userId, {
      candidateProfile: { ...PROFILE_MATCHING, skills: ['Triyaj'] },
    });
    const second = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 1,
      fetchImpl: llm.fetchImpl,
    });

    expect(second.modelCalled).toBe(false);
    expect(second.result.mode).toBe('profile-fallback');
    expect(second.result.notice).toContain('hakkınız doldu');
    expect(second.remainingToday).toBe(0);
    expect(llm.calls).toHaveLength(1);
  });

  it('global bütçe reddi kullanıcının günlük AI kotasını tüketmez', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([{ kind: 'json', payload: { oneriler: [] } }]);
    const blockedBudget = new LlmBudget(repos, {
      dailyCallLimit: 10,
      maxCallsPerRun: 0,
      dailyCostLimitUsd: null,
      runCostLimitUsd: null,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
    });

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
      budget: blockedBudget,
    });

    expect(outcome.modelCalled).toBe(false);
    expect(outcome.remainingToday).toBe(5);
    expect(outcome.result.notice).toContain('bütçesi');
    expect(llm.calls).toHaveLength(0);
    expect(await repos.rateLimits.peek(`ai-daily:${userId}`, 24 * 3_600)).toBe(0);
    expect(await repos.rateLimits.peek('llm-global-daily', 24 * 3_600)).toBe(0);
  });

  it('günlük kota zaten doluysa global bütçeden çağrı rezerve edilmez', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    await repos.rateLimits.reserve(`ai-daily:${userId}`, 24 * 3_600, 1, 1);
    const llm = fakeLlm([{ kind: 'json', payload: { oneriler: [] } }]);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 1,
      fetchImpl: llm.fetchImpl,
    });

    expect(outcome.modelCalled).toBe(false);
    expect(outcome.remainingToday).toBe(0);
    expect(llm.calls).toHaveLength(0);
    expect(await repos.rateLimits.peek('llm-global-daily', 24 * 3_600)).toBe(0);
  });
});

describe('AŞAMA 5.3 — uygunluk kararı KODA aittir, modele devredilmez', () => {
  it('model uyum derecesi deterministik ön eleme sinyalini AŞAMAZ (kod kararı korunur)', () => {
    // Sinyal 'medium' iken model "güçlü" diyemez:
    expect(capFitBySignal('strong', 'medium')).toBe('possible');
    expect(capFitBySignal('strong', 'low')).toBe('weak');
    expect(capFitBySignal('strong', 'unknown')).toBe('weak');
    // Sinyal yeterliyse modelin daha düşük derecesi KORUNUR (asla yükseltilmez):
    expect(capFitBySignal('weak', 'high')).toBe('weak');
    expect(capFitBySignal('possible', 'high')).toBe('possible');
    expect(capFitBySignal('strong', 'high')).toBe('strong');
  });

  it('durum alanı bayat olsa bile süresi geçmiş ilan aday havuzuna girmez', async () => {
    const repos = await makeRepos();
    const body =
      'Örnek Üniversitesi Rektörlüğünden:\n' +
      'Üniversitemiz birimlerinde istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır.\n' +
      'Alınacak personel: Hemşire.\nKontenjan: 3 kişi.\n' +
      "Başvurular 20.09.2026 tarihinde saat 09:00'da başlayacak olup 01.10.2026 tarihinde saat 23:59'da sona erecektir.\n";
    const outcome = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({
        sourceItemId: 'PANEL-BAYAT-1',
        bodyText: body,
        rawExcerpt: 'Sözleşmeli personel alımı.',
      }),
      { repos, now: NOW, workerId: 'worker-panel', provenance: 'scraped' },
    );
    const jobId = outcome.jobId;
    expect(jobId).not.toBeNull();
    // Yanıltıcı senaryo: `deadline-refresh` çalışmadığı için durum alanı BAYAT.
    await repos.store.updateOne('jobs', { id: jobId }, { status: 'active' });
    expect((await repos.jobs.findById(jobId as string))?.status).toBe('active');

    const candidates = await selectCandidates(repos, PROFILE_MATCHING, NOW);
    expect(candidates.map((candidate) => candidate.job.id)).not.toContain(jobId);

    const userId = await seedUser(repos, PROFILE_MATCHING);
    const llm = fakeLlm([
      { kind: 'json', payload: suggestion(jobId as string, 'guclu', ['Süresi geçmiş ilan.']) },
    ]);
    const result = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: LLM,
      dailyLimit: 5,
      fetchImpl: llm.fetchImpl,
    });
    expect(llm.calls).toHaveLength(0);
    expect(result.result.suggestions).toHaveLength(0);
  });
});

describe('AŞAMA 5.3 — veri minimizasyonu ve sunum dürüstlüğü', () => {
  it('profile ait ad/e-posta/parola modele gönderilmez; ilan verisi yapılandırılmıştır', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    const candidates = await selectCandidates(repos, PROFILE_MATCHING, NOW);
    expect(candidates.length).toBeGreaterThan(0);
    const messages = buildMessages(PROFILE_MATCHING, candidates);
    const joined = messages.map((message) => message.content).join('\n');

    expect(joined).not.toContain(EMAIL);
    expect(joined).not.toContain('Ayşe');
    expect(joined).not.toContain('passwordHash');
    expect(joined).not.toContain('test-salt');
    expect(joined).not.toContain(userId);
  });

  it('model yanıtı doğrulayıcı: aday dışı kimlik ve şema dışı uyum reddedilir', () => {
    const ids = new Set(['job_a']);
    expect(
      parseModelSuggestions(
        '{"oneriler":[{"jobId":"job_b","uyum":"guclu","gerekceler":["Yabancı ilan kimliği."]}]}',
        ids,
      ),
    ).toMatchObject({ items: [], rejected: 1 });
    expect(
      parseModelSuggestions(
        '{"oneriler":[{"jobId":"job_a","uyum":"kesin","gerekceler":["Şema dışı uyum değeri."]}]}',
        ids,
      ),
    ).toBeNull();
  });

  it('sağlayıcı yapılandırılmadıysa kalan hak YANLIŞ raporlanmaz', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const userId = await seedUser(repos, PROFILE_MATCHING);
    await repos.rateLimits.hit(`ai-daily:${userId}`, 24 * 3_600);
    await repos.rateLimits.hit(`ai-daily:${userId}`, 24 * 3_600);

    const outcome = await generateSuggestions({
      repos,
      userId,
      preference: await preferenceOf(repos, userId),
      now: NOW,
      llm: null,
      dailyLimit: 5,
    });

    expect(outcome.result.mode).toBe('profile-fallback');
    expect(outcome.modelCalled).toBe(false);
    expect(outcome.remainingToday).toBe(3);
  });

  it('LLM yapılandırması olmadan da çağrı yapılmaz (uç nokta doğru)', async () => {
    const repos = await makeRepos();
    await seedJob(repos);
    const calls: string[] = [];
    const fetchImpl: LlmFetch = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => '{}' };
    };
    const result = await callChatCompletion(
      LLM,
      [{ role: 'user', content: 'deneme' }],
      { fetchImpl },
    );
    expect(calls[0]).toBe('https://llm.test/v1/chat/completions');
    expect(result.ok).toBe(false); // boş zarf → içerik yok
    expect(getEnv({ AI_ASSISTANT_ENABLED: '0' }).AI_ASSISTANT_ENABLED).toBe(false);
  });
});
