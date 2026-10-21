/**
 * PDF metni: Türkçe harflerin ayrı parça gelmesi kelimeleri bölmemeli.
 *
 * Kanıt: RG 16.10.2026-4-14 (Bursa Uludağ Ü. öğretim üyesi ilanı) eski çıkarıcıyla
 * "İ KT İ SAD İ", "Ö Ğ RET İ M ÜYES İ", "Doçentli ğ ini" biçiminde 554 kopukluk
 * içeriyordu (tablo hücrelerinde metin döndürülmüş). Diğer 17 örnek belge
 * yeni çıkarıcıyla bayt düzeyinde aynı kaldı (yerel karşılaştırma, 22.10.2026).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdfText, joinPdfTextItems, type PdfTextItem } from '../src/extraction/pdf';

/** Yatay metin: x'te ilerler; boyut 10. */
const h = (str: string, x: number, width: number, y = 700): PdfTextItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
});
/** Döndürülmüş metin (a=d=0): y'de ilerler. */
const v = (str: string, y: number, width: number, x = 100): PdfTextItem => ({
  str,
  transform: [0, 10, -10, 0, x, y],
  width,
  height: 10,
});

describe('joinPdfTextItems', () => {
  it('bitişik parçaları boşluksuz, aralıklı parçaları boşlukla birleştirir', () => {
    expect(joinPdfTextItems([h('Doçentli', 0, 40), h('ğ', 40, 5), h('ini', 45, 12), h('almış', 60, 25)])).toBe(
      'Doçentliğini almış',
    );
  });

  it('döndürülmüş metinde yön dönüşüm matrisinden okunur', () => {
    expect(joinPdfTextItems([v('ÖĞRET', 0, 30), v('İ', 30, 4), v('M', 34, 8), v('ÜYES', 45, 22), v('İ', 67, 4)])).toBe(
      'ÖĞRETİM ÜYESİ',
    );
  });

  it('farklı satır ya da konum bilgisi yoksa eski davranış: tek boşluk', () => {
    expect(joinPdfTextItems([h('Birinci', 0, 35), h('satır', 0, 25, 680)])).toBe('Birinci satır');
    expect(joinPdfTextItems([{ str: 'konumsuz' }, { str: 'parça' }])).toBe('konumsuz parça');
    expect(joinPdfTextItems([h('son', 0, 15), { str: '', hasEOL: true }, h('yeni', 0, 20, 680)])).toBe('son\nyeni');
  });
});

describe('gerçek PDF: RG 16.10.2026-4-14', () => {
  it('Türkçe harf kopukluğu kalmaz; tablo başlıkları ve unvanlar bütün okunur', async () => {
    const pdf = new Uint8Array(readFileSync(join(process.cwd(), 'fixtures/pdf/gercek/rg-20261016-4-14.pdf')));
    const { text, noTextLayer } = await extractPdfText(pdf);
    expect(noTextLayer).toBe(false);
    const splits = text.match(/[A-Za-zÇĞİÖŞÜçğıöşü] [ğışçöüİĞŞÇÖÜ] [A-Za-zÇĞİÖŞÜçğıöşü]/gu) ?? [];
    expect(splits).toEqual([]);
    for (const word of ['İKTİSADİ', 'ÖĞRETİM', 'ÜYESİ', 'Doçentliğini', 'HEMŞİRELİK']) expect(text).toContain(word);
  }, 60_000);
});
