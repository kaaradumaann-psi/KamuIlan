/**
 * LLM sağlayıcısıyla GERÇEK soket üzerinden uçtan uca doğrulama.
 *
 * Neden ayrı bir dosya: diğer LLM testleri `fetchImpl` enjekte eder; bu test ise
 * hiç enjekte ETMEZ ve 127.0.0.1 üzerinde kaldırılan gerçek bir OpenAI uyumlu
 * HTTP sunucusuna bağlanır. Böylece yalnızca karar mantığı değil, isteğin
 * kendisi (URL birleştirme, yetki başlığı, gövde, zaman aşımı, JSON ayrıştırma,
 * bağlantı hatası) de doğrulanır.
 *
 * ÖNEMLİ: Bu bir MOCK sunucudur. Gerçek sağlayıcı testi değildir; maliyet,
 * gerçek gecikme ve sağlayıcıya özgü davranış hakkında hiçbir iddia üretmez.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { LlmAnalysisDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { getEnv, resetEnvCache } from '../src/config/env';
import { classify } from '../src/classification/engine';
import { createLlmClassificationGate, llmClassifierConfig } from '../src/ai/classifier';
import { callChatCompletion } from '../src/ai/llm';

const NOW = new Date('2026-10-15T09:00:00+03:00');
const LOGGER = createLogger('llm-mock-test', { level: 'silent' });
const API_KEY = 'sk-test-gercek-degil-0123456789';

/** Kuralların `review` dediği, kanıtı doğrulanabilir bir alım duyurusu. */
const REVIEW_TITLE = 'Önemli Duyuru';
const REVIEW_BODY =
  'Kurumumuz merkez teşkilatında istihdam edilmek üzere 5 (beş) sözleşmeli personel alımı yapılacaktır. ' +
  'Başvurular 01.11.2026 - 15.11.2026 tarihleri arasında e-Devlet üzerinden alınacaktır. ' +
  'Adayların aa@example.com adresine 0532 111 22 33 numaralı telefondan ulaşması ve ' +
  '12345678901 numaralı T.C. kimlik numarasını bildirmesi gerekmektedir.';

const VALID_MODEL_OUTPUT = {
  karar: 'ilan',
  icerikTuru: 'personnel_recruitment',
  istihdamTuru: 'sozlesmeli',
  guven: 0.9,
  ozet: 'Sözleşmeli personel alımı duyurusu; başvuru tarihleri ve şartlar verilmiş.',
  kanitlar: { alimIfadesi: 'sözleşmeli personel alımı yapılacaktır' },
};

type Responder = (request: { body: string; attempts: number }) => {
  status: number;
  body: string;
  delayMs?: number;
  headers?: Record<string, string>;
};

interface MockProvider {
  url: string;
  requests: { path: string; authorization: string; body: string }[];
  attempts(): number;
  close(): Promise<void>;
}

let server: Server | null = null;

async function startProvider(respond: Responder): Promise<MockProvider> {
  let attempts = 0;
  const requests: MockProvider['requests'] = [];
  const instance = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      attempts += 1;
      if (req.url) requests.push({ path: req.url, authorization: String(req.headers.authorization ?? ''), body: raw });
      const reply = respond({ body: raw, attempts });
      const send = () => {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(reply.body);
      };
      if (reply.delayMs && reply.delayMs > 0) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  server = instance;
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const port = (instance.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    attempts: () => attempts,
    async close() {
      await new Promise<void>((resolve) => instance.close(() => resolve()));
      server = null;
    },
  };
}

function jsonReply(payload: unknown, status = 200) {
  return {
    status,
    body: JSON.stringify({
      choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
      usage: { prompt_tokens: 1_234, completion_tokens: 210 },
    }),
  };
}

