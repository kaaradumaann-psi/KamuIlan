/**
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` bekçisi.
 *
 * Kullanıcının yaşadığı gerçek durum: sertifika hatalarını "görebilmek" için
 * bu anahtarı kabuğa/kullanıcı değişkenlerine yazmak. Anahtar açıkken
 * `npm run test:live` ve taramalar BAŞARILI görünür, ama bu sitelerin
 * çalıştığını değil, hiçbir sertifikanın denetlenmediğini gösterir. Bu yüzden:
 *
 *  - Üretimde uygulama BAŞLAMAZ (fail-closed).
 *  - Diğer ortamlarda yüksek sesli uyarı + kaldırma adımları yazılır.
 *  - `describeEnv()` özeti `tlsVerification: KAPALI` satırını taşır
 *    (env:check, env:setup, worker başlangıcı, /health aynı satırı gösterir).
 *  - Sihirbaz bu değeri riskli karar sayar: `!` öneki olmadan yazmaz.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeEnv, getEnv, inspectEnvironment, resetEnvCache } from '../src/config/env';
import { processAnswer, riskyDecision } from '../src/config/env-prompt';
import { ENV_FIELD_BY_KEY } from '../src/config/env-spec';
import { describeTlsVerificationOverride, tlsVerificationDisabled } from '../src/lib/tls-trust';
import type { PromptPlanStep } from '../src/config/env-prompt';

const BASE = {
  NODE_ENV: 'development',
  APP_SECRET: 'a'.repeat(40),
  DATABASE_DRIVER: 'file',
  EMAIL_PROVIDER: 'file',
};

/** Üretim kurallarını (kalıcı DB + gerçek e-posta sağlayıcısı) sağlayan temel. */
const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  APP_SECRET: 'a'.repeat(40),
  DATABASE_DRIVER: 'supabase',
  POSTGRES_URL: 'postgres://postgres.ref:gizli-parola@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_anahtar',
  EMAIL_FROM: 'bildirim@ornek.com.tr',
  APP_BASE_URL: 'https://ornek.com.tr',
};

function stepFor(key: string, values: Record<string, string> = {}): PromptPlanStep {
  const field = ENV_FIELD_BY_KEY.get(key);
  if (!field) throw new Error(`katalogda yok: ${key}`);
  return { field, group: field.group, current: values[key] ?? '', required: false, applicable: true };
}

describe('NODE_TLS_REJECT_UNAUTHORIZED bekçisi', () => {
  const original = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];

  beforeEach(() => {
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    resetEnvCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = original;
    resetEnvCache();
  });

  it('geliştirmede uyarıdır; kaldırma adımları platforma göre yazılır', () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const inspection = inspectEnvironment(getEnv({ ...BASE }), {});
    expect(inspection.ok).toBe(true);
    const text = inspection.warnings.join('\n');
    expect(text).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED=0 etkin/);
    expect(text).toMatch(process.platform === 'win32' ? /setx NODE_TLS_REJECT_UNAUTHORIZED/ : /unset NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('üretimde SORUNdur: getEnv() fırlar (uygulama başlamaz)', () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const production = { ...PRODUCTION_BASE };
    let message = '';
    try {
      getEnv(production);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED=0/);
    expect(message).toMatch(/POSTGRES_SSL_CA_MERGE_SYSTEM=1|NODE_EXTRA_CA_CERTS/);
    // Anahtar kaldırılınca aynı yapılandırma sorunsuz geçer.
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    expect(() => getEnv(production)).not.toThrow();
  });

  it('anahtar kapalıyken hiçbir uyarı üretilmez', () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    expect(tlsVerificationDisabled()).toBe(false);
    const inspection = inspectEnvironment(getEnv({ ...BASE }), {});
    expect(inspection.warnings.join('\n')).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(describeTlsVerificationOverride()).toBeNull();
    expect(describeEnv(getEnv({ ...BASE }))).toMatchObject({ tlsVerification: 'açık' });
  });

  it('describeEnv özeti doğrulamanın KAPALI olduğunu söyler', () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const env = getEnv({ ...BASE });
    // tests/setup.ts tarayıcı yedeğini kapatır (Chromium gerçek ağa çıkmasın).
    expect(describeEnv(env)).toMatchObject({
      tlsVerification: 'KAPALI (NODE_TLS_REJECT_UNAUTHORIZED=0)',
      browserFallback: 'kapalı',
    });
    expect(describeEnv(getEnv({ ...BASE, SOURCE_BROWSER_FALLBACK: '1' }))).toMatchObject({
      browserFallback: 'açık (Chromium)',
    });
    // Sır/değer sızıntısı yok: özet yalnızca durumu taşır.
    expect(JSON.stringify(describeEnv(env))).not.toContain('a'.repeat(40));
  });

  it('katalog alanı olarak tanımlı ve riskli karar sayılır', () => {
    const field = ENV_FIELD_BY_KEY.get('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(field).toBeDefined();
    expect(field?.outsideSchema).toBe(true);
    expect(riskyDecision(field!, '0')).toMatch(/doğrulamasını TÜM süreçte kapatır/);
    expect(riskyDecision(field!, '1')).toBeNull();

    const first = processAnswer(stepFor('NODE_TLS_REJECT_UNAUTHORIZED'), '0', {});
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/!0/);
    // Bilinçli kabul: "!" öneki ile yazılabilir (kullanıcı sorumluluğu belgelenir).
    expect(processAnswer(stepFor('NODE_TLS_REJECT_UNAUTHORIZED'), '!0', {})).toMatchObject({ ok: true, value: '0' });
    // Asıl çözüm: alanı boşaltmak (anahtarı .env'den kaldırır).
    expect(processAnswer(stepFor('NODE_TLS_REJECT_UNAUTHORIZED', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }), ':clear', {})).toMatchObject({
      ok: true,
      value: '',
    });
    // Geçersiz değer reddedilir.
    expect(processAnswer(stepFor('NODE_TLS_REJECT_UNAUTHORIZED'), 'yes', {}).ok).toBe(false);
  });
});
