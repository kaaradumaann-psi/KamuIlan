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
import { normalizeTr, collapseWhitespace } from '../domain/text';
import { canonicalFieldKey, type ExpectedFieldValue } from '../evaluation/fields';

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

export const EXPECTED_FIELD_STATUSES = ['present', 'absent', 'ambiguous'] as const;
export const CASE_TAGS = [
  'date-role-confusion',
  'expired-but-real',
  'correction-or-cancellation',
  'multi-province',
  'missing-list-text',
  'neighbour-card-leakage',
  'duplicate-family',
  'other',
] as const;

export const expectedFieldEvidenceSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
    status: z.enum(EXPECTED_FIELD_STATUSES).default('present'),
    /** Resmî kaynaktaki birebir alıntı (kanıt). */
    evidenceQuote: z.string().max(1_000).default(''),
    sourceUrl: z.string().max(2_048).default(''),
    locator: z.string().max(300).default(''),
  })
  .strict();

export const expectedFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
  expectedFieldEvidenceSchema,
]);

export const expectedFieldsSchema = z.record(z.string(), expectedFieldValueSchema).default({});

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
  expectedFields: expectedFieldsSchema,
  /** Resmî kaynaktan alınan zorunlu insan kanıtı (gerçek kayıtlarda). */
  labelEvidence: z
    .object({
      sourceUrl: z.string().max(2_048),
      quote: z.string().max(1_000),
      locator: z.string().max(300).default(''),
    })
    .strict()
    .nullable()
    .default(null),
  /** Etiketleyicinin işaretlediği tuzak senaryoları (ölçüm raporunda ayrıştırılır). */
  caseTags: z.array(z.enum(CASE_TAGS)).default([]),
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
  'kişi labeledBy ve labeledAt yazmadan kayıt içe aktarılmaz. GERÇEK kayıtlar için labelEvidence ' +
  '(resmî URL + birebir alıntı, en az 20 karakter) zorunludur. Alan değeri "yok" ise null, ' +
  'belirsiz ise {value,status:"ambiguous"} yazın; sadece alanları boş bırakmak "yok" demek DEĞİLDİR. ' +
  'Tarihleri YYYY-MM-DD (saat varsa YYYY-MM-DDTHH:mm) olarak verin; yayım, başvuru başlangıcı, ' +
  'son başvuru ve sınav tarihlerini AYRI tutun. Tuzak senaryoları caseTags ile işaretleyin.';

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
        labelEvidence: null,
        caseTags: [],
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
  withLabelEvidence: number;
  coverage: { contentType: ContentType; count: number }[];
  /** Hedef kapsama göre eksik kategoriler (145 kayıt planının izlenebilir hâli). */
  gaps: string[];
  /** Kanonik anahtara çevrilen eski/insan dostu alan adları. */
  aliasNormalizedFields: string[];
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
function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function hostAllowedFor(sourceKey: string, url: URL): boolean {
  const definition = SOURCE_DEFINITIONS.find((source) => source.key === sourceKey);
  return Boolean(definition?.allowedHosts.some((host) => host.toLowerCase() === url.host.toLowerCase()));
}

function canonicalDocumentUrl(value: string): string | null {
  const url = parseHttpsUrl(value);
  if (!url) return null;
  return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
}

function normalizeExpectedFields(raw: Record<string, unknown>): {
  fields: Record<string, ExpectedFieldValue>;
  unknown: string[];
  aliases: string[];
  invalid: string[];
} {
  const fields: Record<string, ExpectedFieldValue> = {};
  const unknown: string[] = [];
  const aliases: string[] = [];
  const invalid: string[] = [];
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = canonicalFieldKey(rawKey);
    if (!key) {
      unknown.push(rawKey);
      continue;
    }
    if (key !== rawKey) aliases.push(rawKey);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const structured = value as { status?: string; value?: unknown };
      if (structured.status === 'present' && (structured.value === null || structured.value === '' || (Array.isArray(structured.value) && structured.value.length === 0))) {
        invalid.push(rawKey);
        continue;
      }
    }
    fields[key] = value as ExpectedFieldValue;
  }
  return { fields, unknown, aliases, invalid };
}

