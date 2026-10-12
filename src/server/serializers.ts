/**
 * API çıktı biçimleri (DTO).
 *
 * İlkeler:
 *  - Veritabanı belgeleri olduğu gibi dışarı verilmez (iç alanlar sızmaz).
 *  - İlan detayında alan bazlı kaynak izi (`fieldSources`), kanıt (`evidence`)
 *    ve belirsizlik uyarıları (`uncertainties`) bulunur — "uydurma yok" ilkesi.
 *  - E-posta adresleri yalnızca maskeli gösterilir; kullanıcının kendi kaydı hariç.
 */
import { deadlineState, toIstanbulDateOnly } from '../domain/dates';
import { maskEmail } from '../domain/text';
import type { JobDoc, JobRevisionDoc, JobSourceDoc, ScrapeRunDoc, SourceDoc, UserDoc } from '../db/schemas';
import type { SourceCoverageEntry } from '../db/repos/sources';

export interface PublicJobSummary {
  id: string;
  title: string;
  institution: string;
  unit: string | null;
  employmentType: string;
  status: string;
  city: string | null;
  district: string | null;
  quota: number | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  publishedAt: string | null;
  detailUrl: string;
  hasApplicationUrl: boolean;
  attachmentCount: number;
  titles: string[];
  sourceKeys: string[];
  extractionConfidence: number;
  lastVerifiedAt: string | null;
  /** 'scraped' = gerçek kaynaktan geldi, 'sample' = demo verisi. */
  provenance: 'scraped' | 'sample' | 'manual';
  version: number;
  updatedAt: string;
  /** Son başvuru gününe göre durum ("son 3 gün" uyarısı için). */
  deadline: { state: string; daysLeft: number | null };
}

export interface PublicJobDetail extends PublicJobSummary {
  applicationUrl: string | null;
  applicationMethod: string | null;
  originalRefNo: string | null;
  textExcerpt: string;
  requirements: JobDoc['requirements'];
  attachments: JobDoc['attachments'];
  classification: {
    decision: string;
    employmentType: string;
    confidence: number;
    reasons: string[];
    version: string;
  };
  /** Alan bazlı kaynak izi: her alanın hangi katmandan geldiği. */
  fieldSources: JobDoc['fieldSources'];
  evidence: JobDoc['evidence'];
  uncertainties: string[];
  firstSeenAt: string;
  sources: {
    sourceKey: string;
    sourceName: string | null;
    url: string;
    title: string;
    publishedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    active: boolean;
  }[];
}

export function deadlineOf(job: JobDoc, now: Date = new Date()): { state: string; daysLeft: number | null } {
  const endDate = job.applicationEndDate;
  if (!endDate) return { state: 'bilinmiyor', daysLeft: null };
  const today = toIstanbulDateOnly(now);
  const daysLeft = Math.round(
    (Date.parse(`${endDate}T00:00:00+03:00`) - Date.parse(`${today}T00:00:00+03:00`)) / 86_400_000,
  );
  return { state: deadlineState(endDate, now), daysLeft };
}

export function toPublicJobSummary(job: JobDoc, now: Date = new Date()): PublicJobSummary {
  return {
    id: job.id,
    title: job.title,
    institution: job.institution,
    unit: job.unit,
    employmentType: job.employmentType,
    status: job.status,
    city: job.city,
    district: job.district,
    quota: job.quota,
    applicationStartAt: job.applicationStartAt,
    applicationEndAt: job.applicationEndAt,
    applicationEndDate: job.applicationEndDate,
    publishedAt: job.publishedAt,
    detailUrl: job.detailUrl,
    hasApplicationUrl: job.applicationUrl !== null,
    attachmentCount: job.attachments.length,
    titles: job.titles,
    sourceKeys: job.sourceKeys,
    extractionConfidence: job.extractionConfidence,
    lastVerifiedAt: job.lastVerifiedAt,
    version: job.version,
    updatedAt: job.updatedAt,
    provenance: job.provenance,
    deadline: deadlineOf(job, now),
  };
}

export function toPublicJobDetail(
  job: JobDoc,
  options: { sources: JobSourceDoc[]; sourceNames?: Map<string, string>; now?: Date },
): PublicJobDetail {
  const summary = toPublicJobSummary(job, options.now ?? new Date());
  return {
    ...summary,
    applicationUrl: job.applicationUrl,
    applicationMethod: null,
    originalRefNo: job.originalRefNo,
    textExcerpt: job.textExcerpt,
    requirements: job.requirements,
    attachments: job.attachments,
    classification: {
      decision: job.classification.decision,
      employmentType: job.classification.employmentType,
      confidence: job.classification.confidence,
      reasons: job.classification.reasons,
      version: job.classification.version,
    },
    fieldSources: job.fieldSources ?? {},
    evidence: job.evidence ?? {},
    uncertainties: job.uncertainties ?? [],
    provenance: job.provenance,
    firstSeenAt: job.firstSeenAt,
    sources: options.sources.map((link) => ({
      sourceKey: link.sourceKey,
      sourceName: options.sourceNames?.get(link.sourceKey) ?? null,
      url: link.url,
      title: link.title,
      publishedAt: link.publishedAt,
      firstSeenAt: link.firstSeenAt,
      lastSeenAt: link.lastSeenAt,
      active: link.active,
    })),
  };
}

