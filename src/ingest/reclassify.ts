import type { JobDoc } from '../db/schemas';
import type { ClassificationKind, ClassificationResult } from '../domain/types';
import { classify } from '../classification/engine';
import { plausibleApplicationEnd, sanePublishedDate, toIstanbulDateOnly } from '../domain/dates';
import { normalizeTr, stripUiChrome } from '../domain/text';
import { extractPublishedAt, extractUnit } from '../extraction/engine';
import { computeStatus, statusReasonFor } from './jobs-service';

/**
 * Desteksiz yayım tarihi için geriye dönük pencere (gün).
 *
 * 16.10.2026 gerçek veri denetimi: eski çıkarıcı, gövdedeki YASAL ATIF tarihini
 * ("26 Eylül 2004 tarihli ve 25585 sayılı Yönetmelik") ilanın yayım tarihi
 * sanıyordu; 2026 tarihli altı kayıt 2004/2008/2013/2018/2019 görünüyordu.
 * Çıkarıcı düzeltildi ama ESKİ kayıtların tarihi yerinde kaldı: yeniden
 * sınıflandırma yayım tarihini yalnızca gelecek tarih için reddediyordu.
 *
 * Kural: tarih gövdeden türetilmişse (liste katmanı otorite değilse), güncel
 * çıkarıcı kayıttaki metinde yayım tarihi BULAMIYORSA ve tarih kaydın ilk
 * görülmesinden bu pencereden daha önceyse tarih desteksizdir → kaldırılır.
 * Yanlış bir tarih göstermektense "bilinmiyor" demek doğrudur.
 */
export const PUBLISHED_DATE_REGRESSION_DAYS = 400;

/** Kaldırılan desteksiz tarih için kullanıcıya görünen belirsizlik notu. */
export const UNSUPPORTED_PUBLISHED_DATE_NOTE =
  'Yayım tarihi kaynak metninde doğrulanamadı (eski çıkarım hatası); tarih kayıttan kaldırıldı.';

function daysBetween(fromDateOnly: string, toDateOnly: string): number {
  const from = Date.parse(`${fromDateOnly}T00:00:00Z`);
  const to = Date.parse(`${toDateOnly}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

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
  // Birim: YALNIZCA saklı değer güncel kurala uymuyorsa (tablo başlığı artığı,
  // ör. "SI KADRO ÜNVANI AÇIKLAMA MDF01 … Fakültesi") boşaltılır. Saklı alıntıdan
  // yeniden türetilmez: alıntı kısaltılmıştır (2.500 karakter) ve çok fakülteli
  // ilanda yalnız ilk fakülteyi görüp tek birim uydurabilir. Doğru değer, ilan
  // kaynakta yeniden görülünce tam metinden çıkarılır.
  if (job.unit && extractUnit(job.unit) !== job.unit) patch.unit = null;

  // 2) Sınıflandırma (güncel kurallar). Kaynak kategorisi kalıcı saklanmadığı için
  //    yalnızca başlık ve metin kullanılır; kanıt kapısı bunu zaten gerektirir.
  const classification = classify({
    title,
    body: textExcerpt,
    documentTextMissing: textExcerpt.length < 100,
  });
  // Karar politikası: yalnızca AÇIK ret sinyali (başlık/gövde ret kuralı ya da
  // personel alım kanıtının yokluğu) kararı "reject" yapar. Kayıtta kaynak kategorisi
  // saklanmadığı için yeniden sınıflandırma kabul/inceleme kararını genel olarak
  // yükseltmez veya düşürmez. Tek istisna: güncel kurallar kaydı AÇIK bir süreç duyurusu
  // (kura, sınav, sonuç, kurum içi görevde yükselme) olarak tanıyorsa, reddedilmiş kayıt
  // süreç olarak akışa geri alınır. Süreç kayıtları iş ilanı bildirimi üretmez.
  const decisionFrom = job.classification.decision;
  const decisionTo: JobDoc['classification']['decision'] =
    classification.decision === 'reject'
      ? 'reject'
      : classification.kind === 'process' && classification.decision === 'accept'
        ? 'accept'
        : decisionFrom;
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
      // İçerik türü kaybolmasın: yeni karar benimseniyorsa güncel tür, aksi halde saklanan.
      contentType:
        (adoptNewReasons ? classification.contentType : job.classification.contentType) ??
        classification.contentType,
      // LLM denetim izi tarihsel kayıttır (ingest anındaki kapı kararı); korunur.
      ...(job.classification.llm ? { llm: job.classification.llm } : {}),
    };
  }

  // 3) Durum ve yayım tarihi (bozuk yayım tarihleri ve eski ilanlar yeniden değerlendirilir).
  let publishedAt = sanePublishedDate(job.publishedAt, today);
  const publishedSourceKind = job.fieldSources?.publishedAt?.kind ?? null;
  if (publishedAt && publishedSourceKind !== 'listing') {
    const firstSeenDate = String(job.firstSeenAt ?? '').slice(0, 10);
    const unsupported =
      extractPublishedAt(job.textExcerpt ?? '') === null &&
      firstSeenDate.length === 10 &&
      daysBetween(publishedAt, firstSeenDate) > PUBLISHED_DATE_REGRESSION_DAYS;
    if (unsupported) {
      publishedAt = null;
      const uncertainties = new Set([...(job.uncertainties ?? []), UNSUPPORTED_PUBLISHED_DATE_NOTE]);
      patch.uncertainties = [...uncertainties];
    }
  }
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
