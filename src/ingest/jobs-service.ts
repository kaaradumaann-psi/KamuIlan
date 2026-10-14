/**
 * İlan servisi: ham ilanı ortak şemaya dönüştürür, tekilleştirir, kaydeder,
 * değişiklikleri sürüm geçmişine yazar ve bildirim olaylarını tetikler.
 *
 * Bu modül iş mantığının tek adresidir: hem zamanlanmış tarama hem yönetici
 * panelinden manuel kayıt hem de testler aynı yolu kullanır.
 */
import { createId, sha256Hex } from '../domain/ids';
import { jobContentFingerprint } from '../domain/job-content-fingerprint';
import { collapseWhitespace, escapeRegExp, makeExcerpt, normalizeTr, redactContactDetails } from '../domain/text';
import { isStalePublication, plausibleApplicationEnd, sanePublishedDate, toIstanbulDateOnly } from '../domain/dates';
import { normalizeUrl } from '../domain/urls';
import type { EmploymentType, JobStatus, RawAnnouncement, ClassificationResult } from '../domain';
import { CLASSIFICATION_VERSION, EXTRACTION_VERSION, DEDUPE_VERSION } from '../config/app';
import { classify } from '../classification/engine';
import { extract, type ExtractedJob } from '../extraction/engine';
import type { JobDoc, JobRevisionDoc, JobSourceDoc, SourceDoc, SourceItemDecisionDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import { DEDUPE_THRESHOLDS, decideDedupe, matchBySourceIdentity } from './dedupe';
import type { DedupeCandidateJob, DedupeDecision } from './dedupe';

export interface IngestOutcome {
  action: 'created' | 'merged' | 'updated' | 'review' | 'rejected' | 'withdrawal-signal';
  jobId: string | null;
  decision: DedupeDecision | null;
  classification: ClassificationResult;
  changes: string[];
  reviewId: string | null;
  revisionCreated: boolean;
}

export interface IngestOptions {
  provenance?: 'scraped' | 'sample' | 'manual';
  /** Manuel kayıtta gövde metni elle verilir. */
  now?: Date;
}

const CAPTURED_NOTICE_LIMIT = 100_000;

function capturedTextFields(
  raw: RawAnnouncement,
): Pick<JobSourceDoc, 'capturedTextCharacterCount' | 'capturedTextStatus'> {
  if (raw.bodyTextSource === 'listing') {
    return { capturedTextCharacterCount: 0, capturedTextStatus: 'listing-only' };
  }
  if (!raw.bodyText) {
    return {
      capturedTextCharacterCount: 0,
      capturedTextStatus: raw.rawExcerpt ? 'listing-only' : 'unavailable',
    };
  }
  const cleanedText = collapseWhitespace(redactContactDetails(raw.bodyText));
  const boundedText = makeExcerpt(cleanedText, CAPTURED_NOTICE_LIMIT);
  const truncated =
    raw.bodyTextTruncated === true ||
    raw.bodyText.length > CAPTURED_NOTICE_LIMIT ||
    cleanedText.length > CAPTURED_NOTICE_LIMIT;
  return {
    capturedTextCharacterCount: boundedText.length,
    capturedTextStatus: truncated ? 'truncated' : 'captured',
  };
}

function sourceLinkDocument(raw: RawAnnouncement, jobId: string, nowIso: string): JobSourceDoc {
  const capture = capturedTextFields(raw);
  return {
    id: createId('jsrc'),
    jobId,
    sourceKey: raw.sourceKey,
    sourceItemId: raw.sourceItemId,
    url: normalizeUrl(raw.url),
    title: raw.title,
    institution: raw.institution ?? null,
    sourceCategory: raw.sourceCategory ?? null,
    publishedAt: raw.publishedAt ?? null,
    ...capture,
    attachments: raw.attachments,
    active: true,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
  };
}

/**
 * İlan oluşturmayan kaydı tarama belleğine yazar (ret/inceleme).
 *
 * Bu kayıt yoksa adaptör aynı ilanı her taramada yeniden "yeni" sayar; liste
 * başındaki ihale/sonuç duyuruları detay bütçesinin tamamını yutup sonraki
 * sayfalardaki gerçek personel alım ilanlarının süresiz aç kalmasına yol açar.
 */
async function recordIngestDecision(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  decision: SourceItemDecisionDoc['decision'],
): Promise<void> {
  const capture = capturedTextFields(raw);
  await ctx.repos.jobs.recordSourceItemDecision({
    sourceKey: raw.sourceKey,
    sourceItemId: raw.sourceItemId,
    decision,
    capturedTextStatus: capture.capturedTextStatus,
    title: raw.title,
    url: normalizeUrl(raw.url) ?? raw.url,
    classificationVersion: CLASSIFICATION_VERSION,
  });
}

/** Başvuru penceresine göre ilan durumu. */
export function computeStatus(params: {
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  /** Yayım tarihi (YYYY-MM-DD). Son başvuru yoksa eski ilan kapalı sayılır. */
  publishedAt?: string | null;
  now: Date;
}): JobStatus {
  const today = toIstanbulDateOnly(params.now);
  // Yanlış çıkarılmış son başvuru (1991, yayından önce) "kapandı" yapmasın; mevcut satırlar için de geçerli.
  const deadline = plausibleApplicationEnd({
    endAt: params.applicationEndAt,
    endDate: params.applicationEndDate,
    publishedAt: params.publishedAt,
  });
  if (deadline.applicationEndDate && deadline.applicationEndDate < today) return 'closed';
  if (params.applicationStartAt && new Date(params.applicationStartAt).getTime() > params.now.getTime())
    return 'upcoming';
  // Saat YALNIZCA metinde gerçekten yazılıysa kesin kabul edilir. Çıkarım
  // motoru saati bilinmeyen tarihlerde 00:00 yazar; bu "gün başı" damgasını
  // kesin sanmak, son başvuru günü BUGÜN olan ilanı gece yarısından sonra
  // "Kapandı" yapıyordu (kullanıcı "son gün" diyor, sistem "kapandı" diyordu).
  // Son başvuru günü, gün bitene kadar açıktır.
  const endAt = deadline.applicationEndAt;
  const endAtHasExplicitTime = endAt !== null && !endAt.includes('T00:00:00');
  if (endAtHasExplicitTime && endAt && new Date(endAt).getTime() < params.now.getTime()) {
    return 'closed';
  }
  // Son başvuru tarihi hiç yoksa ve ilan çok eskiyse (ör. 2008/2018 yayımlı), açık sayılmaz:
  // bu tür kayıtlar yalnızca eski bir duyurunun arşiv kopyasıdır.
  const hasNoDeadline = !deadline.applicationEndDate && !endAt;
  if (hasNoDeadline && isStalePublication(sanePublishedDate(params.publishedAt, today), today)) return 'closed';
  if (hasNoDeadline && !params.applicationStartAt) return 'unknown';
  return 'active';
}

/** Durum gerekçesi (panelde ve detayda gösterilir). Boşsa gerekçe yazılmaz. */
export function statusReasonFor(status: JobStatus, params: { applicationEndDate: string | null; applicationEndAt: string | null; publishedAt: string | null; now: Date }): string {
  if (status === 'unknown') return 'Tarih bilgisi bulunamadı';
  if (status === 'closed' && !params.applicationEndDate && !params.applicationEndAt) {
    return 'Yayımından uzun süre geçti ve son başvuru tarihi belirtilmemiş.';
  }
  return '';
}

/** Metinde geri çekme/iptal sinyali var mı? */
export function detectWithdrawalSignal(title: string, body: string): 'withdrawn' | 'correction' | null {
  const text = normalizeTr(`${title} ${body.slice(0, 400)}`);
  if (/\bilan\s+iptal|\biptal\s+edilmi[şs]|\bgeri\s+[çc]ekil|\by[üu]r[üu]rl[üu]kten\s+kald[ıi]r/.test(text))
    return 'withdrawn';
  if (/\bduzeltme\s+ilan|\bd[üu]zeltme/.test(text)) return 'correction';
  return null;
}

/** İlan dokümanını ham kayıttan üretir (kaydetmez). */
export function buildJobDocument(
  raw: RawAnnouncement,
  classification: ClassificationResult,
  options: { now: Date; provenance: 'scraped' | 'sample' | 'manual' },
): Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'> {
  const detailUrl = normalizeUrl(raw.url);
  const body = raw.bodyText ?? raw.rawExcerpt ?? '';
  const extraction = extract({
    title: raw.title,
    body,
    // Liste sayfasından gelen yapılandırılmış alanlar otoriter kabul edilir.
    listing: {
      institution: raw.institution ?? null,
      city: raw.city ?? null,
      district: raw.district ?? null,
      publishedAt: raw.publishedAt ?? null,
      referenceNo: raw.referenceNo ?? null,
      applicationStartAt: raw.applicationStartAt ?? null,
      applicationEndAt: raw.applicationEndAt ?? null,
    },
    links: raw.links ?? [],
    attachments: raw.attachments,
    bodySource: raw.bodyTextSource ?? (raw.bodyText ? 'detail' : 'listing'),
  });

  const attachments = dedupeAttachments(raw.attachments);

  const applicationEndAt = extraction.applicationEndAt ?? null;
  const applicationStartAt = extraction.applicationStartAt ?? null;
  const publishedAt = sanePublishedDate(
    extraction.publishedAt ?? raw.publishedAt ?? null,
    toIstanbulDateOnly(options.now),
  );
  const status = computeStatus({
    applicationStartAt,
    applicationEndAt,
    applicationEndDate: extraction.applicationEndDate,
    publishedAt,
    now: options.now,
  });

  const institution = extraction.institution ?? raw.institution ?? 'Belirtilmemiş kurum';
  const title = raw.title.trim().slice(0, 400);
  const requirements = toStoredRequirements(extraction);
  const textExcerpt = makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 2_500);

  const employmentType: EmploymentType = classification.employmentType;
  const quota = extraction.quota ?? raw.quota ?? null;

  return {
    title,
    titleNormalized: normalizeTr(title),
    institution,
    institutionNormalized: normalizeTr(institution),
    unit: extraction.unit,
    employmentType,
    status,
    statusReason: statusReasonFor(status, {
      applicationEndDate: extraction.applicationEndDate ?? null,
      applicationEndAt,
      publishedAt,
      now: options.now,
    }),
    city: extraction.city ?? raw.city ?? null,
    cityNormalized: normalizeTr(extraction.city ?? raw.city ?? ''),
    district: extraction.district ?? raw.district ?? null,
    quota,
    applicationStartAt,
    applicationEndAt,
    applicationEndDate: extraction.applicationEndDate,
    publishedAt,
    detailUrl,
    normalizedUrl: detailUrl,
    applicationUrl: raw.applicationUrl ? normalizeUrl(raw.applicationUrl) : extraction.applicationUrl,
    // Metinden okunan başvuru yöntemi depoya yazılır (detay sayfası gösterir).
    applicationMethod: extraction.applicationMethod ?? null,
    attachments,
    requirements,
    titles: extraction.titles,
    textExcerpt,
    // Gövde metni aramada da bulunsun: normalleştirilmiş kopya saklanır.
    textNormalized: normalizeTr(textExcerpt),
    originalRefNo:
      extraction.referenceNo ??
      raw.referenceNo ??
      extractReferenceFromTitle(raw.sourceItemId) ??
      extractReferenceFromTitle(title),
    sourceKeys: [raw.sourceKey],
    primarySourceKey: raw.sourceKey,
    classification: { ...classification, classifiedAt: options.now.toISOString() },
    extractionConfidence: extraction.confidence,
    fieldSources: extraction.fieldSources,
    evidence: extraction.evidence,
    uncertainties: extraction.uncertainties,
    provenance: options.provenance,
    lastVerifiedAt: null,
    contentHash: jobContentFingerprint({ title, textExcerpt, applicationEndAt, quota }),
    dedupeKey: sha256Hex(`${raw.sourceKey}|${raw.sourceItemId}`),
  };
}

