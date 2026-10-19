/**
 * Öneri orkestratörü: aday seçimi → istem → model → DOĞRULAMA → sonuç.
 *
 * Güvenlik ilkeleri:
 *  - Model çıktısı zod ile doğrulanır; kimlik yalnızca aday kümesinden kabul edilir.
 *    Uydurma veya yabancı ilan kimlikleri atılır.
 *  - Model yanıt vermezse, zaman aşımına uğrarsa veya çıktı geçersizse deterministik
 *    sıralama (profil eşleştirmesi) gösterilir; kullanıcı boş ekranla kalmaz.
 *  - Günlük kota aşılırsa model çağrılmaz; yine deterministik sonuç gösterilir.
 *  - Önbellek (bellek içi, ~20 dk) aynı profil ve aynı aday kümesi için model
 *    çağrısını tekrarlamaz. Kalıcı saklanmaz.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uniquePreserve } from '../domain/text';
import type { Repos } from '../db/repos';
import type { JobDoc, NotificationPreferenceDoc } from '../db/schemas';
import { EMPLOYMENT_TYPE_LABELS } from '../domain/types';
import { callChatCompletion, type LlmConfig, type LlmFetch } from './llm';
import { LlmBudget } from './budget';
import { buildMessages } from './prompt';
import { selectCandidates, type JobCandidate } from './candidates';

export const SUGGESTION_CACHE_MS = 20 * 60_000;
export const DAILY_WINDOW_SECONDS = 24 * 3_600;
const MAX_SUGGESTIONS = 6;
const FIT_ORDER = { strong: 0, possible: 1, weak: 2 } as const;

export type SuggestionFit = keyof typeof FIT_ORDER;

export interface SuggestionItem {
  jobId: string;
  title: string;
  institution: string;
  city: string | null;
  employmentTypeLabel: string;
  applicationEndDate: string | null;
  status: JobDoc['status'];
  fit: SuggestionFit;
  reasons: string[];
  caveats: string[];
}

export interface SuggestionResult {
  mode: 'ai' | 'profile-fallback' | 'none';
  generatedAt: string;
  candidateCount: number;
  suggestions: SuggestionItem[];
  notice: string | null;
  cached: boolean;
}

// Model çıktısı şeması (istemdeki JSON anahtarlarıyla birebir).
const modelOutputSchema = z.object({
  oneriler: z
    .array(
      z.object({
        jobId: z.string().min(1).max(64),
        uyum: z.enum(['guclu', 'olasi', 'zayif']),
        gerekceler: z.array(z.string().trim().min(3).max(260)).min(1).max(3),
        uyarilar: z.array(z.string().trim().max(260)).max(2).default([]),
      }),
    )
    .max(10),
});

const FIT_FROM_MODEL: Record<'guclu' | 'olasi' | 'zayif', SuggestionFit> = {
  guclu: 'strong',
  olasi: 'possible',
  zayif: 'weak',
};

function fitFromSignal(signal: JobCandidate['match']['signal']): SuggestionFit {
  if (signal === 'high') return 'strong';
  if (signal === 'medium') return 'possible';
  return 'weak';
}

/**
 * Modelin verdiği uyum derecesi, DETERMİNİSTİK ön eleme sinyalinin üstüne
 * çıkamaz. Neden: öneri bir "ön eleme"dir ve kesin uygunluk kural motorunun
 * bulduğu kanıta dayanır. Aksi halde model, kural motorunun "uyuşmuyor"
 * dediği bir ilan için "Güçlü uyum" yazabilir ve kullanıcı bunu doğrulanmış
 * bir karar sanabilirdi.
 */
export function capFitBySignal(
  modelFit: SuggestionFit,
  signal: JobCandidate['match']['signal'],
): SuggestionFit {
  const cap: Record<JobCandidate['match']['signal'], SuggestionFit> = {
    high: 'strong',
    medium: 'possible',
    low: 'weak',
    unknown: 'weak',
  };
  const allowed = cap[signal] ?? 'weak';
  // FIT_ORDER'da küçük değer daha güçlü uyumdur: model ancak ön eleme
  // sinyalinin izin verdiği dereceye kadar iddia edebilir.
  return FIT_ORDER[modelFit] >= FIT_ORDER[allowed] ? modelFit : allowed;
}

function baseItem(candidate: JobCandidate): Omit<SuggestionItem, 'fit' | 'reasons' | 'caveats'> {
  const { job, summary } = candidate;
  return {
    jobId: job.id,
    title: summary.title,
    institution: summary.institution,
    city: summary.city ?? null,
    employmentTypeLabel: EMPLOYMENT_TYPE_LABELS[job.employmentType] ?? job.employmentType,
    applicationEndDate: job.applicationEndDate ?? null,
    status: job.status,
  };
}

