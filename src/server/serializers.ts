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
import { makeExcerpt, maskEmail } from '../domain/text';
import { EMPLOYMENT_TYPE_LABELS, JOB_STATUS_LABELS, PROCESS_STATUS_LABEL } from '../domain/types';
import type { JobDoc, JobRevisionDoc, JobSourceDoc, ScrapeRunDoc, SourceDoc, UserDoc } from '../db/schemas';
import type { SourceCoverageEntry } from '../db/repos/sources';

export interface PublicJobSummary {
  id: string;
  title: string;
  institution: string;
  unit: string | null;
  /** `job`: iş ilanı; `process`: gerçek bir alımın kura/sınav/sonuç duyurusu. */
  kind: 'job' | 'process';
  employmentType: string;
  employmentTypeLabel: string;
  status: string;
  statusLabel: string;
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
  /** Capture metadata only; source body text is never returned by a public serializer. */
  capturedNotice: {
    sourceKey: string;
    sourceName: string | null;
    characterCount: number;
    status: 'captured' | 'truncated';
  } | null;
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

const PUBLIC_TEXT_EXCERPT_MAX = 400;
const MIN_TEXT_LENGTH_FOR_PUBLIC_EXCERPT = PUBLIC_TEXT_EXCERPT_MAX + 100;

/**
 * Matching/search use a separate bounded, contact-redacted job excerpt; full
 * source-link capture bodies are not retained. Public pages get at most a
 * short excerpt, and none if it could reproduce a short source notice in full.
 */
function publicTextExcerpt(value: string): string {
  // Sanitize before checking the minimum length, including legacy stored records.
  const clean = makeExcerpt(value, Number.MAX_SAFE_INTEGER);
  if (clean.length < MIN_TEXT_LENGTH_FOR_PUBLIC_EXCERPT) return '';
  return makeExcerpt(clean, PUBLIC_TEXT_EXCERPT_MAX);
}

/** A provenance snippet may repeat text already in the public excerpt, but may not extend it. */
function publicSnippet(job: JobDoc, value: string): string | null {
  const visibleExcerpt = publicTextExcerpt(job.textExcerpt);
  const visibleBody = visibleExcerpt.endsWith('…') ? visibleExcerpt.slice(0, -1) : visibleExcerpt;
  const cleanSnippet = makeExcerpt(value, Number.MAX_SAFE_INTEGER);
  if (!visibleBody || !cleanSnippet || !visibleBody.includes(cleanSnippet)) return null;
  return makeExcerpt(cleanSnippet, 200);
}

function publicFieldSources(job: JobDoc): JobDoc['fieldSources'] {
  return Object.fromEntries(
    Object.entries(job.fieldSources ?? {}).map(([field, source]) => [
      field,
      { kind: source.kind, snippet: source.snippet ? publicSnippet(job, source.snippet) : null },
    ]),
  );
}

function publicEvidence(job: JobDoc): JobDoc['evidence'] {
  const entries = Object.entries(job.evidence ?? {}).flatMap(([field, evidence]) => {
    const snippet = publicSnippet(job, evidence);
    return snippet ? [[field, snippet] as const] : [];
  });
  return Object.fromEntries(entries);
}

function publicRevisionSnapshot(snapshot: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot.textExcerpt !== 'string') return snapshot;
  return { ...snapshot, textExcerpt: publicTextExcerpt(snapshot.textExcerpt) };
}

