/**
 * 429 (kota/hız sınırı) teşhis metni testleri.
 *
 * Canlı kanıt (16.10.2026, kullanıcının makinesi, gerçek Gemini anahtarı):
 * `RESOURCE_EXHAUSTED` + "You exceeded your current quota, please check your plan and
 * billing details." döndü. Eski ipucu metni yalnızca `LLM_DAILY_CALL_LIMIT` öneriyordu;
 * oysa sınır sağlayıcı hesabındaydı ve uygulama ayarıyla çözülemez. Bu test, ipucunun
 * sınırı doğru yere yazdığını ve sağlayıcı mesajı olmadığında eski genel metnin
 * korunduğunu doğrular.
 */
import { describe, expect, it } from 'vitest';

import {
  callChatCompletion,
  callChatCompletionWithRetry,
  classifyHttpFailureStatus,
  type LlmConfig,
} from '../src/ai/llm';

const API_KEY = 'kota-testi-anahtari-0123456789';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const config: LlmConfig = { baseUrl: GOOGLE_BASE, apiKey: API_KEY, model: 'gemini-test-model', timeoutMs: 5_000 };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Sağlayıcı yanıtını taklit eden sahte fetch; isteği kaydeder. */
function provider(status: number, body: string, contentType = 'application/json'): { fetchImpl: never; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers ?? {}, body: init.body ?? '' });
    return { status, headers: { 'content-type': contentType }, text: async () => body };
  };
  return { fetchImpl: fetchImpl as never, calls };
}

const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details.',
  },
});

describe('429 kota tanısı', () => {
  it('kota mesajı varsa sınır SAĞLAYICIYA yazılır, uygulama ayarı suçlanmaz', async () => {
    const { fetchImpl, calls } = provider(429, QUOTA_BODY);
    const result = await callChatCompletion(config, [{ role: 'user', content: 'hazır' }], { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(429);
    expect(result.failureCategory).toBe('rate-limit');
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain('KOTA/PLAN');
    expect(result.reason).toContain('LLM_DAILY_CALL_LIMIT');
    expect(result.reason).toContain('ÇÖZMEZ');
    // Eski (yanıltıcı) öneri artık basılmaz.
    expect(result.reason).not.toContain('düşürülebilir');
    // Anahtar hiçbir biçimde metne sızmaz.
    expect(result.reason).not.toContain(API_KEY);
    expect(result.diagnostics?.errorStatus).toBe('RESOURCE_EXHAUSTED');

    // İstek Google kökünde YEREL uca gider (OpenAI uyumlu kabuğa değil) ve anahtar sorguya yazılmaz.
    expect(calls[0]?.url).toBe(`${GOOGLE_BASE}/models/gemini-test-model:generateContent`);
    expect(calls[0]?.url).not.toContain(API_KEY);
    expect(calls).toHaveLength(1); // callChatCompletion tek deneme yapar; yeniden deneme sarmalayıcıdadır
  });

  it('kota ifadesi olmayan 429 yanıtında genel ipucu korunur', async () => {
    const { fetchImpl } = provider(429, JSON.stringify({ error: { code: 429, message: 'Slow down.' } }));
    const result = await callChatCompletion(config, [{ role: 'user', content: 'hazır' }], { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCategory).toBe('rate-limit');
    expect(result.reason).toContain('günlük sınır (LLM_DAILY_CALL_LIMIT) düşürülebilir');
    expect(result.reason).not.toContain('KOTA/PLAN');
  });

  it('503 yoğunluk hatasında kota ipucu basılmaz', async () => {
    const { fetchImpl } = provider(
      503,
      JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is experiencing high demand.' } }),
    );
    const result = await callChatCompletion(config, [{ role: 'user', content: 'hazır' }], { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCategory).toBe('service-unavailable');
    expect(result.reason).not.toContain('KOTA/PLAN');
    expect(result.reason).not.toContain(API_KEY);
  });

  it('kota hatası yeniden denemesi SINIRLI sayıda yapılır (kota tüketmez)', async () => {
    const { fetchImpl, calls } = provider(429, QUOTA_BODY);
    const result = await callChatCompletionWithRetry(
      config,
      [{ role: 'user', content: 'hazır' }],
      { fetchImpl, maxRetries: 1, sleepImpl: async () => undefined },
    );

    expect(result.attempts).toBe(2); // 1 deneme + 1 yeniden deneme, SONSUZ DÖNGÜ YOK
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('KOTA/PLAN');
  });

  it('429 sınıfı rate-limit, 5xx sınıfı service-unavailable olarak ayrılır', () => {
    expect(classifyHttpFailureStatus(429)).toBe('rate-limit');
    expect(classifyHttpFailureStatus(503)).toBe('service-unavailable');
    expect(classifyHttpFailureStatus(404)).toBe('not-found');
    expect(classifyHttpFailureStatus(401)).toBe('auth');
  });
});
