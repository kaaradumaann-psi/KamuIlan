/**
 * PDF testleri: metin katmanı çıkarımı, taranmış PDF davranışı, bozuk dosya.
 *
 * Gerçek kaynaklara istek atılmaz; fixture dosyaları depodan okunur.
 * Fixture'lar `npm run fixtures:pdf` ile yeniden üretilebilir.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdfText, looksLikeAnnouncementPdf, normalizePdfWhitespace } from '../src/extraction/pdf';
import { buildPdf, corruptPdf, sampleAnnouncementPdf, scannedAnnouncementPdf } from './support/pdf-fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'fixtures', 'pdf');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

describe('PDF metin çıkarımı', () => {
  it('gerçek PDF dosyasından metin katmanını okur', async () => {
    const result = await extractPdfText(fixture('ornek-ilan.pdf'));

    expect(result.error).toBeNull();
    expect(result.pages).toBe(1);
    expect(result.pagesRead).toBe(1);
    expect(result.noTextLayer).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('SOZLESMELI PERSONEL ALIM ILANI');
    expect(result.text).toContain('Kontenjan: 25 kisi');
    expect(result.text).toContain('30.10.2026 23:59');
    // Başlık /Info sözlüğünden gelir.
    expect(result.title).toContain('Ornek Universitesi');
    // Metin gerçekten ilan gibi görünüyor (panel göstergesi).
    expect(looksLikeAnnouncementPdf(result.text)).toBe(true);
  });

  it('taranmış (metin katmanı olmayan) PDF için OCR\'a zorlamaz, durumu bildirir', async () => {
    const result = await extractPdfText(fixture('taranmis-ornek.pdf'));

    expect(result.error).toBeNull();
    expect(result.pages).toBe(1);
    expect(result.noTextLayer).toBe(true);
    expect(result.text.trim()).toBe('');
  });

  it('bozuk PDF uygulamayı çökertmez, okunamadı hatası döner', async () => {
    const result = await extractPdfText(corruptPdf());

    expect(result.error).toBeTruthy();
    expect(result.error).toContain('PDF okunamadı');
    expect(result.text).toBe('');
    expect(result.noTextLayer).toBe(true);
  });

  it('PDF olmayan içerik ve boş dosya için anlaşılır hata verir', async () => {
    const notPdf = await extractPdfText(new Uint8Array(Buffer.from('merhaba, bu bir pdf degil', 'latin1')));
    expect(notPdf.error).toContain('PDF biçiminde değil');

    const empty = await extractPdfText(new Uint8Array());
    expect(empty.error).toContain('boş');
  });

  it('uzun PDF metnini sınırlar ve kırpıldığını bildirir', async () => {
    const longPdf = buildPdf({
      lines: Array.from({ length: 40 }, (_item, index) => `Satir ${index + 1}: personel alim ilani basvuru bilgisi`),
    });
    const result = await extractPdfText(longPdf, { maxChars: 120 });

    expect(result.error).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120);
  });

  it('satır sonu tirelemesini ve fazla boşlukları düzeltir', () => {
    expect(normalizePdfWhitespace('sözleş-\nmeli   personel\n\n\n\nilânı')).toBe('sözleşmeli personel\n\nilânı');
  });

  it('üretilen örnek fixture ile kayıtlı fixture tutarlıdır', async () => {
    // Fixture elle değiştirilirse bu test uyarır: testler üretimle aynı veriyi ölçsün.
    const expected = new Uint8Array(sampleAnnouncementPdf());
    const actual = fixture('ornek-ilan.pdf');
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);

    const expectedScanned = new Uint8Array(scannedAnnouncementPdf());
    const actualScanned = fixture('taranmis-ornek.pdf');
    expect(Buffer.from(actualScanned).equals(Buffer.from(expectedScanned))).toBe(true);
  });
});
