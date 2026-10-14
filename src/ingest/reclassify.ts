import type { JobDoc } from '../db/schemas';
import type { ClassificationKind, ClassificationResult } from '../domain/types';
import { classify } from '../classification/engine';
import { plausibleApplicationEnd, sanePublishedDate, toIstanbulDateOnly } from '../domain/dates';
import { normalizeTr, stripUiChrome } from '../domain/text';
import { computeStatus, statusReasonFor } from './jobs-service';

/** Mevcut bir ilan kaydını güncel kurallarla yeniden değerlendirir. Saf fonksiyon; veritabanı yazmaz. */
export interface ReclassifyResult {
  /** Veritabanına yazılacak alanlar (yalnızca değişenler). */
  patch: Partial<JobDoc>;
  /** Herhangi bir alanda değişiklik var mı? */
  changed: boolean;
  /** Karar kabulden reddetmeye (veya tersine) döndü mü? */
  decisionFrom: JobDoc['classification']['decision'];
  decisionTo: JobDoc['classification']['decision'];
  /** Kayıttaki tür (job/process) ve yeni kural setinin türü. */
  kindFrom: ClassificationKind;
  kindTo: ClassificationKind;
  /** Güncel kurallardan çıkan tam sınıflandırma (rapor ve gerekçe için). */
  classification: ClassificationResult;
  titleCleaned: boolean;
  statusFrom: JobDoc['status'];
  statusTo: JobDoc['status'];
}

export function reclassifyJob(job: JobDoc, now: Date): ReclassifyResult {
  const today = toIstanbulDateOnly(now);
  const patch: Partial<JobDoc> = {};

  // 1) Sayfa kabuğu temizliği (başlık, kurum, metin).
  const title = stripUiChrome(job.title) || job.title;
  const titleCleaned = title !== job.title;
  if (titleCleaned) {
    patch.title = title;
    patch.titleNormalized = normalizeTr(title);
  }
  const institution = stripUiChrome(job.institution) || job.institution;
  if (institution !== job.institution) {
    patch.institution = institution;
    patch.institutionNormalized = normalizeTr(institution);
  }
  const textExcerpt = stripUiChrome(job.textExcerpt ?? '');
  if (textExcerpt !== (job.textExcerpt ?? '')) {
    patch.textExcerpt = textExcerpt;
    patch.textNormalized = normalizeTr(textExcerpt);
  }

  // 2) Sınıflandırma (güncel kurallar). Kaynak kategorisi kalıcı saklanmadığı için
  //    yalnızca başlık ve metin kullanılır; kanıt kapısı bunu zaten gerektirir.
  const classification = classify({
    title,
    body: textExcerpt,
    documentTextMissing: textExcerpt.length < 100,
  });
  // Karar politikası: yalnızca AÇIK ret sinyali (başlık/gövde ret kuralı ya da
  // personel alım kanıtının yokluğu) kararı "reject" yapar. Kayıtta kaynak kategorisi
  // saklanmadığı için yeniden sınıflandırma kabul/inceleme kararını yükseltmez veya
  // düşürmez; reddedilmiş kayıt da geri açılmaz (yeniden tarama yeni kayıt getirir).
  const decisionFrom = job.classification.decision;
  const decisionTo: JobDoc['classification']['decision'] =
    classification.decision === 'reject' ? 'reject' : decisionFrom;
  // Tür (job/process): kabul edilmiş kayıtlar dahil her zaman güncel kurala göre güncellenir.
  const kindFrom: ClassificationKind = job.classification.kind ?? 'job';
  const kindTo: ClassificationKind = classification.kind;
  const kindChanged = kindFrom !== kindTo;
  const adoptNewReasons = decisionTo === 'reject' || kindChanged;
  if (
    decisionFrom !== decisionTo ||
    kindChanged ||
    (decisionTo === 'reject' &&
      (job.classification.version !== classification.version ||
        job.classification.reasons.join('|') !== classification.reasons.join('|')))
  ) {
    patch.classification = {
      decision: decisionTo,
      kind: kindTo,
      employmentType: job.classification.employmentType,
      confidence: adoptNewReasons ? classification.confidence : job.classification.confidence,
      reasons: adoptNewReasons ? classification.reasons : job.classification.reasons,
      rules: adoptNewReasons ? classification.rules : job.classification.rules,
      negativeSignals: adoptNewReasons ? classification.negativeSignals : job.classification.negativeSignals,
      version: adoptNewReasons ? classification.version : job.classification.version,
      classifiedAt: now.toISOString(),
    };
  }

  // 3) Durum ve yayım tarihi (bozuk yayım tarihleri ve eski ilanlar yeniden değerlendirilir).
  const publishedAt = sanePublishedDate(job.publishedAt, today);
  if (publishedAt !== job.publishedAt) patch.publishedAt = publishedAt;
  // Yanlış çıkarılmış son başvuru (yayından önce ya da 2000 öncesi) kayıttan da temizlenir.
  const deadline = plausibleApplicationEnd({
    endAt: job.applicationEndAt,
    endDate: job.applicationEndDate,
    publishedAt,
  });
  if (deadline.applicationEndDate !== job.applicationEndDate) {
    patch.applicationEndDate = deadline.applicationEndDate;
  }
  if (deadline.applicationEndAt !== job.applicationEndAt) patch.applicationEndAt = deadline.applicationEndAt;
  const statusFrom = job.status;
  let statusTo = statusFrom;
  if (statusFrom !== 'cancelled') {
    statusTo = computeStatus({
      applicationStartAt: job.applicationStartAt,
      applicationEndAt: deadline.applicationEndAt,
      applicationEndDate: deadline.applicationEndDate,
      publishedAt,
      now,
    });
    if (statusTo !== statusFrom) {
      patch.status = statusTo;
      patch.statusReason = statusReasonFor(statusTo, {
        applicationEndDate: deadline.applicationEndDate,
        applicationEndAt: deadline.applicationEndAt,
        publishedAt,
        now,
      });
    }
  }

  const changed = Object.keys(patch).length > 0;
  if (changed) patch.updatedAt = now.toISOString();
  return {
    patch,
    changed,
    decisionFrom,
    decisionTo,
    kindFrom,
    kindTo,
    classification,
    titleCleaned,
    statusFrom,
    statusTo,
  };
}
