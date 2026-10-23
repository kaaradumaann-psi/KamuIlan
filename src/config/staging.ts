/**
 * Operatör staging akışının sabit güvenlik sınırları.
 *
 * Amaç: tek komutla TEK kaynağın sınırlı bir kesitini ayrı dosya deposuna almak.
 * Bu liste bilinçlidir ve kod değişikliği olmadan genişletilemez; böylece yanlış
 * kaynak anahtarı verildiğinde komut ağa çıkmadan durur.
 *
 * Listeye yalnızca kaynak envanterinde `verified` durumunda olan ve operatörün
 * erişim şartlarını ayrıca inceleyebileceği kaynaklar girer. `config/source-terms.json`
 * içindeki insan incelemesi tamamlanmadan canlı koşum yine başlamaz.
 */
export const STAGING_SOURCE_ALLOWLIST = [
  'resmigazete-cestili-ilanlar',
  'osym-duyurular',
  // iskur-kamu-memur-alim / iskur-kurumdisi-kamu-isci 22.10.2026'da robots kısıtı
  // nedeniyle devre dışı (access-restricted, terms=blocked); artık `verified`
  // değiller ve terms kapısı canlı staging koşumunu zaten durduruyordu → listeden
  // çıkarıldı (bu liste yalnız verified + izin incelenebilir kaynakları taşır).
] as const;

export type StagingSourceKey = (typeof STAGING_SOURCE_ALLOWLIST)[number];

export function isStagingSourceAllowed(sourceKey: string): sourceKey is StagingSourceKey {
  return (STAGING_SOURCE_ALLOWLIST as readonly string[]).includes(sourceKey);
}

/** Depo içi geçici staging kökü; `.gitignore` altındadır. */
export const STAGING_DATA_ROOT = '.staging';

/** Canlı olmayan (kuru) çalışma varsayılanı. */
export const STAGING_DEFAULT_BUDGETS = {
  maxRequests: 5,
  maxPages: 3,
  maxDetails: 1,
  minDelayMs: 1_500,
} as const;
