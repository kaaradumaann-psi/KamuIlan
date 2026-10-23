/**
 * Tekilleştirme motoru (saf fonksiyonlar — ağ ve veritabanı erişimi yok).
 *
 * Öncelik sırası (spec 8):
 *  1. Kaynağın resmî ilan kimliği (sourceKey + sourceItemId)
 *  2. Resmî ilan/duyuru numarası
 *  3. Normalize edilmiş kanonik URL
 *  4. Kurum + unvan + başvuru dönemi + metin benzerliği
 *  5. Şüpheli durumlar insan incelemesine gider
 *
 * Kural: benzer başlıklı iki FARKLI ilan otomatik birleştirilmez; eşik aralığında
 * kalan eşleşmeler `review` döner.
 */
import { diceSimilarity, jaccardSimilarity, normalizeTr } from '../domain/text';
import { sha256Hex } from '../domain/ids';

/** Eşikler — test edilebilir, tek yerde. */
export const DEDUPE_THRESHOLDS = {
  /** Bu oranın üzerindeki başlık benzerliği + aynı kurum → birleştir. */
  mergeTitleSimilarity: 0.86,
  /** Bu aralıktaki benzerlik → insan incelemesi. */
  reviewTitleSimilarity: 0.7,
  /** Metin benzerliği ile birleştirme eşiği (aynı kurum + aynı dönem). */
  mergeTextSimilarity: 0.72,
  /**
   * Başlık benzerliği yüksek olsa bile dönem farklıysa, ancak metin bu kadar
   * benzeriyse "aynı ilan" kabul edilir (farklı ilanların yanlış birleşmesini
   * engeller).
   */
  sameAnnouncementTextSimilarity: 0.45,
} as const;

export interface DedupeRawItem {
  sourceKey: string;
  sourceItemId: string;
  title: string;
  institution: string | null;
  normalizedUrl: string;
  referenceNo: string | null;
  applicationEndDate: string | null;
  textExcerpt: string;
}

export interface DedupeCandidateJob {
  id: string;
  title: string;
  titleNormalized: string;
  institution: string;
  institutionNormalized: string;
  normalizedUrl: string;
  originalRefNo: string | null;
  applicationEndDate: string | null;
  textExcerpt: string;
  sourceKeys: string[];
  /**
   * İlana bağlı kaynak kayıtlarının kimlikleri (`${sourceKey}::${sourceItemId}`).
   * Aynı kaynağın FARKLI kaynak-içi kimliğiyle gelen ilanın yanlışlıkla bu ilana
   * birleşmesini engellemek için kullanılır (bkz. `hasConflictingSourceItem`).
   */
  sourceItemIds: string[];
}

export type DedupeAction = 'create' | 'merge' | 'review';

export interface DedupeDecision {
  action: DedupeAction;
  jobId: string | null;
  matchedBy: string[];
  reason: string;
  score: number;
  /** İnceleme gerekiyorsa aday ilan kimlikleri. */
  candidateJobIds: string[];
}

/** Kaynak-içi kimlik eşleşmesi: aynı kaynak aynı ilanı tekrar yayımladı. */
export function matchBySourceIdentity(
  raw: DedupeRawItem,
  link: { jobId: string; sourceKey: string; sourceItemId: string } | null,
): DedupeDecision | null {
  if (!link) return null;
  if (link.sourceKey !== raw.sourceKey || link.sourceItemId !== raw.sourceItemId) return null;
  return {
    action: 'merge',
    jobId: link.jobId,
    matchedBy: ['source-item-id'],
    reason: 'Aynı kaynak aynı ilanı yeniden yayımladı (kaynak içi kimlik eşleşti).',
    score: 1,
    candidateJobIds: [link.jobId],
  };
}

/**
 * Aday ilan, AYNI kaynaktan FARKLI bir kaynak-içi kimlikle zaten bağlı mı?
 *
 * Üretim bulgusu (23.10.2026): İŞKUR e-Şube kaynağı 91 ayrı İŞKUR ilan
 * numarası getirdi; her satır kendi ilanıdır (farklı il/meslek/kurum). Kurum +
 * başlık + son başvuru benzerliği yüksek olduğu için bunlar 10 ilana
 * birleşiyordu. Kural: aynı kaynağın iki FARKLI kaynak-içi kimliği asla tek
 * ilanda birleşmez. (Kaynaklar arası tekilleştirme — aynı ilan RG + İŞKUR —
 * etkilenmez: farklı kaynağın kimliği burada çatışma saymaz.)
 */
