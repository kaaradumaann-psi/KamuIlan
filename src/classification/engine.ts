/**
 * Sınıflandırma motoru (deterministik, ağ erişimi gerektirmez).
 *
 * Amaç: yalnızca personel alım ilanlarını akışa almak. Resmî Gazete, ÖSYM ve
 * ilan.gov.tr gibi kaynaklarda ihale, sonuç, mevzuat ve tebligat duyuruları
 * yoğundur; bunlar akışı kirletmemelidir.
 *
 * Karar politikası:
 *  - Başlıkta kesin ret ifadesi (sonuç/ihale/mevzuat/yargı/staj…) → `reject`
 *  - Gövdede kesin ret ifadesi (ihale metni, icra, kurs…) → `reject`
 *  - Olumlu puan ≥ 3.0 → `accept`
 *  - 1.5 ≤ puan < 3.0 → `review` (inceleme kuyruğu; kayıt silinmez)
 *  - Puan < 1.5 → `reject` (gerekçe kayda geçer) — hiçbir kayıt sessizce atılmaz,
 *    karar ve gerekçe scrapeRuns/inceleme kuyruğunda tutulur.
 */
import { makeExcerpt, normalizeTr } from '../domain/text';
import type { ClassificationResult, EmploymentType } from '../domain';
import { CLASSIFICATION_VERSION } from '../config/app';
import {
  BODY_REJECT_RULES,
  EMPLOYMENT_TYPE_RULES,
  POSITIVE_RULES,
  RECRUITMENT_CATEGORY_PATTERN,
  RECRUITMENT_EVIDENCE_PATTERN,
  SOFT_NEGATIVE_RULES,
  TITLE_REJECT_RULES,
  type KeywordRule,
} from './rules';

export interface ClassificationInput {
  title: string;
  /** İlan gövdesi/metni varsa; yoksa yalnızca başlık + özet kullanılır. */
  body?: string | null;
  /** Kaynağın kendi kategori başlığı (varsa). */
  sourceCategory?: string | null;
  /** Kaynak kimliği (gerekçeye yazılır). */
  sourceKey?: string;
  /** Belge (PDF) metni okunamadıysa güven düşürülür. */
  documentTextMissing?: boolean;
}

export interface MatchedRule {
  id: string;
  reason: string;
  weight: number;
}

const ACCEPT_THRESHOLD = 3;
const REVIEW_THRESHOLD = 1;

/** Başlık + gövde + kategori tek seferde normalize edilir. */
export function normalizeForClassification(value: string): string {
  return normalizeTr(value);
}

function matchRules(text: string, rules: readonly KeywordRule[]): MatchedRule[] {
  const matched: MatchedRule[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(text)) matched.push({ id: rule.id, reason: rule.reason, weight: rule.weight });
  }
  return matched;
}

export function detectEmploymentType(title: string, body: string): { type: EmploymentType; reason: string } {
  // Ham metinle de çağrılabilir: normalize burada yapılır.
  const combined = normalizeForClassification(`${title} ${body}`);
  for (const rule of EMPLOYMENT_TYPE_RULES) {
    if (rule.pattern.test(combined)) return { type: rule.type, reason: rule.reason };
  }
  return { type: 'belirsiz', reason: 'İstihdam türü metinden belirlenemedi' };
}

/**
 * Ana sınıflandırma fonksiyonu. Saf fonksiyondur: aynı girdi her zaman aynı
 * sonucu verir (test edilebilirlik).
 */
