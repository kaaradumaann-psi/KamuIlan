/**
 * Bildirim eşleştirme motoru (saf fonksiyonlar).
 *
 * Kurallar:
 *  - Aynı kategori içindeki değerler VEYA, farklı kategoriler VE ile bağlanır.
 *  - Hiç filtre yoksa kullanıcı "tüm ilanlar" akışına abonedir.
 *  - Eşleşmeyen tercih için bildirim olayı OLUŞTURULMAZ (gereksiz kayıt yok).
 *  - Eşleşme gerekçesi e-postada gösterilir; kullanıcı neden geldiğini bilir.
 *  - İlanda HİÇ belirtilmeyen koşul (il, öğrenim, KPSS türü/taban puanı) ilanı
 *    elemez: "belirtilmemiş" "uymuyor" demek değildir. Elemek, il yazmayan
 *    Türkiye geneli ya da KPSS'siz işçi alımlarını sessizce gizliyordu. Gerekçede
 *    "belirtilmemiş" diye açıkça yazılır.
 *
 * Aynı fonksiyon (`matchJobFilters`) ana sayfadaki "Size uygun ilanlar"
 * listesini de üretir; e-posta ile ekran aynı kuralla eşleşir.
 */
import type { JobDoc, NotificationPreferenceDoc } from '../db/schemas';
import { normalizeTr } from '../domain/text';

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

export type PreferenceFilters = NotificationPreferenceDoc['filters'];

/** Filtre dışı kapsam ayarları (işçi/akademik ilanları dahil etme). */
export type ScopeOptions = Pick<NotificationPreferenceDoc, 'includeWorkerJobs' | 'includeAcademicJobs'>;

/**
 * Etiketler TEK KAYNAKTAN (domain) gelir: bildirim e-postasındaki "çalışma
 * biçimi" metni ile arayüzdeki etiket aynı olmalıdır. Kopya sözlük tutulduğunda
 * e-posta "Akademik kadro", arayüz "Akademik personel" diyordu.
 */
import { EDUCATION_LEVEL_LABELS as EDUCATION_LABELS, EMPLOYMENT_TYPE_LABELS } from '../domain/types';

/** Başvuru bitişine kalan gün sayısı (İstanbul gününe göre, tam gün). */
export function daysUntilDeadline(job: Pick<JobDoc, 'applicationEndDate'>, now: Date): number | null {
  if (!job.applicationEndDate) return null;
  const end = Date.parse(`${job.applicationEndDate}T23:59:59+03:00`);
  if (!Number.isFinite(end)) return null;
  const diffMs = end - now.getTime();
  return Math.floor(diffMs / 86_400_000);
}

