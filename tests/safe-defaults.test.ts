import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_FIELD_BY_KEY } from '../src/config/env-spec';
import { getEnv, resetEnvCache } from '../src/config/env';

function exampleValue(key: string): string | null {
  const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return match?.[1]?.trim() ?? null;
}

describe('güvenli varsayılanlar', () => {
  it('şema varsayılanı canlı taramayı ve zamanlayıcıyı KAPALI tutar', () => {
    expect(ENV_FIELD_BY_KEY.get('SCHEDULER_ENABLED')?.defaultValue).toBe('0');
    expect(ENV_FIELD_BY_KEY.get('SOURCE_LIVE_FETCH')?.defaultValue).toBe('0');
    expect(ENV_FIELD_BY_KEY.get('SOURCE_BROWSER_FALLBACK')?.defaultValue).toBe('0');
  });

  it('.env.example kopyalanınca start:worker tüm kaynakları taramaz', () => {
    expect(exampleValue('SCHEDULER_ENABLED')).toBe('0');
    expect(exampleValue('SOURCE_LIVE_FETCH')).toBe('0');
    expect(exampleValue('SOURCE_BROWSER_FALLBACK')).toBe('0');
  });

  it('docker compose varsayılanı tek komutla canlı tarama başlatmaz', () => {
    const compose = readFileSync(join(process.cwd(), 'infra', 'docker', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('SCHEDULER_ENABLED: ${SCHEDULER_ENABLED:-0}');
    expect(compose).toContain('SOURCE_LIVE_FETCH: ${SOURCE_LIVE_FETCH:-0}');
  });

  it('çalışma zamanı şeması da tanımsız değerlerde kapalı varsayılan uygular', () => {
    // env-spec (dokümantasyon) ile gerçek Zod şeması ayrışmamalı: eksik değer
    // operatörün bilinçli opt-in'i sayılmaz.
    resetEnvCache();
    const env = getEnv({
      NODE_ENV: 'development',
      SCHEDULER_ENABLED: undefined,
      SOURCE_LIVE_FETCH: undefined,
      SOURCE_BROWSER_FALLBACK: undefined,
    });
    expect(env.SCHEDULER_ENABLED).toBe(false);
    expect(env.SOURCE_LIVE_FETCH).toBe(false);
    expect(env.SOURCE_BROWSER_FALLBACK).toBe(false);
    resetEnvCache();
  });

  it('AI varsayılanları kapalı ve açıklamada iki aşamalı opt-in var', () => {
    expect(ENV_FIELD_BY_KEY.get('AI_ASSISTANT_ENABLED')?.defaultValue).toBe('0');
    expect(ENV_FIELD_BY_KEY.get('LLM_CLASSIFIER_ENABLED')?.defaultValue).toBe('0');
    expect(ENV_FIELD_BY_KEY.get('SOURCE_LIVE_FETCH')?.help).toContain('AYRI AYRI');
    expect(ENV_FIELD_BY_KEY.get('SCHEDULER_ENABLED')?.help).toContain('KAPALIDIR');
  });
});
