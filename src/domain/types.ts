/**
 * KamuRadar shared domain types.
 *
 * These types are the contract between source adapters, the classification /
 * extraction pipeline, the database layer, the API and the web app.
 */

export const EMPLOYMENT_TYPES = [
  'kadrolu',
  'sozlesmeli',
  'kamu-isci',
  'akademik',
  'kariyer-meslek',
  'kuruma-ozel-sinav',
  'diger-kamu',
  'belirsiz',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  kadrolu: 'Kadrolu kamu görevlisi',
  sozlesmeli: 'Sözleşmeli personel (4/B)',
  'kamu-isci': 'Kamu işçisi (İŞKUR)',
  akademik: 'Akademik personel',
  'kariyer-meslek': 'Kariyer meslek / uzman yardımcılığı',
  'kuruma-ozel-sinav': 'Kuruma özgü sınavla personel',
  'diger-kamu': 'Diğer kamu personeli',
  belirsiz: 'Belirsiz (inceleme bekliyor)',
};

export const EDUCATION_LEVELS = [
  'ilkogretim',
  'ortaogretim',
  'onlisans',
  'lisans',
  'yukseklisans',
  'doktora',
] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const EDUCATION_LEVEL_LABELS: Record<EducationLevel, string> = {
  ilkogretim: 'İlköğretim',
  ortaogretim: 'Ortaöğretim (lise)',
  onlisans: 'Ön lisans',
  lisans: 'Lisans',
  yukseklisans: 'Yüksek lisans',
  doktora: 'Doktora',
};

export const KPSS_SCORE_TYPES = ['P1', 'P2', 'P3', 'P10', 'P93', 'P94', 'P121', 'P124', 'DHBT'] as const;
export type KpssScoreType = (typeof KPSS_SCORE_TYPES)[number];

/** Lifecycle status of a deduplicated job announcement. */
export const JOB_STATUSES = ['upcoming', 'active', 'closed', 'cancelled', 'unknown'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  upcoming: 'Başvuru başlamadı',
  active: 'Başvuru devam ediyor',
  closed: 'Başvuru kapandı',
  cancelled: 'İlan geri çekildi / iptal',
  unknown: 'Durum belirsiz',
};

export const CLASSIFICATION_DECISIONS = ['accept', 'reject', 'review'] as const;
export type ClassificationDecision = (typeof CLASSIFICATION_DECISIONS)[number];

export type SourceType =
  | 'official-portal'
  | 'official-index'
  | 'institution-page'
  | 'exam-authority'
  | 'regional-restricted'
  | 'manual';

export type SourceMethod = 'html-list' | 'html-detail' | 'pdf-index' | 'json-api' | 'manual-entry' | 'browser';

/** Honest, verifiable integration status used by the admin coverage report. */
export const SOURCE_STATUSES = [
  'not-researched',
  'researched',
  'method-defined',
  'accessible',
  'scraper-built',
  'verified',
  'temporary-error',
  'access-restricted',
  'needs-manual-method',
  'disabled',
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  'not-researched': 'Henüz araştırılmadı',
  researched: 'Araştırıldı',
  'method-defined': 'Yöntem belirlendi',
  accessible: 'Teknik olarak erişilebilir',
  'scraper-built': 'Scraper geliştirildi',
  verified: 'Gerçek veriyle doğrulandı',
  'temporary-error': 'Geçici hata',
  'access-restricted': 'Erişim kısıtı',
  'needs-manual-method': 'Manuel yöntem gerekiyor',
  disabled: 'Devre dışı',
};

export interface JobAttachment {
  url: string;
  label: string;
  kind: 'pdf' | 'html' | 'doc' | 'excel' | 'other';
  sizeBytes?: number;
}

export interface JobRequirements {
  educationLevels: EducationLevel[];
  departments: string[];
  kpssScoreTypes: KpssScoreType[];
  kpssMinScore?: number;
  kpssYear?: number;
  minAge?: number;
  maxAge?: number
  certificates: string[];
  minExperienceYears?: number;
  foreignLanguages: string[];
  specialConditions: string[];
}

/** One announcement as published by a single source, before deduplication. */
export interface RawAnnouncement {
  sourceKey: string;
  /** Stable id inside the source (official reference number, slug or URL hash). */
  sourceItemId: string;
  url: string;
  title: string;
  /** Full plain text of the announcement body/attachment when available. */
  bodyText?: string;
  institution?: string;
  publishedAt?: string;
  applicationStartAt?: string;
  applicationEndAt?: string;
  applicationUrl?: string;
  city?: string;
  quota?: number;
  attachments: JobAttachment[];
  /** Category/heading the source itself used (used as a classification signal). */
  sourceCategory?: string;
  /** Raw html/text excerpt kept for evidence, never rendered as HTML. */
  rawExcerpt?: string;
  extractionConfidence: number;
  notes?: string[];
}

export interface ClassificationResult {
  decision: ClassificationDecision;
  employmentType: EmploymentType;
  confidence: number;
  reasons: string[];
  rules: string[];
  negativeSignals: string[];
  version: string;
}

export interface JobClassification extends ClassificationResult {
  classifiedAt: string;
}

export interface JobInput {
  title: string;
  institution: string;
  unit?: string;
  employmentType: EmploymentType;
  status: JobStatus;
  city?: string;
  district?: string;
  quota?: number;
  applicationStartAt?: string;
  applicationEndAt?: string;
  applicationEndDate?: string;
  publishedAt?: string;
  detailUrl: string;
  applicationUrl?: string;
  attachments: JobAttachment[];
  requirements: JobRequirements;
  titles: string[];
  textExcerpt: string;
  originalRefNo?: string;
  classification: JobClassification;
  extractionConfidence: number;
}
