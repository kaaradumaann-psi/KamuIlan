/**
 * Alan çıkarımı değerlendirmesi (saf fonksiyonlar).
 *
 * Dürüstlük kuralları:
 *  - Yüzdeler yalnızca İNSAN doğrulamalı `origin: "real"` kayıtlardan üretilir.
 *  - Sentetik/şartname kayıtları asla başarı oranına katılmaz; ayrı sayılır.
 *  - Gövdesi olmayan (yalnızca başlık) kayıtlar alan doğruluğu için ölçülemez ve
 *    rapor bunu `unscorable` altında açıkça söyler.
 *  - Alan başına destek eşiğin altındaysa oran `null` döner (uydurma yüzde yok).
 *  - Her gerçek alan için çıkarımın kanıtı kaynak metinde aranır; bulunamayan
 *    kanıt "desteksiz olgu" olarak sayılır (liste sayfasından gelen alanlar ayrı
 *    sınıflandırılır).
 */
import { createHash } from 'node:crypto';
import { EXTRACTION_VERSION } from '../config/app';
import { normalizeTr, collapseWhitespace } from '../domain/text';
import { parseTurkishDate } from '../domain/dates';
import type { ExtractedJob } from '../extraction/engine';
import {
  canonicalFieldKey,
  EXTRACTION_FIELD_DEFINITIONS,
  fieldDefinition,
  type ExpectedFieldStatus,
  type ExpectedFieldValue,
  type ExtractionFieldDefinition,
  type ExtractionFieldKind,
} from './fields';

export const EXTRACTION_EVALUATOR_VERSION = '2026.10.1';
export const MIN_REAL_RECORDS_FOR_METRICS = 30;
export const MIN_FIELD_SUPPORT = 5;

export interface ExtractionEvalRecord {
  id: string;
  origin: 'real' | 'synthetic' | 'spec-title';
  labelProvenance?: 'human' | 'machine' | 'spec';
  title: string;
  body?: string;
  sourceKey?: string | null;
  expectedContentType?: string | null;
  expectedFields?: Record<string, ExpectedFieldValue>;
  labelEvidence?: { sourceUrl: string; quote: string; locator?: string } | null;
}

interface CanonicalValue {
  presence: 'present' | 'absent' | 'ambiguous' | 'invalid';
  exact: string;
  normalized: string;
  tokens: string[];
  dateOnly: string | null;
  time: string | null;
  count: number | null;
  anyAttachment: boolean;
  pdfAttachment: boolean;
}

const EMPTY_CANONICAL: CanonicalValue = {
  presence: 'absent',
  exact: '',
  normalized: '',
  tokens: [],
  dateOnly: null,
  time: null,
  count: null,
  anyAttachment: false,
  pdfAttachment: false,
};

function unwrap(value: ExpectedFieldValue): { raw: ExpectedFieldValue; status: ExpectedFieldStatus } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { raw: value.value, status: value.status ?? 'present' };
  }
  return { raw: value, status: rawIsAbsent(value) ? 'absent' : 'present' };
}

function rawIsAbsent(value: ExpectedFieldValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return normalizeTr(value);
  }
}

export function normalizeDateValue(value: string): { dateOnly: string; time: string | null } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/.exec(value.trim());
  if (iso?.[1] && iso[2] && iso[3]) {
    return { dateOnly: `${iso[1]}-${iso[2]}-${iso[3]}`, time: iso[4] && iso[5] ? `${iso[4]}:${iso[5]}` : null };
  }
  const parsed = parseTurkishDate(value);
  return parsed ? { dateOnly: parsed.dateOnly, time: parsed.time } : null;
}

function canonicalExpected(field: ExtractionFieldDefinition, value: ExpectedFieldValue): CanonicalValue {
  const { raw, status } = unwrap(value);
  if (status === 'absent') return { ...EMPTY_CANONICAL };
  if (status === 'ambiguous') return { ...EMPTY_CANONICAL, presence: 'ambiguous' };
  if (rawIsAbsent(raw)) return { ...EMPTY_CANONICAL, presence: 'invalid' };
  return canonicalValue(field, raw as string | number | boolean | string[]);
}

function canonicalActual(field: ExtractionFieldDefinition, value: unknown): CanonicalValue {
  if (value === null || value === undefined) return { ...EMPTY_CANONICAL };
  if (typeof value === 'string' && value.trim().length === 0) return { ...EMPTY_CANONICAL };
  if (Array.isArray(value) && value.length === 0) return { ...EMPTY_CANONICAL };
  if (field.key === 'employmentType' && value === 'belirsiz') return { ...EMPTY_CANONICAL };
  return canonicalValue(field, value as string | number | boolean | string[] | Array<{ url: string; kind: string }>);
}

