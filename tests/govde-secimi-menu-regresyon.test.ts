/**
 * İlan gövdesi SEÇİMİ — gerçek kayıtlardan çıkarılan yapısal kural.
 *
 * Kanıt (16.10.2026, kullanıcının üretim verisi): `tani:ilan --kaynak` çıktısında
 * Karayolları/TMSF/DSİ/İŞKUR kayıtlarının 2500 karakterlik gövdesi baştan sona
 * menüydü; ilan cümlesi ancak menünün SONUNDA başlıyordu. Menü metni neredeyse
 * tümüyle `<a>` etiketlerinin içindedir; ilan metni düz paragraflarda durur.
 * Bu dosya, gövde seçiminin bağlantı yoğun menüyü ilan metni saymadığını
 * doğrular. Sayfa iskeleti gerçek dizelerden kurulmuştur (kayıtlardan birebir).
 */
import { describe, expect, it } from 'vitest';

import { loadHtml, readableAnnouncementText } from '../src/lib/html';

/** Kurum duyuru detayı için adaptörün kullandığı sıra (anchor-list.ts). */
const SELECTORS = [
  'article',
  'main',
  '.icerik',
  '.content',
  '#content',
  '#contentBox',
  '#DeltaPlaceHolderMain',
  'body',
] as const;

// --- Gerçek kayıtlardan alınan menü metni (16.10.2026) ---

const KGM_MENU = [
  'Daha yüksek erişilebilirlik modunu aç',
  'Karayolları Genel Müdürlüğü',
  'ANA SAYFA',
  'KURUMSAL',
  'Tarihçe',
  'Görevleri',
  'Yönetim',
  'Personel Bilgileri',
  'Organizasyon Yapısı',
  'Merkez Teşkilatı',
  'Bölgeler',
  'Bütçe Ödenekleri',
  'Yol Ağı Bilgileri',
  'Stratejik Planlama',
  'Performans Programı',
  'Faaliyet Raporu',
  'Etik Komisyonu',
  'Kamu Hizmet Standartları',
  'Faaliyetler',
  'Yayınlar',
  'OTOYOLLAR',
  'TRAFİK',
  'İSTATİSTİKLER',
  'İLETİŞİM',
  'Duyuru Detayı',
  'Tüm Haberler',
];

const ISKUR_MENU = [
  'Erişilebilirlik Menüsü',
  'Ekran Okuyucu',
  'Seçili Alan Okuyucu',
  'Bağlantı Vurgula',
  'Büyük Metin',
  'Metni Sola Hizala',
  'İmleç Okuma Kılavuzu',
  'Okuma Maskesi',
  'Kontrast',
  'KURUMSAL',
  'Bakan',
  'Genel Müdür',
  'Teşkilat Şeması',
  'Yönetim Kurulu',
  'Mevzuat',
  'Hakkında',
  'Tarihçe',
  'Etik Komisyonu',
  'Kurumsal Kimlik',
  'İhaleler',
  'Raporlar',
  'İstatistikler',
  'Yayınlar',
  'İŞ ARAYAN',
  'İŞVEREN',
  'İşsizlik Sigortası',
];

/** Gerçek kayıtlarda görülen ilan metinleri (kayıp olan kısım). */
const KGM_ILAN =
  'KARAYOLLARI GENEL MÜDÜRLÜĞÜ 50 İŞÇİ ALIMINA İLİŞKİN NOTER KURASI DUYURUSU Kurumumuz taşra teşkilatı hizmet ' +
  'birimlerine 4857 sayılı İş Kanunu hükümleri uyarınca süresi belirli olmayan sürekli iş sözleşmesi ile ' +
  'çalıştırılmak üzere 50 işçi alınacaktır. Başvurular 21.09.2026 – 25.09.2026 tarihleri arasında Türkiye İş ' +
  'Kurumu (İŞKUR) üzerinden alınacaktır. Noter kurası 02.10.2026 tarihinde yapılacaktır.';

const TMSF_ILAN =
  'TASARRUF MEVDUATI SİGORTA FONU PERSONEL ALIM İLANI 2026 Fonumuz merkez teşkilatında istihdam edilmek üzere ' +
  'sözleşmeli personel alınacaktır. Son başvuru tarihi 20.10.2026 olup başvurular Kariyer Kapısı üzerinden ' +
  'alınacaktır. Adaylarda 657 sayılı Kanunun 48 inci maddesindeki şartlar aranır.';

