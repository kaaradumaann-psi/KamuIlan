/**
 * Resmî sitelerin eksik sertifika zinciri (UNABLE_TO_VERIFY_LEAF_SIGNATURE) için güven deposu birleştirmesi.
 * Node'un sistem deposu API'si (tls.getCACertificates) mock'lanır; gerçek ağ çağrısı yapılmaz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCACertificates = vi.fn();
vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, getCACertificates: (...args: unknown[]) => getCACertificates(...args) };
});

// loadTrustBundle/describeTlsTrust HTTP istemcisinin dışa aktardığı yüzeydir
// (test:live ve adaptörler onu kullanır); override yardımı doğrudan tls-trust'tan gelir.
import { describeTlsTrust, loadTrustBundle, systemCaStoreAvailable } from '../src/sources/fetcher';
import { describeTlsVerificationOverride, tlsVerificationDisabled } from '../src/lib/tls-trust';

describe('TLS güven deposu birleştirmesi', () => {
  // Geliştirici makinesinde NODE_TLS_REJECT_UNAUTHORIZED=0 tanımlı olabilir
  // (Windows'ta kalıcı kullanıcı değişkeni). Testin sonucu kabuğa bağlı
  // olmamalı: anahtar burada bilinçli olarak temizlenir ve ayrı bir testte
  // davranışı doğrulanır.
  const originalOverride = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  beforeEach(() => {
    getCACertificates.mockReset();
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });
  afterEach(() => {
    if (originalOverride === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalOverride;
  });

  it('varsayılan ve sistem depolarını tekilleştirerek birleştirir (ara sertifika sistem deposunda olabilir)', () => {
    getCACertificates.mockImplementation((type: string) =>
      type === 'default' ? ['DEFAULT-ROOT', 'SHARED'] : ['SYSTEM-ROOT', 'SYSTEM-INTERMEDIATE', 'SHARED'],
    );
    const bundle = loadTrustBundle();
    expect(bundle).toEqual(['DEFAULT-ROOT', 'SHARED', 'SYSTEM-ROOT', 'SYSTEM-INTERMEDIATE']);
    expect(getCACertificates).toHaveBeenCalledWith('default');
    expect(getCACertificates).toHaveBeenCalledWith('system');
  });

  it('sistem deposu okunamazsa (ör. eski Node) güvenli biçimde tanımsız döner, çökmez', () => {
    getCACertificates.mockImplementation(() => {
      throw new Error('unsupported');
    });
    expect(loadTrustBundle()).toBeUndefined();
  });

  it('API varlığını ve TLS özetini raporlar', () => {
    expect(typeof systemCaStoreAvailable()).toBe('boolean');
    expect(describeTlsTrust()).toMatch(/^Node v?\d+/);
  });

  it('NODE_TLS_REJECT_UNAUTHORIZED=0 doğrulamayı kapatır ve özet bunu ÖNE çıkarır', () => {
    expect(tlsVerificationDisabled({})).toBe(false);
    expect(tlsVerificationDisabled({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toBe(false);
    expect(tlsVerificationDisabled({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBe(true);
    expect(describeTlsVerificationOverride({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toBeNull();

    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const described = describeTlsTrust();
    expect(described).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED=0 etkin/);
    expect(described).toMatch(/KAPALI/);
    // Güven deposu bilgisi artık anlamsız: özet "Node v..." ile BAŞLAMAZ.
    expect(described.startsWith('Node')).toBe(false);
    // Kaldırma adımları çalışılan platforma göre verilir.
    const override = describeTlsVerificationOverride();
    expect(override).toMatch(process.platform === 'win32' ? /setx NODE_TLS_REJECT_UNAUTHORIZED/ : /unset NODE_TLS_REJECT_UNAUTHORIZED/);
    // Doğrulamayı kapatmak önerilmez: çözüm CA/zincir tamamlamaktır.
    expect(override).toMatch(/POSTGRES_SSL_CA_MERGE_SYSTEM=1/);
    expect(override).toMatch(/NODE_EXTRA_CA_CERTS/);
  });
});