function canonicalValue(
  field: ExtractionFieldDefinition,
  value: string | number | boolean | string[] | Array<{ url: string; kind: string }>,
): CanonicalValue {
  switch (field.kind) {
    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) return { ...EMPTY_CANONICAL, presence: 'invalid' };
      return { ...EMPTY_CANONICAL, presence: 'present', exact: String(value).trim(), normalized: String(numeric), count: numeric };
    }
    case 'list': {
      const values = Array.isArray(value) ? value.map(String) : String(value).split(/[,;|]/u);
      const cleaned = values.map((item) => collapseWhitespace(item)).filter((item) => item.length > 0);
      if (cleaned.length === 0) return { ...EMPTY_CANONICAL };
      return {
        ...EMPTY_CANONICAL,
        presence: 'present',
        exact: cleaned.join(' | '),
        normalized: cleaned.map((item) => normalizeTr(item)).sort().join(' | '),
        tokens: cleaned.map((item) => normalizeTr(item)),
      };
    }
    case 'date':
    case 'datetime': {
      const parsed = normalizeDateValue(String(value));
      if (!parsed) return { ...EMPTY_CANONICAL, presence: 'invalid' };
      return {
        ...EMPTY_CANONICAL,
        presence: 'present',
        exact: String(value).trim(),
        normalized: parsed.time ? `${parsed.dateOnly}T${parsed.time}` : parsed.dateOnly,
        dateOnly: parsed.dateOnly,
        time: field.kind === 'datetime' ? parsed.time : null,
      };
    }
    case 'url': {
      const raw = String(value).trim();
      return { ...EMPTY_CANONICAL, presence: 'present', exact: raw, normalized: normalizeUrl(raw) };
    }
    case 'attachments': {
      if (typeof value === 'boolean') {
        return value
          ? { ...EMPTY_CANONICAL, presence: 'present', normalized: 'herhangi-bir-ek', anyAttachment: true }
          : { ...EMPTY_CANONICAL };
      }
      if (typeof value === 'number') {
        return { ...EMPTY_CANONICAL, presence: 'present', normalized: `adet:${value}`, count: value };
      }
      const list = Array.isArray(value) ? value : [String(value)];
      const urls = list
        .map((item) => (typeof item === 'string' ? item : item.url))
        .filter((item): item is string => typeof item === 'string' && item.length > 0);
      const kinds = Array.isArray(value)
        ? value
            .map((item) => (typeof item === 'string' ? '' : item.kind))
            .filter((kind): kind is string => typeof kind === 'string')
        : [];
      const looksLikePdfText = list.some((item) => typeof item === 'string' && /^pdf$/i.test(item.trim()));
      const pdf = kinds.includes('pdf') || looksLikePdfText;
      const tokens = urls.map((url) => normalizeUrl(url)).sort();
      if (tokens.length === 0 && !pdf) {
        return { ...EMPTY_CANONICAL, presence: 'invalid' };
      }
      return {
        ...EMPTY_CANONICAL,
        presence: 'present',
        exact: urls.join(' | '),
        normalized: tokens.join(' | ') || (pdf ? 'pdf' : ''),
        tokens,
        pdfAttachment: pdf,
        count: urls.length,
      };
    }
    default: {
      const raw = String(value).trim();
      return { ...EMPTY_CANONICAL, presence: 'present', exact: raw, normalized: normalizeTr(raw), tokens: [normalizeTr(raw)] };
    }
  }
}

