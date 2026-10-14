/**
 * Arayüz ile API arasındaki veri sözleşmeleri.
 *
 * Not: Sunucu tarafındaki biçim `src/server/serializers.ts` içinde üretilir.
 * Burada yalnızca tipler tanımlanır; sunucu modülleri tarayıcı paketine girmez.
 */

/** Kanonik istihdam türleri — `src/domain/types.ts` EMPLOYMENT_TYPES ile birebir aynı. */
export type EmploymentType =
  | 'kadrolu'
  | 'sozlesmeli'
  | 'kamu-isci'
  | 'akademik'
  | 'kariyer-meslek'
  | 'kuruma-ozel-sinav'
  | 'diger-kamu'
  | 'belirsiz';

export type JobStatus = 'upcoming' | 'active' | 'closed' | 'cancelled' | 'unknown' | 'draft' | 'review';

export interface DeadlineInfo {
  /** Sunucudaki `deadlineState` değerleri: open | closing-soon | closed | unknown. */
  state: 'open' | 'closing-soon' | 'closed' | 'unknown';
  daysLeft: number | null;
}

export interface PublicJobSummary {
  id: string;
  title: string;
  institution: string;
  unit: string | null;
  employmentType: EmploymentType;
  employmentTypeLabel: string;
  status: JobStatus;
  statusLabel: string;
  city: string | null;
  district: string | null;
  quota: number | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  publishedAt: string | null;
  detailUrl: string;
  applicationUrl: string | null;
  hasApplicationUrl: boolean;
  attachmentCount: number;
  titles: string[];
  sourceKeys: string[];
  extractionConfidence: number;
  lastVerifiedAt: string | null;
  /** 'scraped' = gerçek kaynaktan geldi, 'sample' = örnek/demo verisi. */
  provenance: 'scraped' | 'sample' | 'manual';
  version: number;
  updatedAt: string;
  deadline: DeadlineInfo;
  criticalMissingFields?: string[];
}

export interface PublicJobDetail extends PublicJobSummary {
  applicationMethod: string | null;
  originalRefNo: string | null;
  textExcerpt: string;
  requirements: {
    educationLevels: string[];
    departments: string[];
    kpssScoreTypes: string[];
    kpssMinScore: number | null;
    kpssYear: number | null;
    qualificationCodes: string[];
    minAge: number | null;
    maxAge: number | null;
    certificates: string[];
    minExperienceYears: number | null;
    foreignLanguages: string[];
    specialConditions: string[];
  };
  attachments: { url: string; label: string; kind: string }[];
  classification: {
    decision: 'accept' | 'reject' | 'review';
    employmentType: EmploymentType;
    confidence: number;
    reasons: string[];
    version: string;
  };
  fieldSources: Record<string, { kind: string; snippet: string | null }>;
  evidence: Record<string, string>;
  uncertainties: string[];
  provenance: 'scraped' | 'sample' | 'manual';
  firstSeenAt: string;
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

export interface JobListResponse {
  items: PublicJobSummary[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  sort: string;
  generatedAt: string;
}

export interface DashboardStats {
  total: number;
  active: number;
  upcoming: number;
  closed: number;
  closingSoon: number;
  addedToday: number;
  byEmploymentType: { key: string; count: number }[];
  lastSuccessfulScanAt: string | null;
  reviewQueue?: { total: number; classification: number; dedupe: number; extraction: number };
  generatedAt?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  app: string;
  version: string;
  environment: string;
  checkedAt: string;
  database: { driver: string; healthy: boolean; latencyMs: number | null; detail: string | null };
  versions: { classification: string; extraction: string; dedupe: string };
  scans: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    minutesSinceSuccess: number | null;
    totalRuns: number;
    failedRuns: number;
  };
  workers: {
    total: number;
    running: number;
    stale: number;
    items: {
      workerId: string;
      role: string;
      status: string;
      lastHeartbeatAt: string;
      processedJobs: number;
    }[];
  };
  queue: { backend: string; pending: number; active: number; dead: number };
  sources: {
    total: number;
    enabled: number;
    /** Canlı erişimle doğrulanmış kaynak sayısı (adaptörü yazılmış olmak yetmez). */
    verified: number;
    built?: number;
    failing: number;
    stale: number;
    planned: number;
  };
  warnings: string[];
}

export interface WorkerHealthResponse {
  checkedAt: string;
  workers: { total: number; running: number; starting: number; stale: number };
}

export interface SourceCoverageEntry {
  key: string;
  name: string;
  institution: string;
  group: string;
  status: string;
  statusNote: string;
  enabled: boolean;
  /** Geçmiş canlı doğrulama kaydı var; güncel erişim/worker durumunu tek başına kanıtlamaz. */
  verified: boolean;
  /** Adaptör yazıldı; canlı doğrulama kanıtı olmayabilir. */
  built: boolean;
  lastVerifiedAt: string | null;
  verificationEvidence: string;
  coverageNote: string;
  intervalMinutes: number;
  health: {
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
    totalRuns: number;
    successRuns: number;
    failureRuns: number;
    avgDurationMs: number | null;
    lastError: string | null;
    itemsFound: number;
    emptyStreak: number;
  };
  lastRun: {
    startedAt: string;
    status: string;
    itemsFound: number;
    errorCount: number;
    result: string;
    coverageStatus: 'complete' | 'partial' | 'unknown';
    coverageNote: string;
  } | null;
}

export interface PlannedSource {
  id: string;
  name: string;
  institution: string;
  candidateUrl: string | null;
  indirectCoverage: string;
  note: string;
}

export interface SourceListResponse {
  sources: SourceCoverageEntry[];
  planned: PlannedSource[];
  summary: {
    total: number;
    enabled: number;
    verified: number;
    /** Adaptörü hazır ancak henüz canlı doğrulanmamış kaynak sayısı. */
    built?: number;
    failing: number;
    stale: number;
    planned: number;
  };
  disclaimer: string;
  generatedAt: string;
}

export interface SessionSetupInfo {
  /** Etkin veritabanında HİÇ kullanıcı yok (ilk yönetici henüz kurulmamış). */
  required: boolean;
  /** Etkin depo sürücüsü: 'file' | 'postgres' | 'mongodb'. */
  driver: string;
  /** Kullanıcıya gösterilecek depo adı (ör. "Supabase (PostgreSQL)"). */
  label: string;
}

export interface SessionResponse {
  authenticated: boolean;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    role: 'user' | 'admin';
    status: string;
    emailVerified: boolean;
    emailVerifiedAt: string | null;
    createdAt: string;
    lastLoginAt: string | null;
  } | null;
  csrfToken: string | null;
  /** Kurulum tanılaması: hesabın hangi veritabanında arandığını gösterir. */
  setup?: SessionSetupInfo;
}