/**
 * Doldurulmuş sayfayı doğrular ve `labeled-set.json` kayıtlarına dönüştürür.
 *
 * Ret nedenleri (kayıt içe alınmaz):
 *  - `expectedContentType` boş;
 *  - `labelProvenance` 'human' değil ya da `labeledBy`/`labeledAt` yok (makine
 *    önerisi altın etiket olamaz);
 *  - `origin: 'real'` ama kaynak envanterinde olmayan bir kaynak (kanıtsız gerçek iddiası);
 *  - `origin: 'real'` ama resmî URL kaynağın allowlist host'unda değil;
 *  - `origin: 'real'` ama `labelEvidence` (URL + >=20 karakter alıntı) yok;
 *  - bilinmeyen `expectedFields` anahtarı (sessizce ölçüm dışı bırakmak yerine reddet);
 *  - aynı kaynak + başlık + kurum ya da aynı resmî belge URL'si (duplicate leakage).
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
  const seenFamilies = new Map<string, string>();
  const seenDocuments = new Map<string, string>();
  const aliasNormalizedFields = new Set<string>();

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
    if (!Number.isFinite(Date.parse(record.labeledAt))) {
      rejected.push({ id: record.id, reason: 'labeledAt geçerli bir tarih değil' });
      continue;
    }

    const normalizedFields = normalizeExpectedFields(record.expectedFields as Record<string, unknown>);
    if (normalizedFields.unknown.length > 0) {
      rejected.push({
        id: record.id,
        reason: `bilinmeyen expectedFields anahtarı: ${normalizedFields.unknown.join(', ')}`,
      });
      continue;
    }
    if (normalizedFields.invalid.length > 0) {
      rejected.push({
        id: record.id,
        reason: `status "present" ama değeri boş: ${normalizedFields.invalid.join(', ')}`,
      });
      continue;
    }
    for (const alias of normalizedFields.aliases) aliasNormalizedFields.add(alias);

    if (record.origin === 'real') {
      if (!record.sourceKey || !REAL_SOURCES.has(record.sourceKey)) {
        rejected.push({ id: record.id, reason: "gerçek kayıt envanterde olmayan/boş bir sourceKey taşıyor" });
        continue;
      }
      const url = parseHttpsUrl(record.url);
      if (!url || !hostAllowedFor(record.sourceKey, url)) {
        rejected.push({ id: record.id, reason: `resmî URL ${record.sourceKey} kaynağının allowlist host'unda değil` });
        continue;
      }
      if (!record.labelEvidence) {
        rejected.push({ id: record.id, reason: 'gerçek kayıt için labelEvidence (kaynak URL + alıntı) zorunlu' });
        continue;
      }
      const evidenceUrl = parseHttpsUrl(record.labelEvidence.sourceUrl);
      if (!evidenceUrl || !hostAllowedFor(record.sourceKey, evidenceUrl)) {
        rejected.push({ id: record.id, reason: 'labelEvidence.sourceUrl resmî kaynak host’unda değil' });
        continue;
      }
      if (canonicalDocumentUrl(record.url) !== canonicalDocumentUrl(record.labelEvidence.sourceUrl)) {
        rejected.push({ id: record.id, reason: 'labelEvidence.sourceUrl ile kayıt URL’si aynı belgeyi göstermiyor' });
        continue;
      }
      if (collapseWhitespace(record.labelEvidence.quote).length < 20) {
        rejected.push({ id: record.id, reason: 'labelEvidence.quote en az 20 karakterlik birebir alıntı olmalı' });
        continue;
      }
    }

    const familyKey = [normalizeTr(record.title), normalizeTr(record.institution ?? ''), record.sourceKey ?? ''].join('|');
    const documentKey = canonicalDocumentUrl(record.url);
    const duplicateOf = seenFamilies.get(familyKey) ?? (documentKey ? seenDocuments.get(documentKey) : undefined);
    if (duplicateOf) {
      rejected.push({ id: record.id, reason: `yinelenen kayıt/ilan ailesi: ${duplicateOf}` });
      continue;
    }
    seenFamilies.set(familyKey, record.id);
    if (documentKey) seenDocuments.set(documentKey, record.id);

    records.push({
      id: record.id,
      origin: record.origin,
      title: record.title,
      sourceCategory: record.sourceCategory ?? '',
      bodyKind: record.machineSuggestion.contentType === 'personnel_recruitment' ? 'recruitment' : 'news',
      expectedContentType: record.expectedContentType,
      ...(record.bodyCompleteness === 'captured' && record.bodyExcerpt.length >= 200
        ? { body: record.bodyExcerpt }
        : {}),
      sourceKey: record.sourceKey,
      labelProvenance: record.labelProvenance === 'machine' ? 'machine' : 'human',
      labelVerifiedBy: record.labeledBy,
      labeledAt: record.labeledAt,
      url: record.url,
      ...(Object.keys(normalizedFields.fields).length > 0 ? { expectedFields: normalizedFields.fields } : {}),
      ...(record.labelEvidence ? { labelEvidence: record.labelEvidence } : {}),
      caseTags: record.caseTags,
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
      withLabelEvidence: records.filter((record) => record.labelEvidence).length,
      coverage: counts,
      gaps,
      aliasNormalizedFields: [...aliasNormalizedFields].sort(),
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
  expectedFields?: Record<string, ExpectedFieldValue>;
  labelEvidence?: { sourceUrl: string; quote: string; locator?: string } | null;
  caseTags?: readonly string[];
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