/**
 * Çıkarım motorunun `undefined` tabanlı isteğe bağlı alanlarını depo şemasının
 * `null` tabanlı alanlarına çevirir. "Belirtilmemiş" bilgi null olarak saklanır.
 */
export function toStoredRequirements(extraction: ExtractedJob): JobDoc['requirements'] {
  return {
    educationLevels: extraction.educationLevels,
    departments: extraction.departments,
    kpssScoreTypes: extraction.kpssScoreTypes,
    kpssMinScore: extraction.kpssMinScore,
    kpssYear: extraction.kpssYear,
    qualificationCodes: extraction.qualificationCodes,
    minAge: extraction.minAge,
    maxAge: extraction.maxAge,
    certificates: extraction.certificates,
    minExperienceYears: extraction.minExperienceYears,
    foreignLanguages: extraction.foreignLanguages,
    specialConditions: extraction.specialConditions,
  };
}

function extractReferenceFromTitle(title: string): string | null {
  const match = /\b(YOK|DPB|ILN)[\s-]?(\d{4,12})\b/i.exec(title);
  return match ? `${match[1]?.toUpperCase()}${match[2]}` : null;
}

function dedupeAttachments(attachments: RawAnnouncement['attachments']): JobDoc['attachments'] {
  const seen = new Set<string>();
  const out: JobDoc['attachments'] = [];
  for (const attachment of attachments) {
    if (!attachment.url || seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    out.push({
      url: attachment.url,
      label: attachment.label,
      kind: attachment.kind,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    });
  }
  return out;
}

export interface ChangeSet {
  changeTypes: JobRevisionDoc['changeTypes'];
  changedFields: string[];
  summary: string;
}

/** Sürüm geçmişi için önemli değişiklikleri bulur. */
export function detectChanges(previous: JobDoc, next: Partial<JobDoc>): ChangeSet {
  const changedFields: string[] = [];
  const changeTypes: JobRevisionDoc['changeTypes'] = [];

  const compare = (field: keyof JobDoc, type: JobRevisionDoc['changeTypes'][number], label: string) => {
    if (!(field in next)) return;
    const before = JSON.stringify(previous[field] ?? null);
    const after = JSON.stringify(next[field] ?? null);
    if (before !== after) {
      changedFields.push(field);
      if (!changeTypes.includes(type)) changeTypes.push(type);
    }
    void label;
  };

  compare('applicationEndAt', 'deadline', 'Son başvuru tarihi');
  compare('applicationEndDate', 'deadline', 'Son başvuru günü');
  compare('applicationStartAt', 'deadline', 'Başvuru başlangıcı');
  compare('quota', 'quota', 'Kontenjan');
  compare('requirements', 'requirements', 'Başvuru şartları');
  compare('applicationUrl', 'application-url', 'Başvuru bağlantısı');
  compare('applicationMethod', 'application-url', 'Başvuru yöntemi');
  compare('title', 'content', 'Başlık');
  compare('textExcerpt', 'content', 'İlan metni');
  compare('attachments', 'content', 'Ekler');
  compare('status', 'closed', 'Durum');

  const summaryParts: string[] = [];
  if (changedFields.includes('applicationEndDate') || changedFields.includes('applicationEndAt')) {
    summaryParts.push('son başvuru tarihi değişti');
  }
  if (changedFields.includes('quota')) summaryParts.push('kontenjan değişti');
  if (changedFields.includes('requirements')) summaryParts.push('başvuru şartları değişti');
  if (changedFields.includes('applicationUrl')) summaryParts.push('başvuru bağlantısı değişti');
  if (changedFields.includes('status'))
    summaryParts.push(`durum "${previous.status}" → "${next.status}" olarak değişti`);
  if (changedFields.includes('textExcerpt') || changedFields.includes('title'))
    summaryParts.push('ilan metni güncellendi');

  return {
    changeTypes: changeTypes.length > 0 ? changeTypes : ['content'],
    changedFields,
    summary: summaryParts.length > 0 ? summaryParts.join(', ') : 'İlan içeriği güncellendi',
  };
}

export interface ApplyContext {
  repos: Repos;
  now: Date;
  workerId: string;
  provenance: 'scraped' | 'sample' | 'manual';
}

/**
 * Ham ilanı işler: sınıflandırma → çıkarma → tekilleştirme → kayıt/sürüm.
 * Reddedilen kayıtlar sessizce atılmaz; karar gerekçesiyle birlikte döner.
 */
export async function applyRawAnnouncement(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  options: { classificationOverride?: ClassificationResult } = {},
): Promise<IngestOutcome> {
  const classification =
    options.classificationOverride ??
    classify({
      title: raw.title,
      body: raw.bodyText ?? raw.rawExcerpt ?? '',
      sourceCategory: raw.sourceCategory ?? null,
      sourceKey: raw.sourceKey,
      documentTextMissing: !raw.bodyText || raw.bodyText.length < 100 || raw.bodyTextSource === 'listing',
    });

  const withdrawal = detectWithdrawalSignal(raw.title, raw.bodyText ?? '');

  // Kaynak içi kimlik: aynı kaynak aynı ilanı tekrar gördü → güncelleme yolu.
  const existingLink = await ctx.repos.jobs.findLinkBySourceItem(raw.sourceKey, raw.sourceItemId);

  if (classification.decision === 'reject' && !withdrawal) {
    // İlan oluşmuyor; yine de tarama belleğine yaz ki sonraki taramada bu
    // kayıt yeniden "yeni" sayılıp detay bütçesini yemesin.
    await recordIngestDecision(raw, ctx, 'rejected');
    return {
      action: 'rejected',
      jobId: existingLink?.jobId ?? null,
      decision: null,
      classification,
      changes: [],
      reviewId: null,
      revisionCreated: false,
    };
  }

  // Geri çekme/düzeltme sinyali: mevcut ilan varsa durum güncellenir.
  if (withdrawal && !existingLink) {
    const candidates = await findCandidates(ctx.repos, raw, null);
    const target = candidates[0];
    if (!target) {
      const reason =
        withdrawal === 'withdrawn'
          ? 'İptal/geri çekme duyurusu için eşleşen ilan bulunamadı; insan incelemesi gerekiyor.'
          : 'Düzeltme ilanı için eşleşen ilan bulunamadı; insan incelemesi gerekiyor.';
      const review = await ctx.repos.review.enqueue({
        kind: 'dedupe',
        sourceKey: raw.sourceKey,
        title: raw.title,
        url: raw.url,
        reason,
        confidence: 0.4,
        payload: {
          sourceItemId: raw.sourceItemId,
          withdrawal,
          excerpt: makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 1_500),
        },
      });
      await recordIngestDecision(raw, ctx, 'review');
      return {
        action: 'review',
        jobId: null,
        decision: null,
        classification,
        changes: [reason],
        reviewId: review.item.id,
        revisionCreated: false,
      };
    }
    return applyWithdrawal(raw, ctx, target.id, withdrawal, classification);
  }

  const document = buildJobDocument(raw, classification, { now: ctx.now, provenance: ctx.provenance });

  // Kaynak bağlantısı yeni kurulacaksa tekilleştirme adayları toplanır.
  const candidates = await findCandidates(ctx.repos, raw, existingLink?.jobId ?? null);
  const identity = matchBySourceIdentity(
    {
      sourceKey: raw.sourceKey,
      sourceItemId: raw.sourceItemId,
      title: raw.title,
      institution: raw.institution ?? document.institution,
      normalizedUrl: document.normalizedUrl,
      referenceNo: document.originalRefNo,
      applicationEndDate: document.applicationEndDate,
      textExcerpt: document.textExcerpt,
    },
    existingLink
      ? {
          jobId: existingLink.jobId,
          sourceKey: existingLink.sourceKey,
          sourceItemId: existingLink.sourceItemId,
        }
      : null,
  );

  const decision =
    identity ??
    decideDedupe(
      {
        sourceKey: raw.sourceKey,
        sourceItemId: raw.sourceItemId,
        title: raw.title,
        institution: raw.institution ?? document.institution,
        normalizedUrl: document.normalizedUrl,
        referenceNo: document.originalRefNo,
        applicationEndDate: document.applicationEndDate,
        textExcerpt: document.textExcerpt,
      },
      candidates,
    );

  if (classification.decision === 'review') {
    const review = await ctx.repos.review.enqueue({
      kind: 'classification',
      sourceKey: raw.sourceKey,
      title: raw.title,
      url: raw.url,
      reason: classification.reasons.join(' • ') || 'Sınıflandırma güveni düşük',
      confidence: classification.confidence,
      payload: {
        sourceItemId: raw.sourceItemId,
        employmentType: classification.employmentType,
        reasons: classification.reasons,
        rules: classification.rules,
        excerpt: makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 1_500),
        institution: raw.institution ?? null,
        publishedAt: raw.publishedAt ?? null,
        applicationStartAt: raw.applicationStartAt ?? null,
        applicationEndAt: raw.applicationEndAt ?? null,
        attachments: raw.attachments,
        dedupeAction: decision.action,
        candidateJobIds: decision.candidateJobIds,
      },
      candidateJobIds: decision.candidateJobIds,
    });
    // İnceleme bekleyen kayıt için ilan oluşturulmaz; karar verildiğinde
    // yönetici paneli bu kaydı kabul edip ilana dönüştürebilir.
    await recordIngestDecision(raw, ctx, 'review');
    return {
      action: 'review',
      jobId: decision.jobId,
      decision,
      classification,
      changes: [classification.reasons[0] ?? 'İnceleme gerekiyor'],
      reviewId: review.item.id,
      revisionCreated: false,
    };
  }

  if (decision.action === 'review') {
    const review = await ctx.repos.review.enqueue({
      kind: 'dedupe',
      sourceKey: raw.sourceKey,
      title: raw.title,
      url: raw.url,
      reason: decision.reason,
      confidence: decision.score,
      payload: {
        sourceItemId: raw.sourceItemId,
        excerpt: makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 1_500),
        decision: decision.matchedBy,
      },
      candidateJobIds: decision.candidateJobIds,
    });
    await recordIngestDecision(raw, ctx, 'review');
    return {
      action: 'review',
      jobId: null,
      decision,
      classification,
      changes: [decision.reason],
      reviewId: review.item.id,
      revisionCreated: false,
    };
  }

  if (decision.action === 'merge' && decision.jobId) {
    return mergeIntoExistingJob(raw, ctx, decision, document);
  }

  return createJob(raw, ctx, decision, document);
}

