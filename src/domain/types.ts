/**
 * Kamuİlan shared domain types.
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

/**
 * TEK KAYNAK: etiket sözlükleri.
 *
 * Aynı ilanın kartında, detayında ve bildirim e-postasında FARKLI metin
 * görünmemesi için etiketler yalnızca burada tanımlanır; arayüz (lib/format),
 * API (server/serializers), e-posta şablonları ve bildirim eşleştiricisi burada
 * tanımlı sözlükleri kullanır. Yeni bir değer eklendiğinde `Record<...>` tipi
 * eksik anahtarı derleme zamanında yakalar.
 */
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  kadrolu: 'Kadrolu memur',
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
  active: 'Başvuru açık',
  closed: 'Başvuru kapandı',
  cancelled: 'İlan geri çekildi / iptal',
  unknown: 'Durum belirsiz',
};

/** Süreç duyurusunun (kura, sınav, sonuç) gösterilecek durum etiketi. Başvuru durumu değildir. */
export const PROCESS_STATUS_LABEL = 'Süreç duyurusu';

export const CLASSIFICATION_DECISIONS = ['accept', 'reject', 'review'] as const;
export type ClassificationDecision = (typeof CLASSIFICATION_DECISIONS)[number];

export type SourceType =
  | 'official-portal'
  | 'official-index'
  | 'institution-page'
  | 'exam-authority'
  | 'regional-restricted'
  | 'manual';

export type SourceMethod =
  'html-list' | 'html-detail' | 'pdf-index' | 'json-api' | 'manual-entry' | 'browser';

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
  researched: 'İncelendi',
  'method-defined': 'Yöntemi hazır',
  accessible: 'Erişilebiliyor',
  'scraper-built': 'Hazırlanıyor',
  verified: 'Gerçek veriyle doğrulandı',
  'temporary-error': 'Geçici sorun',
  'access-restricted': 'Erişilemiyor',
  'needs-manual-method': 'Elle takip ediliyor',
  disabled: 'Kapalı',
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
  /** ÖSYM başvuru nitelik kodları ("Nitelik Kodu" sütunu). */
  qualificationCodes: string[];
  minAge?: number;
  maxAge?: number;
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
  /** Plain text of the announcement body/attachment when available. */
  bodyText?: string;
  /** Which source page supplied bodyText; listing snippets are not full notices. */
  bodyTextSource?: 'detail' | 'listing' | 'document';
  /** True when the adapter hit its extraction/storage cap. */
  bodyTextTruncated?: boolean;
  /** Gövde metni OCR ile okunduysa ortalama güven (0–100); OCR yoksa alan yoktur. */
  ocrConfidence?: number;
  institution?: string;
  publishedAt?: string;
  applicationStartAt?: string;
  applicationEndAt?: string;
  applicationUrl?: string;
  city?: string;
  district?: string;
  quota?: number;
  /** Kaynağın verdiği resmî ilan numarası (varsa). */
  referenceNo?: string;
  /** İlan metninde geçen bağlantılar (başvuru bağlantısını bulmak için). */
  links?: { text: string; url: string }[];
  attachments: JobAttachment[];
  /** Category/heading the source itself used (used as a classification signal). */
  sourceCategory?: string;
  /** Bounded plain-text excerpt kept for evidence; not rendered as HTML and contact-redacted on storage. */
  rawExcerpt?: string;
  extractionConfidence: number;
  notes?: string[];
}

/**
 * `job`: personel alım ilanı. `process`: gerçek bir alımın kura/sınav/mülakat/sonuç
 * duyurusu (ayrı kategori, akışta tutulur). Yalnızca `decision === 'accept'` için anlamlıdır.
 */
export const CLASSIFICATION_KINDS = ['job', 'process'] as const;
export type ClassificationKind = (typeof CLASSIFICATION_KINDS)[number];

/** İçerik türü: sınıflandırmanın nedeni olarak içeriğin ne olduğu (bkz. classification/content-type.ts). */
export const CONTENT_TYPES = [
  'personnel_recruitment',
  'personnel_process_announcement',
  'student_admission',
  'education_program',
  'news',
  'event',
  'report_or_publication',
  'other',
  'uncertain',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * LLM sınıflandırma kapısının ham kararı (Türkçe model çıktısının eşlenmiş hâli).
 * `ilan`: yeni personel alımı · `surec`: alım süreci duyurusu · `ilan-degil`: başka içerik türü ·
 * `belirsiz`: model de emin değil (kayıt incelemede kalır).
 */
export const LLM_VERDICTS = ['ilan', 'surec', 'ilan-degil', 'belirsiz'] as const;
export type LlmVerdict = (typeof LLM_VERDICTS)[number];

/** Kabul edilen bir sınıflandırmaya eşlik eden LLM denetim izi (kanıt doğrulaması geçmiş). */
export interface ClassificationLlmAudit {
  model: string;
  promptVersion: string;
  verdict: LlmVerdict;
  confidence: number;
  /** Modelin gösterdiği kanıt kaynak metinde birebir doğrulandı mı? */
  evidenceVerified: boolean;
  /** Karar önbellekten mi geldi (yeni API çağrısı yapılmadı)? */
  cacheHit: boolean;
  analyzedAt: string;
}

export interface ClassificationResult {
  decision: ClassificationDecision;
  kind: ClassificationKind;
  employmentType: EmploymentType;
  confidence: number;
  reasons: string[];
  rules: string[];
  negativeSignals: string[];
  version: string;
  /** Deterministik içerik türü (eski kayıtlarda yoktur). */
  contentType?: ContentType;
  /** Yalnızca LLM kapısı karara katıldığında vardır (eski kayıtlarda yoktur). */
  llm?: ClassificationLlmAudit;
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