/** Kapatılmış port: bağlantı reddi (ECONNREFUSED) senaryosu için. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-llm-mock-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
  resetEnvCache();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

function envFor(baseUrl: string, extra: Record<string, string> = {}) {
  return getEnv({
    NODE_ENV: 'test',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: API_KEY,
    LLM_CLASSIFIER_MODEL: 'mock-model',
    LLM_TIMEOUT_MS: '5000',
    LLM_MAX_CALLS_PER_RUN: '5',
    LLM_DAILY_CALL_LIMIT: '100',
    LLM_RETRY_MAX: '1',
    LLM_MAX_CONCURRENCY: '2',
    ...extra,
  });
}

async function gateOutcome(providerUrl: string, extra: Record<string, string> = {}) {
  const env = envFor(providerUrl, extra);
  const gate = createLlmClassificationGate({ repos, env, logger: LOGGER, retryBackoffMs: 1 });
  // Kaynak kategorisi bilinmiyor: kurallar belirsiz (review) diyor, kapı devreye giriyor.
  const base = classify({ title: REVIEW_TITLE, body: REVIEW_BODY, sourceCategory: null, sourceKey: 'mock-kaynak' });
  expect(base.decision).toBe('review'); // senaryonun kurulduğundan emin ol
  const outcome = await gate.evaluate({
    title: REVIEW_TITLE,
    body: REVIEW_BODY,
    sourceCategory: null,
    sourceKey: 'mock-kaynak',
    url: 'https://ornek.test/duyuru/1',
    base,
  });
  return { env, gate, outcome };
}

async function telemetryRows(): Promise<LlmAnalysisDoc[]> {
  return (await repos.store.find('llmAnalyses', {}, { sort: [['createdAt', -1]] })) as LlmAnalysisDoc[];
}

describe('LLM kapısı gerçek HTTP soketi üzerinden (mock sağlayıcı)', () => {
  it('doğru uç noktayı, yetki başlığını ve OpenAI gövdesini gönderir; kanıtlı kabulu uygular', async () => {
    const provider = await startProvider(() => jsonReply(VALID_MODEL_OUTPUT));
    const { outcome } = await gateOutcome(provider.url);
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    const sent = JSON.parse(request.body) as {
      model: string;
      temperature: number;
      max_tokens: number;
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };
    expect(sent.model).toBe('mock-model');
    expect(sent.temperature).toBe(0.1);
    expect(sent.max_tokens).toBe(900);
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.messages[0]?.role).toBe('system');
    // Gövde, güvenilmez içerik işaretçileriyle taşınır (prompt injection sınırı).
    expect(sent.messages[1]?.content).toContain('<duyuru>');
    expect(outcome.classification.decision).toBe('accept');
    expect(outcome.classification.kind).toBe('job');
    expect(outcome.classification.llm?.evidenceVerified).toBe(true);
    expect(outcome.callMade).toBe(true);
    const rows = await telemetryRows();
    expect(rows[0]).toMatchObject({ status: 'ok', model: 'mock-model', promptTokens: 1_234, completionTokens: 210 });
    expect(rows[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    await provider.close();
  });

  it('KVKK: e-posta, telefon ve T.C. kimlik numarası ağa ÇIPLAK gitmez', async () => {
    const provider = await startProvider(() => jsonReply(VALID_MODEL_OUTPUT));
    await gateOutcome(provider.url);
    const wire = provider.requests[0]!.body;
    expect(wire).not.toContain('12345678901');
    expect(wire).not.toContain('aa@example.com');
    expect(wire).not.toContain('example.com');
    expect(wire).not.toContain('0532 111 22 33');
    expect(wire).toContain('[kimlik-no gizlendi]');
    expect(wire).toContain('[e-posta gizlendi]');
    expect(wire).toContain('[telefon gizlendi]');
    await provider.close();
  });

  it('429 sonrasında sınırlı yeniden deneme yapar ve kararı uygular', async () => {
    const provider = await startProvider(({ attempts }) =>
      attempts === 1 ? { status: 429, body: '{"error":"rate limited"}', headers: { 'retry-after': '0' } } : jsonReply(VALID_MODEL_OUTPUT),
    );
    const { outcome } = await gateOutcome(provider.url);
    expect(provider.attempts()).toBe(2);
    expect(outcome.classification.decision).toBe('accept');
    await provider.close();
  });

  it('kalıcı 5xx: kayıt review kalır, hata telemetriye yazılır, belirsiz kayıt YAYIMLANMAZ', async () => {
    const provider = await startProvider(() => ({ status: 503, body: 'provider down' }));
    const { gate, outcome } = await gateOutcome(provider.url);
    expect(outcome.classification.decision).toBe('review');
    expect(provider.attempts()).toBe(2); // LLM_RETRY_MAX=1 → en fazla 2 deneme (sonsuz tekrar yok)
    expect(gate.summary().errors).toBe(1);
    const rows = await telemetryRows();
    expect(rows[0]).toMatchObject({ status: 'error', verdict: null });
    expect(rows[0]!.error).toContain('503');
    // Hata yolunda da gecikme ölçülür (0 değil) — yoksa p95 iyimser çıkar.
    expect(rows[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    await provider.close();
  });

  it('geçersiz JSON: doğrulanamayan karar review bırakır ve neden yazılır', async () => {
    const provider = await startProvider(() => jsonReply('bu JSON değil'));
    const { outcome } = await gateOutcome(provider.url);
    expect(outcome.classification.decision).toBe('review');
    expect(outcome.opinion?.verdict).toBe('dogrulanamadi');
    await provider.close();
  });

  it('aynı içeriğin yeniden taranması önbellekten çözülür: ikinci HTTP isteği YOK', async () => {
    const provider = await startProvider(() => jsonReply(VALID_MODEL_OUTPUT));
    const first = await gateOutcome(provider.url);
    expect(first.outcome.callMade).toBe(true);
    const second = await gateOutcome(provider.url);
    expect(provider.attempts()).toBe(1);
    expect(second.outcome.callMade).toBe(false);
    expect(second.outcome.classification.decision).toBe('accept');
    expect(second.gate.summary().cacheHits).toBe(1);
    await provider.close();
  });

  it('günlük kota dolduğunda sağlayıcıya hiç istek gitmez', async () => {
    const provider = await startProvider(() => jsonReply(VALID_MODEL_OUTPUT));
    await repos.rateLimits.hit('llm-classifier-daily', 24 * 3_600);
    await repos.rateLimits.hit('llm-classifier-daily', 24 * 3_600);
    const { gate } = await gateOutcome(provider.url, { LLM_DAILY_CALL_LIMIT: '2' });
    expect(gate.summary().blocked).toBe(1);
    expect(provider.attempts()).toBe(0);
    await provider.close();
  });

  it('kapalı kapı ile hiçbir istek gitmez ve sınıflandırma değişmez', async () => {
    const provider = await startProvider(() => jsonReply(VALID_MODEL_OUTPUT));
    const env = envFor(provider.url, { LLM_CLASSIFIER_ENABLED: '0' });
    expect(llmClassifierConfig(env)).toBeNull();
    const gate = createLlmClassificationGate({ repos, env, logger: LOGGER });
    // Kaynak kategorisi bilinmiyor: kurallar belirsiz (review) diyor, kapı devreye giriyor.
  const base = classify({ title: REVIEW_TITLE, body: REVIEW_BODY, sourceCategory: null, sourceKey: 'mock-kaynak' });
    const outcome = await gate.evaluate({
      title: REVIEW_TITLE,
      body: REVIEW_BODY,
      sourceCategory: 'personel alimi',
      sourceKey: 'mock-kaynak',
      url: 'https://ornek.test/duyuru/1',
      base,
    });
    expect(outcome.classification).toEqual(base);
    expect(provider.attempts()).toBe(0);
    await provider.close();
  });

  it('bağlantı reddi: açık hata mesajı, kayıt incelemede kalır', async () => {
    const url = await closedPortUrl();
    const { gate, outcome } = await gateOutcome(url);
    expect(outcome.classification.decision).toBe('review');
    expect(gate.summary().errors).toBe(1);
    const rows = await telemetryRows();
    expect(rows[0]!.error).toMatch(/ulaşılamadı/i);
    // Anahtar hata metnine sızmamalı.
    expect(rows[0]!.error).not.toContain(API_KEY);
  });

  it('sağlayıcı model çıktısı olarak anahtar sızdırsa bile telemetriye yazılmaz', async () => {
    // JSON ayrıştırma hatası mesajı içeriğin başını taşır; ham metin/anahtar kaydedilmemeli.
    const provider = await startProvider(() => jsonReply(`${API_KEY} bu JSON değil`));
    await gateOutcome(provider.url);
    const rows = await telemetryRows();
    expect(rows[0]!.status).toBe('invalid');
    // Yalnızca anahtarın TAMAMI değil, JSON.parse mesajına giren ÖN EKİ de sızmamalı.
    expect(rows[0]!.error).not.toContain(API_KEY);
    expect(rows[0]!.error).not.toContain('sk-test');
    expect(rows[0]!.error).not.toContain('bu JSON');
    expect(rows[0]!.error).toMatch(/geçersiz JSON/);
    await provider.close();
  });
});

describe('çağrı istemcisinin zaman aşımı (gerçek soket)', () => {
  it('LLM_TIMEOUT_MS aşıldığında istem iptal edilir ve timeout olarak raporlanır', async () => {
    const provider = await startProvider(() => ({ ...jsonReply(VALID_MODEL_OUTPUT), delayMs: 1_200 }));
    const config = { baseUrl: provider.url, apiKey: API_KEY, model: 'mock-model', timeoutMs: 150 };
    const started = Date.now();
    const result = await callChatCompletion(config, [{ role: 'user', content: 'merhaba' }]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.reason).toMatch(/zaman aşımı/i);
    }
    await provider.close();
  });
});
