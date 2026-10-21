/**
 * Persistence schemas (Zod) — single source of truth for document shapes.
 *
 * Everything is stored with ISO-8601 string timestamps and date-only strings in
 * Istanbul local time, so the same shape round-trips through both the file store
 * (local development / tests) and MongoDB (production) without conversion.
 */
import { z } from 'zod';
import {
  CONTENT_TYPES,
  EDUCATION_LEVELS,
  EMPLOYMENT_TYPES,
  JOB_STATUSES,
  KPSS_SCORE_TYPES,
  LLM_VERDICTS,
  SOURCE_STATUSES,
} from '../domain';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const isoString = () => z.string().regex(ISO, 'ISO-8601 zaman damgası bekleniyor');
export const dateOnlyString = () => z.string().regex(DATE_ONLY, 'YYYY-AA-GG biçiminde tarih bekleniyor');
export const idString = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+$`), `${prefix}_ kimliği bekleniyor`);

export const sourceSchema = z.object({
  id: idString('src'),
  key: z.string().min(2),
  name: z.string().min(2),
  institution: z.string().min(2),
  homepageUrl: z.string().min(8),
  listingUrl: z.string().min(8),
  sourceType: z.enum([
    'official-portal',
    'official-index',
    'institution-page',
    'exam-authority',
    'regional-restricted',
    'manual',
  ]),
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
    /** Canlı erişimle doğrulandı mı? (yalnızca "verified" durumu true olur) */
    verified: z.boolean(),
    /** Adaptörü yazıldı mı? (doğrulanmış VEYA scraper-built) — doğrulama değildir. */
    built: z.boolean().default(false),
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
    /** Üst üste atlanan tarama sayısı (atlama ile hata ayırt edilebilsin diye). */
    consecutiveSkips: z.number().int().min(0).default(0),
    /** Son yönetici uyarısının zamanı: uyarıların tekrar sıklığını sınırlar. */
    lastWarningAt: z.string().nullable().default(null),
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
    /** Son taramanın HTTP durumu (bilinmiyorsa null). */
    lastHttpStatus: z.number().int().nullable().default(null),
    /** Son hata türü: unavailable | structure | fetch | item | other; hata yoksa null. */
    lastErrorType: z.enum(['unavailable', 'structure', 'fetch', 'item', 'other']).nullable().default(null),
    /** Son başarılı içerik çıkarma zamanı: ham kayıt bulunup işlendiği son tarama. */
    lastExtractionAt: z.string().nullable().default(null),
    /** Son taramada reddedilen ve incelemeye giden kayıt sayıları. */
    lastRejectedCount: z.number().int().min(0).default(0),
    lastReviewCount: z.number().int().min(0).default(0),
    /**
     * Beklenmeyen sıfır: başarılı erişime rağmen 0 ham kayıt; önceki tarama
     * kayıt döndürmüşse ya da üst üste 3+ sıfır ise işaretlenir (yapı değişimi olabilir).
     */
    unexpectedZero: z.boolean().default(false),
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
  /** Şehir filtresinin Türkçe/büyük-küçük duyarsız eşleşmesi için (titleNormalized kalıbı). */
  cityNormalized: z.string().default(''),
  district: z.string().nullable(),
  quota: z.number().int().positive().nullable(),
  applicationStartAt: z.string().nullable(),
  applicationEndAt: z.string().nullable(),
  applicationEndDate: dateOnlyString().nullable(),
  publishedAt: z.string().nullable(),
  detailUrl: z.string().min(8),
  normalizedUrl: z.string().min(8),
  applicationUrl: z.string().nullable(),
  /**
   * İlanda yazılı başvuru yöntemi (ör. "Kariyer Kapısı", "e-Devlet", "posta").
   *
   * Çıkarım motoru bu alanı zaten üretiyordu ama depoya YAZILMIYORDU: ilan
   * detayı "Başvuru yöntemi: belirtilmemiş" diyordu, oysa metinden okunmuştu.
   * Eski kayıtlarda alan yok → `default(null)`: okuma sırasında güvenle dolar.
   */
  applicationMethod: z.string().nullable().default(null),
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
    qualificationCodes: z.array(z.string()).default([]),
    minAge: z.number().int().min(15).max(80).nullable(),
    maxAge: z.number().int().min(15).max(80).nullable(),
    certificates: z.array(z.string()),
    minExperienceYears: z.number().min(0).max(50).nullable(),
    foreignLanguages: z.array(z.string()),
    specialConditions: z.array(z.string()),
  }),
  titles: z.array(z.string()),
  /**
   * Kadro kırılımı (unvan × kontenjan), yalnızca ilan tablosundan okunduğunda dolu.
   * Eski belgelerde alan yoktur → boş liste (geçiş gerekmez).
   */
  openings: z
    .array(
      z.object({
        title: z.string(),
        quota: z.number().int().positive(),
        serviceClass: z.string().nullable(),
        degree: z.number().int().nullable(),
        qualification: z.string().nullable(),
        evidence: z.string(),
      }),
    )
    .default([]),
  /** Contact-redacted, bounded excerpt used by search, matching, extraction and detail UI. */
  textExcerpt: z.string().default(''),
  /** Turkish-normalized derivative of the retained excerpt; consumed by job search. */
  textNormalized: z.string().default(''),
  originalRefNo: z.string().nullable(),
  sourceKeys: z.array(z.string()).min(1),
  primarySourceKey: z.string().min(2),
  classification: z.object({
    decision: z.enum(['accept', 'reject', 'review']),
    /** Eski kayıtlarda yok; varsayılan `job`. */
    kind: z.enum(['job', 'process']).default('job'),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string()),
    rules: z.array(z.string()),
    negativeSignals: z.array(z.string()),
    version: z.string(),
    classifiedAt: isoString(),
    /** LLM sınıflandırma kapısı karara katıldıysa denetim izi (eski kayıtlarda yoktur). */
    llm: z
      .object({
        model: z.string().min(1),
        promptVersion: z.string().min(1),
        verdict: z.enum(LLM_VERDICTS),
        confidence: z.number().min(0).max(1),
        evidenceVerified: z.boolean(),
        cacheHit: z.boolean(),
        analyzedAt: isoString(),
      })
      .optional(),
    /** Deterministik içerik türü (eski kayıtlarda yoktur). */
    contentType: z.enum(CONTENT_TYPES).optional(),
  }),
  extractionConfidence: z.number().min(0).max(1),
  /** Alan bazlı kaynak izi: her alanın hangi katmandan geldiği (ilan detayında gösterilir). */
  fieldSources: z
    .record(
      z.string(),
      z.object({
        kind: z.enum(['listing', 'detail', 'document', 'link', 'unstated']),
        snippet: z.string().nullable(),
      }),
    )
    .default({}),
  /** Alan bazlı kanıt metni (kısa alıntı). */
  evidence: z.record(z.string(), z.string()).default({}),
  /** Çıkarım sırasında tespit edilen belirsizlikler ("tarih bulunamadı" gibi). */
  uncertainties: z.array(z.string()).default([]),
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
  /** Count of the bounded, normalized capture; body text itself is not retained here. */
  capturedTextCharacterCount: z.number().int().min(0).default(0),
  capturedTextStatus: z.enum(['captured', 'truncated', 'listing-only', 'unavailable']).default('unavailable'),
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

/**
 * Tarama belleği: ilan OLUŞTURMAYAN ama işlenmiş kaynak kayıtları.
 *
 * Sınıflandırma reddi veya incelemeye alınan bir kaynak için `jobSources`
 * bağı oluşmaz (ilana bağlanacak kayıt yoktur). Bu kayıtlar buraya yazılır;
 * `loadKnownItemIds` bunları da bildiği için adaptör aynı ilanı her taramada
 * yeniden "yeni" sayıp detay bütçesini tüketmez. Aksi hâlde liste başındaki
 * ihale/sonuç duyuruları bütçenin tamamını yutar ve sonraki sayfalardaki gerçek
 * personel alım ilanları süresiz aç kalır (açlık/starvation).
 *
 * Gövde metni karar anında yoksa ('listing-only'/'unavailable') kayıt,
 * `loadKnownItemIdsWithDetail` tarafından bilinen-detaylı sayılmaz; adaptör
 * detay alındığında sınıflandırma yeniden çalışabilir (ret → kabul düzelmesi).
 */
export const sourceItemDecisionSchema = z.object({
  id: idString('sid'),
  sourceKey: z.string().min(2),
  sourceItemId: z.string().min(1),
  /** 'rejected': sınıflandırma reddi; 'review': inceleme kuyruğunda; 'signal': iptal/düzeltme sinyali işlendi. */
  decision: z.enum(['rejected', 'review', 'signal']),
  /** Karar anında yakalanmış gövde metni var mıydı? */
  capturedTextStatus: z.enum(['captured', 'truncated', 'listing-only', 'unavailable']),
  title: z.string().min(1).max(300),
  url: z.string().min(8),
  classificationVersion: z.string().min(1),
  firstSeenAt: isoString(),
  lastSeenAt: isoString(),
});
export type SourceItemDecisionDoc = z.infer<typeof sourceItemDecisionSchema>;

export const jobRevisionSchema = z.object({
  id: idString('rev'),
  jobId: idString('job'),
  /**
   * Sürüm numarası: 1 = ilanın ilk kaydı ("new" değişikliği), 2+ = sonraki
   * değişiklikler. Sürüm geçmişi ilk kaydı da içerir.
   */
  version: z.number().int().min(1),
  changeTypes: z.array(
    z.enum([
      'new',
      'content',
      'deadline',
      'quota',
      'requirements',
      'application-url',
      'closed',
      'withdrawn',
      'source-added',
    ]),
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
  type: z.enum(['email-verify', 'password-reset', 'unsubscribe', 'telegram-link']),
  tokenHash: z.string().min(16),
  createdAt: isoString(),
  expiresAt: isoString(),
  usedAt: z.string().nullable(),
});
export type TokenDoc = z.infer<typeof tokenSchema>;

export const candidateProfileSchema = z.object({
  profession: z.string().max(100).default(''),
  educationLevel: z.enum(EDUCATION_LEVELS).nullable().default(null),
  departments: z.array(z.string().max(80)).max(20).default([]),
  skills: z.array(z.string().max(80)).max(20).default([]),
  experienceYears: z.number().int().min(0).max(50).nullable().default(null),
});
export type CandidateProfileDoc = z.infer<typeof candidateProfileSchema>;

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
  /** İlan sayfasında profil eşleştirmesi (kural tabanlı, dış hizmet yok). Yapay zekâ bundan bağımsızdır. */
  profilePersonalizationEnabled: z.boolean().default(false),
  /**
   * Yapay zekâ destekli öneriler için AÇIK RIZA zamanı (ISO). Null = rıza yok.
   * Rıza olmadan profil hiçbir harici hizmete gönderilmez.
   */
  aiConsentAt: z.string().nullable().default(null),
  candidateProfile: candidateProfileSchema.default({
    profession: '',
    educationLevel: null,
    departments: [],
    skills: [],
    experienceYears: null,
  }),
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
  /** Teslim kanalı. Eski kayıtlar 'email' kabul edilir. */
  channel: z.enum(['email', 'telegram']).default('email'),
  eventId: idString('nev').nullable(),
  jobId: idString('job').nullable(),
  userId: idString('usr').nullable(),
  kind: z.enum([
    'job-notification',
    'digest',
    'email-verification',
    'password-reset',
    'account-invite',
    'test',
  ]),
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

/**
 * Telegram hesap bağlantısı (kullanıcı başına en çok bir kayıt).
 * chatId: Telegram özel sohbet kimliği (yalnızca bot ile özel sohbet kabul edilir).
 * status: active (gönderim açık), stopped (kullanıcı /dur dedi), blocked (Telegram
 * botu engellendi / sohbet artık yok), unlinked (bağlantı kaldırıldı; kayıt izi için tutulur).
 */
export const telegramLinkSchema = z.object({
  id: idString('tgl'),
  userId: idString('usr'),
  chatId: z.string().min(1).max(32),
  telegramUsername: z.string().max(64).nullable(),
  status: z.enum(['active', 'stopped', 'blocked', 'unlinked']),
  linkedAt: isoString(),
  statusChangedAt: isoString(),
  lastError: z.string().max(300).nullable(),
  createdAt: isoString(),
  updatedAt: isoString(),
});
export type TelegramLinkDoc = z.infer<typeof telegramLinkSchema>;

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
  coverageStatus: z.enum(['complete', 'partial', 'unknown']).default('unknown'),
  coverageNote: z.string().default(''),
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
  /** Uzun süren taramada kilidin canlı olduğunu gösterir. */
  heartbeatAt: isoString(),
});
export type LockDoc = z.infer<typeof lockSchema>;

export const rateLimitSchema = z.object({
  id: idString('rlm'),
  /** Kova anahtarı: IP/e-posta yerine SHA-256 kısaltması saklanır (KVKK). */
  bucket: z.string().min(2),
  windowStart: isoString(),
  count: z.number().int().min(0),
  /** Pencere sonu; temizleme işi bu alanı kullanır. */
  expiresAt: isoString(),
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
  /**
   * 'stopped': süreç artık yok (kalp atışı kesildi veya kapanış bildirildi).
   * Worker başlarken eskimiş 'running' kayıtları bu duruma çevrilir; panelde
   * sahte "çalışıyor" görünmesinler.
   */
  status: z.enum(['starting', 'running', 'stopping', 'stopped']),
  processedJobs: z.number().int().min(0),
  lastError: z.string().nullable(),
});
export type WorkerHeartbeatDoc = z.infer<typeof workerHeartbeatSchema>;

/**
 * LLM sınıflandırma kapısı telemetrisi ve önbelleği.
 *
 * Her analiz denemesi (başarılı, geçersiz çıktı, hata, zaman aşımı) buraya yazılır:
 *  - `cacheKey` (model + istem sürümü + içerik özeti): aynı içerik için API çağrısı tekrarlanmaz.
 *  - Model/istem sürümü değiştiğinde anahtar değişir → kontrollü yeniden değerlendirme.
 *  - Token, gecikme ve hata ölçümleri yönetici panelindeki LLM özetini besler.
 *  - İlan metni BURAYA YAZILMAZ (yalnızca içerik özeti); KVKK ve sır sızıntısı riski azaltılır.
 */
export const llmAnalysisSchema = z.object({
  id: idString('lma'),
  cacheKey: z.string().min(16),
  contentKey: z.string().min(16),
  sourceKey: z.string().min(2),
  url: z.string().min(8),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  status: z.enum(['ok', 'invalid', 'error', 'timeout']),
  cacheHit: z.boolean(),
  verdict: z.enum(LLM_VERDICTS).nullable(),
  contentType: z.enum(CONTENT_TYPES).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  /** Modelin özeti (en fazla 400 karakter); inceleme kuyruğu ve önbellek yeniden eşlemesi kullanır. */
  summary: z.string().max(400).nullable(),
  /** Doğrulanmış kanıt alıntısı (kısa); önbellek isabetinde kararın YENİDEN doğrulanması için saklanır. */
  evidence: z.string().max(300).nullable(),
  latencyMs: z.number().int().min(0),
  promptTokens: z.number().int().min(0).nullable(),
  completionTokens: z.number().int().min(0).nullable(),
  error: z.string().max(300).nullable(),
  createdAt: isoString(),
});
export type LlmAnalysisDoc = z.infer<typeof llmAnalysisSchema>;

export const COLLECTION_SCHEMAS = {
  sources: sourceSchema,
  jobs: jobSchema,
  jobSources: jobSourceSchema,
  sourceItemDecisions: sourceItemDecisionSchema,
  jobRevisions: jobRevisionSchema,
  users: userSchema,
  sessions: sessionSchema,
  tokens: tokenSchema,
  notificationPreferences: notificationPreferenceSchema,
  notificationEvents: notificationEventSchema,
  emailOutbox: emailOutboxSchema,
  telegramLinks: telegramLinkSchema,
  scrapeRuns: scrapeRunSchema,
  reviewQueue: reviewQueueSchema,
  auditLogs: auditLogSchema,
  savedJobs: savedJobSchema,
  scheduledTasks: scheduledTaskSchema,
  queueJobs: queueJobSchema,
  locks: lockSchema,
  rateLimits: rateLimitSchema,
  workerHeartbeats: workerHeartbeatSchema,
  llmAnalyses: llmAnalysisSchema,
} as const;

export type CollectionName = keyof typeof COLLECTION_SCHEMAS;
export type DocumentOf<K extends CollectionName> = z.infer<(typeof COLLECTION_SCHEMAS)[K]>;
