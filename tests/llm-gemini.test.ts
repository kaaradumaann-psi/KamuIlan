/**
 * Gemini yerel API taşıyıcısı — 2026-10-16 kök neden düzeltmesinin kanıtı.
 *
 * Canlı kanıt (kullanıcı makinesi): aynı API anahtarıyla
 *   GET  /v1beta/openai/models            → 200 (gemini-2.5-flash listede VAR)
 *   POST /v1beta/openai/chat/completions  → 404
 * Yani anahtar ve model geçerli; Google'ın OpenAI uyumluluk KABUĞU bu anahtar/
 * bölge/model için sohbet ucunu sunmuyor. Sonuç: kapıdaki her çağrı hata verdi
 * (panel: 2 çağrı / 2 hata / %100 hata oranı / 0 token) ve inceleme kuyruğundaki
 * tüm belirsiz kayıtlar "model denetimine ulaşılamadı" gerekçesiyle insana kaldı.
 *
 * Düzeltme: Google kökü artık birincil API'ye (`POST {kök}/models/{model}:generateContent`,
 * `x-goog-api-key` başlığı) yönlendirilir. Bu dosya şunları kilitler:
 *  1. Gemini başarılı yanıtı (içerik + token kullanımı)
 *  2. HTTP 400 / 401 / 403 / 404 / 429 sınıflandırması ve yeniden deneme politikası
 *  3. Geçersiz JSON ve boş içerik (finishReason/blockReason gerekçesiyle)
 *  4. Token kullanımının LlmUsage'a doğru aktarılması
 *  5. JSON modu (generationConfig.responseMimeType)
 *  6. Zaman aşımı ve ağ hatası
 *  7. Diğer sağlayıcılar için geriye dönük uyumluluk (OpenAI uyumlu gövde DEĞİŞMEZ)
 *  8. Başarısız çağrının inceleme kuyruğunda doğru işlenmesi + başarılı çağrının
 *     review → accept yükseltmesi (kapı Gemini taşıyıcısıyla gerçekten çalışıyor)
 *
 * Sır politikası: API anahtarı ne URL'de ne hata metninde ne de telemetride görünür.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildGeminiRequestBody,
  callChatCompletion,
  chatCompletionsEndpoint,
  describeTransport,
  normalizeGeminiModel,
  parseGeminiResponse,
  providerErrorMessage,
  redactSecret,
  resolveLlmEndpoint,
  type LlmConfig,
  type LlmFetch,
} from '../src/ai/llm';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { LlmAnalysisDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { getEnv, type Env } from '../src/config/env';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import type { ClassificationResult } from '../src/domain/types';
import { createLlmClassificationGate, type LlmGateInput } from '../src/ai/classifier';

const API_KEY = 'AIzaSy-mock-gizli-anahtar-0123456789';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LOGGER = createLogger('llm-gemini-test', { level: 'silent' });
const NOW = new Date('2026-10-16T09:00:00+03:00');

const config: LlmConfig = { baseUrl: GOOGLE_BASE, apiKey: API_KEY, model: 'gemini-2.5-flash', timeoutMs: 5_000 };

/** Gemini biçiminde başarılı yanıt gövdesi. */
function geminiReply(text: string, usage = { promptTokenCount: 120, candidatesTokenCount: 60, totalTokenCount: 180 }) {
  return JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: usage,
    modelVersion: 'gemini-2.5-flash',
  });
}

/** İstekleri yakalayan sahte fetch. */
function recorder(reply: { status: number; body: string } | Error): {
  fetch: LlmFetch;
  seen: { url: string; headers: Record<string, string>; body: string }[];
} {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: LlmFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    if (reply instanceof Error) throw reply;
    return { status: reply.status, text: async () => reply.body };
  };
  return { fetch: fetchImpl, seen };
}

/* ---------------------------------------------------------------------------
 * 1) Taşıyıcı seçimi ve uç kurulumu
 * ------------------------------------------------------------------------- */

