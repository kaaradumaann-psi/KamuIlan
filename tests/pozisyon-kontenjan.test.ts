/**
 * Bakanlık/kurum ilanlarında pozisyon başına kontenjan ("N. Unvan" + "(K Kişi – …)").
 *
 * Eski davranış: Sayıştay (RG 16.10.2026-4-1) ilanında resmî toplam (2) okunuyordu ama
 * pozisyon kırılımı (`openings`) boştu; detayda hangi pozisyona kaç kişi alındığı yoktu.
 * Gerçek metin: `fixtures/gercek-ilanlar/2026-10-akademik-kadro-tablolari.json` (kurumsal
 * metin, kişi verisi yok). Diğer örnekler sentetiktir (kural sınırları).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractOpenings, extractPositionOpenings } from '../src/extraction/openings';
import { extract } from '../src/extraction/engine';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-akademik-kadro-tablolari.json'), 'utf8'),
) as { items: { id: string; text: string }[] };
const sayistay = fixture.items.find((item) => item.id === 'rg-20261016-4-1')?.text ?? '';

const run = (body: string) =>
  extract({ title: 'Kamu Kurumu Personel Alım İlanı', body, listing: {}, links: [], attachments: [], bodySource: 'document' } as never);

describe('extractPositionOpenings — gerçek Sayıştay ilanı', () => {
  it('iki pozisyon, her biri 1 kişi, kanıt satırıyla', () => {
    const rows = extractOpenings(sayistay);
    expect(rows).toEqual([
      expect.objectContaining({
        title: 'Kıdemli .Net Yazılım Geliştirme Uzmanı ve Çözüm Mimarı (B Grubu)',
        quota: 1,
        serviceClass: null,
        degree: null,
      }),
      expect.objectContaining({ title: 'Yazılım Geliştirme Uzmanı (.Net) (D Grubu)', quota: 1 }),
    ]);
    expect(rows[0]?.evidence).toContain('(1 Kişi');
  });

  it('kontenjan resmî toplamla aynı (2) ve tutarsızlık notu yok', () => {
    const result = run(sayistay);
    expect(result.quota).toBe(2);
    expect(result.openings).toHaveLength(2);
    expect(result.uncertainties.join(' ')).not.toContain('Kontenjan tutarsız');
  });
});

describe('extractPositionOpenings — kural sınırları (sentetik)', () => {
  it('resmî toplam pozisyon toplamından farklıysa tutarsızlık kaydedilir (sessizce ezilmez)', () => {
    const body = [
      'Kurumumuza 3 (üç) Sözleşmeli Bilişim Personeli alınacaktır.',
      '1. Sistem Uzmanı (B Grubu)',
      '(1 Kişi – Tam Zamanlı)',
      'a) şart',
      '2. Ağ Uzmanı (C Grubu)',
      '(1 Kişi – Tam Zamanlı)',
    ].join('\n');
    const result = run(body);
    expect(result.openings).toHaveLength(2);
    expect(result.uncertainties.join(' ')).toContain('Kontenjan tutarsız: metinde 3');
  });

  it('başlık iki satıra bölünmüşse birleştirilir; büyük harf "KİŞİ" okunur', () => {
    const rows = extractPositionOpenings(
      ['1. Kıdemli Veri Tabanı Yöneticisi', 've Sistem Mimarı (A Grubu)', '(2 KİŞİ – Tam Zamanlı)', '2. Yazılım Uzmanı', '(3 Kişi)'].join('\n'),
    );
    expect(rows.map((row) => [row.title, row.quota])).toEqual([
      ['Kıdemli Veri Tabanı Yöneticisi ve Sistem Mimarı (A Grubu)', 2],
      ['Yazılım Uzmanı', 3],
    ]);
  });

  it('numaralar ardışık değilse hiç pozisyon üretilmez', () => {
    expect(extractPositionOpenings(['1. Uzman', '(1 Kişi)', '3. Uzman', '(1 Kişi)'].join('\n'))).toEqual([]);
  });

  it('"Kişi" satırı olmayan numaralı maddeler pozisyon sayılmaz', () => {
    expect(extractPositionOpenings(['1. Başvuru şartları', 'a) şart', '2. Belgeler', '(3 adet vesikalık fotoğraf)'].join('\n'))).toEqual([]);
  });

  it('sınır dışı kişi sayısı (0) pozisyonları geçersiz kılar', () => {
    expect(extractPositionOpenings(['1. Uzman', '(0 Kişi)'].join('\n'))).toEqual([]);
  });
});
