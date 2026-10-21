/**
 * LLM kapısı — ek ÇEVRİMDIŞI (mock sağlayıcı) testler. Gerçek sağlayıcı çağrısı YOKTUR;
 * gerçek doğrulama ayrı ve tavanlı komutla yapılır: `npm run llm:doctor -- --live --max-calls=1 …`.
 *
 *  - Eşzamanlılık: LLM_MAX_CONCURRENCY sağlayıcıya aynı anda giden istek sayısını sınırlar.
 *  - Bozuk kodlama (mojibake): model düzgün Türkçe "kanıt" döndürse de kaynak metinde birebir
 *    geçmediği için karar doğrulanmaz; kayıt otomatik kabul edilmez, incelemede kalır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { getEnv, resetEnvCache } from '../src/config/env';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import { createLlmClassificationGate } from '../src/ai/classifier';
import type { LlmFetch } from '../src/ai/llm';
import type { ClassificationResult } from '../src/domain/types';

const NOW = new Date('2026-10-22T09:00:00+03:00');
const LOGGER = createLogger('llm-ek-test', { level: 'silent' });
const BASE: ClassificationResult = {
  decision: 'review',
  kind: 'job',
  employmentType: 'belirsiz',
  confidence: 0.5,
  reasons: ['belirsiz'],
  rules: [],
  negativeSignals: [],
  version: CLASSIFICATION_VERSION,
  contentType: 'uncertain',
};
const OUTPUT = {
  karar: 'ilan',
  icerikTuru: 'personnel_recruitment',
  istihdamTuru: 'sozlesmeli',
  guven: 0.9,
  ozet: 'Sözleşmeli personel alımı yapılacağı duyuruluyor.',
  kanitlar: { alimIfadesi: 'sözleşmeli personel alımı yapılacaktır' },
};

function env(overrides: Record<string, string> = {}) {
  return getEnv({
    NODE_ENV: 'test',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: 'https://llm.test/v1',
    LLM_API_KEY: 'sk-test-gizli-anahtar',
    LLM_CLASSIFIER_MODEL: 'test-model',
    LLM_MAX_CALLS_PER_RUN: '20',
    LLM_DAILY_CALL_LIMIT: '100',
    LLM_RETRY_MAX: '0',
    LLM_MAX_CONCURRENCY: '2',
    ...overrides,
  });
}

async function repos() {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-llm-ek-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

function envelope(content: unknown) {
  return {
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
  };
}

afterEach(() => resetEnvCache());

describe('LLM kapısı (mock sağlayıcı) — eşzamanlılık', () => {
  it('aynı anda giden istek sayısı LLM_MAX_CONCURRENCY (2) ile sınırlıdır', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: LlmFetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return envelope(OUTPUT);
    };
    const gate = createLlmClassificationGate({ repos: await repos(), env: env(), logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
    const body = (n: number) =>
      `Kurumumuz merkez teşkilatında istihdam edilmek üzere ${n} sözleşmeli personel alımı yapılacaktır. Başvurular e-Devlet üzerinden alınacaktır. Adayların lisans mezunu olması ve KPSS P3 puan türünden en az 70 puan almış olması gerekmektedir.`;
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        gate.evaluate({
          title: `Duyuru ${index}`,
          body: body(index + 2),
          bodyTextSource: 'detail',
          sourceCategory: null,
          sourceKey: 'test',
          url: `https://ornek.test/${index}`,
          base: BASE,
        }),
      ),
    );
    expect(outcomes.every((outcome) => outcome.callMade)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
});

describe('LLM kapısı (mock sağlayıcı) — bozuk Türkçe kodlama', () => {
  it('mojibake metinde düzgün Türkçe kanıt doğrulanmaz; kayıt incelemede kalır', async () => {
    // 200 karakter sınırının üstünde: sağlayıcı GERÇEKTEN çağrılır (maliyet freni devreye girmez).
    const mojibake =
      'Kurumumuz merkez teÅŸkilatÄ±nda istihdam edilmek Ã¼zere sÃ¶zleÅŸmeli personel alÄ±mÄ± yapÄ±lacaktÄ±r. ' +
      'BaÅŸvurular e-Devlet Ã¼zerinden alÄ±nacaktÄ±r. AdaylarÄ±n lisans mezunu olmasÄ± gerekmektedir.';
    const fetchImpl: LlmFetch = async () => envelope(OUTPUT);
    const gate = createLlmClassificationGate({ repos: await repos(), env: env(), logger: LOGGER, fetchImpl, retryBackoffMs: 1 });
    const outcome = await gate.evaluate({
      title: 'Duyuru',
      body: mojibake,
      bodyTextSource: 'detail',
      sourceCategory: null,
      sourceKey: 'test',
      url: 'https://ornek.test/mojibake',
      base: BASE,
    });
    expect(outcome.callMade).toBe(true);
    expect(outcome.classification.decision).toBe('review');
    expect(outcome.classification.llm?.evidenceVerified ?? false).toBe(false);
  });
});
