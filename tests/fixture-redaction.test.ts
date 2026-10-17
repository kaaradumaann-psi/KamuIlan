import { describe, expect, it } from 'vitest';
import { scrubSnapshot, scrubSourceUrl } from '../src/sources/fixture-redaction';

describe('fixture redaction before local snapshot persistence', () => {
  it('drops all source URL query/fragment/credentials from provenance', () => {
    const safe = scrubSourceUrl('https://user:password@example.gov.tr/list?q=private&api_key=secret#fragment');

    expect(safe).toBe('https://example.gov.tr/list');
    expect(safe).not.toContain('password');
    expect(safe).not.toContain('private');
    expect(safe).not.toContain('secret');
    expect(safe).not.toContain('fragment');
  });

  it('redacts sensitive JSON fields while retaining nonsensitive contract fields', () => {
    const input = JSON.stringify({
      title: 'Personel alımı ilanı',
      email: 'candidate@example.test',
      phoneNumber: '+90 532 123 45 67',
      tckn: '12345678901',
      fullName: 'Aday Adı',
      apiKey: 'top-secret-token',
      details: { applicationUrl: 'https://example.gov.tr/apply?token=private-token' },
    });

    const result = scrubSnapshot(input);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    expect(parsed['title']).toBe('Personel alımı ilanı');
    expect(parsed['email']).toBe('[REDACTED]');
    expect(parsed['phoneNumber']).toBe('[REDACTED]');
    expect(parsed['tckn']).toBe('[REDACTED]');
    expect(parsed['fullName']).toBe('[REDACTED]');
    expect(parsed['apiKey']).toBe('[REDACTED]');
    expect(JSON.stringify(parsed)).not.toContain('candidate@example.test');
    expect(JSON.stringify(parsed)).not.toContain('top-secret-token');
    expect(JSON.stringify(parsed)).not.toContain('private-token');
    expect(result.notes).toContain('Otomatik scrub kişisel veriyi kusursuz tespit etmez; commit öncesi manuel PII/lisans/ToS incelemesi gerekir.');
  });

  it('redacts common email, mobile, identity and hidden input patterns from HTML/plain text', () => {
    const result = scrubSnapshot(
      '<p>email@example.test +90 532 123 45 67 12345678901</p>' +
        '<input type="hidden" name="session_token" value="session-secret">' +
        '<a href="/items?access_token=access-secret">Details</a>',
    );

    expect(result.text).not.toContain('email@example.test');
    expect(result.text).not.toContain('+90 532 123 45 67');
    expect(result.text).not.toContain('12345678901');
    expect(result.text).not.toContain('session-secret');
    expect(result.text).not.toContain('access-secret');
    expect(result.text).toContain('[EMAIL REDACTED]');
    expect(result.text).toContain('[PHONE REDACTED]');
  });
});