describe('resolveLlmEndpoint — taşıyıcı seçimi', () => {
  it('Google kökü yerel generateContent ucuna yönlendirilir', () => {
    const endpoint = resolveLlmEndpoint({ baseUrl: GOOGLE_BASE, model: 'gemini-2.5-flash' });
    expect(endpoint.transport).toBe('gemini-native');
    expect(endpoint.url).toBe(`${GOOGLE_BASE}/models/gemini-2.5-flash:generateContent`);
    expect(endpoint.authHeader).toBe('x-goog-api-key');
    expect(endpoint.supportsJsonMode).toBe(true);
  });

  it('OpenAI kabuğu (/v1beta/openai) yazılmışsa da yerel API kullanılır', () => {
    const endpoint = resolveLlmEndpoint({ baseUrl: `${GOOGLE_BASE}/openai`, model: 'gemini-2.5-flash' });
    expect(endpoint.transport).toBe('gemini-native');
    expect(endpoint.url).toBe(`${GOOGLE_BASE}/models/gemini-2.5-flash:generateContent`);
  });

  it('yerel :generateContent yolu yapıştırılmışsa sürüm köküne indirgenir', () => {
    const endpoint = resolveLlmEndpoint({
      baseUrl: `${GOOGLE_BASE}/models/gemini-2.5-flash:generateContent`,
      model: 'gemini-2.5-flash',
    });
    expect(endpoint.url).toBe(`${GOOGLE_BASE}/models/gemini-2.5-flash:generateContent`);
  });

  it('model kimliği normalize edilir (models/ ve google/ önekleri atılır)', () => {
    expect(normalizeGeminiModel('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(normalizeGeminiModel('google/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(normalizeGeminiModel('  gemini-2.5-flash  ')).toBe('gemini-2.5-flash');
    const endpoint = resolveLlmEndpoint({ baseUrl: GOOGLE_BASE, model: 'models/gemini-2.5-flash' });
    expect(endpoint.url).toBe(`${GOOGLE_BASE}/models/gemini-2.5-flash:generateContent`);
  });

  it('diğer sağlayıcılar OpenAI uyumlu uçta kalır (davranış DEĞİŞMEZ)', () => {
    const cases: [string, string][] = [
      ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
      ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
      ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
      ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/chat/completions'],
    ];
    for (const [baseUrl, expected] of cases) {
      const endpoint = resolveLlmEndpoint({ baseUrl, model: 'test-model' });
      expect(endpoint.transport, baseUrl).toBe('openai-compat');
      expect(endpoint.url, baseUrl).toBe(expected);
      expect(endpoint.authHeader, baseUrl).toBe('authorization');
      expect(endpoint.model, baseUrl).toBe('test-model'); // model adı compat yolda olduğu gibi gider
    }
  });

  it('taşıyıcı bayrakla zorlanabilir (tanı aracı karşılaştırması)', () => {
    const forced = resolveLlmEndpoint({ baseUrl: GOOGLE_BASE, model: 'gemini-2.5-flash' }, { transport: 'openai-compat' });
    expect(forced.transport).toBe('openai-compat');
    expect(forced.url).toBe(`${GOOGLE_BASE}/openai/chat/completions`);
    expect(chatCompletionsEndpoint(GOOGLE_BASE)).toBe(`${GOOGLE_BASE}/openai/chat/completions`);
    const native = resolveLlmEndpoint({ baseUrl: 'https://llm.test/v1', model: 'x' }, { transport: 'gemini-native' });
    expect(native.url).toBe('https://llm.test/v1/models/x:generateContent');
  });

  it('taşıyıcı adı insan okunur raporlanır', () => {
    expect(describeTransport('gemini-native')).toContain('generateContent');
    expect(describeTransport('openai-compat')).toContain('OpenAI');
  });
});

/* ---------------------------------------------------------------------------
 * 2) İstek gövdesi dönüşümü
 * ------------------------------------------------------------------------- */

describe('buildGeminiRequestBody — mesaj dönüşümü', () => {
  it('sistem mesajı systemInstruction olur, roller doğru eşlenir', () => {
    const body = buildGeminiRequestBody([
      { role: 'system', content: 'Sen bir sınıflandırıcısın.' },
      { role: 'user', content: 'Bu bir ilan mı?' },
      { role: 'assistant', content: 'Hayır.' },
      { role: 'user', content: 'Neden?' },
    ]);

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Sen bir sınıflandırıcısın.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Bu bir ilan mı?' }] },
      { role: 'model', parts: [{ text: 'Hayır.' }] },
      { role: 'user', parts: [{ text: 'Neden?' }] },
    ]);
  });

  it('ardışık aynı rol tek içerikte birleştirilir (Gemini 400 vermesin)', () => {
    const body = buildGeminiRequestBody([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
    ]);

    expect(body.systemInstruction?.parts).toEqual([{ text: 'A' }, { text: 'B' }]);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '1' }, { text: '2' }] }]);
  });

  it('JSON modu responseMimeType ile istenir; sıcaklık ve token sınırı aktarılır', () => {
    const body = buildGeminiRequestBody([{ role: 'user', content: 'x' }], {
      temperature: 0.1,
      maxTokens: 900,
      jsonMode: true,
    });

    expect(body.generationConfig).toEqual({ temperature: 0.1, maxOutputTokens: 900, responseMimeType: 'application/json' });
  });

  it('JSON modu istenmediğinde responseMimeType gönderilmez', () => {
    const body = buildGeminiRequestBody([{ role: 'user', content: 'x' }], { temperature: 0.2, maxTokens: 8 });
    expect(body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 8 });
  });
});

