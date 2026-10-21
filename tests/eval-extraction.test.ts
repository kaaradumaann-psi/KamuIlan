import { describe, expect, it } from 'vitest';
import {
  compareFieldValues,
  evaluateExtraction,
  hashDataset,
  normalizeDateValue,
  type ExtractionEvalRecord,
} from '../src/evaluation/extraction';
import { fieldDefinition } from '../src/evaluation/fields';
import type { ExtractedJob } from '../src/extraction/engine';

const BODY =
  'Örnek Bakanlığı taşra teşkilatında istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. ' +
  'Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında e-Devlet üzerinden yapılacaktır. ' +
  'KPSS P3 puan türünde en az 70 puan aranır. Lisans mezunu olmak şartı vardır.';

function extracted(overrides: Partial<ExtractedJob> = {}): ExtractedJob {
  return {
    institution: 'Örnek Bakanlığı',
    unit: null,
    employmentType: 'sozlesmeli',
    city: null,
    district: null,
    quota: 5,
    applicationStartAt: '2026-10-01T00:00:00+03:00',
    applicationEndAt: '2026-10-30T00:00:00+03:00',
    applicationEndDate: '2026-10-30',
    publishedAt: '2026-09-20',
    applicationUrl: null,
    applicationMethod: 'e-Devlet',
    referenceNo: null,
    cadreStatus: null,
    titles: [],
    openings: [],
    educationLevels: ['lisans'],
    departments: [],
    kpssScoreTypes: ['P3'],
    kpssMinScore: 70,
    kpssYear: null,
    qualificationCodes: [],
    minAge: null,
    maxAge: null,
    certificates: [],
    minExperienceYears: null,
    foreignLanguages: [],
    specialConditions: [],
    attachments: [],
    fieldSources: {},
    evidence: {},
    uncertainties: [],
    confidence: 0.7,
    version: 'test',
    ...overrides,
  };
}

function record(overrides: Partial<ExtractionEvalRecord> = {}): ExtractionEvalRecord {
  return {
    id: 'rec-1',
    origin: 'real',
    labelProvenance: 'human',
    title: 'Örnek Bakanlığı personel alımı',
    body: BODY,
    sourceKey: 'resmigazete-cestili-ilanlar',
    expectedContentType: 'personnel_recruitment',
    expectedFields: {
      institution: 'Örnek Bakanlığı',
      quota: 5,
      applicationStartAt: '2026-10-01',
      applicationEndAt: '2026-10-30',
      kpssScoreTypes: ['P3'],
      educationLevels: ['Lisans'],
    },
    labelEvidence: { sourceUrl: 'https://www.resmigazete.gov.tr/x.htm', quote: BODY.slice(0, 60) },
    ...overrides,
  };
}

const baseOptions = {
  extractor: () => extracted(),
  now: new Date('2026-10-17T00:00:00Z'),
  minRealRecords: 2,
  minFieldSupport: 2,
};

describe('normalizeDateValue', () => {
  it('ISO ve Türkçe tarihleri aynı güne indirger', () => {
    expect(normalizeDateValue('2026-10-01T10:30:00+03:00')).toEqual({ dateOnly: '2026-10-01', time: '10:30' });
    expect(normalizeDateValue('1 Ekim 2026')).toEqual({ dateOnly: '2026-10-01', time: null });
    expect(normalizeDateValue('30.10.2026 17:00')).toEqual({ dateOnly: '2026-10-30', time: '17:00' });
    expect(normalizeDateValue('geçersiz')).toBeNull();
  });
});

describe('compareFieldValues', () => {
  it('metinde büyük/küçük harf ve Türkçe karakter farkını normalize eder', () => {
    const field = fieldDefinition('city')!;
    expect(compareFieldValues(field, 'ANKARA', 'Ankara')).toMatchObject({ normalized: true, exact: false });
  });

  it('tarihte saat yalnızca beklentide varsa karşılaştırılır', () => {
    const field = fieldDefinition('applicationEndAt')!;
    expect(compareFieldValues(field, '2026-10-30', '2026-10-30T17:00:00+03:00').normalized).toBe(true);
    expect(compareFieldValues(field, '2026-10-30T17:00', '2026-10-30T09:00:00+03:00').normalized).toBe(false);
  });

  it('liste alanında sıra ve ek biçim farkı normalize sayılır', () => {
    const field = fieldDefinition('educationLevels')!;
    expect(compareFieldValues(field, ['Lisans', 'Ön lisans'], ['ön lisans', 'lisans']).normalized).toBe(true);
    expect(compareFieldValues(field, ['Lisans'], ['doktora']).normalized).toBe(false);
  });

  it('yok/boş değerleri ayırır', () => {
    const field = fieldDefinition('quota')!;
    expect(compareFieldValues(field, null, 5).status).toBe('absent');
    expect(compareFieldValues(field, 5, null).status).toBe('present');
  });
});

