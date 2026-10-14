/**
 * Şehir çıkarımı: açık görev yeri ipucu öncelikli; ipucu yoksa yalnızca TEK il kabul edilir.
 * Birden çok ilin geçtiği ve görev yerinin belirtilmediği kayıtta il uydurulmaz (null).
 */
import { describe, expect, it } from 'vitest';
import { chooseCityFromText } from '../src/extraction/engine';

describe('chooseCityFromText', () => {
  it('açık görev yeri ipucunu öncelikler (birden çok il geçse bile)', () => {
    const result = chooseCityFromText(
      'Sözleşmeli Bilişim Personeli Alımı',
      'Kurum merkezi Ankara’dadır. Görev yeri: İzmir olarak belirlenmiştir. Başvurular 01.10.2026 - 30.10.2026.',
    );
    expect(result.city).toBe('İzmir');
    expect(result.byCue).toBe(true);
  });

  it('metinde tek il varsa onu kullanır', () => {
    const result = chooseCityFromText(
      'Memur Alım İlanı',
      'Konya İl Müdürlüğü bünyesinde 2 memur alınacaktır.',
    );
    expect(result.city).toBe('Konya');
    expect(result.byCue).toBe(false);
  });

  it('birden çok il geçiyor ve görev yeri yoksa il uydurulmaz', () => {
    const result = chooseCityFromText(
      'Kurum Duyurusu',
      'Ankara merkez teşkilatı ile İzmir ve Bursa birimlerinde personel ihtiyacı bulunmaktadır.',
    );
    expect(result.city).toBeNull();
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('il yoksa null döner', () => {
    expect(chooseCityFromText('Bilişim Personeli Alımı', 'Kadro unvanı bilişim personeli.').city).toBeNull();
  });
});