/** Aranacak anlamlı değerler (normalize edildiğinde en az 2 karakter). */
function needlesOf(values: readonly string[]): string[] {
  return values.filter((value) => normalizeTr(value).trim().length >= 2);
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

/**
 * Bölüm eşleşmesi: çıkarıcının sözlüğü ("Fizyoterapi") ile kullanıcının yazdığı
 * ya da öneri listesinden seçtiği ad ("Fizyoterapi ve Rehabilitasyon") birebir
 * aynı olmayabilir. Biri diğerini içeriyorsa eşleşir; ilanda bölüm alanı
 * çıkarılamamışsa başlık/metinde geçmesi yeter.
 */
function departmentHits(job: JobDoc, wanted: readonly string[]): string[] {
  const jobDepartments = job.requirements.departments.map((value) => normalizeTr(value)).filter(Boolean);
  const text = normalizeTr(`${job.title} ${job.textExcerpt}`);
  return wanted.filter((department) => {
    const needle = normalizeTr(department).trim();
    if (needle.length < 2) return false;
    if (jobDepartments.some((value) => value.includes(needle) || needle.includes(value))) return true;
    return text.includes(needle);
  });
}

/** En az bir filtre dolu mu? Boş tercih "tüm ilanlar" demektir, kişiselleştirme sayılmaz. */
export function hasActiveFilters(filters: PreferenceFilters | null | undefined): boolean {
  if (!filters) return false;
  return (
    needlesOf(filters.keywords).length > 0 ||
    needlesOf(filters.titles).length > 0 ||
    needlesOf(filters.institutions).length > 0 ||
    needlesOf(filters.cities).length > 0 ||
    needlesOf(filters.departments).length > 0 ||
    filters.employmentTypes.length > 0 ||
    filters.educationLevels.length > 0 ||
    filters.kpssScoreTypes.length > 0 ||
    filters.kpssMinScore !== null ||
    filters.minDaysUntilDeadline !== null
  );
}

/**
 * Yalnızca ilan filtrelerini ve kapsam ayarlarını uygular (bildirim açık/kapalı,
 * olay türü gibi gönderim kuralları `matchPreferenceToJob`'dadır).
 */
export function matchJobFilters(
  filters: PreferenceFilters,
  job: JobDoc,
  now: Date,
  scope: ScopeOptions,
): MatchResult {
  const reasons: string[] = [];
  const miss = (suppressedReason: string): MatchResult => ({ matched: false, reasons: [], suppressedReason });

  if (job.employmentType === 'kamu-isci' && !scope.includeWorkerJobs) {
    return miss('kamu işçisi ilanları hariç tutuldu');
  }
  if (job.employmentType === 'akademik' && !scope.includeAcademicJobs) {
    return miss('akademik ilanlar hariç tutuldu');
  }

  const titles = needlesOf(filters.titles);
  if (titles.length > 0) {
    // Ana başlık, çıkarılan unvanlar ve kadro tablosu birlikte aranır: "Hemşire"
    // aranırken başlığı "Sözleşmeli Personel Alımı" olan ilan da yakalanır.
    // Eski belgelerde `openings` alanı yoktur (şema varsayılanı yalnız ayrıştırmada uygulanır).
    const openings = job.openings ?? [];
    const titleText = [job.title, ...job.titles, ...openings.map((opening) => opening.title)].join(' | ');
    const titleHits = includesAny(titleText, titles);
    if (titleHits.length === 0) return miss('unvan filtresi eşleşmedi');
    reasons.push(`unvan: ${titleHits.slice(0, 3).join(', ')}`);
  }

  const institutions = needlesOf(filters.institutions);
  if (institutions.length > 0) {
    const institutionHits = includesAny(job.institution, institutions);
    if (institutionHits.length === 0) return miss('kurum filtresi eşleşmedi');
    reasons.push(`kurum: ${institutionHits.slice(0, 2).join(', ')}`);
  }

  const cities = needlesOf(filters.cities);
  if (cities.length > 0) {
    if (!job.city) {
      reasons.push('il belirtilmemiş');
    } else {
      const city = normalizeTr(job.city);
      if (!cities.some((candidate) => normalizeTr(candidate) === city)) return miss('il filtresi eşleşmedi');
      reasons.push(`il: ${job.city}`);
    }
  }

  if (filters.employmentTypes.length > 0) {
    if (!filters.employmentTypes.includes(job.employmentType)) {
      return miss('çalışma biçimi filtresi eşleşmedi');
    }
    reasons.push(`çalışma biçimi: ${EMPLOYMENT_TYPE_LABELS[job.employmentType]}`);
  }

  if (filters.educationLevels.length > 0) {
    if (job.requirements.educationLevels.length === 0) {
      reasons.push('öğrenim düzeyi belirtilmemiş');
    } else {
      const educationHits = overlap(job.requirements.educationLevels, filters.educationLevels);
      if (educationHits.length === 0) return miss('öğrenim düzeyi filtresi eşleşmedi');
      reasons.push(`öğrenim: ${educationHits.map((level) => EDUCATION_LABELS[level]).join(', ')}`);
    }
  }

  const departments = needlesOf(filters.departments);
  if (departments.length > 0) {
    const hits = departmentHits(job, departments);
    if (hits.length === 0) return miss('bölüm filtresi eşleşmedi');
    reasons.push(`bölüm: ${hits.slice(0, 3).join(', ')}`);
  }

  if (filters.kpssScoreTypes.length > 0 && job.requirements.kpssScoreTypes.length > 0) {
    // KPSS türü belirtmeyen ilan (ör. KPSS'siz işçi alımı) bu kullanıcıya da açıktır.
    const kpssTypeHits = overlap(job.requirements.kpssScoreTypes, filters.kpssScoreTypes);
    if (kpssTypeHits.length === 0) return miss('KPSS puan türü filtresi eşleşmedi');
    reasons.push(`KPSS: ${kpssTypeHits.join(', ')}`);
  }

  if (filters.kpssMinScore !== null) {
    const jobScore = job.requirements.kpssMinScore;
    if (jobScore === null) {
      reasons.push('KPSS taban puanı belirtilmemiş');
    } else {
      if (jobScore > filters.kpssMinScore) return miss('KPSS taban puanı kullanıcı puanının üzerinde');
      reasons.push(`KPSS taban puanı: ${jobScore}`);
    }
  }

  if (filters.minDaysUntilDeadline !== null) {
    const days = daysUntilDeadline(job, now);
    if (days === null) return miss('son başvuru tarihi belirtilmemiş');
    if (days < filters.minDaysUntilDeadline) return miss(`son başvuruya ${days} gün kaldı`);
    reasons.push(`son başvuruya ${days} gün`);
  }

  const keywords = needlesOf(filters.keywords);
  if (keywords.length > 0) {
    const keywordText = `${job.title} ${job.institution} ${job.titles.join(' ')} ${job.textExcerpt}`;
    const keywordHits = includesAny(keywordText, keywords);
    if (keywordHits.length === 0) return miss('anahtar kelime eşleşmedi');
    reasons.push(`anahtar kelime: ${keywordHits.slice(0, 4).join(', ')}`);
  }

  if (reasons.length === 0) reasons.push('tüm kamu personel ilanları');

  return { matched: true, reasons, suppressedReason: null };
}

/** Süreç duyurusu (kura, sınav, sonuç): bildirim kuyruğuna hiçbir koşulda girmez; yalnızca akışta görünür. */
export const PROCESS_NOTICE_SUPPRESSION = 'süreç duyurusu: bildirim gönderilmez (yalnızca akışta gösterilir)';

export function isProcessNotice(job: Pick<JobDoc, 'classification'>): boolean {
  return job.classification.kind === 'process';
}

/** İlanı kullanıcı tercihiyle karşılaştırır. */
export function matchPreferenceToJob(input: MatchInput): MatchResult {
  const { preference, job, kind, now } = input;
  if (isProcessNotice(job)) {
    return { matched: false, reasons: [], suppressedReason: PROCESS_NOTICE_SUPPRESSION };
  }

  if (!preference.enabled) {
    return { matched: false, reasons: [], suppressedReason: 'bildirimler kapalı' };
  }
  if (preference.paused) {
    return { matched: false, reasons: [], suppressedReason: 'bildirimler duraklatıldı' };
  }
  if (kind === 'job-changed' && !preference.notifyOnChanges) {
    return { matched: false, reasons: [], suppressedReason: 'değişiklik bildirimleri kapalı' };
  }
  if (kind === 'new-job' && !preference.onlyNewJobs && job.version > 1) {
    return { matched: false, reasons: [], suppressedReason: 'yalnızca değişiklik bildirimi istiyor' };
  }

  return matchJobFilters(preference.filters, job, now, preference);
}

export { EMPLOYMENT_TYPE_LABELS, EDUCATION_LABELS };