describe('evaluateExtraction', () => {
  it('insan etiketi yokken INSUFFICIENT DATA üretir ve yüzde vermez', () => {
    const report = evaluateExtraction([record({ origin: 'spec-title', labelProvenance: 'spec', expectedFields: {} })], baseOptions);
    expect(report.status).toBe('INSUFFICIENT DATA');
    expect(report.counts.realHuman).toBe(0);
    expect(report.fields).toHaveLength(0);
    expect(report.overall.precision).toBeNull();
  });

  it('gövdesi kısa/olmayan gerçek kayıt ölçüm dışıdır', () => {
    const report = evaluateExtraction([record({ body: 'kısa' })], baseOptions);
    expect(report.counts.realScorable).toBe(0);
    expect(report.unscorable.shortBody).toBe(1);
    expect(report.status).toBe('INSUFFICIENT DATA');
  });

  it('doğru, kaçırılan, uydurulan ve yanlış değeri ayrı sayar', () => {
    const records: ExtractionEvalRecord[] = [
      record(),
      record({
        id: 'rec-2',
        title: 'İkinci ilan',
        expectedFields: { district: null, city: 'Ankara' },
      }),
    ];
    const report = evaluateExtraction(records, {
      ...baseOptions,
      extractor: () => extracted({ city: 'İzmir', district: 'Çankaya' }),
    });
    const city = report.fields.find((field) => field.key === 'city')!;
    expect(city.expectedPresent).toBe(1);
    expect(city.valueMismatch).toBe(1);
    expect(city.falsePositive).toBe(1);
    const district = report.fields.find((field) => field.key === 'district')!;
    expect(district.expectedAbsent).toBe(1);
    expect(district.hallucinated).toBe(1);
    const quota = report.fields.find((field) => field.key === 'quota')!;
    expect(quota.support).toBe(1);
    expect(quota.truePositive).toBe(1);
    expect(report.dateChecks.roleConfusions).toBe(0);
  });

  it('eksik alanı kaçırma olarak sayar (P/R/F1)', () => {
    const report = evaluateExtraction([record(), record({ id: 'rec-2', title: 'İkinci' })], {
      ...baseOptions,
      extractor: () => extracted({ quota: null }),
    });
    const quota = report.fields.find((field) => field.key === 'quota')!;
    expect(quota.missed).toBe(2);
    expect(quota.recall).toBe(0);
    expect(report.status).toBe('MEASURED');
  });

  it('kanıtı kaynak metinde doğrular; uydurma kanıtı ayrı sayar', () => {
    const valid = evaluateExtraction([record(), record({ id: 'rec-2', title: 'İkinci' })], {
      ...baseOptions,
      extractor: () =>
        extracted({
          evidence: { institution: 'Örnek Bakanlığı' },
          fieldSources: { institution: { kind: 'detail', snippet: 'Örnek Bakanlığı' } },
        }),
    });
    expect(valid.evidence.valid).toBe(2);
    expect(valid.evidence.invalid).toBe(0);
    expect(valid.evidence.missing).toBeGreaterThan(0);

    const invalid = evaluateExtraction([record(), record({ id: 'rec-2', title: 'İkinci' })], {
      ...baseOptions,
      extractor: () =>
        extracted({
          evidence: { institution: 'Metinde olmayan cümle' },
          fieldSources: { institution: { kind: 'detail', snippet: 'Metinde olmayan cümle' } },
        }),
    });
    expect(invalid.evidence.invalid).toBe(2);
  });

  it('liste kaynaklı kanıtı "doğrulanamayan" sayar, uydurma saymaz', () => {
    const report = evaluateExtraction([record(), record({ id: 'rec-2', title: 'İkinci' })], {
      ...baseOptions,
      extractor: () =>
        extracted({
          city: 'Liste hücresi',
          evidence: { city: 'Liste hücresi' },
          fieldSources: { city: { kind: 'listing', snippet: 'Liste hücresi' } },
        }),
    });
    expect(report.evidence.listingUnverified).toBe(2);
  });

  it('yayım tarihi ile başvuru tarihinin karışmasını yakalar', () => {
    const report = evaluateExtraction([record(), record({ id: 'rec-2', title: 'İkinci' })], {
      ...baseOptions,
      extractor: () => extracted({ publishedAt: '2026-10-30' }),
    });
    expect(report.dateChecks.roleConfusions).toBe(2);
  });

  it('destek eşiğinin altındaki alan oranı gizler ve genel durum uydurmaz', () => {
    const report = evaluateExtraction([record()], { ...baseOptions, minRealRecords: 1, minFieldSupport: 2 });
    expect(report.status).toBe('INSUFFICIENT DATA');
    expect(report.fields.every((field) => field.ratesSuppressed)).toBe(true);
    expect(report.overall.precision).toBeNull();
    expect(report.fieldCoverage.labeled).toBe(report.fields.length);
    expect(report.fieldCoverage.unlabeledKeys).not.toContain('quota');
  });

  it('liste eşleşmesi alt-dize değil token kümesidir (lisans ≠ lisansüstü)', () => {
    const education = fieldDefinition('educationLevels')!;
    expect(compareFieldValues(education, ['Lisans'], ['lisans']).normalized).toBe(true);
    expect(compareFieldValues(education, ['Lisans'], ['lisansustu']).normalized).toBe(false);
    expect(compareFieldValues(education, ['Lisans'], ['yukseklisans']).normalized).toBe(false);
  });

  it('sentetik kayıtları hiçbir metrik sayacına katmaz', () => {
    const report = evaluateExtraction(
      [record(), record({ id: 'syn-1', origin: 'synthetic', labelProvenance: 'spec' })],
      { ...baseOptions, minRealRecords: 1, minFieldSupport: 1 },
    );
    expect(report.counts.synthetic).toBe(1);
    expect(report.counts.realScorable).toBe(1);
    expect(report.fields.every((field) => field.support <= 1 && field.truePositive <= field.support)).toBe(true);
  });

  it('veri kümesi hash’i anahtar sırasından bağımsızdır', () => {
    const a = { records: [{ id: '1', origin: 'real' }] };
    const b = { records: [{ origin: 'real', id: '1' }] };
    expect(hashDataset(a)).toBe(hashDataset(b));
  });
});
