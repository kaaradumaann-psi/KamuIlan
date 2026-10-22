/**
 * LLM model zinciri (Groq biçimi, OpenAI uyumlu uç) — SAHTE SAĞLAYICI (mock), ağ yok.
 *
 * Kurallar: kota (429) / geçici hata / erişilemeyen model → sıradaki model; günlük kota
 * kanıtlanınca model süreç boyunca atlanır; 401/403 ve diğer 400'lerde zincir DURUR (hata
 * gizlenmez); hepsi başarısızsa kayıt incelemede kalır (otomatik onay yok). Hata gövdesi biçimi
 * Groq hata zarfıdır (`{"error":{"message","type","code"}}`); mesaj metinleri temsilîdir.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { LlmAnalysisDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { getEnv, type Env } from '../src/config/env';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import type { ClassificationResult } from '../src/domain/types';
import {
  createLlmClassificationGate,
  listUnavailableLlmModels,
  llmClassifierConfig,
  type LlmGateInput,
} from '../src/ai/classifier';
import { parseDurationMs, readRateLimitInfo, redactSecret, type LlmFetch } from '../src/ai/llm';

const GROQ = 'https://api.groq.com/openai/v1';
const API_KEY = 'gsk_mockGizliAnahtar0123456789abcdef';
const [M1, M2, M3] = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b'] as const;
const LOGGER = createLogger('llm-model-gecisi', { level: 'silent' });
const NOW = new Date('2026-10-23T09:00:00+03:00');

const REVIEW_BASE: ClassificationResult = {
  decision: 'review',
  kind: 'job',
  employmentType: 'belirsiz',
  confidence: 0.5,
  reasons: ['Başlıkta personel alımı ifadesi yok; inceleme gerekir'],
  rules: [],
  negativeSignals: [],
  version: CLASSIFICATION_VERSION,
  contentType: 'uncertain',
};
const BODY =
  'Kurumumuz merkez teşkilatında istihdam edilmek üzere 5 (beş) sözleşmeli personel alımı yapılacaktır. ' +
  'Başvurular 01.11.2026 - 15.11.2026 tarihleri arasında e-Devlet üzerinden alınacaktır. ' +
  'Adayların lisans mezunu olması ve KPSS P3 puan türünden en az 70 puan almış olması gerekmektedir.';
const ILAN = JSON.stringify({
  karar: 'ilan',
  icerikTuru: 'personnel_recruitment',
  istihdamTuru: 'sozlesmeli',
  guven: 0.9,
  ozet: 'Sözleşmeli personel alımı duyuruluyor.',
  kanitlar: { alimIfadesi: 'sözleşmeli personel alımı yapılacaktır' },
});

const input = (): LlmGateInput => ({
  title: 'Önemli Duyuru',
  body: BODY,
  bodyTextSource: 'detail',
  sourceCategory: null,
  sourceKey: 'groq-kaynak',
  url: 'https://ornek.test/duyuru/1',
  base: REVIEW_BASE,
});

function envFor(overrides: Record<string, string> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: GROQ,
    LLM_API_KEY: API_KEY,
    LLM_CLASSIFIER_MODEL: M1,
    LLM_CLASSIFIER_FALLBACK_MODELS: `${M2}, ${M3}`,
    LLM_MAX_CALLS_PER_RUN: '20',
    LLM_DAILY_CALL_LIMIT: '100',
    LLM_RETRY_MAX: '1',
    LLM_MAX_CONCURRENCY: '1',
    ...overrides,
  } as never);
}

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-model-gecisi-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

type Reply = { status: number; body: string; headers?: Record<string, string> };
const ok = (content = ILAN): Reply => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 40 } }),
  headers: { 'x-ratelimit-remaining-requests': '998', 'x-ratelimit-reset-tokens': '7.66s' },
});
const groqError = (status: number, message: string, code: string, headers: Record<string, string> = {}): Reply => ({
  status,
  body: JSON.stringify({ error: { message, type: status === 429 ? 'requests' : 'invalid_request_error', code } }),
  headers,
});
const DAILY_429 = groqError(
  429,
  'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_01abcdefghijk` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s.',
  'rate_limit_exceeded',
  { 'retry-after': '87', 'x-ratelimit-remaining-requests': '0' },
);
const MINUTE_429 = groqError(
  429,
  'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 600. Please try again in 1.2s.',
  'rate_limit_exceeded',
  { 'retry-after': '0', 'x-ratelimit-remaining-tokens': '100' },
);

/** Modele göre yanıt veren sahte uç; her modelin çağrı sayısını tutar. */
function provider(replies: Partial<Record<string, Reply[] | Reply>>) {
  const calls: Record<string, number> = {};
  const fetchImpl: LlmFetch = async (_url, init) => {
    const model = (JSON.parse(init.body) as { model: string }).model;
    const n = (calls[model] = (calls[model] ?? 0) + 1);
    const entry = replies[model];
    const reply = Array.isArray(entry) ? (entry[Math.min(n, entry.length) - 1] as Reply) : entry;
    if (!reply) throw new Error(`beklenmeyen model: ${model}`);
    return { status: reply.status, headers: reply.headers ?? {}, text: async () => reply.body };
  };
  return { fetchImpl, calls };
}

