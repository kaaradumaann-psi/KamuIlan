import { describe, expect, it } from 'vitest';
import { describeSectionPage, resmiGazeteSectionUrl } from '../src/sources/adapters/resmigazete';

const PAGE_URL = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261014-4.htm';

describe('Resmî Gazete bölüm adresi ve teşhis (probe ile adaptör aynı kod)', () => {
  it('bölüm adresini adaptörle aynı biçimde üretir', () => {
    expect(resmiGazeteSectionUrl('2026-10-14')).toBe(PAGE_URL);
  });

  it('PDF satırlarını ve ayrıştırılan satır sayısını raporlar', () => {
    const html = `<!doctype html><html><head><title>Resmî Gazete</title></head><body>
      <div id="html-content"><table>
        <tr><td>Karamanoğlu Mehmetbey Üniversitesi Rektörlüğünden: Personel alım ilanı
          <a href="/ilanlar/eskiilanlar/2026/10/20261014-4-4.pdf">PDF</a></td></tr>
        <tr><td>Tarım ve Orman Bakanlığından: Sözleşmeli personel alınacaktır
          <a href="/ilanlar/eskiilanlar/2026/10/20261014-4-5.pdf">PDF</a></td></tr>
      </table></div></body></html>`;
    const diagnostics = describeSectionPage(html, PAGE_URL);
    expect(diagnostics.title).toBe('Resmî Gazete');
    expect(diagnostics.htmlContentPresent).toBe(true);
    expect(diagnostics.pdfLinkCount).toBe(2);
    expect(diagnostics.parsedRows).toBe(2);
    expect(diagnostics.challengeHint).toBe(false);
  });

  it('engel/doğrulama sayfasını PDF çıkarmadan işaretler', () => {
    const html = `<!doctype html><html><head><title>Just a moment...</title></head><body>
      <h1>Access denied</h1><p>Please complete the captcha to continue.</p></body></html>`;
    const diagnostics = describeSectionPage(html, PAGE_URL);
    expect(diagnostics.parsedRows).toBe(0);
    expect(diagnostics.pdfLinkCount).toBe(0);
    expect(diagnostics.challengeHint).toBe(true);
  });

  it('içerik saklamaz: teşhis alanları sınırlı uzunlukta metin döndürür', () => {
    const html = `<html><body>${'Menü metni '.repeat(200)}</body></html>`;
    const diagnostics = describeSectionPage(html, PAGE_URL);
    expect(diagnostics.textHead.length).toBeLessThanOrEqual(160);
  });
});
