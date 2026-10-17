/**
 * LLM sınıflandırma kapısı ortam yapılandırması testleri.
 *
 * Kanıtlanan sözleşmeler:
 *  - LLM_CLASSIFIER_ENABLED=1 için LLM_BASE_URL + LLM_API_KEY + model zorunludur.
 *  - Üretimde LLM_BASE_URL https:// olmalıdır (hem panel hem kapı).
 *  - Varsayılan yapılandırmada kapı kapalıdır; production'da iki fiyat varsayımı ve koşu/gün USD tavanı gerekir.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvCache } from '../src/config/env';
import { llmClassifierConfig } from '../src/ai/classifier';

afterEach(() => {
  resetEnvCache();
});

describe('LLM kapısı ortam doğrulaması', () => {
  it('varsayılan olarak kapalıdır ve yapılandırma üretmez', () => {
    const env = getEnv({ NODE_ENV: 'test' });
    expect(env.LLM_CLASSIFIER_ENABLED).toBe(false);
    expect(llmClassifierConfig(env)).toBeNull();
  });

  it('etkinleştirme için taban adres, anahtar ve model zorunludur', () => {
    expect(() => getEnv({ NODE_ENV: 'test', LLM_CLASSIFIER_ENABLED: '1' })).toThrow(
      /LLM_CLASSIFIER_ENABLED=1 için/,
    );
    expect(() =>
      getEnv({ NODE_ENV: 'test', LLM_CLASSIFIER_ENABLED: '1', LLM_BASE_URL: 'https://llm.test/v1' }),
    ).toThrow(/LLM_API_KEY/);
    const env = getEnv({
      NODE_ENV: 'test',
      LLM_CLASSIFIER_ENABLED: '1',
      LLM_BASE_URL: 'https://llm.test/v1',
      LLM_API_KEY: 'sk-test',
      LLM_CLASSIFIER_MODEL: 'kapali-model',
    });
    const config = llmClassifierConfig(env);
    expect(config?.model).toBe('kapali-model');
    expect(config?.timeoutMs).toBe(env.LLM_TIMEOUT_MS);
  });

  it('LLM_CLASSIFIER_MODEL boşsa LLM_MODEL yedeği kullanılır', () => {
    const env = getEnv({
      NODE_ENV: 'test',
      LLM_CLASSIFIER_ENABLED: '1',
      LLM_BASE_URL: 'https://llm.test/v1',
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'panel-modeli',
    });
    expect(llmClassifierConfig(env)?.model).toBe('panel-modeli');
  });

  it('üretimde http:// taban adresi reddedilir (kapı etkinse)', () => {
    // getEnv sorunlarda hata fırlatır (sessiz güvensiz yapılandırma yoktur).
    expect(() =>
      getEnv({
        NODE_ENV: 'production',
        APP_SECRET: 'a'.repeat(40),
        POSTGRES_URL: 'postgres://user:pass@host:5432/db',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test',
        LLM_CLASSIFIER_ENABLED: '1',
        LLM_BASE_URL: 'http://llm.test/v1',
        LLM_API_KEY: 'sk-test',
        LLM_CLASSIFIER_MODEL: 'model',
      }),
    ).toThrow(/https:\/\//);
  });

  it('production LLM iki USD tavanı ve pozitif fiyat varsayımı olmadan açılamaz', () => {
    const base = {
      NODE_ENV: 'production',
      APP_SECRET: 'a'.repeat(40),
      DATABASE_DRIVER: 'postgres',
      POSTGRES_URL: 'postgresql://user:pass@db.example.test:5432/kamuilan',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      LLM_CLASSIFIER_ENABLED: '1',
      LLM_BASE_URL: 'https://llm.example.test/v1',
      LLM_API_KEY: 'sk-test',
      LLM_CLASSIFIER_MODEL: 'test-model',
    };
    expect(() => getEnv(base)).toThrow(/LLM_RUN_COST_LIMIT_USD.*LLM_DAILY_COST_LIMIT_USD/);

    const env = getEnv({
      ...base,
      LLM_RUN_COST_LIMIT_USD: '0.25',
      LLM_DAILY_COST_LIMIT_USD: '2.00',
      LLM_COST_USD_PER_MTOK_INPUT: '1',
      LLM_COST_USD_PER_MTOK_OUTPUT: '2',
    });
    expect(env.LLM_RUN_COST_LIMIT_USD).toBe(0.25);
    expect(env.LLM_DAILY_COST_LIMIT_USD).toBe(2);
  });

  it('bütçe varsayılanları maliyet freni sağlar', () => {
    const env = getEnv({ NODE_ENV: 'test' });
    expect(env.LLM_MAX_CALLS_PER_RUN).toBe(12);
    expect(env.LLM_DAILY_CALL_LIMIT).toBe(400);
    expect(env.LLM_MAX_CONCURRENCY).toBe(2);
    expect(env.LLM_RETRY_MAX).toBe(1);
    expect(env.LLM_MAX_INPUT_CHARS).toBe(12_000);
  });
});
