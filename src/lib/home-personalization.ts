/**
 * Ana sayfa kişiselleştirme yardımcıları.
 *
 * Eşleştirme sunucuda yapılır (`GET /api/jobs/for-me`, bildirim eşleştiricisiyle
 * aynı kural). Burada yalnızca "kullanıcının anlamlı bir tercihi var mı?" sorusu
 * yanıtlanır; kural sunucudaki `hasActiveFilters` ile aynıdır.
 */
import type { PreferenceFilters } from '../types';

function cleaned(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** En az bir filtre dolu mu? Boş tercih kişiselleştirme sayılmaz. */
export function hasActivePreferences(filters: PreferenceFilters | null | undefined): boolean {
  if (!filters) return false;
  return (
    cleaned(filters.keywords).length > 0 ||
    cleaned(filters.titles).length > 0 ||
    cleaned(filters.institutions).length > 0 ||
    cleaned(filters.cities).length > 0 ||
    cleaned(filters.employmentTypes).length > 0 ||
    cleaned(filters.educationLevels).length > 0 ||
    cleaned(filters.departments).length > 0 ||
    cleaned(filters.kpssScoreTypes).length > 0 ||
    // Sihirbazda yalnız KPSS puanı girilse de tercih kaydedilir; kişiselleştirme sayılmalı.
    (filters.kpssMinScore ?? null) !== null ||
    (filters.minDaysUntilDeadline ?? null) !== null
  );
}
