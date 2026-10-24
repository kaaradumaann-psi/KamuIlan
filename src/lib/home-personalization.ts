/**
 * Ana sayfa kişiselleştirme yardımcıları.
 *
 * Kullanıcının Panel'de kaydettiği bildirim tercihlerinden (`PreferenceFilters`)
 * "başvurusu açık" ilan sorgusu üretir.
 *
 * Eşleme notu: `/api/jobs` `q` alanı TEK bir arama terimi alır; bu yüzden birden
 * çok anahtar kelime varsa yalnızca ilki `q`'ya yazılır (geri kalan atlanır,
 * ilki yoksa ilk kayıtlı unvana düşülür). `institution` de tek değer aldığından
 * ilk kurum kullanılır. Şehir, çalışma türü, eğitim, bölüm ve KPSS türü alanları
 * dizi olarak desteklendiğinden tümü gönderilir.
 */
import type { PreferenceFilters } from '../types';

/** `api.get` sorgu sözlüğüyle uyumlu düz nesne (index imzalı). */
export type PreferenceJobQuery = Record<string, string | number | string[] | undefined>;

/** Kişiselleştirilmiş vitrinde gösterilecek varsayılan ilan sayısı. */
export const PERSONALIZED_PAGE_SIZE = 6;

function firstNonEmpty(values: readonly string[] | undefined): string | undefined {
  if (!values) return undefined;
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

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
    cleaned(filters.kpssScoreTypes).length > 0
  );
}

/** Tercihlerden `/api/jobs` sorgu parametrelerini üretir (açık ilan, son güne göre). */
export function jobQueryFromPreferences(
  filters: PreferenceFilters,
  pageSize: number = PERSONALIZED_PAGE_SIZE,
): PreferenceJobQuery {
  const query: PreferenceJobQuery = { status: 'active', sort: 'deadline', pageSize };
  const q = firstNonEmpty(filters.keywords) ?? firstNonEmpty(filters.titles);
  if (q) query.q = q;
  const institution = firstNonEmpty(filters.institutions);
  if (institution) query.institution = institution;
  const city = cleaned(filters.cities);
  if (city.length > 0) query.city = city;
  const employmentType = cleaned(filters.employmentTypes);
  if (employmentType.length > 0) query.employmentType = employmentType;
  const education = cleaned(filters.educationLevels);
  if (education.length > 0) query.education = education;
  const department = cleaned(filters.departments);
  if (department.length > 0) query.department = department;
  const kpssType = cleaned(filters.kpssScoreTypes);
  if (kpssType.length > 0) query.kpssType = kpssType;
  return query;
}

/**
 * "Tüm uygun ilanlar" bağlantısı.
 *
 * `/ilanlar` formu her alandan yalnızca TEK değer okuduğundan diziler ilk
 * değerleriyle temsil edilir; böylece bağlantı liste formuyla sorunsuz yuvarlanır.
 */
export function preferenceListPath(filters: PreferenceFilters): string {
  const params = new URLSearchParams();
  const q = firstNonEmpty(filters.keywords) ?? firstNonEmpty(filters.titles);
  if (q) params.set('q', q);
  const city = firstNonEmpty(filters.cities);
  if (city) params.set('city', city);
  const institution = firstNonEmpty(filters.institutions);
  if (institution) params.set('institution', institution);
  const employmentType = firstNonEmpty(filters.employmentTypes);
  if (employmentType) params.set('employmentType', employmentType);
  const education = firstNonEmpty(filters.educationLevels);
  if (education) params.set('education', education);
  const department = firstNonEmpty(filters.departments);
  if (department) params.set('department', department);
  const kpssType = firstNonEmpty(filters.kpssScoreTypes);
  if (kpssType) params.set('kpssType', kpssType);
  params.set('status', 'active');
  params.set('sort', 'deadline');
  return `/ilanlar?${params.toString()}`;
}