/* ---------------------------------------------------------------------------
 * 3) Yanıt dönüşümü
 * ------------------------------------------------------------------------- */

describe('parseGeminiResponse', () => {
  it('çok parçalı metni birleştirir ve token kullanımını aktarır', () => {
    const parsed = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: '{"karar":' }, { text: '"ilan"}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 45, totalTokenCount: 366 },
    });

    expect(parsed.content).toBe('{"karar":"ilan"}');
    expect(parsed.failure).toBeNull();
    expect(parsed.usage).toEqual({ promptTokens: 321, completionTokens: 45 });
  });

  it('candidatesTokenCount yoksa toplam token yedek olarak kullanılır', () => {
    const parsed = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'tamam' }] } }],
      usageMetadata: { promptTokenCount: 10, totalTokenCount: 14 },
    });
    expect(parsed.usage).toEqual({ promptTokens: 10, completionTokens: 14 });
  });

  it('boş içerik finishReason ile gerekçelendirilir (sessiz boş dönüş yok)', () => {
    const parsed = parseGeminiResponse({
      candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS', finishMessage: 'Token limit reached.' }],
      usageMetadata: { promptTokenCount: 5 },
    });
    expect(parsed.content).toBeNull();
    expect(parsed.failure).toContain('MAX_TOKENS');
    expect(parsed.failure).toContain('Token limit reached.');
  });

  it('güvenlik engeli blockReason ile raporlanır', () => {
    const parsed = parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
    expect(parsed.content).toBeNull();
    expect(parsed.failure).toContain('SAFETY');
  });

  it('hiç aday yoksa içerik yok sayılır', () => {
    const parsed = parseGeminiResponse({});
    expect(parsed.content).toBeNull();
    expect(parsed.failure).toMatch(/içerik yok/);
  });
});

describe('providerErrorMessage', () => {
  it('sağlayıcının kendi mesajını kısaltarak çıkarır ve anahtarı ayıklar', () => {
    const raw = JSON.stringify({ error: { code: 404, message: `models/x is not found for key ${API_KEY}`, status: 'NOT_FOUND' } });
    const message = providerErrorMessage(raw, API_KEY);
    expect(message).toContain('is not found');
    expect(message).not.toContain(API_KEY);
    expect(message).toContain('***');
  });

  it('JSON olmayan gövde için mesaj üretmez', () => {
    expect(providerErrorMessage('<html>404</html>', API_KEY)).toBeNull();
    expect(providerErrorMessage('', API_KEY)).toBeNull();
  });

  it('redactSecret anahtarı her biçimde ayıklar', () => {
    expect(redactSecret(`hata ${API_KEY} oldu`, API_KEY)).not.toContain(API_KEY);
  });
});

/* ---------------------------------------------------------------------------
 * 4) Uçtan uca çağrı (sahte fetch): başarı, hatalar, zaman aşımı
 * ------------------------------------------------------------------------- */

