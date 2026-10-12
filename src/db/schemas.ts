/**
 * Persistence schemas (Zod) — single source of truth for document shapes.
 *
 * Everything is stored with ISO-8601 string timestamps and date-only strings in
 * Istanbul local time, so the same shape round-trips through both the file store
 * (local development / tests) and MongoDB (production) without conversion.
 */
import { z } from 'zod';
import { EDUCATION_LEVELS, EMPLOYMENT_TYPES, JOB_STATUSES, KPSS_SCORE_TYPES, SOURCE_STATUSES } from '../domain';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const isoString = () => z.string().regex(ISO, 'ISO-8601 zaman damgası bekleniyor');
export const dateOnlyString = () => z.string().regex(DATE_ONLY, 'YYYY-AA-GG biçiminde tarih bekleniyor');
export const idString = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+$`), `${prefix}_ kimliği bekleniyor`);

export const sourceSchema = z.object({
  id: idString('src'),
  key: z.string().min(2),
  name: z.string().min(2),
  institution: z.string().min(2),
  homepageUrl: z.string().min(8),
  listingUrl: z.string().min(8),
  sourceType: z.enum(['official-portal', 'official-index', 'institution-page', 'exam-authority', 'regional-restricted', 'manual']),
  method: z.enum(['html-list', 'html-detail', 'pdf-index', 'json-api', 'manual-entry', 'browser']),
  adapterKey: z.string().min(2),
  enabled: z.boolean(),
  scrapeIntervalMinutes: z.number().int().min(5).max(10_080),
  minRequestIntervalMs: z.number().int().min(0).max(60_000),
  maxConcurrency: z.number().int().min(1).max(4),
  status: z.enum(SOURCE_STATUSES),
  statusNote: z.string().default(''),
  /** What was actually verified, when and how. Never claim more than evidence. */
  verification: z.object({
    verified: z.boolean(),
    verifiedAt: z.string().nullable(),
    method: z.string().default(''),
    evidence: z.string().default(''),
    scope: z.string().default(''),
  }),
  coverageNotes: z.string().default(''),
  allowHosts: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  health: z.object({
    lastRunAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    lastErrorMessage: z.string().nullable(),
    consecutiveFailures: z.number().int().min(0),
    totalRuns: z.number().int().min(0),
    totalSuccesses: z.number().int().min(0),
    avgDurationMs: z.number().min(0),
    lastDiscoveredCount: z.number().int().min(0),
    lastAcceptedCount: z.number().int().min(0),
    lastScheduleDelayMs: z.number().min(0).nullable(),
    etag: z.string().nullable(),
    lastModified: z.string().nullable(),
    lastContentHash: z.string().nullable(),
    emptyStreak: z.number().int().min(0),
  }),
  createdAt: isoString(),
  updatedAt: isoString(),
});
export type SourceDoc = z.infer<typeof sourceSchema>;

export const jobSchema = z.object({
  id: idString('job'),
  title: z.string().min(3),
  titleNormalized: z.string().min(3),
  institution: z.string().min(2),
  institutionNormalized: z.string().min(2),
  unit: z.string().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  status: z.enum(JOB_STATUSES),
  statusReason: z.string().default(''),
  city: z.string().nullable(),
  district: z.string().nullable(),
  quota: z.number().int().positive().nullable(),
  applicationStartAt: z.string().nullable(),
  applicationEndAt: z.string().nullable(),
  applicationEndDate: dateOnlyString().nullable(),
  publishedAt: z.string().nullable(),
  detailUrl: z.string().min(8),
  normalizedUrl: z.string().min(8),
  applicationUrl: z.string().nullable(),
  attachments: z.array(
    z.object({
      url: z.string().min(8),
      label: z.string().default(''),
      kind: z.enum(['pdf', 'html', 'doc', 'excel', 'other']),
      sizeBytes: z.number().int().min(0).optional(),
    }),
  ),
  requirements: z.object({
    educationLevels: z.array(z.enum(EDUCATION_LEVELS)),
    departments: z.array(z.string()),
    kpssScoreTypes: z.array(z.enum(KPSS_SCORE_TYPES)),
    kpssMinScore: z.number().min(0).max(100).nullable(),
    kpssYear: z.number().int().min(2000).max(2100).nullable(),
    minAge: z.number().int().min(15).max(80).nullable(),
    maxAge: z.number().int().min(15).max(80).nullable(),
    certificates: z.array(z.string()),
    minExperienceYears: z.number().min(0).max(50).nullable(),
    foreignLanguages: z.array(z.string()),
    specialConditions: z.array(z.string()),
  }),
  titles: z.array(z.string()),
  textExcerpt: z.string().default(''),
  originalRefNo: z.string().nullable(),
  sourceKeys: z.array(z.string()).min(1),
  primarySourceKey: z.string().min(2),
  classification: z.object({
    decision: z.enum(['accept', 'reject', 'review']),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string()),
    rules: z.array(z.string()),
    negativeSignals: z.array(z.string()),
    version: z.string(),
    classifiedAt: isoString(),
  }),
  extractionConfidence: z.number().min(0).max(1),
  /** 'scraped' = collected from a real source, 'sample' = seeded demo record. */
  provenance: z.enum(['scraped', 'sample', 'manual']),
  contentHash: z.string().min(8),
  dedupeKey: z.string().min(8),
  version: z.number().int().min(1),
  firstSeenAt: isoString(),
  lastSeenAt: isoString(),
  lastVerifiedAt: isoString().nullable(),
  createdAt: isoString(),
  updatedAt: isoString(),
});
export type JobDoc = z.infer<typeof jobSchema>;

export const jobSourceSchema = z.object({
  id: idString('jsrc'),
  jobId: idString('job'),
  sourceKey: z.string().min(2),
  sourceItemId: z.string().min(1),
  url: z.string().min(8),
  title: z.string().min(1),
  institution: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  publishedAt: z.string().nullable(),
  rawContentHash: z.string().min(8),
  rawExcerpt: z.string().default(''),
  attachments: z.array(
    z.object({
      url: z.string(),
      label: z.string(),
      kind: z.enum(['pdf', 'html', 'doc', 'excel', 'other']),
      sizeBytes: z.number().int().min(0).optional(),
    }),
  ),
  active: z.boolean(),
  firstSeenAt: isoString(),
  lastSeenAt: isoString(),
});
export type JobSourceDoc = z.infer<typeof jobSourceSchema>;

export const jobRevisionSchema = z.object({
  id: idString('rev'),
  jobId: idString('job'),
  /**
   * Sürüm numarası: 1 = ilanın ilk kaydı ("new" değişikliği), 2+ = sonraki
   * değişiklikler. Sürüm geçmişi ilk kaydı da içerir.
   */
  version: z.number().int().min(1),
  changeTypes: z.array(
    z.enum(['new', 'content', 'deadline', 'quota', 'requirements', 'application-url', 'closed', 'withdrawn', 'source-added']),
  ),
  changedFields: z.array(z.string()),
  previous: z.record(z.string(), z.unknown()),
  current: z.record(z.string(), z.unknown()),
  summary: z.string(),
  sourceKey: z.string(),
  createdAt: isoString(),
});
export type JobRevisionDoc = z.infer<typeof jobRevisionSchema>;

export const userSchema = z.object({
  id: idString('usr'),
  email: z.string().min(5),
  emailNormalized: z.string().min(5),
  displayName: z.string().nullable(),
  passwordHash: z.string().min(10),
  passwordSalt: z.string().min(8),
  passwordAlgo: z.string().default('scrypt'),
  role: z.enum(['user', 'admin']),
  emailVerified: z.boolean(),
  emailVerifiedAt: z.string().nullable(),
  status: z.enum(['active', 'disabled', 'deleted']),
  createdAt: isoString(),
  updatedAt: isoString(),
  lastLoginAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type UserDoc = z.infer<typeof userSchema>;

export const sessionSchema = z.object({
  id: idString('ses'),
  userId: idString('usr'),
  tokenHash: z.string().min(16),
  csrfToken: z.string().min(8),
  createdAt: isoString(),
  expiresAt: isoString(),
  revokedAt: z.string().nullable(),
  userAgentHash: z.string().nullable(),
  ipHash: z.string().nullable(),
  lastSeenAt: isoString(),
});
export type SessionDoc = z.infer<typeof sessionSchema>;

export const tokenSchema = z.object({
  id: idString('tok'),
  userId: idString('usr'),
  type: z.enum(['email-verify', 'password-reset', 'unsubscribe']),
  tokenHash: z.string().min(16),
  createdAt: isoString(),
  expiresAt: isoString(),
  usedAt: z.string().nullable(),
});
export type TokenDoc = z.infer<typeof tokenSchema>;

export const notificationPreferenceSchema = z.object({
  id: idString('npr'),
  userId: idString('usr'),
  enabled: z.boolean(),
  paused: z.boolean(),
  mode: z.enum(['instant', 'daily-digest']),
  onlyNewJobs: z.boolean(),
  notifyOnChanges: z.boolean(),
  includeWorkerJobs: z.boolean(),
  includeAcademicJobs: z.boolean(),
  filters: z.object({
    keywords: z.array(z.string()),
    titles: z.array(z.string()),
    institutions: z.array(z.string()),
    cities: z.array(z.string()),
    employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)),
    educationLevels: z.array(z.enum(EDUCATION_LEVELS)),
    departments: z.array(z.string()),
    kpssScoreTypes: z.array(z.enum(KPSS_SCORE_TYPES)),
    kpssMinScore: z.number().min(0).max(100).nullable(),
    minDaysUntilDeadline: z.number().int().min(0).max(365).nullable(),
  }),
  createdAt: isoString(),
  updatedAt: isoString(),
});
export type NotificationPreferenceDoc = z.infer<typeof notificationPreferenceSchema>;

export const notificationEventSchema = z.object({
  id: idString('nev'),
  userId: idString('usr'),
  jobId: idString('job'),
  kind: z.enum(['new-job', 'job-changed']),
  jobVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8),
  status: z.enum(['created', 'queued', 'suppressed', 'failed']),
  suppressionReason: z.string().nullable(),
  matchedOn: z.array(z.string()),
  createdAt: isoString(),
});
export type NotificationEventDoc = z.infer<typeof notificationEventSchema>;

export const emailOutboxSchema = z.object({
  id: idString('eml'),
  eventId: idString('nev').nullable(),
  jobId: idString('job').nullable(),
  userId: idString('usr').nullable(),
  kind: z.enum(['job-notification', 'digest', 'email-verification', 'password-reset', 'test']),
  toEmail: z.string().min(5),
  subject: z.string().min(1),
  template: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8),
  status: z.enum(['pending', 'sending', 'accepted', 'failed', 'dead', 'suppressed']),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(20),
  nextAttemptAt: isoString(),
  lockedBy: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  lastError: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  /** Provider accepted != delivered. Kept explicit to avoid false claims. */
  providerResponse: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  createdAt: isoString(),
  updatedAt: isoString(),
});
export type EmailOutboxDoc = z.infer<typeof emailOutboxSchema>;

export const scrapeRunSchema = z.object({
  id: idString('run'),
  sourceKey: z.string().min(2),
  trigger: z.enum(['schedule', 'manual', 'boot', 'backfill']),
  status: z.enum(['queued', 'running', 'success', 'partial', 'failed', 'skipped', 'locked']),
  startedAt: isoString(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().min(0).nullable(),
  scheduledFor: z.string().nullable(),
  scheduleDelayMs: z.number().min(0).nullable(),
  itemsFound: z.number().int().min(0),
  itemsAccepted: z.number().int().min(0),
  itemsRejected: z.number().int().min(0),
  itemsReview: z.number().int().min(0),
  jobsCreated: z.number().int().min(0),
  jobsUpdated: z.number().int().min(0),
  itemsMerged: z.number().int().min(0),
  revisionsCreated: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  httpStatuses: z.array(z.number().int()),
  errors: z.array(z.string()),
  result: z.string().default(''),
  workerId: z.string().min(1),
  notes: z.array(z.string()).default([]),
});
export type ScrapeRunDoc = z.infer<typeof scrapeRunSchema>;

export const reviewQueueSchema = z.object({
  id: idString('rev'),
  kind: z.enum(['classification', 'dedupe', 'extraction']),
  sourceKey: z.string().min(2),
  status: z.enum(['open', 'resolved', 'ignored']),
  title: z.string().min(1),
  url: z.string().min(8),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.string(), z.unknown()),
  candidateJobIds: z.array(z.string()),
  createdAt: isoString(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolution: z.string().nullable(),
});
export type ReviewQueueDoc = z.infer<typeof reviewQueueSchema>;

export const auditLogSchema = z.object({
  id: idString('aud'),
  actorUserId: z.string().nullable(),
  actorRole: z.string().nullable(),
  action: z.string().min(2),
  targetType: z.string().min(2),
  targetId: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  ipHash: z.string().nullable(),
  createdAt: isoString(),
});
export type AuditLogDoc = z.infer<typeof auditLogSchema>;

export const savedJobSchema = z.object({
  id: idString('sav'),
  userId: idString('usr'),
  jobId: idString('job'),
  createdAt: isoString(),
});
export type SavedJobDoc = z.infer<typeof savedJobSchema>;

export const scheduledTaskSchema = z.object({
  id: idString('tsk'),
  kind: z.enum(['source-scrape', 'maintenance', 'coverage-audit', 'deadline-refresh']),
  sourceKey: z.string().min(1),
  intervalMinutes: z.number().int().min(1),
  enabled: z.boolean(),
  nextRunAt: isoString(),
  lastRunAt: z.string().nullable(),
  lastEnqueuedRunId: z.string().nullable(),
  lastDequeuedAt: z.string().nullable(),
  misses: z.number().int().min(0),
  updatedAt: isoString(),
});
export type ScheduledTaskDoc = z.infer<typeof scheduledTaskSchema>;

export const queueJobSchema = z.object({
  id: idString('qjb'),
  queue: z.string().min(2),
  name: z.string().min(2),
  dedupeKey: z.string().min(2),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'dead']),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(20),
  runAt: isoString(),
  lockedBy: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: isoString(),
  updatedAt: isoString(),
  completedAt: z.string().nullable(),
});
export type QueueJobDoc = z.infer<typeof queueJobSchema>;

export const lockSchema = z.object({
  id: idString('lck'),
  key: z.string().min(2),
  owner: z.string().min(1),
  acquiredAt: isoString(),
  expiresAt: isoString(),
});
export type LockDoc = z.infer<typeof lockSchema>;

export const rateLimitSchema = z.object({
  id: idString('rlm'),
  bucket: z.string().min(2),
  windowStart: isoString(),
  count: z.number().int().min(0),
});
export type RateLimitDoc = z.infer<typeof rateLimitSchema>;

export const workerHeartbeatSchema = z.object({
  id: idString('wrk'),
  workerId: z.string().min(1),
  role: z.enum(['worker', 'api']),
  version: z.string(),
  pid: z.number().int(),
  host: z.string(),
  startedAt: isoString(),
  lastHeartbeatAt: isoString(),
  status: z.enum(['starting', 'running', 'stopping']),
  processedJobs: z.number().int().min(0),
  lastError: z.string().nullable(),
});
export type WorkerHeartbeatDoc = z.infer<typeof workerHeartbeatSchema>;

export const COLLECTION_SCHEMAS = {
  sources: sourceSchema,
  jobs: jobSchema,
  jobSources: jobSourceSchema,
  jobRevisions: jobRevisionSchema,
  users: userSchema,
  sessions: sessionSchema,
  tokens: tokenSchema,
  notificationPreferences: notificationPreferenceSchema,
  notificationEvents: notificationEventSchema,
  emailOutbox: emailOutboxSchema,
  scrapeRuns: scrapeRunSchema,
  reviewQueue: reviewQueueSchema,
  auditLogs: auditLogSchema,
  savedJobs: savedJobSchema,
  scheduledTasks: scheduledTaskSchema,
  queueJobs: queueJobSchema,
  locks: lockSchema,
  rateLimits: rateLimitSchema,
  workerHeartbeats: workerHeartbeatSchema,
} as const;

export type CollectionName = keyof typeof COLLECTION_SCHEMAS;
export type DocumentOf<K extends CollectionName> = z.infer<(typeof COLLECTION_SCHEMAS)[K]>;
