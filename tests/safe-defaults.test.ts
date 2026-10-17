import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_FIELD_BY_KEY } from '../src/config/env-spec';

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

  it('AI varsayılanları kapalı ve açıklamada iki aşamalı opt-in var', () => {
    expect(ENV_FIELD_BY_KEY.get('AI_ASSISTANT_ENABLED')?.defaultValue).toBe('0');
    expect(ENV_FIELD_BY_KEY.get('LLM_CLASSIFIER_ENABLED')?.defaultValue).toBe('0');
    expect(ENV_FIELD_BY_KEY.get('SOURCE_LIVE_FETCH')?.help).toContain('AYRI AYRI');
    expect(ENV_FIELD_BY_KEY.get('SCHEDULER_ENABLED')?.help).toContain('KAPALIDIR');
  });
});