/** Alan türüne göre eşleşme; `exact` ham, `normalized` anlamlı karşılaştırma. */
export function compareFieldValues(
  field: ExtractionFieldDefinition,
  expected: ExpectedFieldValue,
  actual: unknown,
): { status: CanonicalValue['presence'] | 'invalid'; exact: boolean; normalized: boolean } {
  const left = canonicalExpected(field, expected);
  const right = canonicalActual(field, actual);
  if (left.presence !== 'present' || right.presence !== 'present') {
    return { status: left.presence, exact: false, normalized: false };
  }
  if (field.kind === 'attachments') {
    let normalized = false;
    if (left.anyAttachment) normalized = right.presence === 'present';
    else if (left.pdfAttachment) normalized = right.pdfAttachment;
    else if (left.count !== null) normalized = right.count === left.count;
    else normalized = left.tokens.every((token) => right.tokens.includes(token));
    return { status: 'present', exact: left.exact === right.exact, normalized };
  }
  if (field.kind === 'date' || field.kind === 'datetime') {
    const sameDate = left.dateOnly === right.dateOnly;
    const normalized = left.time ? sameDate && left.time === right.time : sameDate;
    return { status: 'present', exact: left.exact === right.exact, normalized };
  }
  if (field.kind === 'list') {
    const exact = left.exact === right.exact;
    // Alt-dize eşleşmesi YANLIŞ pozitif üretiyordu: "lisans" ⊂ "lisansüstü".
    // Bu yüzden liste karşılaştırması normalize edilmiş token KÜMELERİNİN
    // eşitliğidir; fazladan/eksik öğe varsa alan yanlış sayılır.
    const normalized = left.normalized === right.normalized;
    return { status: 'present', exact, normalized };
  }
  return { status: 'present', exact: left.exact === right.exact, normalized: left.normalized === right.normalized };
}

export interface FieldMetric {
  key: string;
  label: string;
  kind: ExtractionFieldKind;
  /** Beklenen değeri etiketlenmiş kayıt sayısı (ambiguous dahil). */
  support: number;
  expectedPresent: number;
  expectedAbsent: number;
  ambiguous: number;
  invalidLabels: number;
  actualPresent: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  missed: number;
  hallucinated: number;
  valueMismatch: number;
  exactCorrect: number;
  normalizedCorrect: number;
  evidenceChecked: number;
  evidenceValid: number;
  evidenceMissing: number;
  evidenceInvalid: number;
  evidenceListingUnverified: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  fillRate: number | null;
  exactAccuracy: number | null;
  normalizedAccuracy: number | null;
  ratesSuppressed: boolean;
}

export interface BreakdownMetric {
  key: string;
  records: number;
  scorable: number;
  expectedFields: number;
  correctFields: number;
  evidenceInvalid: number;
}

