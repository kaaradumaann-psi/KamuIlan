/**
 * Bildirim eşleştirme motoru (saf fonksiyonlar).
 *
 * Kurallar:
 *  - Aynı kategori içindeki değerler VEYA, farklı kategoriler VE ile bağlanır.
 *  - Hiç filtre yoksa kullanıcı "tüm ilanlar" akışına abonedir.
 *  - Eşleşmeyen tercih için bildirim olayı OLUŞTURULMAZ (gereksiz kayıt yok).
 *  - Eşleşme gerekçesi e-postada gösterilir; kullanıcı neden geldiğini bilir.
 */
import type { JobDoc, NotificationPreferenceDoc } from '../db/schemas';
import { normalizeTr } from '../domain/text';
import type { EmploymentType, EducationLevel } from '../domain';

export interface MatchResult {
  matched: boolean;
  /** Bildirimin neden gönderildiğini açıklayan kısa etiketler. */
  reasons: string[];
  /** Eşleşmeme nedeni (kullanıcı panelinde gösterilebilir). */
  suppressedReason: string | null;
}

export interface MatchInput {
  preference: NotificationPreferenceDoc;
  job: JobDoc;
  /** 'new-job' yalnızca yeni ilanlarda, 'job-changed' sürüm değişikliklerinde. */
  kind: 'new-job' | 'job-changed';
  now: Date;
}

const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  kadrolu: 'Kadrolu memur',
  sozlesmeli: 'Sözleşmeli personel',
  'kamu-isci': 'Kamu işçisi',
  akademik: 'Akademik kadro',
  'kariyer-meslek': 'Kariyer meslek personeli',
  'kuruma-ozel-sinav': 'Kuruma özgü sınavla alım',
  'diger-kamu': 'Diğer kamu personeli',
  belirsiz: 'Türü belirsiz',
};

const EDUCATION_LABELS: Record<EducationLevel, string> = {
  ilkogretim: 'İlköğretim',
  ortaogretim: 'Ortaöğretim (lise)',
  onlisans: 'Ön lisans',
  lisans: 'Lisans',
  yukseklisans: 'Yüksek lisans',
  doktora: 'Doktora',
};

/** Başvuru bitişine kalan gün sayısı (İstanbul gününe göre, tam gün). */
export function daysUntilDeadline(job: Pick<JobDoc, 'applicationEndDate'>, now: Date): number | null {
  if (!job.applicationEndDate) return null;
  const end = Date.parse(`${job.applicationEndDate}T23:59:59+03:00`);
  if (!Number.isFinite(end)) return null;
  const diffMs = end - now.getTime();
  return Math.floor(diffMs / 86_400_000);
}

function includesAny(haystack: string, needles: readonly string[]): string[] {
  if (needles.length === 0) return [];
  const normalizedHaystack = normalizeTr(haystack);
  const hits: string[] = [];
  for (const needle of needles) {
    const normalizedNeedle = normalizeTr(needle).trim();
    if (normalizedNeedle.length < 2) continue;
    if (normalizedHaystack.includes(normalizedNeedle)) hits.push(needle);
  }
  return hits;
}

function overlap<T extends string>(values: readonly T[], needles: readonly T[]): T[] {
  if (needles.length === 0) return [];
  const set = new Set<string>(values);
  return needles.filter((needle) => set.has(needle));
}

