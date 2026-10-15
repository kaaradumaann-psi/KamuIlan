/**
 * OpenAI uyumlu LLM ucunun kurulması ve sağlayıcı hatalarının okunabilirliği.
 *
 * 2026-10-16 canlı panel: "Yapay zekâ ön görüşü — model denetimine ulaşılamadı /
 * Sağlayıcı HTTP 404 döndü", LLM ölçümleri %100 hata · 0 token. Kök neden
 * yapılandırmaydı: istemci `${LLM_BASE_URL}/chat/completions` çağırırken
 * Google'ın yerel kökü bu yolu bilmez. Bu dosya uç kurulumunu, uç/model
 * uyuşmazlığı uyarısını ve hata gerekçesinin operatöre yol göstermesini kilitler.
 */
import { describe, expect, it } from 'vitest';

import { callChatCompletion, chatCompletionsEndpoint, describeLlmEndpointRisk, redactSecret } from '../src/ai/llm';
import { getEnv, inspectEnvironment } from '../src/config/env';

const config = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'cok-gizli-anahtar',
  model: 'test-model',
  timeoutMs: 5_000,
};

describe('chatCompletionsEndpoint', () => {
  it('genel OpenAI uyumlu köke /chat/completions ekler', () => {
    expect(chatCompletionsEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsEndpoint('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(chatCompletionsEndpoint('https://api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(chatCompletionsEndpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('Google AI kökünü OpenAI uyumlu /openai ucuna çevirir (404 düzeltmesi)', () => {
    expect(chatCompletionsEndpoint('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    // Zaten uyumlu uç verilmişse yeniden eklenmez (idempotent).
    expect(chatCompletionsEndpoint('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(chatCompletionsEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    // Yerel (OpenAI uyumlu olmayan) tam yol yapıştırılmışsa sürüm köküne indirgenir.
    expect(chatCompletionsEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('tam uç adresi verilmişse olduğu gibi kullanılır', () => {
    expect(chatCompletionsEndpoint('https://gateway.example/v1/chat/completions')).toBe(
      'https://gateway.example/v1/chat/completions',
    );
  });
});

describe('describeLlmEndpointRisk', () => {
  it('OpenAI ucuna Gemini modeli yazıldığında uyarır', () => {
    const risk = describeLlmEndpointRisk('https://api.openai.com/v1', 'gemini-2.5-flash');
    expect(risk).toMatch(/Gemini için/);
  });

  it('Google ucuna OpenAI modeli yazıldığında uyarır', () => {
    const risk = describeLlmEndpointRisk('https://generativelanguage.googleapis.com/v1beta', 'gpt-4o-mini');
    expect(risk).toMatch(/404/);
  });

  it('tutarlı eşleşmelerde ve boş değerlerde sessizdir', () => {
    expect(describeLlmEndpointRisk('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash')).toBeNull();
    expect(describeLlmEndpointRisk('https://api.openai.com/v1', 'gpt-4o-mini')).toBeNull();
    expect(describeLlmEndpointRisk('https://openrouter.ai/api/v1', 'google/gemini-2.5-flash')).toBeNull();
    expect(describeLlmEndpointRisk('', 'gemini-2.5-flash')).toBeNull();
  });

  it('geçersiz adres anlaşılır biçimde raporlanır', () => {
    expect(describeLlmEndpointRisk('api.openai.com/v1', 'gpt-4o-mini')).toMatch(/geçerli bir adres değil/);
  });
});

describe('callChatCompletion hata gerekçesi', () => {
  it('404 için hangi uca hangi modelle gidildiğini yazar ve anahtarı sızdırmaz', async () => {
    const result = await callChatCompletion(
      { ...config, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      [{ role: 'user', content: 'deneme' }],
      { fetchImpl: async () => ({ status: 404, text: async () => '{"error":{"message":"not found"}}' }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain('HTTP 404');
    expect(result.reason).toContain('/v1beta/openai/chat/completions');
    expect(result.reason).toContain('test-model');
    expect(result.reason).toContain('LLM_BASE_URL');
    expect(result.reason).not.toContain(config.apiKey);
  });

  it('401/403 anahtara, 429 kotaya, 400 istek gövdesine yönlendirir', async () => {
    const call = async (status: number) => {
      const result = await callChatCompletion(config, [{ role: 'user', content: 'deneme' }], {
        fetchImpl: async () => ({ status, text: async () => '' }),
      });
      return result.ok ? '' : result.reason;
    };

    expect(await call(401)).toMatch(/API anahtarı/);
    expect(await call(403)).toMatch(/API anahtarı/);
    expect(await call(429)).toMatch(/kota/);
    expect(await call(400)).toMatch(/İstek gövdesi/);
  });

  it('istek gövdesi OpenAI uyumlu biçimde gider (model, messages, max_tokens)', async () => {
    let seen = '';
    await callChatCompletion(config, [{ role: 'user', content: 'deneme' }], {
      fetchImpl: async (url, init) => {
        seen = `${url} ${init.body}`;
        return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'hazır' } }] }) };
      },
    });

    expect(seen).toContain('https://example.test/v1/chat/completions');
    expect(seen).toContain('"model":"test-model"');
    expect(seen).toContain('"max_tokens":1200');
  });

  it('redactSecret anahtarı hata metninden ayıklar', () => {
    expect(redactSecret('hata: cok-gizli-anahtar geçersiz', 'cok-gizli-anahtar')).not.toContain('cok-gizli-anahtar');
  });
});

describe('ortam denetimi', () => {
  it('uç/model uyuşmazlığı env:check çıktısında uyarı olarak görünür (engelleyici değil)', () => {
    const env = getEnv({
      LLM_CLASSIFIER_ENABLED: '1',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: 'test-anahtar',
      LLM_MODEL: 'gemini-2.5-flash',
    } as never);
    const inspection = inspectEnvironment(env);

    expect(inspection.problems.join(' ')).not.toMatch(/LLM_BASE_URL/);
    expect(inspection.warnings.join(' ')).toMatch(/Gemini için/);
    expect(inspection.warnings.join(' ')).toMatch(/llm:doctor/);
  });

  it('maliyet alanları boşken panel uyarısı verilir', () => {
    const env = getEnv({
      LLM_CLASSIFIER_ENABLED: '1',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_API_KEY: 'test-anahtar',
      LLM_MODEL: 'gpt-4o-mini',
      LLM_COST_USD_PER_MTOK_INPUT: '',
      LLM_COST_USD_PER_MTOK_OUTPUT: '',
    } as never);

    expect(inspectEnvironment(env).warnings.join(' ')).toMatch(/LLM_COST_USD_PER_MTOK/);
  });
});
