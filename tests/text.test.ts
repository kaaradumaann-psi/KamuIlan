import { describe, expect, it } from 'vitest';
import { makeExcerpt } from '../src/domain/text';

describe('makeExcerpt contact redaction', () => {
  it('redacts common e-mail and Turkish phone formats', () => {
    const excerpt = makeExcerpt(
      'İletişim: ik@example.gov.tr, +90 (312) 555-12-34; 0 555 123 45 67; 0850 123 45 67; 444 0 632.',
    );

    expect(excerpt).toContain('[e-posta gizlendi]');
    expect(excerpt.match(/\[telefon gizlendi\]/g)).toHaveLength(4);
    expect(excerpt).not.toContain('ik@example.gov.tr');
    expect(excerpt).not.toContain('+90 (312) 555-12-34');
    expect(excerpt).not.toContain('0 555 123 45 67');
    expect(excerpt).not.toContain('0850 123 45 67');
    expect(excerpt).not.toContain('444 0 632');
  });

  it('does not mistake Turkish dates or plain announcement references for phone numbers', () => {
    const notice = 'İlan tarihi 12.10.2026, son başvuru 20.10.2026, ilan no 2026/123456.';
    expect(makeExcerpt(notice)).toBe(notice);
  });

  it('applies redaction before enforcing the excerpt length limit', () => {
    const excerpt = makeExcerpt(
      `${'A'.repeat(40)} ik@example.gov.tr +90 (312) 555-12-34 ${'B'.repeat(40)}`,
      48,
    );
    expect(excerpt.length).toBeLessThanOrEqual(48);
    expect(excerpt).not.toContain('ik@example.gov.tr');
    expect(excerpt).not.toContain('+90 (312) 555-12-34');
  });
});
