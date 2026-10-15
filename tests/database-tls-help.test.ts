import { describe, expect, it } from 'vitest';
import { databaseTlsHelp } from '../src/lib/tls-trust';

describe('veritabanı TLS hata yönlendirmesi', () => {
  it.each([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ])('%s için proje CA kurulumu gösterir, sırları yazmaz', (code) => {
    const error = Object.assign(new Error('postgres://user:secret@private-host/db'), { code });
    const help = databaseTlsHelp(error);
    expect(help).toContain('POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt');
    expect(help).toContain('POSTGRES_SSL_MODE=verify');
    expect(help).toContain('docs/database-tls.md');
    expect(help).not.toMatch(/secret|private-host|postgres:\/\//);
  });

  it('süre dolması için yanlışlıkla CA eklemeyi önermez', () => {
    const error = Object.assign(new Error('private'), { code: 'CERT_HAS_EXPIRED' });
    expect(databaseTlsHelp(error)).toContain('süresi dolmuş');
    expect(databaseTlsHelp(error)).not.toContain('POSTGRES_SSL_CA_FILE');
  });

  it('ad uyuşmazlığı için bağlantı adresinin kontrolünü önerir', () => {
    const error = Object.assign(new Error('private'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(databaseTlsHelp(error)).toContain('POSTGRES_URL');
    expect(databaseTlsHelp(error)).not.toContain('POSTGRES_SSL_CA_FILE');
  });

  it.each([null, 'SELF_SIGNED_CERT_IN_CHAIN', new Error('secret'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }, Object.assign(new Error('secret'), { code: '23505' })])(
    'TLS dışı veya bilinmeyen hata için ham mesaj yazmaz (%s)', (error) => {
      expect(databaseTlsHelp(error)).toBeUndefined();
    },
  );
});