export interface CandidateProfile {
  profession: string;
  educationLevel: string | null;
  departments: string[];
  skills: string[];
  experienceYears: number | null;
}

export interface PreferenceFilters {
  keywords: string[];
  titles: string[];
  institutions: string[];
  cities: string[];
  employmentTypes: EmploymentType[];
  educationLevels: string[];
  departments: string[];
  kpssScoreTypes: string[];
  kpssMinScore: number | null;
  minDaysUntilDeadline: number | null;
}

export interface NotificationPreference {
  id: string;
  userId: string;
  enabled: boolean;
  paused: boolean;
  mode: 'instant' | 'daily-digest';
  onlyNewJobs: boolean;
  notifyOnChanges: boolean;
  includeWorkerJobs: boolean;
  includeAcademicJobs: boolean;
  profilePersonalizationEnabled: boolean;
  candidateProfile: CandidateProfile;
  filters: PreferenceFilters;
  createdAt: string;
  updatedAt: string;
}

export interface PreferencesResponse {
  preference: NotificationPreference | null;
  email: string;
  emailVerified: boolean;
  canReceive: boolean;
  options: {
    employmentTypes: string[];
    educationLevels: string[];
    kpssScoreTypes: string[];
    modes: string[];
  };
  notice: string | null;
}

export interface SavedJobItem {
  job: PublicJobSummary;
  savedAt: string;
}

export interface SavedJobsResponse {
  items: SavedJobItem[];
  total: number;
  generatedAt: string;
}

export interface NotificationHistoryResponse {
  events: {
    id: string;
    jobId: string;
    jobTitle: string | null;
    kind: string;
    jobVersion: number;
    status: string;
    suppressionReason: string | null;
    matchedOn: string[];
    createdAt: string;
  }[];
  emails: {
    id: string;
    subject: string;
    kind: string;
    status: string;
    statusLabel: string;
    attempts: number;
    createdAt: string;
    acceptedAt: string | null;
    lastError: string | null;
  }[];
  notice: string;
}

export interface AdminOverview {
  appVersion: string;
  versions: { classification: string; extraction: string; dedupe: string };
  jobs: DashboardStats;
  coverage: {
    summary: {
      total: number;
      enabled: number;
      verified: number;
      failing: number;
      stale: number;
      planned: number;
    };
  };
  runs: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    avgDurationMs: number;
  };
  reviewQueue: { total: number; classification: number; dedupe: number; extraction: number };
  outbox: Record<string, number>;
  queue: { backend: string; counts: Record<string, number>; dead: number };
  workers: {
    workerId: string;
    role: string;
    status: string;
    version: string;
    lastHeartbeatAt: string;
    processedJobs: number;
    stale: boolean;
    lastError: string | null;
  }[];
  workerWarning: string | null;
  auditEntries: number;
  generatedAt: string;
}

export interface ScrapeRunSummary {
  id: string;
  sourceKey: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  scheduleDelayMs: number | null;
  itemsFound: number;
  itemsAccepted: number;
  itemsRejected: number;
  itemsReview: number;
  jobsCreated: number;
  jobsUpdated: number;
  itemsMerged: number;
  revisionsCreated: number;
  errorCount: number;
  errors: string[];
  httpStatuses: number[];
  coverageStatus: 'complete' | 'partial' | 'unknown';
  coverageNote: string;
  result: string;
  notes: string[];
  workerId: string;
}

export interface ReviewItem {
  id: string;
  kind: 'classification' | 'dedupe' | 'extraction';
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
}

export interface OutboxItem {
  id: string;
  kind: string;
  to: string;
  subject: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lockedBy: string | null;
  lastError: string | null;
  providerMessageId: string | null;
  createdAt: string;
  acceptedAt?: string | null;
  failedAt?: string | null;
}

export interface QueueResponse {
  stats: { backend: string; counts: Record<string, number>; dead: number };
  dead: {
    id: string;
    queue: string;
    name: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
  }[];
  locks: { key: string; owner: string; expiresAt: string; expired: boolean }[];
  tasks: {
    id: string;
    kind: string;
    sourceKey: string;
    enabled: boolean;
    intervalMinutes: number;
    nextRunAt: string;
    lastRunAt: string | null;
    lastEnqueuedRunId: string | null;
    misses: number;
    overdueMinutes: number;
  }[];
  scheduleLagWarning: string | null;
}

export interface CoverageReport {
  verified: number;
  enabled: number;
  total: number;
  planned: number;
  byGroup: { group: string; count: number }[];
  gaps: { key: string; name: string; reason: string }[];
  unscheduled: string[];
  unknownRegistryAdapters: string[];
  disclaimer: string;
  generatedAt: string;
}