/** Prefer retained metadata; the legacy body fallback exists only for pre-migration rows. */
function capturedCharacterCount(link: JobSourceDoc): number {
  const legacy = link as unknown as { capturedText?: unknown; capturedTextCharacterCount?: unknown };
  const count = legacy.capturedTextCharacterCount;
  if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) return count;
  if (typeof legacy.capturedText === 'string' && legacy.capturedText.length > 0) {
    return legacy.capturedText.length;
  }
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function deadlineOf(job: JobDoc, now: Date = new Date()): { state: string; daysLeft: number | null } {
  const endDate = job.applicationEndDate;
  if (!endDate) return { state: 'unknown', daysLeft: null };
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
    kind: job.classification.kind ?? 'job',
    employmentType: job.employmentType,
    employmentTypeLabel: EMPLOYMENT_TYPE_LABELS[job.employmentType] ?? job.employmentType,
    status: job.status,
    // Süreç duyurusunda "Başvuru açık" gibi bir durum etiketi gösterilmez.
    statusLabel:
      (job.classification.kind ?? 'job') === 'process'
        ? PROCESS_STATUS_LABEL
        : (JOB_STATUS_LABELS[job.status] ?? job.status),
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
  const capturedSource = options.sources
    .filter(
      (link) =>
        (link.capturedTextStatus === 'captured' || link.capturedTextStatus === 'truncated') &&
        capturedCharacterCount(link) > 0,
    )
    .sort((a, b) => {
      const aPrimary = a.sourceKey === job.primarySourceKey ? 1 : 0;
      const bPrimary = b.sourceKey === job.primarySourceKey ? 1 : 0;
      return bPrimary - aPrimary || capturedCharacterCount(b) - capturedCharacterCount(a);
    })[0];
  return {
    ...summary,
    applicationUrl: job.applicationUrl,
    applicationMethod: job.applicationMethod ?? null,
    originalRefNo: job.originalRefNo,
    textExcerpt: publicTextExcerpt(job.textExcerpt),
    requirements: {
      ...job.requirements,
      // Eski dokümanlarda alan yoksa boş liste dön (API sözleşmesi sabit kalsın).
      qualificationCodes: job.requirements.qualificationCodes ?? [],
    },
    attachments: job.attachments,
    classification: {
      decision: job.classification.decision,
      employmentType: job.classification.employmentType,
      confidence: job.classification.confidence,
      reasons: job.classification.reasons,
      version: job.classification.version,
    },
    fieldSources: publicFieldSources(job),
    evidence: publicEvidence(job),
    uncertainties: job.uncertainties ?? [],
    provenance: job.provenance,
    firstSeenAt: job.firstSeenAt,
    capturedNotice: capturedSource
      ? {
          sourceKey: capturedSource.sourceKey,
          sourceName: options.sourceNames?.get(capturedSource.sourceKey) ?? null,
          characterCount: capturedCharacterCount(capturedSource),
          status: capturedSource.capturedTextStatus as 'captured' | 'truncated',
        }
      : null,
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
          coverageStatus: lastRun.coverageStatus ?? 'unknown',
          coverageNote: lastRun.coverageNote ?? 'Eski tarama kaydı; kapsam bilinmiyor.',
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
    health: {
      lastRunAt: entry.health.lastRunAt,
      lastSuccessAt: entry.health.lastSuccessAt,
      consecutiveFailures: entry.health.consecutiveFailures,
      totalRuns: entry.health.totalRuns,
      successRuns: entry.health.totalSuccesses,
      failureRuns: Math.max(0, entry.health.totalRuns - entry.health.totalSuccesses),
      avgDurationMs: entry.health.avgDurationMs,
      lastError: entry.health.lastErrorMessage,
      itemsFound: entry.health.lastDiscoveredCount,
      emptyStreak: entry.health.emptyStreak,
      lastSuccessfulExtractionAt: entry.health.lastExtractionAt,
      lastHttpStatus: entry.health.lastHttpStatus,
      lastErrorType: entry.health.lastErrorType,
      lastRejectedCount: entry.health.lastRejectedCount,
      lastReviewCount: entry.health.lastReviewCount,
      unexpectedZero: entry.health.unexpectedZero,
    },
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
    coverageStatus: run.coverageStatus ?? 'unknown',
    coverageNote: run.coverageNote ?? 'Eski tarama kaydı; kapsam bilinmiyor.',
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
    previous: publicRevisionSnapshot(revision.previous),
    detectedAt: revision.createdAt,
    sourceKey: revision.sourceKey,
  };
}
