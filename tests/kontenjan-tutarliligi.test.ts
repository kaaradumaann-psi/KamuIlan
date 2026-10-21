/**
 * Kontenjan: metindeki sayı ↔ kadro tablosu toplamı (gerçek RG metinleri).
 *
 * Kanıt (RG 14.10.2026-4-9, Keşan Belediyesi): kadro tablosu 2 kadro (toplam 2)
 * içerirken kontenjan "Son altı ay içerisinde çekilmiş 3 adet vesikalık fotoğraf"
 * cümlesinden 3 okunuyordu; kart "3 kişi" gösteriyordu.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract, extractQuota } from '../src/extraction/engine';

const kadro = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-kadro-tablolari.json'), 'utf8'),
) as { items: { id: string; text: string }[] };
const kesan = kadro.items.find((item) => item.id === 'rg-20261014-4-9')?.text ?? '';

function run(body: string) {
  return extract({
    title: 'Edirne İli Keşan Belediye Başkanlığından: Memur Alım İlanı',
    body,
    listing: {},
    links: [],
    attachments: [],
    bodySource: 'document',
  } as never);
}

describe('extractQuota — belge adedi kontenjan değildir', () => {
  it('"3 adet vesikalık fotoğraf" ve benzeri belge adetleri sayılmaz', () => {
    expect(extractQuota('e) Son altı ay içerisinde çekilmiş 3 adet vesikalık fotoğraf, (1 adedi forma yapıştırılacak)')).toBeNull();
    expect(extractQuota('Profesör kadrosu için 6 (altı) adet dijital dosya ile birlikte başvurulur.')).toBeNull();
    expect(extractQuota('2 adet fotokopi ve 1 adet dosya')).toBeNull();
    // Belge listesi biçimi (RG 16.10-4-14, 20.10-4-9).
    expect(extractQuota('6- Sabıka Kaydı (1 adet) (x) 7- Onaylı Hizmet Belgesi')).toBeNull();
    expect(extractQuota('başvuru formu) (1 adet), - Özgeçmiş (2 adet)')).toBeNull();
    expect(extractQuota('Profesör kadrosu adayları 6 adet, Doçent ve Dr.Öğretim Üyesi kadrosu adayları 4 adet dijital dosya')).toBeNull();
    // RG 15.10.2026-4-10 (Atatürk Ü.): eski kod 2, ilk düzeltme 4 okuyordu; ilanda toplam yok.
    expect(
      extractQuota('öğrenim belgeleri ve 2 adet fotoğraf içeren 4 takım dijital dosya (4 adet USB/CD/DVD) halinde teslim edeceklerdir.'),
    ).toBeNull();
  });

  it('gerçek kontenjan ifadeleri korunur; belge adedinden sonra gelen kontenjan bulunur', () => {
    expect(extractQuota('Kurumumuza 5 adet sözleşmeli personel alınacaktır.')?.value).toBe(5);
    expect(extractQuota('Belediyemize 1 adet Zabıta Memuru kadrosu için alım yapılacaktır.')?.value).toBe(1);
    expect(extractQuota('Hemşire (5 kişi) alınacaktır.')?.value).toBe(5);
    expect(extractQuota('3 adet vesikalık fotoğraf. Toplam 12 kişi alınacaktır.')?.value).toBe(12);
  });
});

describe('kadro tablosu ↔ kontenjan', () => {
  it('gerçek tablo: kontenjan tablo toplamıdır (belge adedi değil)', () => {
    const result = run(`${kesan}\ne) Son altı ay içerisinde çekilmiş 3 adet vesikalık fotoğraf.`);
    const total = result.openings.reduce((sum, opening) => sum + opening.quota, 0);
    expect(result.openings.length).toBeGreaterThan(0);
    expect(result.quota).toBe(total);
  });

  it('metindeki kontenjan tabloyla uyuşmazsa tablo toplamı gösterilir ve tutarsızlık açıkça yazılır', () => {
    const result = run(`${kesan}\nBelediyemize toplam 7 personel alınacaktır.`);
    const total = result.openings.reduce((sum, opening) => sum + opening.quota, 0);
    expect(result.quota).toBe(total);
    expect(result.uncertainties.join(' ')).toContain(`metinde 7 geçiyor, kadro tablosunun toplamı ${total}`);
  });

  it('tablo yoksa metindeki kontenjan kullanılır, tutarsızlık notu yazılmaz', () => {
    const result = run('Belediyemize 4/B sözleşmeli toplam 7 personel alınacaktır. Son başvuru 30.10.2026.');
    expect(result.openings).toHaveLength(0);
    expect(result.quota).toBe(7);
    expect(result.uncertainties.join(' ')).not.toContain('tutarsız');
  });
});
