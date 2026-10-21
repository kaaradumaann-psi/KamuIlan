/**
 * Sınıflandırma motoru testleri.
 *
 * Örnek metinler gerçek kaynaklardan alınan başlıklardır
 * (Resmî Gazete 12.10.2026, ilan.gov.tr kamu-akademik personel kategorisi, ÖSYM
 * duyuru listesi). Hiçbir test dış kaynağa istek atmaz.
 */
import { CLASSIFICATION_VERSION } from '../src/config/app';
import { describe, expect, it } from 'vitest';
import { classify, detectEmploymentType, preFilterListingItem } from '../src/classification/engine';
import { PROVINCE_NAMES } from '../src/domain/provinces';

describe('sınıflandırma: kabul edilmesi gerekenler', () => {
  it('personel alım ilanını kabul eder', () => {
    const result = classify({
      title: 'Şırnak Üniversitesi Rektörlüğünden Sürekli İşçi Alım İlanı',
      body:
        'Üniversitemize 657 sayılı Devlet Memurları Kanunu kapsamında sürekli işçi alınacaktır. ' +
        'Kontenjan 12 kişidir. Başvurular 12.10.2026 - 26.10.2026 tarihleri arasında yapılacaktır.',
    });
    expect(result.decision).toBe('accept');
    expect(result.employmentType).toBe('kamu-isci');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('kariyer meslek (uzman yardımcılığı) sınav ilanını kabul eder', () => {
    const result = classify({
      title: 'Kültür ve Turizm Bakanlığı Vakıflar Genel Müdürlüğü Vakıf Uzman Yardımcılığı Sınav İlanı',
      body:
        'Vakıf Uzman Yardımcılığı giriş sınavı yapılacaktır. Kontenjan 20 kişidir. ' +
        'Adayların 2026 KPSS P3 puan türünden en az 70 puan almaları gerekmektedir.',
    });
    expect(result.decision).toBe('accept');
    expect(result.employmentType).toBe('kariyer-meslek');
  });

  it('akademik personel alım ilanını kabul eder', () => {
    const result = classify({
      title: 'Türk Hava Kurumu Üniversitesi Rektörlüğünden Akademik Personel Alım İlanı',
      body: 'Üniversitemizin çeşitli birimlerine öğretim üyesi ve öğretim elemanı alınacaktır.',
    });
    expect(result.decision).toBe('accept');
    expect(result.employmentType).toBe('akademik');
  });

  it('sözleşmeli sağlık personeli alımını kabul eder', () => {
    const result = classify({
      title: 'Sağlık Bakanlığı Sözleşmeli Sağlık Personeli Alım İlanı',
      body: '4/B sözleşmeli personel alınacaktır. Kadro sayısı 1.500 adet sözleşmeli pozisyondur.',
    });
    expect(result.decision).toBe('accept');
    expect(result.employmentType).toBe('sozlesmeli');
  });

  it('kuruma özgü giriş sınavı ilanını kabul eder', () => {
    const result = classify({
      title:
        'Tasarruf Mevduatı Sigorta Fonu Başkanlığından Fon Denetçi Yardımcısı, Fon Uzman Yardımcısı ve Fon Avukatı Alım İlanı',
      body: 'Başvurular 20.10.2026 tarihine kadar yapılacaktır. Sözlü sınav ilanı ayrıca duyurulacaktır.',
    });
    expect(result.decision).toBe('accept');
  });

  it('kamuya açık kariyer giriş ve yeterlik sınavı duyurularını mevcut personel sınavı sanmaz', () => {
    const entrance = classify({
      title: 'Muhasebe Uzman Yardımcılığı Giriş Sınavı İlanı',
      body: 'Kamu kurumunda uzman yardımcısı olarak istihdam edilmek üzere aday alımı yapılacaktır.',
    });
    const publicEntryQualification = classify({
      title: 'Kamu Kurumu Uzmanlık Yeterlik Sınavı Duyurusu',
      body: 'Dışarıdan uzman yardımcısı alınmak üzere tüm adayların başvurusuna açıktır; yeni personel alımı yapılacaktır.',
      sourceCategory: 'Uzmanlık Sınavı',
    });
    expect(entrance.decision).toBe('accept');
    expect(publicEntryQualification.decision).toBe('accept');
  });
});

describe('sınıflandırma: reddedilmesi gerekenler', () => {
  it('ihale ilanını reddeder', () => {
    const result = classify({
      title: 'Konya Otogarı Yapım İşi İhalesi',
      body: 'İhale 2886 sayılı Kanun kapsamında açık artırma usulüyle yapılacaktır.',
    });
    expect(result.decision).toBe('reject');
  });

  it('personel alımı SONUÇ duyurusu yeni ilan değil; süreç duyurusu olarak ayrı kategoride kalır', () => {
    const result = classify({
      title: '2026 Yılı Sözleşmeli Personel Alımı Sonuçları Açıklandı',
      body: 'Sözleşmeli personel alımı için başvuru yapan adayların sonuçları ilan edilmiştir.',
    });
    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('process');
    expect(result.reasons.join(' ')).toContain('süreç');
  });

  it('yerleştirme sonuçları duyurusunu reddeder', () => {
    const result = classify({
      title: '2026-KPSS Lisans Sınavı Yerleştirme Sonuçları Açıklandı',
      body: 'Adayların puan sıralaması ve asıl ve yedek liste yayımlanmıştır.',
    });
    expect(result.decision).toBe('reject');
  });

  it('yönetmelik duyurusunu reddeder', () => {
    const result = classify({
      title: 'Gazi Üniversitesi Spor Bilimleri Uygulama ve Araştırma Merkezi Yönetmeliği',
      body: 'Bu yönetmelik yayımı tarihinde yürürlüğe girer.',
    });
    expect(result.decision).toBe('reject');
  });

  it('öğrenci/staj programını reddeder', () => {
    const result = classify({
      title: 'Ulusal Staj Programı 2026 Başvuruları',
      body: 'Programa öğrenciler başvurabilir.',
    });
    expect(result.decision).toBe('reject');
  });

  it('mal/hizmet alımı duyurusunu reddeder', () => {
    const result = classify({
      title: 'Hizmet Alımı İlanı',
      body: 'Kurumumuz temizlik hizmeti alımı yapılacaktır.',
    });
    expect(result.decision).toBe('reject');
  });

  it('danışmanlık hizmeti duyurusunu reddeder', () => {
    const result = classify({
      title: 'Bireysel Danışmanlık Hizmeti Duyurusu',
      body: 'Kooperatifimiz bireysel danışmanlık hizmeti alacaktır.',
    });
    expect(result.decision).toBe('reject');
  });

  it('genel başvuru/özgeçmiş havuzu duyurusunu hayalet ilan sayıp reddeder', () => {
    const result = classify({
      title: 'Genel Başvuru Duyurusu',
      body:
        'Kurumumuza ileride açılacak pozisyonlar için özgeçmiş havuzu oluşturulacaktır. ' +
        'Başvurular genel başvuru olarak değerlendirilecektir.',
    });
    expect(result.decision).toBe('reject');
    expect(result.rules).toContain('ret-baslik.genel-basvuru');
  });

  it('başlıkta havuz sinyali yoksa gövde sinyali puan kırar ama tek başına karar vermez', () => {
    const withPool = classify({
      title: 'Sözleşmeli Sağlık Personeli Alım İlanı',
      body:
        'Kurumumuza 20 sözleşmeli sağlık personeli alınacaktır. ' +
        'İleride açılacak pozisyonlar için ayrıca genel başvuru alınacaktır.',
    });
    expect(withPool.negativeSignals.join(' ')).toContain('ileride açılacak pozisyon');

    const clean = classify({
      title: 'Sözleşmeli Sağlık Personeli Alım İlanı',
      body: 'Kurumumuza 20 sözleşmeli sağlık personeli alınacaktır. Başvurular e-Devlet üzerinden yapılacaktır.',
    });
    expect(clean.decision).toBe('accept');
  });

  it('Hazine muhasebe uzmanlığı yeterlik sınavını yeni boş kadro sanmaz; kurum içi süreç olarak akışta kalır', () => {
    const result = classify({
      title: 'Hazine ve Maliye Bakanlığı Muhasebe Uzmanlığı Yeterlik Sınavı Duyurusu',
      body: 'Sınav, Bakanlıkta Muhasebe Uzman Yardımcısı olarak görev yapan personel için yapılacaktır.',
      sourceCategory: 'Yeterlik Sınavı İlanları',
    });
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
    expect(result.reasons.join(' ')).toContain('Kurum içi yeterlik sınavı');
    expect(result.rules).toContain('süreç.kurum-ici-yeterlik');
  });

  it.each(['Bank Mellat Basın Duyurusu', 'Param Şirketleri Basın Duyurusu'])(
    '%s personel ilanı sayılmaz',
    (title) => {
      const result = classify({ title, body: 'Kurum tarafından yapılan basın açıklaması.' });
      expect(result.decision).toBe('reject');
    },
  );

  it('görevde yükselme sınav duyurusunu yeni kamu alımı saymaz; süreç duyurusu olarak tutar', () => {
    const result = classify({
      title: 'Kurum İçi Görevde Yükselme Sınavı Duyurusu',
      body: 'Mevcut personel için unvan değişikliği yapılacaktır.',
    });
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
  });

  it('mevcut personelin yer değiştirme duyurusunu reddeder', () => {
    const result = classify({
      title: 'Öğretmenlerin İller Arası İsteğe Bağlı Yer Değiştirme Başvurusu (2026-2)',
      body: 'Yer değiştirme başvuruları e-Devlet üzerinden alınacaktır.',
    });
    expect(result.decision).toBe('reject');
  });

  it('sınav giriş belgesi duyurusunu reddeder', () => {
    const result = classify({
      title: '2026-BKUBTS: Sınava Giriş Belgeleri Erişime Açıldı',
      body: 'Adaylar sınav giriş belgelerini edevlet üzerinden alabilir.',
    });
    expect(result.decision).toBe('reject');
  });

  it('icra/tebligat ilanını reddeder', () => {
    const result = classify({
      title: 'İflas Hukuku Davaları — İcra İlanı',
      body: 'İcra dosyası kapsamında tebligat yoluyla duyurulur.',
    });
    expect(result.decision).toBe('reject');
  });

  it('personel alımıyla ilgisiz bir kültür duyurusunu reddeder', () => {
    const result = classify({
      title: 'Kütüphane Haftası Etkinlik Programı',
      body: 'Etkinlikler 20-26 Ekim tarihleri arasında yapılacaktır.',
    });
    expect(result.decision).toBe('reject');
  });
});

describe('sınıflandırma: incelemeye gönderilen belirsiz kayıtlar', () => {
  it('zayıf sinyalli kaydı silmek yerine incelemeye gönderir', () => {
    const result = classify({
      title: 'Kurumumuzda Görevlendirme Duyurusu',
      body: 'Kadro karşılığı istihdam edilmek üzere değerlendirme yapılacaktır.',
    });
    expect(result.decision).toBe('review');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('belge metni çıkarılamadığında kabul kararını incelemeye çeker', () => {
    const result = classify({
      title: 'Belediye Personel Alım İlanı',
      body: '',
      documentTextMissing: true,
    });
    expect(result.decision).toBe('review');
    expect(result.reasons.join(' ')).toContain('Belge metni');
  });
});

describe('sınıflandırma: yardımcılar', () => {
  it('istihdam türünü başlıktan çıkarır', () => {
    expect(detectEmploymentType('sürekli işçi alım ilanı', '').type).toBe('kamu-isci');
    expect(detectEmploymentType('öğretim üyesi alım ilanı', '').type).toBe('akademik');
    expect(detectEmploymentType('sözleşmeli personel alımı', '').type).toBe('sozlesmeli');
    expect(detectEmploymentType('uzman yardımcılığı sınav ilanı', '').type).toBe('kariyer-meslek');
    expect(detectEmploymentType('personel alımı', '').type).toBe('diger-kamu');
  });

  it('liste düzeyinde ön karar verir ve reddedilen için detay indirmez', () => {
    const skip = preFilterListingItem({ title: 'Artırma, Eksiltme ve İhale İlânları' });
    expect(skip.action).toBe('skip');
    const consider = preFilterListingItem({ title: 'Sürekli İşçi Alım İlanı' });
    expect(consider.action).toBe('consider');
  });

  it('sınıflandırma sürümünü döner', () => {
    const result = classify({ title: 'Personel Alım İlanı' });
    // Sürüm tek bir yerden (config/app.ts) yönetilir; karar kaydı bu sürümü taşır.
    expect(result.version).toBe(CLASSIFICATION_VERSION);
    expect(result.version.length).toBeGreaterThan(3);
  });
});

// Bağımsız doğrulamada bulunan hata (21.10.2026): tür, başlık + gövde birleşik metinde
// kural sırasıyla seçiliyordu; gövdedeki dışlama cümlesi başlıktaki açık türü eziyordu.
describe('istihdam türü: başlıktaki açık tür gövdedeki dışlama cümlesine üstün gelir', () => {
  const window = 'Başvurular 01.11.2026 - 10.11.2026 tarihleri arasında yapılacaktır.';

  it.each([
    [
      'Sözleşmeli Personel Alım İlanı',
      `657 sayılı Kanunun 4/B maddesi uyarınca 3 sözleşmeli personel alınacaktır. Kurumumuzda sürekli işçi olarak çalışanlar başvuramaz. ${window}`,
      'sozlesmeli',
    ],
    [
      'Sözleşmeli Bilişim Personeli Alımı',
      `Kurumumuzda sözleşmeli bilişim personeli alınacaktır. Adayların öğretim görevlisi olarak çalışmıyor olması gerekir. ${window}`,
      'sozlesmeli',
    ],
    [
      'Sürekli İşçi Alım İlanı',
      `İŞKUR üzerinden 4 sürekli işçi alınacaktır. Sözleşmeli personel statüsünde çalışanlar başvuramaz. ${window}`,
      'kamu-isci',
    ],
  ])('%s → %s', (title, body, expected) => {
    expect(detectEmploymentType(title, body).type).toBe(expected);
    expect(classify({ title, body }).employmentType).toBe(expected);
  });

  // PR #27 incelemesinde bulunan regresyon: başlıktaki yöntem ("Giriş Sınavı", "Sözlü Sınav")
  // tür sayılıp gövdedeki 4/B statüsünü eziyordu. Yöntem başlıkta öncelik almaz.
  it.each([
    ['Personel Alımı Giriş Sınavı Duyurusu', 'sozlesmeli'],
    ['Kurumumuz Sözlü Sınav ile Personel Alımı', 'sozlesmeli'],
    ['Sözleşmeli Personel Giriş Sınavı İlanı', 'sozlesmeli'],
  ])('başlıktaki işe alım yöntemi gövdedeki statüyü ezmez: %s → %s', (title, expected) => {
    const body = `657 sayılı Kanunun 4/B maddesi uyarınca 10 sözleşmeli personel alınacaktır. ${window}`;
    expect(detectEmploymentType(title, body).type).toBe(expected);
  });

  it('başlıkta yalnızca yöntem, gövdede statü yoksa yöntem türü korunur', () => {
    expect(
      detectEmploymentType(
        'Personel Alımı Giriş Sınavı Duyurusu',
        `Kurumumuza personel alınacaktır. ${window}`,
      ).type,
    ).toBe('kuruma-ozel-sinav');
  });

  it('başlıktaki kariyer mesleği ve memur statüsü gövdedeki çelişkili ifadeye üstün gelir', () => {
    expect(
      detectEmploymentType(
        'Uzman Yardımcılığı Giriş Sınavı İlanı',
        `Sürekli işçi kadrosunda çalışanlar başvuramaz. ${window}`,
      ).type,
    ).toBe('kariyer-meslek');
    expect(
      detectEmploymentType('Memur Alımı İlanı', `Sürekli işçi kadrosunda çalışanlar başvuramaz. ${window}`)
        .type,
    ).toBe('kadrolu');
  });

  it('başlık genel ifadeyse (Personel Alım İlanı) tür gövdeden belirlenir', () => {
    expect(
      detectEmploymentType('Personel Alım İlanı', `Kurumumuza 5 sürekli işçi alınacaktır. ${window}`).type,
    ).toBe('kamu-isci');
  });
});

// Bağımsız doğrulamada bulunan hata (21.10.2026): `ret-baslik.staj-burs` kalıbındaki
// `burs\w*` "Bursa" ile başlayan her başlığı eşliyordu; Bursa kurumlarının gerçek
// ilanları başlık düzeyinde %92 güvenle reddediliyordu. 81 il taraması bunu
// yakalar ve başka bir il adının ret kuralına takılmasını da önler.
describe('il adları ret kurallarına takılmaz', () => {
  const body =
    'Kurumumuzda istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Başvurular 01.11.2026 - 10.11.2026 tarihleri arasında yapılacaktır.';
  const forms = (il: string): string[] => [
    `${il} Valiliği Sözleşmeli Personel Alım İlanı`,
    `${il} Belediyesi Zabıta Memuru Alım İlanı`,
    `${il} Üniversitesi Sözleşmeli Personel Alım İlanı`,
    `${il} İl Sağlık Müdürlüğü Sürekli İşçi Alım İlanı`,
  ];

  it('81 ilin 4 kurum biçiminde gerçek ilan başlığı kabul edilir', () => {
    const notAccepted = PROVINCE_NAMES.flatMap(forms)
      .map((title) => ({ title, result: classify({ title, body }) }))
      .filter(({ result }) => result.decision !== 'accept')
      .map(({ title, result }) => `${title} → ${result.decision} (${result.rules.join(',')})`);
    expect(PROVINCE_NAMES).toHaveLength(81);
    expect(notAccepted).toEqual([]);
  });

  it.each([
    'Üniversite Öğrencilerine Burs Başvurusu',
    'Burs Sonuçları Açıklandı',
    'Yükseköğrenim Bursu Başvuruları',
  ])('burs duyurusu yine reddedilir: %s', (title) => {
    const result = classify({ title, body: 'Burs başvuruları 01.11.2026 tarihine kadar alınacaktır.' });
    expect(result.decision).toBe('reject');
    expect(result.rules).toContain('ret-baslik.staj-burs');
  });
});
