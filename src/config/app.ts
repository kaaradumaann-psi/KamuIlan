/**
 * Uygulama kimliği ve işletim varsayılanları.
 *
 * Ürün adı tek yerden değiştirilebilir (marka değişikliği isteği) — arayüz,
 * e-posta ve meta etiketleri `BRANDING` üzerinden okur.
 */
export const BRANDING = {
  name: 'Kamuİlan',
  shortName: 'Kamuİlan',
  tagline: 'Türkiye genelinde kamu personel alım ilanları — tek yerde, kaynaklı ve doğrulanmış.',
  description:
    'Resmî kaynaklardan toplanan memur, sözleşmeli personel, kamu işçisi ve akademik kadro ilanlarını sınıflandıran, tekilleştiren ve e-posta ile bildiren açık platform.',
  supportEmail: 'destek@example.com',
} as const;

/** Zamanlanmış işler için varsayılanlar (kaynak kayıtları bunları geçebilir). */
export const SCHEDULER_DEFAULTS = {
  /** Hızlı kaynaklar: Resmî Gazete, ilan.gov.tr, Kariyer Kapısı. */
  fastIntervalMinutes: 60,
  /** Kurumsal sayfalar (bakanlık, kurum). */
  institutionalIntervalMinutes: 180,
  /** Günlük keşif: yeni kaynak/kurum listelerinin taraması. */
  discoveryIntervalMinutes: 60 * 24,
  /** Bütünlük denetimi: yayımlanmış ilanların yeniden doğrulanması. */
  auditIntervalMinutes: 60 * 24,
  /** Worker kilidi/lease süreleri. */
  scrapeLockTtlMs: 5 * 60_000,
  heartbeatIntervalMs: 15_000,
  /** Bu süreden uzun süre kalp atışı gelmeyen worker "ölü" sayılır. */
  heartbeatStaleMs: 120_000,
} as const;

/** Sınıflandırma ve çıkarım sürümleri — kural değişince artırılır. */
export const APP_VERSION = '2026.10.1';
// 2026.10.2: dizin/yardım sayfası başlıkları için kesin ret kuralları eklendi
// (ret-baslik.sss, politika-belgesi, etkinlik-konusma, dizin-sayfasi,
// sayi-istatistik, dil-akademik-sinav). Eski sürümle sınıflanmış kayıtlar
// `npm run jobs:reclassify` ile güncellenir.
// 2026.10.3: ünvan/kadro + alım/temin kalıpları kanıt sayıldı
// 2026.10.4: kurumsal etkinlik/tören/ziyaret/rayiç fiyat başlıkları kesin ret
// (POSITION_RECRUITMENT_PATTERN, pozitif.unvan-alimi). "Hemşire, ebe ve sağlık
// teknikeri alımı", "destek personeli alımı", "uzman erbaş temin ilanı" gibi
// gerçek ilan başlıkları kanıt kapısında reddediliyordu. Eski sürümle
// sınıflanmış kayıtlar `npm run jobs:reclassify -- --apply` ile güncellenir.
// 2026.10.5: 21.10.2026 kural düzeltmeleri — haber kapısı görev unvanlı ilanı reddetmez
// (#25), başlıktaki statü gövdedeki dışlama cümlesine üstün (#27), "Bursa" kurum adı
// "burs" sayılmaz (#31). Eski sürümle verilmiş RET kararları tarama belleğinden düşer
// (src/ingest/pipeline.ts `loadKnownItemIds`): kaynakta hâlâ listelenen kayıt bir kez
// yeniden indirilip güncel kuralla değerlendirilir.
export const CLASSIFICATION_VERSION = '2026.10.5';
// 2026.10.2: gövde metni artık sayfa iskeletinden (menü, çerez/KVKK modali,
// erişilebilirlik araç çubuğu) arındırılarak çıkarılıyor.
// 2026.10.3: iskelet temizliği metin katmanında da genişletildi —
// UI_CHROME_PHRASES'e canlı koşumda gövdeye yapıştığı görülen erişilebilirlik
// çubuğu ("Erişilebilirlik Menüsü", "Ekran Okuyucu", "Okuma Maskesi" …) ve
// çerez metni dizeleri eklendi. Temizlikten önce kaydedilmiş gövdeler
// `npm run jobs:reclassify -- --apply` ile arındırılır; aynı komut gövdedsiz
// kalan eski yayım tarihlerini ve imkânsız son başvuru tarihlerini de temizler.
// 2026.10.4: gövde SEÇİMİ bağlantı yoğunluğuna göre yapılır. Gerçek kayıt
// kanıtı (16.10.2026): Karayolları/TMSF/DSİ/İŞKUR detay sayfalarında ilk
// "80+ karakterlik" kap menüydü ve gövdenin tamamını menü dolduruyordu; ilan
// metni menünün SONUNDA, kesme sınırının ötesinde kalıyordu. Artık metninin
// yarısından fazlası bağlantı olan aday ilan gövdesi sayılmaz (menü atlanır);
// sayfa tümüyle menüyse en az bağlantı yoğun adaya düşülür, kayıt boş kalmaz.
// 2026.10.5: birim (`unit`) çıkarımı tablo başlığı artıklarını almaz; birden fazla
// farklı birim varsa alan boş kalır (gerçek RG kanıtı: "SI KADRO ÜNVANI AÇIKLAMA
// MDF01 Mühendislik ve Doğa Bilimleri Fakültesi"). Yeni/yeniden görülen kayıtlara uygulanır.
// 2026.10.6: kontenjan belge adedinden okunmaz, kadro tablosu toplamı önceliklidir (#43);
// üniversite öğretim elemanı tabloları okunur; "N (yazıyla) … personel alınacaktır" resmî
// toplamı pozisyon başı sayıların önüne geçer (gerçek RG: Bursa Uludağ 37, Akdeniz 29, Sayıştay 2).
// 2026.10.7: kurum ilanlarında pozisyon kırılımı ("N. Unvan" + "(K Kişi – …)") okunur;
// resmî toplamdan farklıysa tutarsızlık yazılır (gerçek RG: Sayıştay 16.10-4-1, 1 + 1).
// 2026.10.8: resmî toplam birden çok kalemi toplar ("6 (altı) Uzman ve 1 (bir) Destek Personeli
// … alımı yapılacaktır"); rakam yazıyla doğrulanır, OCR'ın okuyamadığı rakamda yazı esas alınır
// (gerçek RG OCR: Orta Anadolu Kalkınma Ajansı 19.10-4-7, 2 → 7).
export const EXTRACTION_VERSION = '2026.10.8';
export const DEDUPE_VERSION = '2026.10.1';

/** Sayfalama sınırları. */
export const PAGINATION = {
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;
