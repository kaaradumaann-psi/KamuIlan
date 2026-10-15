/**
 * SMTP TLS doğrulaması (güvenlik denetimi 2026-10-15).
 *
 * Bulgu: `tls: { rejectUnauthorized: NODE_ENV === 'production' }` — doğrulama
 * geliştirmede KAPALIYDI. STARTTLS'e düşen bağlantıda sunucu sertifikası
 * denetlenmediği için SMTP_USER/SMTP_PASS ortadaki adama açık kalıyordu
 * (Postgres için kabul edilmeyen `no-verify` davranışının e-posta karşılığı).
 * Çözüm: doğrulama varsayılan açık; yalnızca açık `SMTP_TLS_INSECURE=1` kapatır
 * ve bu üretimde başlangıcı durduran, diğer ortamlarda uyarı üreten bir karardır.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getEnv, inspectEnvironment, resetEnvCache } from '../src/config/env';
import { envFieldKeys } from '../src/config/env-spec';
import { smtpTlsOptions } from '../src/email/transport';

afterEach(() => {
  delete process.env.SMTP_TLS_INSECURE;
  resetEnvCache();
});

describe('smtpTlsOptions', () => {
  it('varsayılan olarak sertifika doğrulaması açıktır', () => {
    expect(smtpTlsOptions(getEnv()).rejectUnauthorized).toBe(true);
  });

  it('NODE_ENV=test iken de açıktır (ortama bağlı değil)', () => {
    expect(getEnv().NODE_ENV).not.toBe('production');
    expect(smtpTlsOptions(getEnv()).rejectUnauthorized).toBe(true);
  });

  it('SMTP_TLS_INSECURE=1 doğrulamayı kapatır', () => {
    process.env.SMTP_TLS_INSECURE = '1';
    resetEnvCache();
    expect(smtpTlsOptions(getEnv()).rejectUnauthorized).toBe(false);
  });

  it('SMTP_TLS_INSECURE=true doğrulamayı kapatır,diğer değerler kapatmaz', () => {
    process.env.SMTP_TLS_INSECURE = 'true';
    resetEnvCache();
    expect(smtpTlsOptions(getEnv()).rejectUnauthorized).toBe(false);

    process.env.SMTP_TLS_INSECURE = '0';
    resetEnvCache();
    expect(smtpTlsOptions(getEnv()).rejectUnauthorized).toBe(true);
  });

  it('doğrudan nesne ile çağrılabilir (saf fonksiyon)', () => {
    expect(smtpTlsOptions({ SMTP_TLS_INSECURE: false }).rejectUnauthorized).toBe(true);
    expect(smtpTlsOptions({ SMTP_TLS_INSECURE: true }).rejectUnauthorized).toBe(false);
  });
});

describe('ortam denetimi', () => {
  it('geliştirmede yüksek sesli uyarı üretir', () => {
    process.env.SMTP_TLS_INSECURE = '1';
    resetEnvCache();
    const inspection = inspectEnvironment(getEnv());
    expect(inspection.warnings.join(' ')).toContain('SMTP_TLS_INSECURE=1');
    expect(inspection.warnings.join(' ')).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('üretimde engelleyici sorundur', () => {
    process.env.SMTP_TLS_INSECURE = '1';
    resetEnvCache();
    const env = { ...getEnv(), NODE_ENV: 'production' as const, APP_SECRET: 'a'.repeat(48) };
    const inspection = inspectEnvironment(env);
    expect(inspection.ok).toBe(false);
    expect(inspection.problems.join(' ')).toContain('SMTP_TLS_INSECURE=1');
  });

  it('anahtar sihirbaz kataloğunda tanımlıdır', () => {
    expect(envFieldKeys()).toContain('SMTP_TLS_INSECURE');
  });
});
