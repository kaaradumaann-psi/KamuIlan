/**
 * 2026-10-15 canlı çıktısındaki inceleme kuyruğu gürültüsünün regresyonu.
 *
 * Panelde 58 "ilgililik" kaydı %45-57 güvenle bekliyordu ve neredeyse tamamı
 * kurum sitelerinin dizin/yardım sayfalarıydı: "Sıkça Sorulan Sorular",
 * "Bilgi Güvenliği Politikası", "Basın Açıklamaları", "Başkan'ın Konuşmaları",
 * "SEMPOZYUM VE SERGİLER", "HABERLER & DUYURULAR", "İç Kontrol Çalışmaları",
 * "Radar uygulama sayıları", "projeler", ayrıca ÖSYM'nin "e-YDS 2026/10" ve
 * "2026-TUS 2. Dönem Tercih" duyuruları. Bu sayfalar ilan değildir; başlıkta
 * kesin ret uygulanır. Gerçek alım başlıkları ise bu kurallara takılmamalıdır.
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';

const noiseTitles: { title: string; rule: string }[] = [
  { title: 'Sıkça Sorulan Sorular', rule: 'ret-baslik.sss' },
  { title: 'Bilgi Güvenliği Politikası', rule: 'ret-baslik.politika-belgesi' },
  { title: 'Gizlilik ve Çerez Politikası', rule: 'ret-baslik.politika-belgesi' },
  { title: 'KVKK Politikası', rule: 'ret-baslik.politika-belgesi' },
  { title: "Başkan'ın Konuşmaları", rule: 'ret-baslik.etkinlik-konusma' },
  { title: 'SEMPOZYUM VE SERGİLER', rule: 'ret-baslik.etkinlik-konusma' },
  { title: 'Basın Açıklamaları', rule: 'ret-baslik.dizin-sayfasi' },
  { title: 'HABERLER & DUYURULAR', rule: 'ret-baslik.dizin-sayfasi' },
  { title: 'İç Kontrol Çalışmaları', rule: 'ret-baslik.dizin-sayfasi' },
  { title: 'projeler', rule: 'ret-baslik.dizin-sayfasi' },
  { title: 'Foto Galeri', rule: 'ret-baslik.dizin-sayfasi' },
  { title: 'Radar uygulama sayıları', rule: 'ret-baslik.sayi-istatistik' },
  { title: '2026 yılı istatistikleri', rule: 'ret-baslik.sayi-istatistik' },
  { title: 'e-YDS 2026/10 İngilizce Sınavı Başvuruları', rule: 'ret-baslik.dil-akademik-sinav' },
  { title: '2026-TUS 2. Dönem Tercih İşlemleri', rule: 'ret-baslik.dil-akademik-sinav' },
  { title: '2026-ALES/2 Başvuru Kılavuzu', rule: 'ret-baslik.dil-akademik-sinav' },
];

describe('dizin/yardım sayfası başlıkları', () => {
  for (const { title, rule } of noiseTitles) {
    it(`"${title}" reddedilir`, () => {
      const result = classify({ title, sourceKey: 'test-kaynak' });
      expect(result.decision, JSON.stringify(result.reasons)).toBe('reject');
      expect(result.rules).toContain(rule);
    });
  }

  it('gövdedeki zayıf kanıt dizin sayfasını incelemeye taşıyamaz', () => {
    const result = classify({
      title: 'Basın Açıklamaları',
      body: 'Kurumumuz personel alımı başvuruları hakkında basın açıklaması yayımladı.',
      sourceKey: 'test-kaynak',
    });
    expect(result.decision).toBe('reject');
  });
});

/** Bu fazda eklenen başlık ret kuralları; eski kuralların davranışı bu dosyada yargılanmaz. */
const NEW_RULE_IDS: readonly string[] = [
  'ret-baslik.sss',
  'ret-baslik.politika-belgesi',
  'ret-baslik.etkinlik-konusma',
  'ret-baslik.dizin-sayfasi',
  'ret-baslik.sayi-istatistik',
  'ret-baslik.dil-akademik-sinav',
];

describe('gerçek alım başlıkları yeni kurallara takılmaz', () => {
  const keepTitles = [
    'SGK 100 Personel Alım İlanı yayımlandı',
    'YDS Şartlı 50 Sözleşmeli Personel Alımı',
    'Uzman Yardımcılığı Giriş Sınavı İlanı',
    'Basın Açıklaması: 200 Memur Alımı Yapılacak',
    'Sergi salonunda görevlendirilecek temizlik personeli alımı',
    'Kadro sayıları açıklanan 4/B sözleşmeli personel alımı',
    'KPSS 2026/1 Tercih Kılavuzu ile memur alımı',
  ];
  for (const title of keepTitles) {
    it(`"${title}" yeni başlık ret kurallarına takılmaz`, () => {
      const result = classify({ title, sourceKey: 'test-kaynak' });
      expect(result.rules.filter((rule) => NEW_RULE_IDS.includes(rule)), JSON.stringify(result.reasons)).toEqual([]);
    });
  }
});
