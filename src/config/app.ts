/**
 * Uygulama kimliği ve işletim varsayılanları.
 *
 * Ürün adı tek yerden değiştirilebilir (marka değişikliği isteği) — arayüz,
 * e-posta ve meta etiketleri `BRANDING` üzerinden okur.
 */
export const BRANDING = {
  name: 'KamuRadar',
  shortName: 'KamuRadar',
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
export const CLASSIFICATION_VERSION = '2026.10.1';
export const EXTRACTION_VERSION = '2026.10.1';
export const DEDUPE_VERSION = '2026.10.1';

/** Sayfalama sınırları. */
export const PAGINATION = {
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;
