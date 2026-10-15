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
import { CLASSIFICATION_VERSION } from '../src/config/app';
import { buildJobDocument } from '../src/ingest/jobs-service';
import { reclassifyJob } from '../src/ingest/reclassify';
import type { RawAnnouncement } from '../src/domain';
import type { JobDoc } from '../src/db/schemas';

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
  // 2026-10-16 canlı panel dökümü: KGM/DSİ/SPK kurumsal etkinlik ve fiyat sayfaları.
  { title: '2026 Yılı Rayiç Fiyatları', rule: 'ret-baslik.kurumsal-etkinlik' },
  { title: 'Tarihi Köprünün Restorasyon Çalışmasının Açılışı Yapıldı', rule: 'ret-baslik.kurumsal-etkinlik' },
  { title: 'GICC 2026 Kapsamında Heyet Ziyareti Gerçekleştirildi', rule: 'ret-baslik.kurumsal-etkinlik' },
  { title: 'Japonya Heyeti ile Görüşme', rule: 'ret-baslik.kurumsal-etkinlik' },
  { title: 'Kurumlar Arası İş Birliği Protokolü İmza Töreni', rule: 'ret-baslik.kurumsal-etkinlik' },
  { title: 'Uluslararası Akıllı Ulaşım Sistemleri Yarışması', rule: 'ret-baslik.kurumsal-etkinlik' },
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
  'ret-baslik.kurumsal-etkinlik',
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
    // Yeni "kurumsal etkinlik" kuralının yanlış pozitif vermemesi gereken başlıklar:
    // etkinlik/ziyaret/fuar kelimesi geçiyor ama alım açıkça belirtiliyor.
    'Ziyaretçi kabulünde görevlendirilecek 10 güvenlik personeli alımı',
    'Fuar alanında çalıştırılmak üzere 5 temizlik işçisi alımı',
    'Açılışı yapılan hizmet binasında görevlendirilecek sözleşmeli memur alımı',
  ];
  for (const title of keepTitles) {
    it(`"${title}" yeni başlık ret kurallarına takılmaz`, () => {
      const result = classify({ title, sourceKey: 'test-kaynak' });
      expect(result.rules.filter((rule) => NEW_RULE_IDS.includes(rule)), JSON.stringify(result.reasons)).toEqual([]);
    });
  }
});

/**
 * Paneldeki 58 "ilgililik" kaydı eski kural setiyle (2026.10.1) sınıflanmıştı; kural
 * değişikliği tek başına depodaki kararı değiştirmez. Kayıtların gerçekten temizlendiğini
 * kanıtlayan yol `reclassifyJob`: inceleme kararı açık ret sinyaliyle reddedilmeli.
 */
describe('mevcut inceleme kuyruğu yeniden sınıflandırmayla temizlenir', () => {
  const NOW = new Date('2026-10-15T09:00:00+03:00');
  const CEREZ_GOVDESİ =
    'Modal content × T.C. İÇİŞLERİ BAKANLIĞI WEB SİTESİ GİZLİLİK VE ÇEREZ POLİTİKASI Erişilebilirlik Menüsü ' +
    'Ekran Okuyucu Kurumsal Sıkça Sorulan Sorular Basın Açıklamaları İletişim Başvuru personel alımı hakkında bilgi.';

  function reviewJob(id: string, title: string, body: string): JobDoc {
    const raw = {
      sourceKey: 'icisleri-bakanligi-duyurular',
      sourceItemId: id,
      title,
      url: `https://www.icisleri.gov.tr/duyurular/${id}`,
      attachments: [],
      bodyText: body,
      institution: 'T.C. İçişleri Bakanlığı',
      publishedAt: '2026-10-14',
    } as unknown as RawAnnouncement;
    const doc = buildJobDocument(raw, { ...classify({ title, body }), decision: 'review' }, { now: NOW, provenance: 'scraped' });
    return {
      ...doc,
      id,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      firstSeenAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      version: 1,
    } as unknown as JobDoc;
  }

  it('dizin sayfası kaydı incelemeden rete döner', () => {
    const job = reviewJob('sss', 'Sıkça Sorulan Sorular', CEREZ_GOVDESİ);
    expect(job.classification.decision).toBe('review');

    const result = reclassifyJob(job, NOW);

    expect(result.decisionFrom).toBe('review');
    expect(result.decisionTo).toBe('reject');
    expect(result.patch.classification?.decision).toBe('reject');
    expect(result.patch.classification?.version).toBe(CLASSIFICATION_VERSION);
    expect(result.patch.classification?.rules.join(' ')).toContain('ret-baslik.sss');
    expect(result.changed).toBe(true);
  });

  it('gerçek alım ilanı yeniden sınıflandırmada akışta kalır', () => {
    const job = reviewJob(
      'ilan-1',
      'Bakanlığımız taşra teşkilatına 100 sözleşmeli personel alımı yapılacaktır',
      'Kurumumuz taşra teşkilatında istihdam edilmek üzere 100 sözleşmeli personel alınacaktır. ' +
        'Başvurular 12.10.2026-20.10.2026 tarihleri arasında e-Devlet üzerinden yapılır. KPSS puan sıralaması esas alınır.',
    );

    const result = reclassifyJob(job, NOW);

    expect(result.decisionTo).not.toBe('reject');
  });
});
