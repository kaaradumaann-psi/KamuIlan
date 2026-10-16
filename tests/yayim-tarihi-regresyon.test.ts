/**
 * Yayım tarihi çıkarımı — KANITLI HATA REGRESYONU (16.10.2026 gerçek veri denetimi).
 *
 * Gerçek veritabanındaki kayıtlarda yayım tarihleri 2004/2008/2013/2018/2019
 * çıkmıştı; oysa ilanlar 2026 aittir (başlıklarında "2026" yazar, son başvuru
 * tarihleri 2026'dır). Kök neden: `extractPublishedAt` ilanın kendi tarihini
 * değil, gövdedeki YASAL ATIF tarihini okuyordu:
 *
 *   "26 Eylül 2004 tarihli ve 25585 sayılı Yönetmelik hükümleri uyarınca…"
 *
 * İkinci hata: etiketli tarih kalıbı noktalı biçimi (`14.10.2026`) hiç
 * yakalayamıyordu; `[^.\n]{0,60}` ifadesi noktayı gördüğü yerde kesiyor ve
 * "14" gibi tek sayı kalıyordu.
 *
 * Bu testler her iki hatayı da kilitler. Dış kaynağa istek atılmaz.
 */
import { describe, expect, it } from 'vitest';
import { extract, extractPublishedAt } from '../src/extraction/engine';

describe('yayım tarihi — yasal atıf tuzağı', () => {
  it('yazıyla ay verilen yasal atıf tarihi yayım tarihi sayılmaz (AFAD 2004 vakası)', () => {
    const body =
      'KPSS 2026/1 Yerleştirme İşlemi Sonuçlarına Göre Merkez ve Taşra Teşkilatı Kadrolarına Yerleştirilenlere İlişkin Duyuru\n' +
      '26 Eylül 2004 tarihli ve 25585 sayılı Yönetmelik hükümleri uyarınca işlemler yapılacaktır.';
    expect(extractPublishedAt(body)).toBeNull();
  });

  it('gerçek veride görülen dört atıf tarihini de reddeder', () => {
    const cases = [
      '31 Aralık 2008 tarihli ve 27097 sayılı Yönetmelik uyarınca sınav yapılacaktır.',
      '15 Temmuz 2018 tarihli ve 30479 sayılı Kararname kapsamında 3 uzman alınacaktır.',
      '2 Mayıs 2019 tarihli ve 30762 sayılı Yönetmelik gereğince sınav yapılacaktır.',
      '11 Temmuz 2013 tarihli ve 28686 sayılı Yönetmelik hükümlerine göre alım yapılacaktır.',
    ];
    for (const text of cases) {
      expect(extractPublishedAt(text), text).toBeNull();
    }
  });

  it('noktalı biçimdeki yasal atıf tarihini de reddeder', () => {
    expect(extractPublishedAt('26.09.2004 tarihli ve 25585 sayılı Yönetmelik uyarınca.')).toBeNull();
  });

  it('atıf ile gerçek yayım etiketi aynı metinde varsa etiket kazanır', () => {
    const body =
      '15 Temmuz 2018 tarihli ve 30479 sayılı Kararname kapsamında personeL alınacaktır.\n' +
      'Yayım Tarihi: 13.10.2026';
    expect(extractPublishedAt(body)).toBe('2026-10-13T00:00:00+03:00');
  });

  it('yasal atıf olmayan "tarihli" ifadesi ilanın kendi tarihi olarak kalır', () => {
    expect(extractPublishedAt('5 Ekim 2026 tarihli ilanımız kapsamında başvurular alınacaktır.')).toBe(
      '2026-10-05T00:00:00+03:00',
    );
  });
});

describe('yayım tarihi — etiketli tarih kalıpları', () => {
  it('noktalı etiketli tarihi okur (eskiden null dönüyordu)', () => {
    expect(extractPublishedAt('Yayım Tarihi: 14.10.2026')).toBe('2026-10-14T00:00:00+03:00');
    expect(extractPublishedAt('İlan tarihi 14.10.2026')).toBe('2026-10-14T00:00:00+03:00');
    expect(extractPublishedAt('Yayınlanma Tarihi: 14.10.2026')).toBe('2026-10-14T00:00:00+03:00');
  });

  it('yazıyla ay verilen etiketli tarihi okur', () => {
    expect(extractPublishedAt('Yayım Tarihi: 14 Ekim 2026')).toBe('2026-10-14T00:00:00+03:00');
  });

  it('etiket yoksa komşu satırdaki tarihi yayım tarihi saymaz', () => {
    const body = 'Memur Alım İlanı\nSon başvuru tarihi 20.10.2026 olup başvurular e-Devlet üzerindendir.';
    expect(extractPublishedAt(body)).toBeNull();
  });

  it('son başvuru tarihini yayım tarihi olarak atamaz', () => {
    const result = extract({
      title: 'Sürekli İşçi Alım İlanı',
      body: 'Son başvuru tarihi: 26.10.2026 olup başvurular e-Devlet üzerinden alınacaktır.',
    });
    expect(result.applicationEndDate).toBe('2026-10-26');
    expect(result.publishedAt).toBeNull();
  });
});

describe('yayım tarihi — kayıt düzeyi etkisi', () => {
  it('yasal atıf metni olan duyuruda yayım tarihi uydurulmaz', () => {
    const result = extract({
      title: 'KPSS 2026/1 Yerleştirme İşlemi Sonuçlarına Göre Duyuru',
      body:
        '26 Eylül 2004 tarihli ve 25585 sayılı Yönetmelik hükümleri uyarınca yerleştirme işlemleri yapılacaktır.\n' +
        'Ayrıntılı bilgi kurum internet sitesinde yer almaktadır.',
    });
    expect(result.publishedAt).toBeNull();
    expect(result.applicationEndDate).toBeNull();
  });

  it('kaynak listeden tarih verdiyse o tarih korunur (otorite kaynakta)', () => {
    const result = extract({
      title: 'Sözleşmeli Personel Alım İlanı',
      body: '26 Eylül 2004 tarihli ve 25585 sayılı Yönetmelik uyarınca alım yapılacaktır.',
      listing: { publishedAt: '2026-10-13' },
    });
    expect(result.publishedAt).toBe('2026-10-13');
  });
});