describe('callChatCompletion — gemini-native', () => {
  const messages = [
    { role: 'system', content: 'Yalnızca JSON yanıt ver.' },
    { role: 'user', content: 'Bu bir personel alım ilanı mı?' },
  ];

  it('başarılı yanıtta içerik, durum ve token kullanımı döner; anahtar URLde görünmez', async () => {
    const { fetch, seen } = recorder({ status: 200, body: geminiReply('{"karar":"ilan"}') });

    const result = await callChatCompletion(config, messages, { fetchImpl: fetch, temperature: 0.1, maxTokens: 900, jsonMode: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('{"karar":"ilan"}');
    expect(result.status).toBe(200);
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 60 });

    const request = seen[0]!;
    expect(request.url).toBe(`${GOOGLE_BASE}/models/gemini-2.5-flash:generateContent`);
    expect(request.url).not.toContain(API_KEY); // anahtar sorguda taşınmaz
    expect(request.headers['x-goog-api-key']).toBe(API_KEY);
    expect(request.headers.authorization).toBeUndefined();
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.systemInstruction).toBeTruthy();
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Bu bir personel alım ilanı mı?' }] }]);
    expect(body.generationConfig).toEqual({ temperature: 0.1, maxOutputTokens: 900, responseMimeType: 'application/json' });
    // OpenAI'ye özgü alanlar yerel API'ye sızmaz.
    expect(body.messages).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it.each([
    [400, false, /Gemini biçimiyle uyumsuz/],
    [401, false, /API anahtarı/],
    [403, false, /API anahtarı/],
    [404, false, /Model adı ya da API sürümü/],
    [429, true, /hız\/kota/],
    [503, true, ''],
  ])('HTTP %i doğru sınıflandırılır (retryable=%s)', async (status, retryable, hint) => {
    const providerText = JSON.stringify({
      error: { code: status, message: `sağlayıcı mesajı ${status}`, status: 'FAILED' },
    });
    const { fetch, seen } = recorder({ status, body: providerText });

    const result = await callChatCompletion(config, messages, { fetchImpl: fetch });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(status);
    expect(result.retryable).toBe(retryable);
    // Sağlayıcının KENDİ mesajı gerekçeye girer: 404'ün nedeni ayırt edilebilir.
    expect(result.reason).toContain(`sağlayıcı mesajı ${status}`);
    expect(result.reason).toContain(`HTTP ${status}`);
    expect(result.reason).toContain('Gemini yerel API');
    if (hint) expect(result.reason).toMatch(hint as RegExp);
    expect(result.reason).not.toContain(API_KEY);
    expect(seen[0]!.url).toContain(':generateContent');
  });

  it('404 gerekçesi karşılaştırma komutunu da söyler', async () => {
    const { fetch } = recorder({
      status: 404,
      body: JSON.stringify({ error: { code: 404, message: 'models/gemini-2.5-flash is not found for API version v1beta, or is not supported by generateContent.' } }),
    });

    const result = await callChatCompletion(config, messages, { fetchImpl: fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('is not supported by generateContent');
    expect(result.reason).toContain('llm:doctor -- --compat');
  });

  it('geçersiz JSON ve boş içerik açık hata olur', async () => {
    const notJson = recorder({ status: 200, body: '<html>200 ama JSON değil</html>' });
    const first = await callChatCompletion(config, messages, { fetchImpl: notJson.fetch });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toMatch(/JSON değil/);

    const empty = recorder({ status: 200, body: geminiReply('   ') });
    const second = await callChatCompletion(config, messages, { fetchImpl: empty.fetch });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/içerik yok/);
  });

  it('zaman aşımı iptal eder ve geçici hata sayılır', async () => {
    const fetchImpl: LlmFetch = (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const started = Date.now();
    const result = await callChatCompletion({ ...config, timeoutMs: 60 }, messages, { fetchImpl });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.timedOut).toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.reason).toMatch(/Zaman aşımı/);
  });

  it('ağ hatası geçici sayılır ve anahtar sızdırmaz', async () => {
    const { fetch } = recorder(new Error(`fetch failed for ${API_KEY}`));
    const result = await callChatCompletion(config, messages, { fetchImpl: fetch });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.status).toBeNull();
    expect(result.reason).toMatch(/ulaşılamadı/);
    expect(result.reason).not.toContain(API_KEY);
  });

  it('model adı boşsa istek atılmadan açık hata verilir', async () => {
    const { fetch, seen } = recorder({ status: 200, body: geminiReply('x') });
    const result = await callChatCompletion({ ...config, model: '' }, messages, { fetchImpl: fetch });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Model adı boş/);
    expect(seen).toHaveLength(0);
  });

  it('yalnızca sistem mesajı varsa istek atılmaz (Gemini contents boş olamaz)', async () => {
    const { fetch, seen } = recorder({ status: 200, body: geminiReply('x') });
    const result = await callChatCompletion(config, [{ role: 'system', content: 'tek başına sistem' }], { fetchImpl: fetch });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/model mesajı yok/);
    expect(seen).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * 5) Geriye dönük uyumluluk: OpenAI uyumlu sağlayıcılar DEĞİŞMEDİ
 * ------------------------------------------------------------------------- */

describe('callChatCompletion — openai-compat geriye dönük uyumluluk', () => {
  const other: LlmConfig = { baseUrl: 'https://llm.test/v1', apiKey: 'sk-test', model: 'llama-3.3-70b', timeoutMs: 5_000 };

  it('istek gövdesi ve başlıkları eski biçimde gider', async () => {
    const { fetch, seen } = recorder({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'merhaba' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    });

    const result = await callChatCompletion(other, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], {
      fetchImpl: fetch,
      temperature: 0.2,
      maxTokens: 1200,
      jsonMode: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('merhaba');
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3 });

    const request = seen[0]!;
    expect(request.url).toBe('https://llm.test/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer sk-test');
    expect(request.headers['x-goog-api-key']).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      model: 'llama-3.3-70b',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });
  });

  it('OpenAI uyumlu hata gövdesi de gerekçeye alınır', async () => {
    const { fetch } = recorder({ status: 404, body: JSON.stringify({ error: { message: 'model not found' } }) });
    const result = await callChatCompletion(other, [{ role: 'user', content: 'x' }], { fetchImpl: fetch });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('model not found');
    expect(result.reason).toContain('OpenAI uyumlu uç');
  });
});