/** Yapay zekâ kullanılamadığında: kural tabanlı sıralama (aynı biçimde). */
export function deterministicSuggestions(candidates: JobCandidate[]): SuggestionItem[] {
  return candidates.slice(0, MAX_SUGGESTIONS).map((candidate) => ({
    ...baseItem(candidate),
    fit: fitFromSignal(candidate.match.signal),
    reasons:
      candidate.match.reasons.slice(0, 3).length > 0
        ? candidate.match.reasons.slice(0, 3)
        : ['Profilinizdeki bilgiler ilan metniyle sınırlı örtüşüyor.'],
    caveats: candidate.match.caveats.slice(0, 2),
  }));
}

/** Model yanıtını ayrıştırır ve yalnızca aday kümesindeki kimlikleri kabul eder. */
export function parseModelSuggestions(
  content: string,
  candidateIds: ReadonlySet<string>,
): {
  items: { jobId: string; fit: SuggestionFit; reasons: string[]; caveats: string[] }[];
  rejected: number;
} | null {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch {
    return null;
  }
  const parsed = modelOutputSchema.safeParse(json);
  if (!parsed.success) return null;

  const seen = new Set<string>();
  const items: { jobId: string; fit: SuggestionFit; reasons: string[]; caveats: string[] }[] = [];
  let rejected = 0;
  for (const entry of parsed.data.oneriler) {
    if (!candidateIds.has(entry.jobId) || seen.has(entry.jobId)) {
      rejected += 1;
      continue;
    }
    seen.add(entry.jobId);
    items.push({
      jobId: entry.jobId,
      fit: FIT_FROM_MODEL[entry.uyum],
      reasons: entry.gerekceler,
      caveats: entry.uyarilar.filter((value) => value.length > 0),
    });
  }
  return { items: items.slice(0, MAX_SUGGESTIONS), rejected };
}

// ---------------------------------------------------------------- önbellek

const cache = new Map<string, { at: number; userId: string; result: SuggestionResult }>();

export function clearSuggestionCache(userId: string): void {
  for (const [key, entry] of cache) {
    if (entry.userId === userId) cache.delete(key);
  }
}

export function resetSuggestionCache(): void {
  cache.clear();
}

function cacheKey(userId: string, preference: NotificationPreferenceDoc, candidates: JobCandidate[]): string {
  const material = JSON.stringify({
    profile: preference.candidateProfile,
    candidates: candidates.map((candidate) => candidate.job.id).sort(),
  });
  return `${userId}:${createHash('sha256').update(material).digest('hex').slice(0, 40)}`;
}

// ------------------------------------------------------------- ana akış

export interface GenerateOptions {
  repos: Repos;
  userId: string;
  preference: NotificationPreferenceDoc;
  now: Date;
  llm: LlmConfig | null;
  dailyLimit: number;
  /** Shared, worker-safe application budget. Route supplies the validated Env policy. */
  budget?: LlmBudget;
  globalDailyLimit?: number;
  fetchImpl?: LlmFetch;
}

export interface GenerateOutcome {
  result: SuggestionResult;
  /** Bugün kalan model çağrısı hakkı (kota bilgisi). */
  remainingToday: number;
  /** Yalnızca denetim için: model çağrısı gerçekten yapıldı mı. */
  modelCalled: boolean;
}