export interface ExtractionEvalReport {
  schemaVersion: 1;
  evaluatorVersion: string;
  extractionVersion: string;
  generatedAt: string;
  commit: string | null;
  datasetHash: string;
  status: 'MEASURED' | 'INSUFFICIENT DATA';
  llm: null;
  networkCalls: 0;
  config: {
    mode: 'rules-only';
    bodyRequired: true;
    minRealRecords: number;
    minFieldSupport: number;
  };
  counts: {
    total: number;
    real: number;
    realHuman: number;
    realScorable: number;
    synthetic: number;
    specTitle: number;
    withLabelEvidence: number;
  };
  unscorable: {
    noBody: number;
    shortBody: number;
    noExpectedFields: number;
    nonHuman: number;
    ambiguousFields: number;
    invalidLabels: number;
  };
  fields: FieldMetric[];
  fieldCoverage: {
    dictionary: number;
    labeled: number;
    unlabeledKeys: string[];
  };
  overall: {
    expectedFields: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    macroF1: number | null;
  };
  evidence: {
    checkedFacts: number;
    valid: number;
    missing: number;
    invalid: number;
    listingUnverified: number;
  };
  dateChecks: {
    roleConfusions: number;
    consistencyIssues: number;
  };
  bySource: BreakdownMetric[];
  byContentType: BreakdownMetric[];
  limitations: string[];
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[cyclic]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key], seen)}`);
  return `{${entries.join(',')}}`;
}

export function hashDataset(records: unknown): string {
  return createHash('sha256').update(stableJson(records)).digest('hex');
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function evidenceKind(actual: ExtractedJob, key: string): 'listing' | 'other' | null {
  const source = actual.fieldSources[key];
  if (!source) return null;
  return source.kind === 'listing' ? 'listing' : 'other';
}

export function evaluateExtraction(
  records: readonly ExtractionEvalRecord[],
  options: {
    extractor?: (input: { title: string; body?: string | null }) => ExtractedJob;
    now?: Date;
    commit?: string | null;
    minRealRecords?: number;
    minFieldSupport?: number;
  } = {},
): ExtractionEvalReport {
  if (!options.extractor) {
    throw new Error('evaluateExtraction için bir extractor gerekir (varsayılan motordan bağımsız test edilebilirlik).');
  }
  const extractor = options.extractor;
  const now = options.now ?? new Date();
  const minRealRecords = options.minRealRecords ?? MIN_REAL_RECORDS_FOR_METRICS;
  const minFieldSupport = options.minFieldSupport ?? MIN_FIELD_SUPPORT;

  const realHuman = records.filter(
    (record) => record.origin === 'real' && record.labelProvenance === 'human' && record.expectedContentType,
  );
  const scorable = realHuman.filter(
    (record) =>
      typeof record.body === 'string' &&
      record.body.trim().length >= 200 &&
      Object.keys(record.expectedFields ?? {}).length > 0,
  );
  const shortBody = realHuman.filter(
    (record) => typeof record.body === 'string' && record.body.trim().length > 0 && record.body.trim().length < 200,
  ).length;

  const metrics = new Map<string, FieldMetric>();
  for (const field of EXTRACTION_FIELD_DEFINITIONS) {
    metrics.set(field.key, {
      key: field.key,
      label: field.label,
      kind: field.kind,
      support: 0,
      expectedPresent: 0,
      expectedAbsent: 0,
      ambiguous: 0,
      invalidLabels: 0,
      actualPresent: 0,
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
      missed: 0,
      hallucinated: 0,
      valueMismatch: 0,
      exactCorrect: 0,
      normalizedCorrect: 0,
      evidenceChecked: 0,
      evidenceValid: 0,
      evidenceMissing: 0,
      evidenceInvalid: 0,
      evidenceListingUnverified: 0,
      precision: null,
      recall: null,
      f1: null,
      fillRate: null,
      exactAccuracy: null,
      normalizedAccuracy: null,
      ratesSuppressed: true,
    });
  }

  const breakdown = {
    source: new Map<string, BreakdownMetric>(),
    contentType: new Map<string, BreakdownMetric>(),
  };
  const bump = (
    map: Map<string, BreakdownMetric>,
    key: string,
    patch: { scorable?: boolean; expectedFields?: number; correctFields?: number; evidenceInvalid?: boolean },
  ): void => {
    const current = map.get(key) ?? { key, records: 0, scorable: 0, expectedFields: 0, correctFields: 0, evidenceInvalid: 0 };
    current.records += 1;
    if (patch.scorable) current.scorable += 1;
    if (patch.expectedFields) current.expectedFields += patch.expectedFields;
    if (patch.correctFields) current.correctFields += patch.correctFields;
    if (patch.evidenceInvalid) current.evidenceInvalid += 1;
    map.set(key, current);
  };

  let roleConfusions = 0;
  let consistencyIssues = 0;
  const evidenceTotals = { checked: 0, valid: 0, missing: 0, invalid: 0, listingUnverified: 0 };
  let ambiguousFields = 0;
  let invalidLabels = 0;

  for (const record of scorable) {
    const actual = extractor({ title: record.title, body: record.body ?? null });
    const sourceText = normalizeTr(`${record.title}\n${record.body ?? ''}`);
    let expectedFieldCount = 0;
    let correctFieldCount = 0;
    let recordEvidenceInvalid = 0;

    const expectedMap = new Map<string, ExpectedFieldValue>();
    for (const [rawKey, expected] of Object.entries(record.expectedFields ?? {})) {
      const key = canonicalFieldKey(rawKey);
      if (key) expectedMap.set(key, expected);
    }

    const dateRole = (key: string): string | null => {
      const expected = expectedMap.get(key);
      if (expected === undefined) return null;
      const canonical = canonicalExpected(fieldDefinition(key)!, expected);
      return canonical.presence === 'present' ? canonical.dateOnly : null;
    };
    const expectedPublished = dateRole('publishedAt');
    const expectedEnd = dateRole('applicationEndAt');
    const actualPublished = normalizeDateValue(actual.publishedAt ?? '')?.dateOnly ?? null;
    const actualStart = normalizeDateValue(actual.applicationStartAt ?? '')?.dateOnly ?? null;
    const actualEnd = normalizeDateValue(actual.applicationEndAt ?? '')?.dateOnly ?? null;
    if (expectedPublished && (actualStart === expectedPublished || actualEnd === expectedPublished)) roleConfusions += 1;
    if (expectedEnd && actualPublished === expectedEnd) roleConfusions += 1;
    if (actualStart && actualEnd && actualEnd < actualStart) consistencyIssues += 1;
    if (actualPublished && actualEnd && actualPublished > actualEnd) consistencyIssues += 1;

    for (const [key, expected] of expectedMap) {
      const field = fieldDefinition(key);
      if (!field) continue;
      const metric = metrics.get(key)!;
      expectedFieldCount += 1;
      const canonical = canonicalExpected(field, expected);
      if (canonical.presence === 'ambiguous') {
        metric.ambiguous += 1;
        ambiguousFields += 1;
        continue;
      }
      if (canonical.presence === 'invalid') {
        metric.invalidLabels += 1;
        invalidLabels += 1;
        continue;
      }
      metric.support += 1;
      const actualValue = (actual as unknown as Record<string, unknown>)[key];
      const actualCanonical = canonicalActual(field, actualValue);
      const actualPresent = actualCanonical.presence === 'present';
      if (actualPresent) metric.actualPresent += 1;
      if (canonical.presence === 'present') metric.expectedPresent += 1;
      else metric.expectedAbsent += 1;

      const comparison = compareFieldValues(field, expected, actualValue);
      let correct = false;
      if (canonical.presence === 'present') {
        if (actualPresent) {
          if (comparison.normalized) {
            metric.truePositive += 1;
            metric.normalizedCorrect += 1;
            correct = true;
          } else {
            metric.valueMismatch += 1;
            metric.falsePositive += 1;
            metric.falseNegative += 1;
          }
        } else {
          metric.missed += 1;
          metric.falseNegative += 1;
        }
      } else if (actualPresent) {
        metric.hallucinated += 1;
        metric.falsePositive += 1;
      } else {
        // Doğrulanmış yokluk doğru tahmin: TP/FP/FN'ye katılmaz.
        correct = true;
      }
      if (correct) correctFieldCount += 1;
      if (comparison.exact && canonical.presence === 'present' && actualPresent) metric.exactCorrect += 1;

    }

    // Kanıt denetimi ETİKETTEN BAĞIMSIZ yapılır: çıkarımın ürettiği her olgu
    // (etiketlenmemiş alanlar dahil) için kaynak metinde kanıt aranır.
    for (const field of EXTRACTION_FIELD_DEFINITIONS) {
      const actualCanonical = canonicalActual(field, (actual as unknown as Record<string, unknown>)[field.key]);
      if (actualCanonical.presence !== 'present') continue;
      const metric = metrics.get(field.key)!;
      const quote = actual.evidence[field.key] ?? '';
      metric.evidenceChecked += 1;
      evidenceTotals.checked += 1;
      if (quote && sourceText.includes(normalizeTr(quote))) {
        metric.evidenceValid += 1;
        evidenceTotals.valid += 1;
      } else if (!quote) {
        metric.evidenceMissing += 1;
        evidenceTotals.missing += 1;
      } else if (evidenceKind(actual, field.key) === 'listing') {
        metric.evidenceListingUnverified += 1;
        evidenceTotals.listingUnverified += 1;
      } else {
        metric.evidenceInvalid += 1;
        evidenceTotals.invalid += 1;
        recordEvidenceInvalid += 1;
      }
    }

    if (record.sourceKey) {
      bump(breakdown.source, record.sourceKey, {
        scorable: true,
        expectedFields: expectedFieldCount,
        correctFields: correctFieldCount,
        evidenceInvalid: recordEvidenceInvalid > 0,
      });
    }
    if (record.expectedContentType) {
      bump(breakdown.contentType, record.expectedContentType, {
        scorable: true,
        expectedFields: expectedFieldCount,
        correctFields: correctFieldCount,
        evidenceInvalid: recordEvidenceInvalid > 0,
      });
    }
  }

  const fields: FieldMetric[] = [...metrics.values()].filter((metric) => metric.support > 0);
  for (const metric of fields) {
    const suppressed = metric.support < minFieldSupport;
    metric.ratesSuppressed = suppressed;
    if (suppressed) continue;
    metric.precision = rate(metric.truePositive, metric.truePositive + metric.falsePositive);
    metric.recall = rate(metric.truePositive, metric.truePositive + metric.falseNegative);
    metric.f1 =
      metric.precision !== null && metric.recall !== null && metric.precision + metric.recall > 0
        ? (2 * metric.precision * metric.recall) / (metric.precision + metric.recall)
        : metric.precision !== null && metric.recall !== null
          ? 0
          : null;
    metric.fillRate = rate(metric.actualPresent, metric.support);
    metric.exactAccuracy = rate(metric.exactCorrect, metric.expectedPresent);
    metric.normalizedAccuracy = rate(metric.normalizedCorrect, metric.expectedPresent);
  }

  const measured = scorable.length >= minRealRecords;
  // Genel oran yalnızca alan bazında destek eşiğini geçen alanlardan üretilir;
  // aksi hâlde 1-2 etiketli alan genel P/R'yi sessizce domine ederdi.
  const overall = fields
    .filter((metric) => !metric.ratesSuppressed)
    .reduce(
    (acc, metric) => {
      acc.expectedFields += metric.support;
      acc.truePositive += metric.truePositive;
      acc.falsePositive += metric.falsePositive;
      acc.falseNegative += metric.falseNegative;
      return acc;
    },
    { expectedFields: 0, truePositive: 0, falsePositive: 0, falseNegative: 0 },
  );
  const f1Values = fields.filter((metric) => !metric.ratesSuppressed && metric.f1 !== null).map((metric) => metric.f1!);
  // Hiçbir alan destek eşiğini geçmiyorsa genel oran da ÜRETİLMEZ: az sayıda
  // etiketten türetilen "genel başarı" yanıltıcı olur.
  const overallMeasured = measured && f1Values.length > 0;
  const macroF1 = f1Values.length > 0 ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length : null;

  return {
    schemaVersion: 1,
    evaluatorVersion: EXTRACTION_EVALUATOR_VERSION,
    extractionVersion: EXTRACTION_VERSION,
    generatedAt: now.toISOString(),
    commit: options.commit ?? null,
    datasetHash: hashDataset(records),
    status: overallMeasured ? 'MEASURED' : 'INSUFFICIENT DATA',
    llm: null,
    networkCalls: 0,
    config: { mode: 'rules-only', bodyRequired: true, minRealRecords, minFieldSupport },
    counts: {
      total: records.length,
      real: records.filter((record) => record.origin === 'real').length,
      realHuman: realHuman.length,
      realScorable: scorable.length,
      synthetic: records.filter((record) => record.origin === 'synthetic').length,
      specTitle: records.filter((record) => record.origin === 'spec-title').length,
      withLabelEvidence: realHuman.filter((record) => (record.labelEvidence?.quote ?? '').trim().length > 0).length,
    },
    unscorable: {
      noBody: realHuman.filter((record) => !record.body).length,
      shortBody,
      noExpectedFields: realHuman.filter((record) => Object.keys(record.expectedFields ?? {}).length === 0).length,
      nonHuman: records.filter(
        (record) => record.origin === 'real' && record.labelProvenance !== 'human',
      ).length,
      ambiguousFields,
      invalidLabels,
    },
    fields,
    fieldCoverage: {
      dictionary: EXTRACTION_FIELD_DEFINITIONS.length,
      labeled: fields.length,
      unlabeledKeys: EXTRACTION_FIELD_DEFINITIONS.filter((field) => !fields.some((metric) => metric.key === field.key)).map(
        (field) => field.key,
      ),
    },
    overall: {
      ...overall,
      precision: overallMeasured ? rate(overall.truePositive, overall.truePositive + overall.falsePositive) : null,
      recall: overallMeasured ? rate(overall.truePositive, overall.truePositive + overall.falseNegative) : null,
      f1:
        overallMeasured && overall.truePositive + overall.falsePositive > 0 && overall.truePositive + overall.falseNegative > 0
          ? (2 * overall.truePositive) /
            (2 * overall.truePositive + overall.falsePositive + overall.falseNegative)
          : null,
      macroF1: overallMeasured ? macroF1 : null,
    },
    evidence: {
      checkedFacts: evidenceTotals.checked,
      valid: evidenceTotals.valid,
      missing: evidenceTotals.missing,
      invalid: evidenceTotals.invalid,
      listingUnverified: evidenceTotals.listingUnverified,
    },
    dateChecks: { roleConfusions, consistencyIssues },
    bySource: [...breakdown.source.values()].sort((a, b) => b.records - a.records),
    byContentType: [...breakdown.contentType.values()].sort((a, b) => b.records - a.records),
    limitations: [
      'Yüzdeler yalnızca insan doğrulamalı, gövdesi tam (>=200 karakter) gerçek kayıtlardan üretilir.',
      `Genel ölçüm için en az ${minRealRecords} gerçek kayıt gerekir; alan başına en az ${minFieldSupport} etiket altında oran gizlenir.`,
      'Sentetik/şartname kayıtları hiçbir başarı oranına katılmaz.',
      'Liste sayfasından gelen alanların kanıtı başlık/gövde metninde bulunmayabilir; bunlar ayrı sayılır.',
    ],
  };
}
