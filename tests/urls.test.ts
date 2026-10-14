import { describe, expect, it } from 'vitest';
import { assertFetchableUrl, isOfficialApplicationUrl } from '../src/domain/urls';

describe('URL source-host validation', () => {
  it('uses parsed, boundary-checked official application hosts', () => {
    expect(isOfficialApplicationUrl('https://kariyerkapisi.gov.tr/isealim')).toBe(true);
    expect(isOfficialApplicationUrl('https://sub.turkiye.gov.tr/basvuru')).toBe(true);
    expect(isOfficialApplicationUrl('https://evil.example/?next=turkiye.gov.tr')).toBe(false);
    expect(isOfficialApplicationUrl('https://turkiye.gov.tr.evil.example/basvuru')).toBe(false);
    expect(isOfficialApplicationUrl('https://user:pass@turkiye.gov.tr/basvuru')).toBe(false);
    expect(isOfficialApplicationUrl('javascript:alert(1)')).toBe(false);
  });

  it('uses exact allowlisted hosts and blocks numeric addresses and nonstandard ports', () => {
    expect(
      assertFetchableUrl('https://www.ilan.gov.tr/ilanlar', { allowHosts: ['www.ilan.gov.tr'] }).hostname,
    ).toBe('www.ilan.gov.tr');
    expect(() =>
      assertFetchableUrl('https://sub.ilan.gov.tr/ilanlar', { allowHosts: ['ilan.gov.tr'] }),
    ).toThrow();
    expect(() => assertFetchableUrl('http://2130706433/')).toThrow();
    expect(() => assertFetchableUrl('https://example.gov.tr:8443/')).toThrow();
  });
});