export async function generateSuggestions(options: GenerateOptions): Promise<GenerateOutcome> {
  const { repos, userId, preference, now } = options;
  const profile = preference.candidateProfile;
  const candidates = await selectCandidates(repos, profile, now);
  const generatedAt = now.toISOString();

  if (candidates.length === 0) {
    const used = await repos.rateLimits.peek(`ai-daily:${userId}`, DAILY_WINDOW_SECONDS);
    return {
      result: {
        mode: 'none',
        generatedAt,
        candidateCount: 0,
        suggestions: [],
        notice:
          'Profilinize uyan açık bir ilan bulunamadı. Profilinizi genişletmeyi veya daha sonra tekrar denemeyi deneyin.',
        cached: false,
      },
      remainingToday: Math.max(0, options.dailyLimit - used),
      modelCalled: false,
    };
  }

  const key = cacheKey(userId, preference, candidates);
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < SUGGESTION_CACHE_MS) {
    const used = await repos.rateLimits.peek(`ai-daily:${userId}`, DAILY_WINDOW_SECONDS);
    return {
      result: { ...hit.result, cached: true },
      remainingToday: Math.max(0, options.dailyLimit - used),
      modelCalled: false,
    };
  }

  const fallback = (notice: string, used: number, modelCalled = false): GenerateOutcome => ({
    result: {
      mode: 'profile-fallback',
      generatedAt,
      candidateCount: candidates.length,
      suggestions: deterministicSuggestions(candidates),
      notice,
      cached: false,
    },
    remainingToday: Math.max(0, options.dailyLimit - used),
    modelCalled,
  });

  if (!options.llm) {
    // Kota bilgisi yanlış raporlanmasın: kullanılmış çağrılar okunur.
    const used = await repos.rateLimits.peek(`ai-daily:${userId}`, DAILY_WINDOW_SECONDS);
    return fallback('Yapay zekâ hizmeti yapılandırılmadığı için profil eşleştirmesi gösteriliyor.', used);
  }

  // Kullanıcı kotası, bütün worker'larda atomik rezerve edilir. Önce salt-okunur
  // bir ön kontrol yapılır: global bütçe reddederse kullanıcının günlük hakkı
  // BOŞA HARCANMAMALIDIR. Asıl atomik rezervasyon bütçe kapısından SONRA yapılır.
  const usedBefore = await repos.rateLimits.peek(`ai-daily:${userId}`, DAILY_WINDOW_SECONDS);
  if (usedBefore >= options.dailyLimit) {
    return fallback(
      'Bugünkü yapay zekâ öneri hakkınız doldu. Aşağıda profil eşleştirmesine göre sıralanmış öneriler var.',
      usedBefore,
    );
  }
  const messages = buildMessages(profile, candidates);
  const budget =
    options.budget ??
    new LlmBudget(repos, {
      dailyCallLimit: options.globalDailyLimit ?? 400,
      maxCallsPerRun: 1,
      dailyCostLimitUsd: null,
      runCostLimitUsd: null,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      additionalDailyCallBucket: 'llm-assistant-daily',
    });
  const reservation = await budget.reserve(messages, 1_200);
  if (!reservation.allowed) {
    return fallback(
      'Yapay zekâ öneri bütçesi/kotası dolu veya güvenli biçimde doğrulanamadı. Profil eşleştirmesi gösteriliyor.',
      usedBefore,
    );
  }

  // Bütçe ayrıldıktan sonra kullanıcı kotası atomik olarak rezerve edilir.
  // Eşzamanlı iki istekten yalnızca biri geçer; kaybeden istek model çağırmaz.
  // Bu nadir yarışta global bütçeden bir çağrılık rezervasyon boşa gidebilir;
  // kullanıcı kotası asla boşa harcanmaz (fail-closed, kullanıcı lehine).
  const usage = await repos.rateLimits.reserve(
    `ai-daily:${userId}`,
    DAILY_WINDOW_SECONDS,
    1,
    options.dailyLimit,
  );
  if (!usage.allowed) {
    return fallback(
      'Bugünkü yapay zekâ öneri hakkınız doldu. Aşağıda profil eşleştirmesine göre sıralanmış öneriler var.',
      options.dailyLimit,
    );
  }
  const remainingToday = Math.max(0, options.dailyLimit - usage.count);

  const llmResult = await callChatCompletion(
    options.llm,
    messages,
    { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), maxTokens: 1_200 },
  );
  if (!llmResult.ok) {
    return fallback(
      `Yapay zekâ yanıtı alınamadı (${llmResult.reason}). Profil eşleştirmesi gösteriliyor.`,
      usage.count,
      true,
    );
  }

  const parsed = parseModelSuggestions(llmResult.content, new Set(candidates.map((c) => c.job.id)));
  // Biçimi bozuk ya da yalnızca aday dışı kimlik içeren yanıt güvenilmez: yedek gösterilir.
  if (!parsed || (parsed.items.length === 0 && parsed.rejected > 0)) {
    return fallback('Yapay zekâ yanıtı doğrulanamadı. Profil eşleştirmesi gösteriliyor.', usage.count, true);
  }
  if (parsed.items.length === 0) {
    // Model geçerli biçimde "belirgin uyum yok" dedi: bu bir sonuçtur, yedekle ezilmez.
    const emptyResult: SuggestionResult = {
      mode: 'ai',
      generatedAt,
      candidateCount: candidates.length,
      suggestions: [],
      notice: 'Yapay zekâ bu adaylar arasında profilinizle belirgin bir uyum görmedi.',
      cached: false,
    };
    cache.set(key, { at: now.getTime(), userId, result: emptyResult });
    return { result: emptyResult, remainingToday, modelCalled: true };
  }

  const byId = new Map(candidates.map((candidate) => [candidate.job.id, candidate]));
  const suggestions = parsed.items
    .map((item) => {
      const candidate = byId.get(item.jobId);
      if (!candidate) return null;
      const fit = capFitBySignal(item.fit, candidate.match.signal);
      const capped = fit !== item.fit;
      return {
        ...baseItem(candidate),
        fit,
        // Model gerekçeleri korunur; kural motorunun kanıta dayalı gerekçeleri
        // (ve uyarıları) HER ZAMAN eklenir — model bunları gizleyemez.
        reasons: uniquePreserve([...item.reasons, ...candidate.match.reasons.slice(0, 2)]).slice(0, 4),
        caveats: uniquePreserve([
          ...item.caveats,
          ...(capped
            ? [
                'Model bu ilan için daha yüksek uyum belirtmişti; gösterilen derece kural tabanlı ön eleme sinyaliyle sınırlandırıldı.',
              ]
            : []),
          ...candidate.match.caveats.slice(0, 2),
        ]).slice(0, 4),
      };
    })
    .filter((item): item is SuggestionItem => item !== null)
    .sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit]);

  const result: SuggestionResult = {
    mode: 'ai',
    generatedAt,
    candidateCount: candidates.length,
    suggestions,
    notice: null,
    cached: false,
  };
  cache.set(key, { at: now.getTime(), userId, result });
  return { result, remainingToday, modelCalled: true };
}
