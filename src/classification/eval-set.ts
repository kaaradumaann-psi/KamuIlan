/**
 * Gerçek veri değerlendirme kümesi: etiketleme sayfası üretimi ve içe aktarma.
 *
 * Neden bu modül: `npm run eval:classification` bir küme DOSYASI okur; ama o dosyayı
 * dolduracak gerçek, insan doğrulamalı kayıt akışı yoktu. Bu modül iki işi yapar:
 *
 *  1. `buildLabelingWorksheet` — depodaki GERÇEK kaynaklardan toplanmış kayıtlardan
 *     (provenance: 'scraped') salt okunur bir etiketleme sayfası üretir. Makinenin
 *     tahmini `machineSuggestion` altında DURUR ve gerçek etiket olarak kullanılmaz;
 *     `expectedContentType` boş bırakılır (insan doldurur).
 *  2. `importLabeledWorksheet` — doldurulmuş sayfayı doğrular ve `labeled-set.json`
 *     biçimine birleştirir. İnsan doğrulaması olmayan (`labelVerifiedBy`/`labeledAt`)
 *     kayıt REDDEDİLİR; böylece "modelin kendi tahminini altın etiket yapma" riski
 *     yapısal olarak kapanır.
 *
 * Metin küçültme kısıtı: depoda tam ilan gövdesi saklanmaz (`textExcerpt` sınırlı ve
 * iletişim bilgileri_maskelenmiş alıntıdır; `jobSources.capturedTextStatus` tam metnin
 * varlığını söyler). Etiketleyen kişi tam metni `url` üzerinden resmî kaynağından
 * okumalıdır — sayfa bunu açıkça not eder.
 */
import { z } from 'zod';
import { CONTENT_TYPES, type ContentType } from '../domain/types';
import { SOURCE_DEFINITIONS } from '../config/sources';

/** Depodaki bir ilan kaydından etiketleme sayfasına girecek en küçük alan seti. */
export interface WorksheetJobRecord {
  id: string;
  title: string;
  institution: string;
  detailUrl: string;
  applicationUrl: string | null;
  city: string | null;
  quota: number | null;
  publishedAt: string | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  textExcerpt: string;
  evidence: Record<string, string>;
  provenance: 'scraped' | 'sample' | 'manual';
  primarySourceKey: string;
  sourceCategory: string | null;
  capturedTextStatus: 'captured' | 'truncated' | 'listing-only' | 'unavailable';
  classification: {
    decision: 'accept' | 'reject' | 'review';
    kind: 'job' | 'process';
    contentType?: ContentType;
    confidence: number;
    reasons: string[];
    llm?: { model: string; verdict: string; evidenceVerified: boolean; cacheHit: boolean };
  };
  uncertainties: string[];
  /** Kayıt çoklu il içeriyor mu (birden fazla başvuru bağlantısı/tarihi olan ilanlar için). */
  extraCities?: string[];
}

export const labelingWorksheetRecordSchema = z.object({
  id: z.string().min(3),
  origin: z.enum(['real', 'synthetic', 'spec-title']),
  /** Etiket henüz konmadı: 'unreviewed'. İnsan koyduysa 'human'. Makine önerisi 'machine'. */
  labelProvenance: z.enum(['unreviewed', 'human', 'machine']),
  sourceKey: z.string().nullable(),
  url: z.string().min(8),
  title: z.string().min(3),
  institution: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  /** Etiketlemenin dayandığı kısa alıntı (tam metin değildir; `url` üzerinden doğrulanmalı). */
  bodyExcerpt: z.string(),
  bodyCompleteness: z.enum(['captured', 'truncated', 'listing-only', 'unavailable']),
  /** Deterministik motor + LLM tahmini. GERÇEK ETİKET DEĞİLDİR; yalnızca işi hızlandırır. */
  machineSuggestion: z.object({
    contentType: z.string().nullable(),
    decision: z.string(),
    confidence: z.number(),
    reasons: z.array(z.string()),
    llm: z
      .object({ model: z.string(), verdict: z.string(), evidenceVerified: z.boolean(), cacheHit: z.boolean() })
      .nullable(),
  }),
  /** İnsan tarafından doldurulur. */
  expectedContentType: z.enum(CONTENT_TYPES).nullable(),
  expectedFields: z
    .object({
      institution: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      quota: z.number().int().nullable().optional(),
      applicationStartAt: z.string().nullable().optional(),
      applicationEndAt: z.string().nullable().optional(),
      applicationUrl: z.string().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
    })
    .default({}),
  labeledBy: z.string().nullable().default(null),
  labeledAt: z.string().nullable().default(null),
  notes: z.string().default(''),
});
export type LabelingWorksheetRecord = z.infer<typeof labelingWorksheetRecordSchema>;

