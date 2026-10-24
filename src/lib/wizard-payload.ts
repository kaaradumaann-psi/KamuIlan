/**
 * Başlangıç sihirbazının seçimlerinden PUT /api/notifications/preferences
 * gövdesini üretir (saf fonksiyon — bileşenden bağımsız test edilir).
 *
 * Sunucu şeması (src/server/routes/notifications.ts) dizilerdeki her değerin
 * en az 2 karakter olmasını ister; bu yüzden burada kısa/boş değerler elenir.
 * kpssMinScore 0–100 aralığında tutulur. Yalnızca şemada tanımlı alanlar
 * gönderilir (gövde `.strict()` doğrulanır).
 *
 * Sihirbazın SORMADIĞI alanlar (kurum filtresi, son güne kalan gün, bildirim
 * modu, profil becerileri/deneyim) gövdeye YAZILMAZ: sunucu tercihleri alan
 * bazında birleştirir; boş değer göndermek Panel'de ayarlanmış değerleri
 * sessizce siliyordu.
 */
import type { EmploymentType } from '../domain/types';
import type { NotificationPreference } from '../types';

export interface WizardChoices {
  /** Hedef unvan(lar) — ilki aynı zamanda profil mesleği olur. */
  titles: string[];
  keywords: string[];
  departments: string[];
  cities: string[];
  employmentTypes: EmploymentType[];
  educationLevels: string[];
  /** Profil için tek eğitim düzeyi (opsiyonel). */
  educationLevel: string | null;
  kpssScoreTypes: string[];
  kpssMinScore: number | null;
  onlyNewJobs: boolean;
  notifyOnChanges: boolean;
  includeWorkerJobs: boolean;
  includeAcademicJobs: boolean;
}

export const INITIAL_WIZARD_CHOICES: WizardChoices = {
  titles: [],
  keywords: [],
  departments: [],
  cities: [],
  employmentTypes: [],
  educationLevels: [],
  educationLevel: null,
  kpssScoreTypes: [],
  kpssMinScore: null,
  onlyNewJobs: true,
  notifyOnChanges: true,
  includeWorkerJobs: true,
  includeAcademicJobs: true,
};

/** En az 2 karakterli, benzersiz, kırpılmış değerler (sunucu şemasıyla uyumlu). */
function sanitizeList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length < 2) continue;
    const key = trimmed.toLocaleLowerCase('tr');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function clampScore(score: number | null): number | null {
  if (score === null || Number.isNaN(score)) return null;
  return Math.max(0, Math.min(100, score));
}

/** En az bir anlamlı tercih seçildi mi? (Boş sihirbaz kaydedilmemeli.) */
export function hasAnyChoice(choices: WizardChoices): boolean {
  return (
    sanitizeList(choices.titles).length > 0 ||
    sanitizeList(choices.keywords).length > 0 ||
    sanitizeList(choices.departments).length > 0 ||
    sanitizeList(choices.cities).length > 0 ||
    choices.employmentTypes.length > 0 ||
    choices.educationLevels.length > 0 ||
    choices.kpssScoreTypes.length > 0 ||
    clampScore(choices.kpssMinScore) !== null
  );
}

export interface WizardPayload {
  enabled: true;
  paused: false;
  onlyNewJobs: boolean;
  notifyOnChanges: boolean;
  includeWorkerJobs: boolean;
  includeAcademicJobs: boolean;
  /** Yalnız unvan seçildiğinde `true` gönderilir; aksi hâlde mevcut ayar korunur. */
  profilePersonalizationEnabled?: true;
  candidateProfile: {
    profession: string;
    educationLevel: string | null;
    departments: string[];
  };
  filters: {
    keywords: string[];
    titles: string[];
    cities: string[];
    employmentTypes: EmploymentType[];
    educationLevels: string[];
    departments: string[];
    kpssScoreTypes: string[];
    kpssMinScore: number | null;
  };
}

export function buildWizardPayload(choices: WizardChoices): WizardPayload {
  const titles = sanitizeList(choices.titles);
  const departments = sanitizeList(choices.departments);
  const profession = titles[0] ?? '';
  return {
    enabled: true,
    paused: false,
    onlyNewJobs: choices.onlyNewJobs,
    notifyOnChanges: choices.notifyOnChanges,
    includeWorkerJobs: choices.includeWorkerJobs,
    includeAcademicJobs: choices.includeAcademicJobs,
    // Sihirbaz açıkça tamamlandığında profil eşleşme açıklamaları açılır.
    ...(profession.length > 0 ? { profilePersonalizationEnabled: true as const } : {}),
    candidateProfile: {
      profession,
      educationLevel: choices.educationLevel,
      departments,
    },
    filters: {
      keywords: sanitizeList(choices.keywords),
      titles,
      cities: sanitizeList(choices.cities),
      employmentTypes: choices.employmentTypes,
      educationLevels: choices.educationLevels,
      departments,
      kpssScoreTypes: choices.kpssScoreTypes,
      kpssMinScore: clampScore(choices.kpssMinScore),
    },
  };
}

/**
 * Kayıtlı tercihten sihirbaz başlangıcı: Panel'den yeniden açılan sihirbaz
 * mevcut seçimleri gösterir (boş başlayıp "Tamamla" ile silmez).
 */
export function choicesFromPreference(preference: NotificationPreference | null | undefined): WizardChoices {
  if (!preference) return INITIAL_WIZARD_CHOICES;
  const { filters } = preference;
  return {
    titles: [...filters.titles],
    keywords: [...filters.keywords],
    departments: [...filters.departments],
    cities: [...filters.cities],
    employmentTypes: [...filters.employmentTypes] as EmploymentType[],
    educationLevels: [...filters.educationLevels],
    educationLevel: preference.candidateProfile?.educationLevel ?? filters.educationLevels[0] ?? null,
    kpssScoreTypes: [...filters.kpssScoreTypes],
    kpssMinScore: filters.kpssMinScore,
    onlyNewJobs: preference.onlyNewJobs,
    notifyOnChanges: preference.notifyOnChanges,
    includeWorkerJobs: preference.includeWorkerJobs,
    includeAcademicJobs: preference.includeAcademicJobs,
  };
}