export function classify(input: ClassificationInput): ClassificationResult {
  const titleText = normalizeForClassification(input.title ?? '');
  const bodyText = normalizeForClassification(input.body ?? '');
  const categoryText = normalizeForClassification(input.sourceCategory ?? '');

  const titleHasRecruitmentCue =
    /\b(?:personel\s+alim|memur\s+alim|isci\s+alim|akademik\s+personel\s+alim|uzman\s+yardimciligi|giris\s+sinav|kariyer\s+uzmani\s+alim|sozlesmeli\s+personel\s+alim)\b/.test(
      titleText,
    );
  const incumbentExamContext =
    /\b(?:halihazirda|gorevde\s+bulunan|gorev\s+yapmakta\s+olan|mevcut\s+personel|uzman\s+yardimcisi\s+olarak\s+gorev)/.test(
      bodyText,
    );
  const bodyHasRecruitmentCue =
    /\b(?:personel\s+alim|memur\s+alim|isci\s+alim|akademik\s+personel\s+alim|uzman\s+yardimciligi|giris\s+sinav|kariyer\s+uzmani\s+alim|sozlesmeli\s+personel\s+alim|atanmak\s+uzere|kadroya\s+alim)\b/.test(
      bodyText,
    );
  const inServiceQualificationExam =
    /\byeterlik\s+sinav\w*/.test(`${titleText} ${bodyText}`) && incumbentExamContext;
  const nonRecruitmentPressRelease =
    /\bbasin\s+(?:duyurusu|aciklamasi)\b/.test(titleText) &&
    !titleHasRecruitmentCue &&
    !bodyHasRecruitmentCue;
  if (inServiceQualificationExam || nonRecruitmentPressRelease) {
    const reason = inServiceQualificationExam
      ? 'Yeterlik sınavı mevcut görevli personele yönelik görünüyor; yeni işe alım ilanı değil'
      : 'Basın duyurusu/haber başlığı; personel alımı ilanı olduğuna dair başlık kanıtı yok';
    const rule = inServiceQualificationExam ? 'ret-baslik.hizmet-ici-yeterlik' : 'ret-baslik.basin-duyurusu';
    return {
      decision: 'reject',
      employmentType: 'belirsiz',
      confidence: 0.95,
      reasons: [reason, `Kural: ${rule}`],
      rules: [rule],
      negativeSignals: [reason],
      version: CLASSIFICATION_VERSION,
    };
  }

  // 1) Başlık düzeyinde kesin ret
  const titleRejections = matchRules(titleText, TITLE_REJECT_RULES);
  if (titleRejections.length > 0) {
    const primary = titleRejections[0] as MatchedRule;
    return {
      decision: 'reject',
      employmentType: 'belirsiz',
      confidence: 0.92,
      reasons: [primary.reason, `Kural: ${primary.id}`],
      rules: titleRejections.map((rule) => rule.id),
      negativeSignals: titleRejections.map((rule) => rule.reason),
      version: CLASSIFICATION_VERSION,
    };
  }

  // 2) Gövdede kesin ret
  const bodyRejections = matchRules(bodyText, BODY_REJECT_RULES);
  if (bodyRejections.length > 0) {
    const primary = bodyRejections[0] as MatchedRule;
    return {
      decision: 'reject',
      employmentType: 'belirsiz',
      confidence: 0.85,
      reasons: [primary.reason, `Kural: ${primary.id}`],
      rules: bodyRejections.map((rule) => rule.id),
      negativeSignals: bodyRejections.map((rule) => rule.reason),
      version: CLASSIFICATION_VERSION,
    };
  }

  // 3) Olumlu kanıtlar (başlık kanıtı tam, gövde kanıtı 0.7 katsayılı)
  const titlePositives = matchRules(titleText, POSITIVE_RULES);
  const bodyPositives = matchRules(bodyText, POSITIVE_RULES).filter(
    (rule) => !titlePositives.some((titleRule) => titleRule.id === rule.id),
  );
  const categoryPositive = RECRUITMENT_CATEGORY_PATTERN.test(categoryText)
    ? [
        {
          id: 'pozitif.kaynak-kategorisi',
          reason: 'Kaynak kategorisi personel alımı olarak işaretli',
          weight: 1.5,
        },
      ]
    : [];
  const negatives = matchRules(bodyText, SOFT_NEGATIVE_RULES);

  const titleScore = titlePositives.reduce((total, rule) => total + rule.weight, 0);
  const bodyScore = bodyPositives.reduce((total, rule) => total + rule.weight, 0) * 0.7;
  const categoryScore = categoryPositive.reduce((total, rule) => total + rule.weight, 0);
  const negativeScore = negatives.reduce((total, rule) => total + rule.weight, 0);
  const rawScore = titleScore + bodyScore + categoryScore - negativeScore;

  const matchedRules = [...titlePositives, ...bodyPositives, ...categoryPositive];
  const { type: employmentType, reason: employmentReason } = detectEmploymentType(titleText, bodyText);

  const reasons: string[] = [];
  if (titlePositives.length > 0) reasons.push(...titlePositives.map((rule) => rule.reason));
  else if (bodyPositives.length > 0) reasons.push(...bodyPositives.map((rule) => rule.reason));
  reasons.push(employmentReason);

  // Kanıt kapısı: metinde personel alım/istihdam ifadesi yoksa puan ne olursa olsun kabul edilmez.
  const hasRecruitmentEvidence =
    RECRUITMENT_EVIDENCE_PATTERN.test(titleText) || RECRUITMENT_EVIDENCE_PATTERN.test(bodyText);

  let decision: ClassificationResult['decision'];
  let confidence: number;

  if (!hasRecruitmentEvidence) {
    decision = 'reject';
    confidence = 0.8;
    reasons.push('İlanda personel alım/istihdam ifadesi bulunamadı — iş ilanı değil');
  } else if (rawScore >= ACCEPT_THRESHOLD) {
    decision = 'accept';
    confidence = Math.min(0.95, 0.6 + rawScore * 0.06);
  } else if (rawScore >= REVIEW_THRESHOLD) {
    decision = 'review';
    confidence = 0.45 + Math.max(0, rawScore - REVIEW_THRESHOLD) * 0.08;
  } else {
    decision = 'reject';
    confidence = 0.7;
    reasons.push('İlanda personel alımına ilişkin yeterli ifade bulunamadı');
  }

  // Gövde hiç okunamadıysa (bozuk PDF) güveni düşür ve incelemeye yönlendir.
  if (input.documentTextMissing && decision === 'accept' && bodyText.length < 200) {
    decision = 'review';
    confidence = Math.min(confidence, 0.5);
    reasons.push('Belge metni çıkarılamadı; alanların doğrulanması gerekiyor');
  }

  if (input.documentTextMissing === false && decision === 'accept') {
    confidence = Math.min(0.97, confidence + 0.03);
  }

  return {
    decision,
    employmentType,
    confidence: Number(confidence.toFixed(2)),
    reasons,
    rules: matchedRules.map((rule) => rule.id),
    negativeSignals: negatives.map((rule) => rule.reason),
    version: CLASSIFICATION_VERSION,
  };
}

/**
 * Liste düzeyinde hızlı ön karar (detay indirilmeden önce).
 * `skip` dönerse adaptör detay sayfasını hiç indirmez (gereksiz indirme yok).
 */
export function preFilterListingItem(input: {
  title: string;
  summary?: string | null;
  sourceCategory?: string | null;
}): {
  action: 'skip' | 'fetch-detail' | 'consider';
  decision: ClassificationResult;
} {
  const decision = classify({
    title: input.title,
    body: input.summary ?? '',
    sourceCategory: input.sourceCategory ?? null,
  });
  if (decision.decision === 'reject') return { action: 'skip', decision };
  if (decision.decision === 'accept') return { action: 'consider', decision };
  return { action: 'fetch-detail', decision };
}

export function classificationSummary(result: ClassificationResult): string {
  const reason = result.reasons[0] ?? 'gerekçe yok';
  return `${result.decision} (${result.confidence}) — ${reason}`;
}

export function classificationExcerpt(result: ClassificationResult): string {
  return makeExcerpt(`${result.decision}: ${result.reasons.join(' • ')}`, 300);
}

export type { KeywordRule };