export interface PublicSourceSummary {
  key: string;
  name: string;
  institution: string;
  group: string;
  sourceType: string;
  method: string;
  status: string;
  statusNote: string;
  listingUrl: string;
  homepageUrl: string;
  enabled: boolean;
  intervalMinutes: number;
  lastVerifiedAt: string | null;
  verification: { verified: boolean; built: boolean; method: string; evidence: string; scope: string };
  coverageNote: string;
  tags: string[];
}

export function toPublicSource(source: SourceDoc): PublicSourceSummary {
  return {
    key: source.key,
    name: source.name,
    institution: source.institution,
    group: 'kaynak',
    sourceType: source.sourceType,
    method: source.method,
    status: source.status,
    statusNote: source.statusNote,
    listingUrl: source.listingUrl,
    homepageUrl: source.homepageUrl,
    enabled: source.enabled,
    intervalMinutes: source.scrapeIntervalMinutes,
    lastVerifiedAt: source.verification.verifiedAt,
    verification: {
      verified: source.verification.verified,
      built: source.verification.built,
      method: source.verification.method,
      evidence: source.verification.evidence,
      scope: source.verification.scope,
    },
    coverageNote: source.coverageNotes,
    tags: source.tags,
  };
}

/** Kaynak durumu: sağlık bilgisi (operatör paneli ve /api/sources/:id/status). */
export function toSourceStatus(source: SourceDoc, lastRun: ScrapeRunDoc | null) {
  return {
    key: source.key,
    name: source.name,
    enabled: source.enabled,
    status: source.status,
    intervalMinutes: source.scrapeIntervalMinutes,
    health: source.health,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          durationMs: lastRun.durationMs,
          scheduleDelayMs: lastRun.scheduleDelayMs,
          itemsFound: lastRun.itemsFound,
          itemsAccepted: lastRun.itemsAccepted,
          result: lastRun.result,
          errors: lastRun.errors,
        }
      : null,
    /** Kaç dakikadır başarılı tarama yok (sağlık göstergesi). */
    minutesSinceSuccess: source.health.lastSuccessAt
      ? Math.round((Date.now() - Date.parse(source.health.lastSuccessAt)) / 60_000)
      : null,
  };
}

export function toCoverageEntry(entry: SourceCoverageEntry) {
  return {
    key: entry.key,
    name: entry.name,
    institution: entry.institution,
    group: entry.group,
    status: entry.status,
    statusNote: entry.statusNote,
    enabled: entry.enabled,
    verified: entry.verified,
    /** Adaptörü yazıldı mı? Doğrulama değildir; arayüz ikisini ayrı gösterir. */
    built: entry.built,
    lastVerifiedAt: entry.lastVerifiedAt,
    verificationEvidence: entry.verificationEvidence,
    coverageNote: entry.coverageNote,
    intervalMinutes: entry.intervalMinutes,
    health: entry.health,
    lastRun: entry.lastRun,
  };
}

export function toRunSummary(run: ScrapeRunDoc) {
  return {
    id: run.id,
    sourceKey: run.sourceKey,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    scheduleDelayMs: run.scheduleDelayMs,
    itemsFound: run.itemsFound,
    itemsAccepted: run.itemsAccepted,
    itemsRejected: run.itemsRejected,
    itemsReview: run.itemsReview,
    jobsCreated: run.jobsCreated,
    jobsUpdated: run.jobsUpdated,
    itemsMerged: run.itemsMerged,
    revisionsCreated: run.revisionsCreated,
    errorCount: run.errorCount,
    errors: run.errors,
    httpStatuses: run.httpStatuses,
    result: run.result,
    notes: run.notes,
    workerId: run.workerId,
  };
}

export function toReviewItem(item: {
  id: string;
  kind: string;
  sourceKey: string;
  title: string;
  url: string;
  reason: string;
  confidence: number;
  payload: Record<string, unknown>;
  candidateJobIds: string[];
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}) {
  return {
    id: item.id,
    kind: item.kind,
    sourceKey: item.sourceKey,
    title: item.title,
    url: item.url,
    reason: item.reason,
    confidence: item.confidence,
    payload: item.payload,
    candidateJobIds: item.candidateJobIds,
    status: item.status,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolvedBy: item.resolvedBy,
    resolution: item.resolution,
  };
}

export function toUserProfile(user: UserDoc, options: { self: boolean }) {
  return {
    id: user.id,
    email: options.self ? user.email : maskEmail(user.email),
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export function toRevision(revision: JobRevisionDoc) {
  return {
    id: revision.id,
    jobId: revision.jobId,
    version: revision.version,
    changeTypes: revision.changeTypes,
    changedFields: revision.changedFields,
    summary: revision.summary,
    previous: revision.previous,
    detectedAt: revision.createdAt,
    sourceKey: revision.sourceKey,
  };
}
