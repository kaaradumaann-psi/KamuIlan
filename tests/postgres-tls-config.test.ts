/**
 * Veritabanı TLS yapılandırması: CA verilince doğrulama açık; CA yoksa mevcut davranış korunur
 * ve bu durum ortam uyarısıyla raporlanır. Doğrulamayı sessizce kapatan yeni bir yol eklenmedi.
 */
import { describe, expect, it } from 'vitest';
import { sslConfigFor } from '../src/db/postgres-store';

describe('veritabanı TLS yapılandırması', () => {
  it('CA verilirse sunucu sertifikası doğrulanır', () => {
    const config = sslConfigFor('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
    expect(config).toMatchObject({ rejectUnauthorized: true });
    expect('ca' in config && config.ca).toContain('BEGIN CERTIFICATE');
  });

  it('boş CA dizgisi doğrulamayı açmaz (eski davranış, uyarı ile raporlanır)', () => {
    expect(sslConfigFor('   ')).toEqual({ rejectUnauthorized: false });
    expect(sslConfigFor(undefined)).toEqual({ rejectUnauthorized: false });
  });
});