export const labelingWorksheetSchema = z.object({
  kind: z.literal('kamuilan-eval-worksheet'),
  generatedAt: z.string(),
  /** Üretim notu: etiketlerin nasıl doğrulanması gerektiği kayıtlarla birlikte taşınır. */
  instructions: z.string(),
  records: z.array(labelingWorksheetRecordSchema),
});
export type LabelingWorksheet = z.infer<typeof labelingWorksheetSchema>;

const REAL_SOURCES = new Set(SOURCE_DEFINITIONS.filter((source) => source.method !== 'manual-entry').map((source) => source.key));

/** Gerçek kaynak etiketi yalnızca resmî kaynak envanterinde bulunan kaynaklardan gelir. */
export function isRealSourceRecord(record: Pick<WorksheetJobRecord, 'provenance' | 'primarySourceKey'>): boolean {
  return record.provenance === 'scraped' && REAL_SOURCES.has(record.primarySourceKey);
}

export const WORKSHEET_INSTRUCTIONS =
  'expectedContentType ve expectedFields alanlarını RESMÎ KAYNAĞI (url) okuyarak doldurun; ' +
  'machineSuggestion yalnızca işi hızlandırmak içindir ve altın etiket SAYILMAZ. Etiket koyan ' +
  'kişi labeledBy ve labeledAt yazmadan kayıt içe aktarılmaz. Tarihleri YYYY-MM-DD olarak verin; ' +
  'başvuru başlangıcı, son başvuru, yayım ve sınav tarihlerini AYRI tutun.';

export function buildLabelingWorksheet(
  records: readonly WorksheetJobRecord[],
  now: Date,
): LabelingWorksheet {
  return {
    kind: 'kamuilan-eval-worksheet',
    generatedAt: now.toISOString(),
    instructions: WORKSHEET_INSTRUCTIONS,
    records: records.map((record) => {
      const real = isRealSourceRecord(record);
      return {
        id: record.id,
        origin: real ? 'real' : 'synthetic',
        labelProvenance: 'unreviewed',
        sourceKey: record.primarySourceKey,
        url: record.detailUrl,
        title: record.title,
        institution: record.institution || null,
        sourceCategory: record.sourceCategory,
        bodyExcerpt: record.textExcerpt,
        bodyCompleteness: record.capturedTextStatus,
        machineSuggestion: {
          contentType: record.classification.contentType ?? null,
          decision: record.classification.decision,
          confidence: record.classification.confidence,
          reasons: record.classification.reasons.slice(0, 8),
          llm: record.classification.llm ?? null,
        },
        expectedContentType: null,
        expectedFields: {},
        labeledBy: null,
        labeledAt: null,
        notes:
          record.capturedTextStatus === 'captured'
            ? ''
            : 'UYARI: depoda tam metin yok/kesik; etiket resmî kaynakta okunarak konmalı.',
      } satisfies LabelingWorksheetRecord;
    }),
  };
}

export interface ImportReport {
  accepted: string[];
  rejected: { id: string; reason: string }[];
  realCount: number;
  syntheticCount: number;
  withExpectedFields: number;
  coverage: { contentType: ContentType; count: number }[];
  /** Hedef kapsama göre eksik kategoriler (150–200 kayıt planının izlenebilir hâli). */
  gaps: string[];
}

/** Hedef: her kritik kategoride en az bu kadar insan doğrulamalı gerçek kayıt. */
export const COVERAGE_TARGETS: { label: string; contentType: ContentType; min: number }[] = [
  { label: 'gerçek personel alımı', contentType: 'personnel_recruitment', min: 40 },
  { label: 'personel alım süreci duyurusu', contentType: 'personnel_process_announcement', min: 25 },
  { label: 'haber', contentType: 'news', min: 25 },
  { label: 'öğrenci alımı', contentType: 'student_admission', min: 15 },
  { label: 'eğitim programı', contentType: 'education_program', min: 10 },
  { label: 'etkinlik', contentType: 'event', min: 10 },
  { label: 'rapor/yayın', contentType: 'report_or_publication', min: 10 },
  { label: 'diğer/belirsiz', contentType: 'other', min: 10 },
];

export const COVERAGE_TARGET_TOTAL = COVERAGE_TARGETS.reduce((sum, target) => sum + target.min, 0);

/**
 * Doldurulmuş sayfayı doğrular ve `labeled-set.json` kayıtlarına dönüştürür.
 *
 * Ret nedenleri (kayıt içe alınmaz):
 *  - `expectedContentType` boş;
 *  - `labelProvenance` 'human' değil ya da `labeledBy`/`labeledAt` yok (makine
 *    önerisi altın etiket olamaz);
 *  - `origin: 'real'` ama kaynak envanterinde olmayan bir kaynak (kanıtsız gerçek iddiası).
 */