/* ---------------------------------------------------------------------------
 * 6) Gerçek soket: Google biçiminde yerel mock sunucu
 * ------------------------------------------------------------------------- */

interface MockGoogle {
  url: string;
  requests: { method: string; path: string; apiKeyHeader: string | undefined; authorization: string | undefined; body: string }[];
  close(): Promise<void>;
}

let activeServer: MockGoogle | null = null;

async function startMockGoogle(responder: (path: string) => { status: number; body: string }): Promise<MockGoogle> {
  const requests: MockGoogle['requests'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        apiKeyHeader: typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : undefined,
        authorization: req.headers.authorization,
        body,
      });
      const reply = responder(req.url ?? '/');
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const mock: MockGoogle = {
    url: `http://127.0.0.1:${address.port}/v1beta`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  activeServer = mock;
  return mock;
}

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

describe('gerçek soket — Google biçiminde mock sağlayıcı', () => {
  it('yerel uç gerçek HTTP isteğiyle çalışır (yol, başlık, gövde)', async () => {
    const mock = await startMockGoogle((path) =>
      path.includes(':generateContent')
        ? { status: 200, body: geminiReply('{"karar":"ilan"}') }
        : { status: 404, body: JSON.stringify({ error: { message: 'Bilinmeyen yol' } }) },
    );

    const result = await callChatCompletion(
      { baseUrl: mock.url, apiKey: API_KEY, model: 'models/gemini-2.5-flash', timeoutMs: 5_000 },
      [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
      { transport: 'gemini-native', jsonMode: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('{"karar":"ilan"}');

    const request = mock.requests[0]!;
    expect(request.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(request.apiKeyHeader).toBe(API_KEY);
    expect(request.authorization).toBeUndefined();
    expect(JSON.parse(request.body).generationConfig.responseMimeType).toBe('application/json');
  });

  it('kullanıcının canlı bulgusu yeniden üretilir: kabuk 404, yerel API 200', async () => {
    const mock = await startMockGoogle((path) => {
      if (path.includes('/chat/completions')) {
        return { status: 404, body: JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }) };
      }
      if (path.includes(':generateContent')) return { status: 200, body: geminiReply('hazır') };
      return { status: 404, body: '{}' };
    });
    const target = { baseUrl: mock.url, apiKey: API_KEY, model: 'gemini-2.5-flash', timeoutMs: 5_000 };

    const compat = await callChatCompletion(target, [{ role: 'user', content: 'hazır' }], { transport: 'openai-compat' });
    expect(compat.ok).toBe(false);
    if (!compat.ok) {
      expect(compat.status).toBe(404);
      expect(compat.reason).toContain('Requested entity was not found');
    }

    const native = await callChatCompletion(target, [{ role: 'user', content: 'hazır' }], { transport: 'gemini-native' });
    expect(native.ok).toBe(true);
    if (native.ok) expect(native.content).toBe('hazır');
    // Gerçek Google kökünde compat yol `/v1beta/openai/chat/completions` olur
    // (bkz. resolveLlmEndpoint birim testi); yerel mock 127.0.0.1 olduğu için
    // `/openai` segmenti eklenmez, davranış aynıdır: kabuk 404, yerel API 200.
    expect(mock.requests.map((entry) => entry.path)).toEqual([
      '/v1beta/chat/completions',
      '/v1beta/models/gemini-2.5-flash:generateContent',
    ]);
    expect(chatCompletionsEndpoint(GOOGLE_BASE)).toBe(`${GOOGLE_BASE}/openai/chat/completions`);
  });

  it('gerçek sokette zaman aşımı iptal edilir', async () => {
    const server = createServer(() => {
      /* yanıt verilmez: zaman aşımı denenir */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    try {
      const result = await callChatCompletion(
        { baseUrl: `http://127.0.0.1:${address.port}/v1beta`, apiKey: API_KEY, model: 'gemini-2.5-flash', timeoutMs: 120 },
        [{ role: 'user', content: 'x' }],
        { transport: 'gemini-native' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.timedOut).toBe(true);
        expect(result.retryable).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ---------------------------------------------------------------------------
 * 7) İnceleme kuyruğu: başarısız çağrı review bırakır, başarılı çağrı yükseltir
 * ------------------------------------------------------------------------- */

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

const RECRUIT_BODY =
  'Kurumumuz merkez teşkilatında istihdam edilmek üzere 5 (beş) sözleşmeli personel alımı yapılacaktır. ' +
  'Başvurular 01.11.2026 - 15.11.2026 tarihleri arasında e-Devlet üzerinden alınacaktır. ' +
  'Adayların lisans mezunu olması ve KPSS P3 puan türünden en az 70 puan almış olması gerekmektedir.';

const ILAN_OUTPUT = {
  karar: 'ilan',
  icerikTuru: 'personnel_recruitment',
  istihdamTuru: 'sozlesmeli',
  guven: 0.9,
  ozet: 'Sözleşmeli personel alımı yapılacağı başvuru tarihleriyle birlikte duyuruluyor.',
  kanitlar: {
    alimIfadesi: 'sözleşmeli personel alımı yapılacaktır',
    basvuruTarihi: '01.11.2026 - 15.11.2026 tarihleri arasında',
    kontenjan: '5 (beş)',
  },
};

function gateInput(): LlmGateInput {
  return {
    title: 'Önemli Duyuru',
    body: RECRUIT_BODY,
    bodyTextSource: 'detail',
    sourceCategory: null,
    sourceKey: 'gemini-kaynak',
    url: 'https://ornek.test/duyuru/1',
    base: REVIEW_BASE,
  };
}

function envFor(overrides: Record<string, string> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: GOOGLE_BASE,
    LLM_API_KEY: API_KEY,
    LLM_CLASSIFIER_MODEL: 'gemini-2.5-flash',
    LLM_MAX_CALLS_PER_RUN: '10',
    LLM_DAILY_CALL_LIMIT: '100',
    LLM_RETRY_MAX: '0',
    LLM_MAX_CONCURRENCY: '2',
    ...overrides,
  } as never);
}

async function makeRepos(): Promise<{ repos: Repos; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-gemini-'));
  const store = new FileStore(dir);
  await store.init();
  return { repos: createRepos(store, fixedClock(NOW)), dir };
}

describe('inceleme kuyruğu ve Gemini taşıyıcısı', () => {
  it('404 hatasında kayıt incelemede kalır, telemetriye ayrıntılı gerekçe yazılır', async () => {
    const { repos } = await makeRepos();
    const { fetch } = recorder({
      status: 404,
      body: JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }),
    });
    const gate = createLlmClassificationGate({ repos, env: envFor(), logger: LOGGER, fetchImpl: fetch, retryBackoffMs: 1 });

    const outcome = await gate.evaluate(gateInput());

    // Kayıt OTOMATİK ONAYLANMAZ: review kalır (fail-safe).
    expect(outcome.classification.decision).toBe('review');
    expect(gate.summary().errors).toBe(1);

    const rows: LlmAnalysisDoc[] = await repos.store.find('llmAnalyses', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
    // Gerekçe panelde görünür: durum kodu + sağlayıcının kendi mesajı.
    expect(rows[0]!.error).toContain('HTTP 404');
    expect(rows[0]!.error).toContain('Requested entity was not found');
    expect(rows[0]!.error).not.toContain(API_KEY);
    // Hata yolunda token ÜRETİLMEDİ (paneldeki "0 token" göstergesinin kaynağı).
    expect(rows[0]!.promptTokens ?? 0).toBe(0);
    expect(rows[0]!.completionTokens ?? 0).toBe(0);
  });

  it('başarılı Gemini yanıtı review → accept(job) yükseltmesi yapar', async () => {
    const { repos } = await makeRepos();
    const { fetch, seen } = recorder({ status: 200, body: geminiReply(JSON.stringify(ILAN_OUTPUT)) });
    const gate = createLlmClassificationGate({ repos, env: envFor(), logger: LOGGER, fetchImpl: fetch, retryBackoffMs: 1 });

    const outcome = await gate.evaluate(gateInput());

    expect(outcome.classification.decision).toBe('accept');
    expect(outcome.classification.kind).toBe('job');
    expect(outcome.classification.contentType).toBe('personnel_recruitment');
    expect(gate.summary().calls).toBe(1);
    // İstek yerel Gemini biçiminde gitti.
    expect(seen[0]!.url).toContain('/models/gemini-2.5-flash:generateContent');
    const rows: LlmAnalysisDoc[] = await repos.store.find('llmAnalyses', {});
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.promptTokens).toBe(120);
    expect(rows[0]!.completionTokens).toBe(60);
  });

  it('429 geçici hatasında yeniden deneme yapılır, kalıcı hatada yapılmaz', async () => {
    const { repos } = await makeRepos();
    let calls = 0;
    const fetchImpl: LlmFetch = async () => {
      calls += 1;
      return { status: calls === 1 ? 429 : 200, text: async () => (calls === 1 ? '{}' : geminiReply(JSON.stringify(ILAN_OUTPUT))) };
    };
    const gate = createLlmClassificationGate({
      repos,
      env: envFor({ LLM_RETRY_MAX: '2' }),
      logger: LOGGER,
      fetchImpl,
      retryBackoffMs: 1,
    });

    const outcome = await gate.evaluate(gateInput());
    expect(calls).toBe(2);
    expect(outcome.classification.decision).toBe('accept');

    // Kalıcı hata (404) yeniden denenmez: kota tüketilmez.
    const { repos: repos2 } = await makeRepos();
    let permanentCalls = 0;
    const failing: LlmFetch = async () => {
      permanentCalls += 1;
      return { status: 404, text: async () => JSON.stringify({ error: { message: 'yok' } }) };
    };
    const gate2 = createLlmClassificationGate({
      repos: repos2,
      env: envFor({ LLM_RETRY_MAX: '2' }),
      logger: LOGGER,
      fetchImpl: failing,
      retryBackoffMs: 1,
    });
    await gate2.evaluate(gateInput());
    expect(permanentCalls).toBe(1);
  });
});