async function run(replies: Partial<Record<string, Reply[] | Reply>>, overrides: Record<string, string> = {}) {
  const repos = await makeRepos();
  const { fetchImpl, calls } = provider(replies);
  const gate = createLlmClassificationGate({ repos, env: envFor(overrides), logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
  const outcome = await gate.evaluate(input());
  const rows: LlmAnalysisDoc[] = await repos.store.find('llmAnalyses', {});
  return { gate, outcome, calls, rows, repos, fetchImpl };
}

describe('llmClassifierConfig — yedek model listesi', () => {
  it('virgüllü listeyi sırayla, tekrarsız ve ana modeli çıkararak okur', () => {
    expect(llmClassifierConfig(envFor({ LLM_CLASSIFIER_FALLBACK_MODELS: ` ${M2},${M1},,${M2}, ${M3} ` }))?.fallbackModels).toEqual([M2, M3]);
    expect(llmClassifierConfig(envFor({ LLM_CLASSIFIER_FALLBACK_MODELS: '' }))?.fallbackModels).toEqual([]);
  });
});

describe('model zinciri (mock)', () => {
  it('günlük kota (429 RPD): ana model yeniden denenmez, yedek model kararı uygular, model süreç boyunca atlanır', async () => {
    const { outcome, calls, rows, repos, fetchImpl } = await run({ [M1]: DAILY_429, [M2]: ok() });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBe(1);
    expect(outcome.classification.decision).toBe('accept');
    expect(outcome.classification.llm?.model).toBe(M2);
    expect(rows.find((row) => row.status === 'ok')?.model).toBe(M2);
    expect(listUnavailableLlmModels().map((entry) => entry.model)).toEqual([M1]);

    // Aynı süreçte yeni kapı (sonraki tarama): kotası biten modele istek GİTMEZ. Farklı içerik → önbellek yok.
    const gate2 = createLlmClassificationGate({ repos, env: envFor(), logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
    await gate2.evaluate({ ...input(), body: `${BODY} Ek açıklama: kadro unvanı Mühendis.` });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBe(2);
  });

  it('dakikalık sınır (429 TPM): sınırlı yeniden deneme, sonra sıradaki model; model kara listeye alınmaz', async () => {
    const { outcome, calls } = await run({ [M1]: MINUTE_429, [M2]: ok() });
    expect(calls[M1]).toBe(2); // 1 + LLM_RETRY_MAX
    expect(outcome.classification.decision).toBe('accept');
    expect(listUnavailableLlmModels()).toEqual([]);
  });

  it('401 geçersiz anahtar: yedek modellere GEÇİLMEZ, hata gizlenmez, kayıt incelemede kalır', async () => {
    const { outcome, calls, rows } = await run({
      [M1]: groqError(401, 'Invalid API Key', 'invalid_api_key'),
      [M2]: ok(),
      [M3]: ok(),
    });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBeUndefined();
    expect(calls[M3]).toBeUndefined();
    expect(outcome.classification.decision).toBe('review');
    expect(outcome.opinion?.verdict).toBe('hata');
    expect(rows[0]?.error).toContain('HTTP 401');
    expect(rows[0]?.error).not.toContain(API_KEY);
  });

  it('403 de kota sayılmaz ve zinciri durdurur', async () => {
    const { calls, outcome } = await run({ [M1]: groqError(403, 'Forbidden', 'permission_denied'), [M2]: ok() });
    expect(calls[M2]).toBeUndefined();
    expect(outcome.classification.decision).toBe('review');
  });

  it('genel 400 (geçersiz istek) kota sayılmaz, yeniden denenmez, zinciri durdurur', async () => {
    const { calls, outcome } = await run({ [M1]: groqError(400, "'messages' must be an array", 'invalid_request_error'), [M2]: ok() });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBeUndefined();
    expect(outcome.classification.decision).toBe('review');
  });

  it('erişilemeyen model (404 model_not_found / 400 model_decommissioned) → sıradaki model, ilki atlanır', async () => {
    const notFound = await run({ [M1]: groqError(404, 'The model `openai/gpt-oss-20b` does not exist', 'model_not_found'), [M2]: ok() });
    expect(notFound.outcome.classification.decision).toBe('accept');
    expect(notFound.outcome.classification.llm?.model).toBe(M2);
    expect(listUnavailableLlmModels().map((entry) => entry.model)).toEqual([M1]);

    const decommissioned = await run({ [M2]: groqError(400, 'The model has been decommissioned', 'model_decommissioned'), [M3]: ok() });
    // M1 önceki testte atlandı (aynı süreç); M2 kaldırılmış → M3.
    expect(decommissioned.calls[M1]).toBeUndefined();
    expect(decommissioned.outcome.classification.llm?.model).toBe(M3);
  });

  it('5xx/zaman aşımı: her modelde sınırlı deneme; üç model de başarısız → incelemede kalır, onay YOK', async () => {
    const down = groqError(503, 'Service Unavailable', 'service_unavailable');
    const { outcome, calls, rows, gate } = await run({ [M1]: down, [M2]: down, [M3]: down });
    expect([calls[M1], calls[M2], calls[M3]]).toEqual([2, 2, 2]);
    expect(outcome.classification.decision).toBe('review');
    expect(outcome.opinion?.verdict).toBe('hata');
    expect(gate.summary().calls).toBe(6);
    expect(rows[0]?.error).toContain('model zinciri');
  });

  it('bütçe zinciri de kapsar: koşu sınırı dolunca yedek modele çağrı gitmez', async () => {
    const down = groqError(503, 'Service Unavailable', 'service_unavailable');
    const { calls, outcome } = await run({ [M1]: down, [M2]: ok() }, { LLM_MAX_CALLS_PER_RUN: '2' });
    expect(calls[M1]).toBe(2);
    expect(calls[M2]).toBeUndefined();
    expect(outcome.classification.decision).toBe('review');
  });

  it('HTTP 200 + bozuk JSON → aynı model yeniden denenmez, yedek model kararı uygular', async () => {
    const { outcome, calls, rows } = await run({ [M1]: ok('{"karar": "ilan", kanitlar'), [M2]: ok() });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBe(1);
    expect(outcome.classification.decision).toBe('accept');
    expect(outcome.classification.llm?.model).toBe(M2);
    expect(rows.map((row) => row.status)).toEqual(['ok']);
  });

  it('HTTP 200 + şemaya uymayan JSON da yedek modele geçer', async () => {
    const { outcome, calls } = await run({ [M1]: ok('{"karar":"evet","guven":2}'), [M2]: ok() });
    expect(calls[M1]).toBe(1);
    expect(outcome.classification.llm?.model).toBe(M2);
  });

  it('üç model de bozuk JSON → incelemede kalır, son model "invalid" kaydedilir, onay YOK', async () => {
    const bad = ok('düz metin, JSON yok');
    const { outcome, calls, rows } = await run({ [M1]: bad, [M2]: bad, [M3]: bad });
    expect([calls[M1], calls[M2], calls[M3]]).toEqual([1, 1, 1]);
    expect(outcome.classification.decision).toBe('review');
    expect(outcome.opinion?.verdict).toBe('dogrulanamadi');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('invalid');
    expect(rows[0]?.model).toBe(M3);
  });

  it('bozuk JSON sonrası bütçe biterse yedek modele gidilmez; kayıt "invalid" olarak incelemede kalır', async () => {
    const { outcome, calls, rows } = await run({ [M1]: ok('{bozuk'), [M2]: ok() }, { LLM_MAX_CALLS_PER_RUN: '1' });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBeUndefined();
    expect(outcome.classification.decision).toBe('review');
    expect(rows[0]?.status).toBe('invalid');
  });

  it('geçerli JSON ama kanıtı metinde yok (model yargısı) → yedek modele GEÇİLMEZ', async () => {
    const unbacked = JSON.stringify({ ...JSON.parse(ILAN), kanitlar: { alimIfadesi: 'metinde geçmeyen uydurma ifade' } });
    const { outcome, calls } = await run({ [M1]: ok(unbacked), [M2]: ok() });
    expect(calls[M1]).toBe(1);
    expect(calls[M2]).toBeUndefined();
    expect(outcome.classification.decision).toBe('review');
    expect(outcome.opinion?.verdict).toBe('dogrulanamadi');
  });

  it('yedek modelin doğrulanmış kararı önbellekten yeniden kullanılır (ikinci çağrı yok)', async () => {
    const { calls, repos, fetchImpl } = await run({ [M1]: MINUTE_429, [M2]: ok() });
    const gate2 = createLlmClassificationGate({ repos, env: envFor(), logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
    const again = await gate2.evaluate(input());
    expect(again.opinion?.cacheHit).toBe(true);
    expect(again.opinion?.model).toBe(M2);
    expect(calls[M2]).toBe(1);
  });
});

describe('hız sınırı başlıkları ve maskeleme', () => {
  it('Groq süre biçimleri', () => {
    expect(parseDurationMs('2m59.56s')).toBe(179_560);
    expect(parseDurationMs('7.66s')).toBe(7_660);
    expect(parseDurationMs('1h2m')).toBe(3_720_000);
    expect(parseDurationMs('120ms')).toBe(120);
    expect(parseDurationMs('87')).toBe(87_000);
    expect(parseDurationMs('yarın')).toBeNull();
  });

  it('başlıklar okunur; retry-after kırpılmaz (günlük bekleme gerçek süresiyle)', () => {
    expect(
      readRateLimitInfo({
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '2m59.56s',
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '7400',
        'x-ratelimit-reset-tokens': '4.5s',
        'retry-after': '87',
      }),
    ).toEqual({
      limitRequests: 1000,
      remainingRequests: 0,
      resetRequestsMs: 179_560,
      limitTokens: 8000,
      remainingTokens: 7400,
      resetTokensMs: 4_500,
      retryAfterMs: 87_000,
    });
    expect(readRateLimitInfo({})).toBeNull();
  });

  it('Groq anahtarı ve kuruluş kimliği maskelenir', () => {
    expect(redactSecret('key gsk_abcdefghijKLMNOP0123 org org_01abcdefghijk', '')).toBe('key *** org org_***');
  });
});
