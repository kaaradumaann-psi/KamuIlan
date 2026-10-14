import { describe, expect, it } from 'vitest';
import { absoluteUrl, loadHtml, readableAnnouncementText, stripPageChrome } from '../src/lib/html';

describe('HTML link and announcement helpers', () => {
  it('uses same-origin base hrefs for relative links', () => {
    const $ = loadHtml('<base href="/arsiv/2026/"><a href="duyuru.htm">İlan</a>');
    expect(absoluteUrl('duyuru.htm', 'https://www.example.gov.tr/ilanlar/', $)).toBe(
      'https://www.example.gov.tr/arsiv/2026/duyuru.htm',
    );
  });

  it('ignores cross-origin and malformed base href values', () => {
    const offsite = loadHtml('<base href="https://attacker.example/"><a href="/ilan/123">İlan</a>');
    const malformed = loadHtml('<base href="http://[::1"><a href="/ilan/123">İlan</a>');
    expect(absoluteUrl('/ilan/123', 'https://www.example.gov.tr/liste', offsite)).toBe(
      'https://www.example.gov.tr/ilan/123',
    );
    expect(absoluteUrl('/ilan/123', 'https://www.example.gov.tr/liste', malformed)).toBe(
      'https://www.example.gov.tr/ilan/123',
    );
  });

  it('rejects active, non-web, and credential-bearing links', () => {
    const $ = loadHtml('');
    expect(absoluteUrl('javascript:alert(1)', 'https://www.example.gov.tr/', $)).toBeNull();
    expect(absoluteUrl('data:text/html,hello', 'https://www.example.gov.tr/', $)).toBeNull();
    expect(absoluteUrl('https://user:pass@example.gov.tr/path', 'https://www.example.gov.tr/', $)).toBeNull();
  });

  it('removes navigation and hidden chrome from announcement text', () => {
    const $ = loadHtml(
      '<body><nav>Menü içeriği</nav><main><article><h1>Personel alımı</h1><p>Başvuru şartları ve son tarih duyurunun içindedir.</p><div hidden>Gizli içerik</div></article></main></body>',
    );
    const text = readableAnnouncementText($, ['article', 'main', 'body'], 1_000);
    expect(text).toContain('Personel alımı');
    expect(text).toContain('Başvuru şartları');
    expect(text).not.toContain('Menü içeriği');
    expect(text).not.toContain('Gizli içerik');

    stripPageChrome($.root());
    expect($.root().text()).not.toContain('Menü içeriği');
  });
});