async function findCandidates(
  repos: Repos,
  raw: RawAnnouncement,
  excludeJobId: string | null,
): Promise<(DedupeCandidateJob & { id: string })[]> {
  const institutionHint = normalizeTr(raw.institution ?? '');
  const referenceNo = extractReferenceFromTitle(raw.title);

  const queries: Promise<JobDoc[]>[] = [];
  if (referenceNo) {
    queries.push(repos.store.find('jobs', { originalRefNo: referenceNo }, { limit: 5 }));
  }
  queries.push(repos.store.find('jobs', { normalizedUrl: normalizeUrl(raw.url) }, { limit: 5 }));
  if (institutionHint) {
    queries.push(
      repos.store.find(
        'jobs',
        // Kurum adı taranmış içerikten gelir; regex kaynağı olarak güvenli hâle getirilir.
        { institutionNormalized: { $regex: escapeRegExp(institutionHint.slice(0, 40)), $regexFlags: 'i' } },
        { limit: 25, sort: [['createdAt', -1]] },
      ),
    );
  }

  const results = await Promise.all(queries);
  const map = new Map<string, JobDoc>();
  for (const rows of results) {
    for (const job of rows) {
      if (excludeJobId && job.id === excludeJobId) continue;
      map.set(job.id, job);
    }
  }

  // Metin benzerliği taraması için son ilanlardan geniş bir küme eklenir.
  const recent = await repos.store.find('jobs', {}, { limit: 400, sort: [['createdAt', -1]] });
  for (const job of recent) {
    if (excludeJobId && job.id === excludeJobId) continue;
    map.set(job.id, job);
  }

  return [...map.values()].map((job) => ({
    id: job.id,
    title: job.title,
    titleNormalized: job.titleNormalized,
    institution: job.institution,
    institutionNormalized: job.institutionNormalized,
    normalizedUrl: job.normalizedUrl,
    originalRefNo: job.originalRefNo,
    applicationEndDate: job.applicationEndDate,
    textExcerpt: job.textExcerpt,
    sourceKeys: job.sourceKeys,
  }));
}

