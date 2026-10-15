/**
 * Resmî sitelerin eksik sertifika zinciri (UNABLE_TO_VERIFY_LEAF_SIGNATURE) için güven deposu birleştirmesi.
 * Node'un sistem deposu API'si (tls.getCACertificates) mock'lanır; gerçek ağ çağrısı yapılmaz.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCACertificates = vi.fn();
vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, getCACertificates: (...args: unknown[]) => getCACertificates(...args) };
});

import { describeTlsTrust, loadTrustBundle, systemCaStoreAvailable } from '../src/sources/fetcher';

describe('TLS güven deposu birleştirmesi', () => {
  beforeEach(() => {
    getCACertificates.mockReset();
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
});