/** İlanı kullanıcı tercihiyle karşılaştırır. */
export function matchPreferenceToJob(input: MatchInput): MatchResult {
  const { preference, job, kind, now } = input;
  const reasons: string[] = [];

  if (!preference.enabled) {
    return { matched: false, reasons: [], suppressedReason: 'bildirimler kapalı' };
  }
  if (preference.paused) {
    return { matched: false, reasons: [], suppressedReason: 'bildirimler duraklatıldı' };
  }
  if (kind === 'new-job' && !preference.onlyNewJobs) {
    // Yalnızca yeni ilan isteyen kullanıcı için yeni ilan her zaman uygundur;
    // bu dal onlyNewJobs=false olan kullanıcı için ek kontrol gerektirmez.
  }
  if (kind === 'job-changed' && !preference.notifyOnChanges) {
    return { matched: false, reasons: [], suppressedReason: 'değişiklik bildirimleri kapalı' };
  }
  if (kind === 'new-job' && !preference.onlyNewJobs && job.version > 1) {
    return { matched: false, reasons: [], suppressedReason: 'yalnızca değişiklik bildirimi istiyor' };
  }
  if (job.employmentType === 'kamu-isci' && !preference.includeWorkerJobs) {
    return { matched: false, reasons: [], suppressedReason: 'kamu işçisi ilanları hariç tutuldu' };
  }
  if (job.employmentType === 'akademik' && !preference.includeAcademicJobs) {
    return { matched: false, reasons: [], suppressedReason: 'akademik ilanlar hariç tutuldu' };
  }

  const filters = preference.filters;

  const titleHits = includesAny(job.title, filters.titles);
  if (filters.titles.length > 0 && titleHits.length === 0) {
    return { matched: false, reasons: [], suppressedReason: 'unvan filtresi eşleşmedi' };
  }
  if (titleHits.length > 0) reasons.push(`unvan: ${titleHits.slice(0, 3).join(', ')}`);

  const jobTitleHits = overlap(job.titles, filters.titles);
  if (jobTitleHits.length > 0 && titleHits.length === 0) reasons.push(`unvan: ${jobTitleHits.slice(0, 3).join(', ')}`);

  const institutionHits = includesAny(job.institution, filters.institutions);
  if (filters.institutions.length > 0 && institutionHits.length === 0) {
    return { matched: false, reasons: [], suppressedReason: 'kurum filtresi eşleşmedi' };
  }
  if (institutionHits.length > 0) reasons.push(`kurum: ${institutionHits.slice(0, 2).join(', ')}`);

  if (filters.cities.length > 0) {
    const city = job.city ?? '';
    if (!filters.cities.some((candidate) => normalizeTr(candidate) === normalizeTr(city))) {
      return { matched: false, reasons: [], suppressedReason: 'il filtresi eşleşmedi' };
    }
    reasons.push(`il: ${job.city}`);
  }

  if (filters.employmentTypes.length > 0) {
    if (!filters.employmentTypes.includes(job.employmentType)) {
      return { matched: false, reasons: [], suppressedReason: 'çalışma biçimi filtresi eşleşmedi' };
    }
    reasons.push(`çalışma biçimi: ${EMPLOYMENT_TYPE_LABELS[job.employmentType]}`);
  }

  const educationHits = overlap(job.requirements.educationLevels, filters.educationLevels);
  if (filters.educationLevels.length > 0 && educationHits.length === 0) {
    return { matched: false, reasons: [], suppressedReason: 'öğrenim düzeyi filtresi eşleşmedi' };
  }
  if (educationHits.length > 0) {
    reasons.push(`öğrenim: ${educationHits.map((level) => EDUCATION_LABELS[level]).join(', ')}`);
  }

  const departmentHits = overlap(
    job.requirements.departments.map((value) => normalizeTr(value)),
    filters.departments.map((value) => normalizeTr(value)),
  );
  if (filters.departments.length > 0 && departmentHits.length === 0) {
    return { matched: false, reasons: [], suppressedReason: 'bölüm filtresi eşleşmedi' };
  }
  if (departmentHits.length > 0) reasons.push(`bölüm: ${departmentHits.slice(0, 3).join(', ')}`);

  const kpssTypeHits = overlap(job.requirements.kpssScoreTypes, filters.kpssScoreTypes);
  if (filters.kpssScoreTypes.length > 0 && kpssTypeHits.length === 0) {
    return { matched: false, reasons: [], suppressedReason: 'KPSS puan türü filtresi eşleşmedi' };
  }
  if (kpssTypeHits.length > 0) reasons.push(`KPSS: ${kpssTypeHits.join(', ')}`);

  if (filters.kpssMinScore !== null) {
    const jobScore = job.requirements.kpssMinScore;
    if (jobScore === null) {
      // Puan bilgisi yoksa "kesin eşleşti" denemez; bilgi eksikliği nedeniyle
      // gönderilmez ve neden yazılır (yanlış pozitif üretmemek için).
      return { matched: false, reasons: [], suppressedReason: 'ilanda KPSS taban puanı belirtilmemiş' };
    }
    if (jobScore > filters.kpssMinScore) {
      return { matched: false, reasons: [], suppressedReason: 'KPSS taban puanı kullanıcı eşiğinin üzerinde' };
    }
    reasons.push(`KPSS taban puanı: ${jobScore}`);
  }

  if (filters.minDaysUntilDeadline !== null) {
    const days = daysUntilDeadline(job, now);
    if (days === null) {
      return { matched: false, reasons: [], suppressedReason: 'son başvuru tarihi belirtilmemiş' };
    }
    if (days < filters.minDaysUntilDeadline) {
      return { matched: false, reasons: [], suppressedReason: `son başvuruya ${days} gün kaldı` };
    }
    reasons.push(`son başvuruya ${days} gün`);
  }

  const keywordHits = includesAny(`${job.title} ${job.textExcerpt}`, filters.keywords);
  if (filters.keywords.length > 0 && keywordHits.length === 0) {
    return { matched: false, reasons: [], suppressedReason: 'anahtar kelime eşleşmedi' };
  }
  if (keywordHits.length > 0) reasons.push(`anahtar kelime: ${keywordHits.slice(0, 4).join(', ')}`);

  if (reasons.length === 0) reasons.push('tüm kamu personel ilanları');

  return { matched: true, reasons, suppressedReason: null };
}

export { EMPLOYMENT_TYPE_LABELS, EDUCATION_LABELS };