function hasConflictingSourceItem(raw: DedupeRawItem, candidate: DedupeCandidateJob): boolean {
  const prefix = `${raw.sourceKey}::`;
  return candidate.sourceItemIds.some(
    (entry) => entry.startsWith(prefix) && entry.slice(prefix.length) !== raw.sourceItemId,
  );
}

export function decideDedupe(raw: DedupeRawItem, rawCandidates: DedupeCandidateJob[]): DedupeDecision {
  if (rawCandidates.length === 0) {
    return {
      action: 'create',
      jobId: null,
      matchedBy: [],
      reason: 'Aynı ilana benzeyen kayıt bulunamadı; yeni ilan oluşturuldu.',
      score: 0,
      candidateJobIds: [],
    };
  }

  // Aynı kaynağın farklı kaynak-içi kimliğiyle zaten bağlı adaylar birleştirme
  // hedefi OLAMAZ: bunlar ayrı ilanlardır. Adaylardan elenir; geriye kimse
  // kalmazsa yeni ilan oluşturulur.
  const candidates = rawCandidates.filter((candidate) => !hasConflictingSourceItem(raw, candidate));
  if (candidates.length === 0) {
    return {
      action: 'create',
      jobId: null,
      matchedBy: [],
      reason:
        'Aynı kaynağın farklı ilan numaraları ayrı ilandır; eşleşen tüm adaylar aynı kaynaktan başka kimlikle bağlı.',
      score: 0,
      candidateJobIds: [],
    };
  }

  // 2) Resmî ilan numarası
  if (raw.referenceNo) {
    const referenceNeedle = normalizeTr(raw.referenceNo);
    const byReference = candidates.find(
      (candidate) => candidate.originalRefNo && normalizeTr(candidate.originalRefNo) === referenceNeedle,
    );
    if (byReference) {
      return {
        action: 'merge',
        jobId: byReference.id,
        matchedBy: ['official-reference'],
        reason: `Resmî ilan numarası eşleşti (${raw.referenceNo}).`,
        score: 0.99,
        candidateJobIds: [byReference.id],
      };
    }
  }

  // 3) Kanonik URL
  const byUrl = candidates.find((candidate) => candidate.normalizedUrl === raw.normalizedUrl);
  if (byUrl) {
    return {
      action: 'merge',
      jobId: byUrl.id,
      matchedBy: ['canonical-url'],
      reason: 'Kanonik ilan URL’si aynı.',
      score: 0.97,
      candidateJobIds: [byUrl.id],
    };
  }

  // 4) Kurum + unvan + dönem + metin benzerliği
  const rawInstitution = normalizeTr(raw.institution ?? '');
  const rawTitle = normalizeTr(raw.title);
  let best:
    | { job: DedupeCandidateJob; titleScore: number; textScore: number; institutionMatch: boolean; combined: number }
    | null = null;

  for (const candidate of candidates) {
    const institutionMatch =
      rawInstitution.length > 0 &&
      (candidate.institutionNormalized === rawInstitution ||
        candidate.institutionNormalized.includes(rawInstitution) ||
        rawInstitution.includes(candidate.institutionNormalized));
    const titleScore = diceSimilarity(rawTitle, candidate.titleNormalized || normalizeTr(candidate.title));
    const textScore =
      raw.textExcerpt.length > 80 && candidate.textExcerpt.length > 80
        ? jaccardSimilarity(raw.textExcerpt.slice(0, 3_000), candidate.textExcerpt.slice(0, 3_000))
        : 0;
    const samePeriod =
      Boolean(raw.applicationEndDate) && raw.applicationEndDate === candidate.applicationEndDate;
    const combined = titleScore * 0.6 + textScore * 0.25 + (institutionMatch ? 0.15 : 0) + (samePeriod ? 0.1 : 0);
    if (!best || combined > best.combined) {
      best = { job: candidate, titleScore, textScore, institutionMatch, combined };
    }
  }

  if (!best) {
    return {
      action: 'create',
      jobId: null,
      matchedBy: [],
      reason: 'Aday kayıtlar değerlendirildi, eşleşme bulunamadı.',
      score: 0,
      candidateJobIds: candidates.map((candidate) => candidate.id),
    };
  }

  const { job, titleScore, textScore, institutionMatch } = best;
  const samePeriod = Boolean(raw.applicationEndDate) && raw.applicationEndDate === job.applicationEndDate;

  if (institutionMatch && titleScore >= DEDUPE_THRESHOLDS.mergeTitleSimilarity) {
    // Başlık benzerliği tek başına yeterli DEĞİLDİR: aynı kurumun benzer başlıklı
    // FARKLI ilanları (örn. "… Personel Alım İlanı" ve "… Personel Alım İlanı
    // (Şoför)") otomatik birleştirilmemelidir. Bu yüzden aynı başvuru dönemi ya
    // da yüksek metin benzerliği de aranır; yoksa insan incelemesine gider.
    if (samePeriod || textScore >= DEDUPE_THRESHOLDS.sameAnnouncementTextSimilarity) {
      return {
        action: 'merge',
        jobId: job.id,
        matchedBy: ['institution+title'],
        reason: `Kurum ve başlık benzerliği yüksek (${(titleScore * 100).toFixed(0)}%) ve ${samePeriod ? 'başvuru dönemi aynı' : `metin benzerliği yüksek (${(textScore * 100).toFixed(0)}%)`}.`,
        score: titleScore,
        candidateJobIds: [job.id],
      };
    }
    return {
      action: 'review',
      jobId: null,
      matchedBy: ['institution+title-similar'],
      reason: `Kurum ve başlık benzer (${(titleScore * 100).toFixed(0)}%) ancak başvuru dönemi ve metin farklı; ayrı ilan olabilir. İnsan incelemesi gerekiyor.`,
      score: titleScore,
      candidateJobIds: [job.id],
    };
  }

  if (institutionMatch && samePeriod && textScore >= DEDUPE_THRESHOLDS.mergeTextSimilarity) {
    return {
      action: 'merge',
      jobId: job.id,
      matchedBy: ['institution+period+text'],
      reason: `Kurum, başvuru dönemi ve ilan metni benzerliği yüksek (${(textScore * 100).toFixed(0)}%).`,
      score: textScore,
      candidateJobIds: [job.id],
    };
  }

  // Farklı kurumların kalıp başlıkları ("X Rektörlüğünden: ÖĞRETİM ÜYESİ ALIM İLANI") yüksek
  // benzerlik verir; kurumlar açıkça farklı ve metin de benzemiyorsa ayrı ilandır (üretim
  // 22.10.2026: gerçek akademik ilanlar "aynı ilan olabilir" incelemesinde kalıyordu).
  const rawPrefix = titleInstitutionPrefix(raw.title);
  const candidatePrefix = titleInstitutionPrefix(job.title);
  const institutionsDiffer =
    (rawInstitution.length > 0 && job.institutionNormalized.length > 0 && !institutionMatch) ||
    (rawPrefix.length > 0 && candidatePrefix.length > 0 && rawPrefix !== candidatePrefix);
  if (institutionsDiffer && textScore < DEDUPE_THRESHOLDS.sameAnnouncementTextSimilarity) {
    return {
      action: 'create',
      jobId: null,
      matchedBy: [],
      reason: `Başlıklar benzer (${(titleScore * 100).toFixed(0)}%) ancak kurumlar farklı; ayrı ilan olarak kaydedildi.`,
      score: titleScore,
      candidateJobIds: [],
    };
  }

  if (titleScore >= DEDUPE_THRESHOLDS.reviewTitleSimilarity) {
    return {
      action: 'review',
      jobId: null,
      matchedBy: ['institution+title-similar'],
      reason: `Başlıklar benzer (${(titleScore * 100).toFixed(0)}%) ancak otomatik birleştirme güvenli değil; insan incelemesi gerekiyor.`,
      score: titleScore,
      candidateJobIds: [job.id],
    };
  }

  return {
    action: 'create',
    jobId: null,
    matchedBy: [],
    reason: 'Benzerlik eşiklerin altında; ayrı ilan olarak kaydedildi.',
    score: titleScore,
    candidateJobIds: [],
  };
}

/** İlan metni içerik hash'i (değişiklik tespiti). */
export function contentHashOf(parts: (string | null | undefined)[]): string {
  return sha256Hex(parts.map((part) => (part ?? '').trim()).join('\u0001'));
}

/** Resmî Gazete kalıbı "Kurum Adından: BAŞLIK" → normalize edilmiş "Kurum Adından" (yoksa boş). */
function titleInstitutionPrefix(title: string): string {
  const index = title.indexOf(':');
  return index >= 8 ? normalizeTr(title.slice(0, index)) : '';
}