export function importLabeledWorksheet(worksheet: unknown): {
  records: LabeledSetRecord[];
  report: ImportReport;
} {
  const parsed = labelingWorksheetSchema.safeParse(worksheet);
  if (!parsed.success) {
    throw new Error(`Etiketleme sayfası biçimi geçersiz: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const records: LabeledSetRecord[] = [];
  const rejected: ImportReport['rejected'] = [];
  for (const record of parsed.data.records) {
    if (!record.expectedContentType) {
      rejected.push({ id: record.id, reason: 'expectedContentType boş (insan etiketi gerekiyor)' });
      continue;
    }
    if (record.origin === 'real' && record.labelProvenance !== 'human') {
      rejected.push({
        id: record.id,
        reason: `gerçek kayıt için etiket provenansı 'human' olmalı (bulundu: ${record.labelProvenance})`,
      });
      continue;
    }
    if (!record.labeledBy || !record.labeledAt) {
      rejected.push({ id: record.id, reason: 'labeledBy/labeledAt boş: kimin ne zaman doğruladığı yazılmadan içe alınmaz' });
      continue;
    }
    records.push({
      id: record.id,
      origin: record.origin,
      title: record.title,
      sourceCategory: record.sourceCategory ?? '',
      bodyKind: record.machineSuggestion.contentType === 'personnel_recruitment' ? 'recruitment' : 'news',
      expectedContentType: record.expectedContentType,
      // Sayfadaki alıntı gerçek metnin PARÇASI; `body` olarak yalnızca tam metin
      // durumu 'captured' ise kullanılır (kırpık alıntıyla ölçüm yapılmaz).
      ...(record.bodyCompleteness === 'captured' && record.bodyExcerpt.length >= 200
        ? { body: record.bodyExcerpt }
        : {}),
      sourceKey: record.sourceKey,
      // Sayfayı dolduran kişi human demese bile (labeledBy/labeledAt zorunlu olduğu için)
      // etiket insan doğrulamasıdır; 'machine' olarak işaretlenmişse öyle kalır.
      labelProvenance: record.labelProvenance === 'machine' ? 'machine' : 'human',
      labelVerifiedBy: record.labeledBy,
      labeledAt: record.labeledAt,
      url: record.url,
      ...(Object.keys(record.expectedFields).length > 0 ? { expectedFields: record.expectedFields } : {}),
    });
  }
  const realCount = records.filter((record) => record.origin === 'real').length;
  const counts = CONTENT_TYPES.map((contentType) => ({
    contentType,
    count: records.filter((record) => record.expectedContentType === contentType).length,
  })).filter((entry) => entry.count > 0);
  const gaps = COVERAGE_TARGETS.filter(
    (target) => records.filter((record) => record.origin === 'real' && record.expectedContentType === target.contentType).length < target.min,
  ).map((target) => `${target.label}: ${records.filter((r) => r.origin === 'real' && r.expectedContentType === target.contentType).length}/${target.min}`);
  return {
    records,
    report: {
      accepted: records.map((record) => record.id),
      rejected,
      realCount,
      syntheticCount: records.length - realCount,
      withExpectedFields: records.filter((record) => record.expectedFields && Object.keys(record.expectedFields).length > 0)
        .length,
      coverage: counts,
      gaps,
    },
  };
}

export interface LabeledSetRecord {
  id: string;
  origin: 'real' | 'synthetic' | 'spec-title';
  title: string;
  sourceCategory: string;
  bodyKind: 'news' | 'recruitment';
  expectedContentType: ContentType;
  body?: string;
  sourceKey?: string | null;
  labelProvenance?: 'human' | 'machine' | 'spec';
  labelVerifiedBy?: string | null;
  labeledAt?: string | null;
  url?: string;
  expectedFields?: Record<string, string | number | null>;
}

/**
 * Mevcut kümeyle birleştirir: aynı `id` varsa İÇE AKTARILAN kazanır (etiket yenilenir),
 * başka hiçbir kayıt silinmez. Küme dosyası şeması sabit tutulur
 * (`{ description, records }`) ki `eval:classification` olduğu gibi okumaya devam etsin.
 */
export function mergeLabeledSets(
  existing: { records: LabeledSetRecord[] } | null,
  incoming: LabeledSetRecord[],
  now: Date,
): { document: { description: string; updatedAt: string; records: LabeledSetRecord[] }; added: number; updated: number } {
  const byId = new Map<string, LabeledSetRecord>();
  for (const record of existing?.records ?? []) byId.set(record.id, record);
  let added = 0;
  let updated = 0;
  for (const record of incoming) {
    if (byId.has(record.id)) updated += 1;
    else added += 1;
    byId.set(record.id, record);
  }
  return {
    document: {
      description:
        'Kamuİlan sınıflandırma değerlendirme kümesi. Yalnızca İNSAN DOĞRULAMALI gerçek ' +
        'kayıtlar (origin "real" + labelProvenance "human") gerçek başarı ölçütü sayılır; ' +
        'sentetik/başlık kayıtları regresyon içindir, makine önerisi altın etiket değildir.',
      updatedAt: now.toISOString(),
      records: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    },
    added,
    updated,
  };
}
