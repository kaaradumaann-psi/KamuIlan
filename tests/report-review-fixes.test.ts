import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { isSiteChromeTitle } from '../src/domain/text';

/**
 * Supabase dry-run raporunda (2026-10-14) görülen gerçek başlıklar. Gövdeler raporun
 * kısa özetinden alınmıştır; kararlar başlık düzeyindeki kurallara dayanır.
 */
const run = (title: string, body = '') => classify({ title, body, sourceCategory: '' });

describe('rapor: sayfa kabuğu ve kategori başlıkları reddedilir', () => {
  it.each([
    [
      'T.C. İÇİŞLERİ BAKANLIĞI T.C. İÇİŞLERİ BAKANLIĞI BAKANLIK BAKANLIK Bakanımız Hakkımızda Teşkilat Şeması',
      'Sözleşmeli personel alımı giriş sınavı',
    ],
    [
      'Daha yüksek erişilebilirlik modunu aç Daha yüksek erişilebilirlik modunu kapat Karayolları Genel Müdürlüğü',
      'Karayolları Genel Müdürlüğü 50 işçi alımı',
    ],
    [
      'Sizlere daha iyi hizmet verebilmek için sitemizde çerezlere yer veriyoruz 🍪 Çerez politikamız hakkında bilgi',
      'İşçi alım ilanları',
    ],
    ['Ana Sayfa İlanlar Kurumdışı Kamu İşçi Alım İlanları', 'Erişilebilirlik Menüsü kamu işçi alımı'],
    ['Kamu Memur Alım İlanları', 'Erişilebilirlik Menüsü Ekran Okuyucu'],
    ['Kurumdışı Kamu İşçi Alım ...', 'Erişilebilirlik Menüsü Çerez Ayarları'],
    ['PERSONEL DAİRESİ BAŞKANLIĞI', 'Anasayfa Tarım ve Orman Bakanlığı'],
    [
      'ARAZİ TOPLULAŞTIRMASI ETÜT VE PROJELENDİRME DAİRESİ BAŞKANLIĞI',
      'Giriş sınavı Personel alım ilanı menü bağlantıları',
    ],
  ])('reddedilir: %s', (title, body) => {
    const result = run(title, body);
    expect(result.decision).toBe('reject');
    expect(result.kind).toBe('job');
  });

  it('sayfa kabuğu başlığı adaptörde de ilan olarak alınmaz', () => {
    expect(isSiteChromeTitle('Sizlere daha iyi hizmet verebilmek için çerezlere yer veriyoruz')).toBe(true);
    expect(isSiteChromeTitle('Daha yüksek erişilebilirlik modunu aç')).toBe(true);
    expect(
      isSiteChromeTitle('Karayolları Genel Müdürlüğüne Bağlı İşyerlerine 50 İşçi Personel Alımı Hk.'),
    ).toBe(false);
    expect(isSiteChromeTitle('Erzurum İlindeki İş Yerlerimize 1 Engelli İşçi Alınacaktır')).toBe(false);
  });
});

describe('rapor: gerçek ilanlar reddedilmez (negatif kontrol)', () => {
  it.each([
    [
      'Karayolları Genel Müdürlüğüne Bağlı İşyerlerine 50 İşçi Personel Alımı Hk.',
      'Karayolları Genel Müdürlüğü işyerlerine 50 işçi alınacaktır. Başvuru şartları aşağıdadır.',
    ],
    [
      'Erzurum İlindeki İş Yerlerimize 1 Engelli İşçi Alınacaktır',
      'İşyerimize 1 engelli işçi alınacaktır. Başvurular kariyer kapısı üzerinden yapılır.',
    ],
    [
      'BANKACILIK DÜZENLEME VE DENETLEME KURUMU BAŞKANLIĞI (BDDK) - BANKACILIK DÜZENLEME VE DENETLEME KURUMU 2026 YILI MESLEK PERSONELİ GİRİŞ SINAVI İLANI',
      'Bankacılık Uzman Yardımcısı giriş sınavı yazılı ve sözlü olmak üzere iki aşamalıdır. İstanbul.',
    ],
    [
      'ÖZELLEŞTİRME İDARESİ BAŞKANLIĞI - 2026-2 ÖZELLEŞTİRME İDARESİ BAŞKANLIĞI UZMAN YARDIMCILIĞI GİRİŞ SINAVI DUYURUSU',
      'Uzman yardımcılığı giriş sınavı ile 14 adet kadroya atama yapılacaktır.',
    ],
    [
      'Kamu Personel Alım İlanı 2026',
      'Kamu kurumunda personel alım ilanı. Kadro sayısı 5. Başvuru şartları aşağıdadır.',
    ],
  ])('kabul kalır: %s', (title, body) => {
    const result = run(title, body);
    expect(result.decision).not.toBe('reject');
  });
});

describe('rapor: süreç duyuruları ayrı kategoride kalır', () => {
  it('yedek aday duyurusu (sonuç aşaması) süreç olur', () => {
    const result = run(
      "20 Nisan 2026 Tarihli ve 33230 Sayılı Resmi Gazete'de Yayımlanan 35 Sözleşmeli Personel Alımı Yedek Aday Duyurusu",
      'Yedek aday listesi aşağıdadır.',
    );
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
  });

  it('bilişim sınavı çağrı listesi süreç olarak kalır (regresyon)', () => {
    const result = run(
      'Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru',
      'Sınav tarihleri için tıklayınız.',
    );
    expect(result.kind).toBe('process');
  });
});
