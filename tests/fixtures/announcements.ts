/**
 * Test verileri — gerçek ilan yapısına benzetilmiş ÖRNEK metinler.
 *
 * Bu kayıtlar üretim veritabanına yazılmaz: testler `provenance: 'sample'`
 * kullanır ve gerçek kaynaklara hiçbir istek atılmaz (network kapalı).
 */
import type { RawAnnouncement } from '../../src/domain';

export const TEST_SOURCE_KEY = 'test-kaynak';

function base(overrides: Partial<RawAnnouncement> & Pick<RawAnnouncement, 'sourceItemId' | 'title'>): RawAnnouncement {
  return {
    sourceKey: TEST_SOURCE_KEY,
    url: `https://ornek.test/ilanlar/${overrides.sourceItemId}`,
    institution: 'Örnek Üniversitesi Rektörlüğü',
    publishedAt: '2026-10-12T00:00:00+03:00',
    attachments: [],
    sourceCategory: 'personel alimi',
    extractionConfidence: 0.5,
    ...overrides,
  };
}

const PERSONEL_BODY = `
Örnek Üniversitesi Rektörlüğünden:
Üniversitemiz birimlerinde istihdam edilmek üzere 657 sayılı Devlet Memurları Kanunu'nun 4/B maddesi
kapsamında sözleşmeli personel alımı yapılacaktır.
Alınacak personel: Hemşire, Sağlık Teknikeri.
Kontenjan: 25 kişi.
Başvuru şartları: İlgili ön lisans veya lisans programlarından mezun olmak, 2026 yılı KPSS (P3) puanına sahip olmak,
KPSS taban puanı 70 ve üzeri olmak, 18 yaşını doldurmuş ve 35 yaşını bitirmemiş olmak.
Başvurular 20.10.2026 tarihinde saat 09:00'da başlayacak olup 30.10.2026 tarihinde saat 23:59'da sona erecektir.
Başvurular Kariyer Kapısı üzerinden elektronik ortamda alınacaktır. Başvuru bağlantısı ve kılavuz ekte yer almaktadır.
İlan edilen pozisyonlara başvuru yapabilmek için istenen belgelerin eksiksiz yüklenmesi gerekmektedir.
`;

/** Kabul edilmesi gereken gerçekçi sözleşmeli personel ilanı. */
export function sozlesmeliPersonelIlani(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return base({
    sourceItemId: 'ORNEK-2026-0001',
    title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
    bodyText: PERSONEL_BODY,
    rawExcerpt: PERSONEL_BODY.trim().slice(0, 400),
    attachments: [
      { url: 'https://ornek.test/ek/2026-kilavuz.pdf', label: 'Başvuru kılavuzu', kind: 'pdf' },
    ],
    ...overrides,
  });
}

/** İhale ilanı — personel alımı değildir, reddedilmelidir. */
export function ihaleIlani(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return base({
    sourceItemId: 'ORNEK-2026-0002',
    title: 'Örnek Üniversitesi Rektörlüğünden: Doğalgaz Alımı İhalesi İlanı',
    institution: 'Örnek Üniversitesi Rektörlüğü',
    sourceCategory: 'ihale',
    bodyText: `
Örnek Üniversitesi Rektörlüğünden:
Üniversitemizin ihtiyacı olan doğalgaz alımı 4734 sayılı Kamu İhale Kanunu hükümlerine göre açık ihale usulü ile
ihale edilecektir. İhaleye ilişkin ayrıntılı bilgiler aşağıda yer almaktadır.
İhale tarihi: 27.10.2026 Çarşamba günü saat 10:00'da yapılacaktır. Geçici teminat tutarı 25.000 TL'dir.
İsteklilerin ihale dokümanını satın almaları zorunludur.
`,
    rawExcerpt: 'Doğalgaz alımı ihalesi',
    ...overrides,
  });
}

/** Sonuç duyurusu — yeni ilan değildir, reddedilmelidir. */
export function sonucDuyurusu(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return base({
    sourceItemId: 'ORNEK-2026-0003',
    title: 'Örnek Belediye Başkanlığından: Personel Alımı Sonuçları Açıklandı',
    institution: 'Örnek Belediye Başkanlığı',
    sourceCategory: 'duyuru',
    bodyText: `
Örnek Belediye Başkanlığından:
Daha önce yayımlanan sözleşmeli personel alım ilanımızın değerlendirme süreci tamamlanmıştır.
Yerleştirmeye esas puanlar ve kazanan adayların listesi ekte sunulmuştur. İtiraz süresi 5 gündür.
`,
    rawExcerpt: 'Personel alımı sonuçları',
    ...overrides,
  });
}

/** Belirsiz kayıt — inceleme kuyruğuna düşmelidir (metin eksik). */
export function belirsizDuyuru(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return base({
    sourceItemId: 'ORNEK-2026-0004',
    title: 'Örnek Belediye Başkanlığından: Personel Alımı Duyurusu',
    institution: 'Örnek Belediye Başkanlığı',
    bodyText: 'Duyuru metni kısa.',
    rawExcerpt: 'Duyuru metni kısa.',
    ...overrides,
  });
}

/** Geri çekme/iptal duyurusu — mevcut ilanı kapatmalıdır. */
export function iptalDuyurusu(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return base({
    sourceItemId: 'ORNEK-2026-0005',
    title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı İptal Edilmiştir',
    sourceCategory: 'duyuru',
    bodyText: `
Örnek Üniversitesi Rektörlüğünden:
12.10.2026 tarihinde yayımlanan sözleşmeli personel alım ilanımız ilan iptal edilmiştir.
İlan iptal edildiğinden başvuru alınmayacaktır. İlgililere duyurulur.
`,
    rawExcerpt: 'İlan iptal edilmiştir',
    ...overrides,
  });
}

/** Aynı ilanın ikinci kaynaktaki yayımı (kurum + başlık eşleşir, URL farklı). */
export function ikinciKaynakYayini(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return sozlesmeliPersonelIlani({
    sourceKey: 'test-kaynak-2',
    sourceItemId: 'ORNEK-ILAN-9001',
    url: 'https://ornek2.test/ilan/9001',
    ...overrides,
  });
}

/** Benzer başlıklı ama FARKLI ilan — otomatik birleştirilmemelidir. */
export function benzerBaslikliFarkliIlan(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return base({
    sourceItemId: 'ORNEK-2026-0006',
    title: 'Örnek Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı (Şoför)',
    bodyText: `
Örnek Üniversitesi Rektörlüğünden:
Üniversitemiz birimlerinde istihdam edilmek üzere 657 sayılı Devlet Memurları Kanunu'nun 4/B maddesi
kapsamında şoför kadrosu için sözleşmeli personel alımı yapılacaktır.
Kontenjan: 3 kişi. Başvuru şartları: B sınıfı sürücü belgesine sahip olmak ve en az 5 yıl deneyimli olmak.
Başvurular 05.11.2026 tarihinde saat 09:00'da başlayacak olup 15.11.2026 tarihinde saat 23:59'da sona erecektir.
`,
    rawExcerpt: 'Şoför kadrosu sözleşmeli personel alımı',
    ...overrides,
  });
}