describe('ilan gövdesi seçimi: menü kabı ilan gövdesi sayılmaz', () => {
  it('menü + gerçek ilan aynı sayfada: ilan metni seçilir (Karayolları yapısı)', () => {
    const $ = loadHtml(`<html><body>
      <div class="content">${KGM_MENU.map((item) => `<a href="#">${item}</a>`).join('')}</div>
      <div id="DeltaPlaceHolderMain"><h1>Duyuru Detayı</h1><p>${KGM_ILAN}</p></div>
    </body></html>`);
    const text = readableAnnouncementText($, SELECTORS);
    expect(text).toContain('50 İŞÇİ ALIMINA İLİŞKİN NOTER KURASI DUYURUSU');
    expect(text).toContain('50 işçi alınacaktır');
    expect(text).not.toContain('Bütçe Ödenekleri');
  });

  it('ana + menü, icerik + ilan: ilan metni seçilir (TMSF/İŞKUR yapısı)', () => {
    const $ = loadHtml(`<html><body>
      <main>${ISKUR_MENU.map((item) => `<a href="#">${item}</a>`).join('')}</main>
      <div class="icerik"><p>${TMSF_ILAN}</p></div>
    </body></html>`);
    const text = readableAnnouncementText($, SELECTORS);
    expect(text).toContain('PERSONEL ALIM İLANI 2026');
    expect(text).toContain('Son başvuru tarihi 20.10.2026');
    expect(text).not.toContain('Erişilebilirlik Menüsü');
  });

  it('ilk aday zaten ilan metniyse davranış değişmez (hızlı yol)', () => {
    const $ = loadHtml(`<html><body>
      <nav><a href="/">Ana Sayfa</a><a href="/x">İletişim</a></nav>
      <article><p>${TMSF_ILAN}</p></article>
    </body></html>`);
    const text = readableAnnouncementText($, SELECTORS);
    expect(text).toContain('PERSONEL ALIM İLANI 2026');
  });

  it('sayfa tümüyle menüyse boş dönülmez, en az bağlantı yoğun aday kullanılır', () => {
    const $ = loadHtml(`<html><body>
      <div class="content">${KGM_MENU.map((item) => `<a href="#">${item}</a>`).join('')}</div>
    </body></html>`);
    const text = readableAnnouncementText($, SELECTORS);
    expect(text.length).toBeGreaterThan(80);
    expect(text).toContain('Karayolları Genel Müdürlüğü');
  });

  it('kısa duyurular (80 karakter altı adaylar) eskisi gibi bulunur', () => {
    const $ = loadHtml('<html><body><article>Sınav 12 Ekim 2026 tarihinde yapılacaktır.</article></body></html>');
    expect(readableAnnouncementText($, SELECTORS)).toContain('12 Ekim 2026');
  });

  it('eski kural (ilk 80+ karakterlik aday) menüyü gövde olarak seçiyordu — hata kanıtı', () => {
    const $ = loadHtml(`<html><body>
      <div class="content">${KGM_MENU.map((item) => `<a href="#">${item}</a>`).join('')}</div>
      <div id="DeltaPlaceHolderMain"><p>${KGM_ILAN}</p></div>
    </body></html>`);
    // Eski davranış: seçici sırasındaki İLK 80+ karakterlik aday kazanıyordu.
    const legacy = '.content';
    const legacyText = $(legacy).text();
    expect(legacyText).toContain('Bütçe Ödenekleri'); // menü metni
    expect(legacyText).not.toContain('ALIMINA İLİŞKİN NOTER KURASI'); // ilan metni yok
    // Yeni davranış: menü kabı atlanır, ilan metni seçilir.
    expect(readableAnnouncementText($, SELECTORS)).toContain('ALIMINA İLİŞKİN NOTER KURASI');
  });

  it('menü etiketleri kabuk temizliğiyle de atılır (gerçek dizeler)', () => {
    const $ = loadHtml(`<html><body><div class="icerik">
      <a href="#">Erişilebilirlik Menüsü</a><a href="#">Ekran Okuyucu</a>
      <p>${TMSF_ILAN}</p></div></body></html>`);
    const text = readableAnnouncementText($, SELECTORS);
    expect(text).toContain('PERSONEL ALIM İLANI 2026');
  });
});