async function createJob(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  decision: DedupeDecision,
  document: Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'>,
): Promise<IngestOutcome> {
  const nowIso = ctx.now.toISOString();
  const job: JobDoc = {
    ...document,
    id: createId('job'),
    version: 1,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const inserted = await ctx.repos.jobs.insertJob(job);
  if (!inserted.created) {
    // Yarış koşulu: başka bir worker aynı ilanı yazdı → mevcut kaydı kullan.
    return mergeIntoExistingJob(raw, ctx, { ...decision, jobId: inserted.job.id }, document);
  }

  await ctx.repos.jobs.addSourceLink(sourceLinkDocument(raw, job.id, nowIso));

  await ctx.repos.jobs.addRevision({
    id: createId('rev'),
    jobId: job.id,
    version: 1,
    changeTypes: ['new'],
    changedFields: ['*'],
    previous: {},
    current: { title: job.title, applicationEndDate: job.applicationEndDate, quota: job.quota },
    summary: 'İlan ilk kez kaydedildi.',
    sourceKey: raw.sourceKey,
    createdAt: nowIso,
  });

  return {
    action: 'created',
    jobId: job.id,
    decision,
    classification: { ...job.classification } as ClassificationResult,
    changes: ['yeni ilan'],
    reviewId: null,
    revisionCreated: true,
  };
}

async function mergeIntoExistingJob(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  decision: DedupeDecision,
  document: Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'>,
): Promise<IngestOutcome> {
  const jobId = decision.jobId;
  if (!jobId) throw new Error('Birleştirme kararı için ilan kimliği yok.');
  const previous = await ctx.repos.jobs.findById(jobId);
  if (!previous) {
    return createJob(raw, ctx, { ...decision, action: 'create', jobId: null }, document);
  }

  const nowIso = ctx.now.toISOString();
  const nextSourceKeys = previous.sourceKeys.includes(raw.sourceKey)
    ? previous.sourceKeys
    : [...previous.sourceKeys, raw.sourceKey];

  // Alanları birleştir: kaynak yeni bilgi getiriyorsa güncelle, boşsa koru.
  const merged: Partial<JobDoc> = {
    sourceKeys: nextSourceKeys,
    lastSeenAt: nowIso,
    lastVerifiedAt: nowIso,
    extractionConfidence: Math.max(previous.extractionConfidence, document.extractionConfidence),
    applicationEndAt: document.applicationEndAt ?? previous.applicationEndAt,
    applicationEndDate: document.applicationEndDate ?? previous.applicationEndDate,
    applicationStartAt: document.applicationStartAt ?? previous.applicationStartAt,
    applicationUrl: document.applicationUrl ?? previous.applicationUrl,
    applicationMethod: document.applicationMethod ?? previous.applicationMethod ?? null,
    quota: document.quota ?? previous.quota,
    city: previous.city ?? document.city,
    titles: previous.titles.length >= document.titles.length ? previous.titles : document.titles,
    requirements:
      document.requirements.departments.length +
        document.requirements.educationLevels.length +
        document.requirements.kpssScoreTypes.length +
        document.requirements.qualificationCodes.length >
      previous.requirements.departments.length +
        previous.requirements.educationLevels.length +
        previous.requirements.kpssScoreTypes.length +
        previous.requirements.qualificationCodes.length
        ? document.requirements
        : previous.requirements,
    attachments: dedupeAttachments([
      ...previous.attachments,
      ...document.attachments,
    ]) as JobDoc['attachments'],
  };

  // Durum her zaman güncel tarihlere göre yeniden hesaplanır.
  merged.status = computeStatus({
    applicationStartAt: merged.applicationStartAt ?? null,
    applicationEndAt: merged.applicationEndAt ?? null,
    applicationEndDate: merged.applicationEndDate ?? null,
    publishedAt: sanePublishedDate(merged.publishedAt ?? null, toIstanbulDateOnly(ctx.now)),
    now: ctx.now,
  });
  merged.statusReason = statusReasonFor(merged.status, {
    applicationEndDate: merged.applicationEndDate ?? null,
    applicationEndAt: merged.applicationEndAt ?? null,
    publishedAt: merged.publishedAt ?? null,
    now: ctx.now,
  });
  if (previous.status === 'cancelled') merged.status = 'cancelled';

  const changes = detectChanges(previous, merged);
  const shouldCreateRevision = changes.changedFields.length > 0 && previous.version > 0;

  const updated = await ctx.repos.jobs.updateJob(jobId, {
    ...merged,
    version: shouldCreateRevision ? previous.version + 1 : previous.version,
  });

  const link = await ctx.repos.jobs.findLinkBySourceItem(raw.sourceKey, raw.sourceItemId);
  if (link) {
    const capture = capturedTextFields(raw);
    const hasNewCapturedText =
      capture.capturedTextStatus === 'captured' || capture.capturedTextStatus === 'truncated';
    await ctx.repos.jobs.touchSourceLink(link.id, {
      lastSeenAt: nowIso,
      title: raw.title,
      active: true,
      ...(hasNewCapturedText ? { ...capture, attachments: raw.attachments } : {}),
    });
  } else {
    await ctx.repos.jobs.addSourceLink(sourceLinkDocument(raw, jobId, nowIso));
    if (!changes.changeTypes.includes('source-added')) changes.changeTypes.push('source-added');
    changes.changedFields.push('sourceKeys');
    changes.summary =
      changes.summary === 'İlan içeriği güncellendi'
        ? 'İlan ikinci bir kaynakta yayımlandı'
        : changes.summary;
  }

  let revisionCreated = false;
  if (shouldCreateRevision && updated) {
    const revision: JobRevisionDoc = {
      id: createId('rev'),
      jobId,
      version: updated.version,
      changeTypes: changes.changeTypes,
      changedFields: changes.changedFields,
      previous: pickRevisionFields(previous),
      current: pickRevisionFields(updated),
      summary: changes.summary,
      sourceKey: raw.sourceKey,
      createdAt: nowIso,
    };
    const result = await ctx.repos.jobs.addRevision(revision);
    revisionCreated = result.created;
  }

  return {
    action: revisionCreated ? 'updated' : 'merged',
    jobId,
    decision,
    classification: { ...(updated?.classification ?? previous.classification) } as ClassificationResult,
    changes: changes.changedFields,
    reviewId: null,
    revisionCreated,
  };
}

async function applyWithdrawal(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  jobId: string,
  withdrawal: 'withdrawn' | 'correction',
  classification: ClassificationResult,
): Promise<IngestOutcome> {
  const previous = await ctx.repos.jobs.findById(jobId);
  if (!previous) throw new Error('Geri çekme sinyali için ilan bulunamadı.');
  const nowIso = ctx.now.toISOString();
  const nextVersion = previous.version + 1;
  const changeType = withdrawal === 'withdrawn' ? 'withdrawn' : 'content';

  const updated = await ctx.repos.jobs.updateJob(jobId, {
    status: withdrawal === 'withdrawn' ? 'cancelled' : previous.status,
    statusReason:
      withdrawal === 'withdrawn'
        ? `Resmî duyuru ile geri çekildi (${raw.sourceKey})`
        : `Düzeltme ilanı görüldü (${raw.sourceKey})`,
    version: nextVersion,
    lastSeenAt: nowIso,
    lastVerifiedAt: nowIso,
  });

  // Sinyal duyurusu da kaynak kaydı üretir: aksi hâlde aynı iptal/düzeltme
  // ilanı her taramada yeniden görülür ve her seferinde yeni sürüm yazar.
  const signalLink = await ctx.repos.jobs.findLinkBySourceItem(raw.sourceKey, raw.sourceItemId);
  if (signalLink) {
    await ctx.repos.jobs.touchSourceLink(signalLink.id, { lastSeenAt: nowIso, title: raw.title });
  } else {
    await ctx.repos.jobs.addSourceLink(sourceLinkDocument(raw, jobId, nowIso));
  }

  const revision = await ctx.repos.jobs.addRevision({
    id: createId('rev'),
    jobId,
    version: nextVersion,
    changeTypes: [changeType],
    changedFields: ['status'],
    previous: { status: previous.status },
    current: { status: updated?.status ?? previous.status },
    summary:
      withdrawal === 'withdrawn'
        ? 'İlan resmî olarak geri çekildi/iptal edildi.'
        : 'İlan için düzeltme duyurusu yayımlandı.',
    sourceKey: raw.sourceKey,
    createdAt: nowIso,
  });

  return {
    action: 'withdrawal-signal',
    jobId,
    decision: null,
    classification,
    changes: ['status'],
    reviewId: null,
    revisionCreated: revision.created,
  };
}

function pickRevisionFields(job: JobDoc): Record<string, unknown> {
  return {
    title: job.title,
    status: job.status,
    applicationStartAt: job.applicationStartAt,
    applicationEndAt: job.applicationEndAt,
    applicationEndDate: job.applicationEndDate,
    quota: job.quota,
    applicationUrl: job.applicationUrl,
    attachments: job.attachments.map((attachment) => attachment.url),
    requirements: job.requirements,
    sourceKeys: job.sourceKeys,
  };
}

export const INGEST_VERSIONS = {
  classification: CLASSIFICATION_VERSION,
  extraction: EXTRACTION_VERSION,
  dedupe: DEDUPE_VERSION,
  thresholds: DEDUPE_THRESHOLDS,
};

export type { SourceDoc };
