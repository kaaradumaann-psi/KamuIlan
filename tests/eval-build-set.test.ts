/**
 * Etiketleme sayfası aracının testi.
 *
 * İki katman:
 *  1. Saf fonksiyonlar: makine tahmini ile insan etiketinin AYRILMASI, kanıtsız
 *     'real' kayıtların içe alınmaması, küme birleştirme davranışı.
 *  2. UÇTAN UCA CLI: geçici bir dosya deposunda iki kayıtla `eval:build-set`
 *     çalıştırılır, sayfa doldurulur, `--import` (kuru) ve `--import --apply`
 *     koşulur. Betiğin gerçekten dosya yazdığı/üretmediği böylece doğrulanır.
 *
 * Buradaki 'scraped' kayıt YALNIZCA aracın testidir; değerlendirme kümesi verisi
 * değildir ve küme dosyasına yazılmaz.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import type { JobDoc, JobSourceDoc } from '../src/db/schemas';
import {
  buildLabelingWorksheet,
  importLabeledWorksheet,
  isRealSourceRecord,
  mergeLabeledSets,
  WORKSHEET_INSTRUCTIONS,
  type WorksheetJobRecord,
} from '../src/classification/eval-set';

function jobRecord(overrides: Partial<WorksheetJobRecord> = {}): WorksheetJobRecord {
  return {
    id: 'job-00000001',
    title: 'Bakanlığımız taşra teşkilatında istihdam edilmek üzere personel alımı yapılacaktır',
    institution: 'Örnek Bakanlığı',
    detailUrl: 'https://ornek.gov.tr/duyuru/1',
    applicationUrl: null,
    city: 'Ankara',
    quota: 5,
    publishedAt: '2026-10-01',
    applicationStartAt: null,
    applicationEndAt: null,
    textExcerpt: 'Taşra teşkilatında istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır.',
    evidence: {},
    provenance: 'scraped',
    primarySourceKey: 'resmigazete-cestili-ilanlar',
    sourceCategory: null,
    capturedTextStatus: 'captured',
    classification: {
      decision: 'review',
      kind: 'job',
      contentType: 'uncertain',
      confidence: 0.5,
      reasons: ['İlan metninde alım ifadesi var ama tarih yok'],
    },
    uncertainties: [],
    ...overrides,
  };
}

describe('buildLabelingWorksheet', () => {
  it('makine tahminini ayrı tutar ve beklenen etiketi BOŞ bırakır', () => {
    const worksheet = buildLabelingWorksheet([jobRecord()], new Date('2026-10-15T09:00:00+03:00'));
    const record = worksheet.records[0]!;
    expect(worksheet.instructions).toBe(WORKSHEET_INSTRUCTIONS);
    expect(record.expectedContentType).toBeNull();
    expect(record.labelProvenance).toBe('unreviewed');
    expect(record.origin).toBe('real');
    expect(record.machineSuggestion).toMatchObject({ decision: 'review', confidence: 0.5 });
    expect(record.machineSuggestion.contentType).toBe('uncertain');
  });

  it('demo/örnek kayıt ve envanterde olmayan kaynak gerçek sayılmaz', () => {
    expect(isRealSourceRecord({ provenance: 'sample', primarySourceKey: 'resmigazete-cestili-ilanlar' })).toBe(false);
    expect(isRealSourceRecord({ provenance: 'scraped', primarySourceKey: 'bilinmeyen-kaynak' })).toBe(false);
    expect(isRealSourceRecord({ provenance: 'scraped', primarySourceKey: 'ilan-gov-tr-personel' })).toBe(true);
    const worksheet = buildLabelingWorksheet([jobRecord({ provenance: 'sample' })], new Date());
    expect(worksheet.records[0]?.origin).toBe('synthetic');
  });

  it('tam metin kesikse etiketleyici uyarılır', () => {
    const worksheet = buildLabelingWorksheet(
      [jobRecord({ capturedTextStatus: 'listing-only' })],
      new Date(),
    );
    expect(worksheet.records[0]?.notes).toMatch(/tam metin yok\/kesik/);
    expect(worksheet.records[0]?.bodyCompleteness).toBe('listing-only');
  });
});

describe('importLabeledWorksheet', () => {
  const filled = (overrides: Record<string, unknown> = {}) => ({
    ...buildLabelingWorksheet([jobRecord()], new Date()).records[0],
    expectedContentType: 'personnel_recruitment',
    labelProvenance: 'human',
    labeledBy: 'insan-adi',
    labeledAt: '2026-10-15T10:00:00+03:00',
    ...overrides,
  });

  function worksheetWith(records: unknown[]) {
    return {
      kind: 'kamuilan-eval-worksheet',
      generatedAt: '2026-10-15T09:00:00+03:00',
      instructions: WORKSHEET_INSTRUCTIONS,
      records,
    };
  }

  it('insan doğrulaması olmayan gerçek kaydı İÇE ALMAZ', () => {
    const result = importLabeledWorksheet(
      worksheetWith([
        filled(), // tek geçerli kayıt
        filled({ id: 'job-00000002', labelProvenance: 'machine' }),
        filled({ id: 'job-00000003', labelProvenance: 'unreviewed', expectedContentType: null }),
        filled({ id: 'job-00000004', labeledBy: null }),
      ]),
    );
    expect(result.records.map((record) => record.id)).toEqual(['job-00000001']);
    expect(result.report.rejected).toHaveLength(3);
    const reasons = result.report.rejected.map((entry) => entry.reason).join(' ');
    expect(reasons).toMatch(/human/);
    expect(reasons).toMatch(/expectedContentType boş/);
    expect(reasons).toMatch(/labeledBy\/labeledAt boş/);
  });

  it('kabul edilen kayıt küme biçimine dönüşür ve provenans korunur', () => {
    const result = importLabeledWorksheet(
      worksheetWith([filled({ expectedFields: { city: 'Ankara', quota: 5, applicationEndAt: '2026-10-30' } })]),
    );
    const record = result.records[0]!;
    expect(record).toMatchObject({
      origin: 'real',
      expectedContentType: 'personnel_recruitment',
      labelProvenance: 'human',
      labelVerifiedBy: 'insan-adi',
      sourceKey: 'resmigazete-cestili-ilanlar',
      url: 'https://ornek.gov.tr/duyuru/1',
    });
    expect(record.expectedFields).toMatchObject({ city: 'Ankara', quota: 5 });
    expect(result.report.withExpectedFields).toBe(1);
    // Alıntı yeterince uzunsa (>=200 karakter) ve tam metin durumundaysa gövde taşınır.
    const longExcerpt = 'x'.repeat(240);
    const withBody = importLabeledWorksheet(
      worksheetWith([filled({ bodyExcerpt: longExcerpt, bodyCompleteness: 'captured' })]),
    );
    expect(withBody.records[0]?.body).toBe(longExcerpt);
    // Kısa alıntılar gövde sayılmaz; kesik/liste-only metinler de gövde olmaz.
    expect(record.body).toBeUndefined();
    const truncated = importLabeledWorksheet(
      worksheetWith([filled({ bodyExcerpt: longExcerpt, bodyCompleteness: 'truncated' })]),
    );
    expect(truncated.records[0]?.body).toBeUndefined();
  });

  it('kapsam hedefinin altındaki kategoriler gap olarak döner', () => {
    const result = importLabeledWorksheet(worksheetWith([filled()]));
    expect(result.report.gaps.join(' ')).toMatch(/haber: 0\/25/);
    expect(result.report.coverage).toEqual([{ contentType: 'personnel_recruitment', count: 1 }]);
  });

  it('biçimbozuk sayfa açık hata verir (sessiz kısmi içe aktarma yok)', () => {
    expect(() => importLabeledWorksheet({ kind: 'yanlis', records: [] })).toThrow(/biçimi geçersiz/);
  });
});

describe('mergeLabeledSets', () => {
  it('aynı id güncellenir, başkaları korunur, yeni kayıtlar eklenir', () => {
    const existing = {
      records: [
        {
          id: 'old',
          origin: 'spec-title' as const,
          title: 'Eski kayıt',
          sourceCategory: '',
          bodyKind: 'news' as const,
          expectedContentType: 'news' as const,
        },
        {
          id: 'job-00000001',
          origin: 'real' as const,
          title: 'Eski hâli',
          sourceCategory: '',
          bodyKind: 'news' as const,
          expectedContentType: 'news' as const,
        },
      ],
    };
    const incoming = importLabeledWorksheet({
      kind: 'kamuilan-eval-worksheet',
      generatedAt: 'x',
      instructions: WORKSHEET_INSTRUCTIONS,
      records: [
        {
          ...buildLabelingWorksheet([jobRecord()], new Date()).records[0],
          expectedContentType: 'personnel_recruitment',
          labelProvenance: 'human',
          labeledBy: 'kişi',
          labeledAt: '2026-10-15',
        },
      ],
    }).records;
    const merged = mergeLabeledSets(existing, incoming, new Date('2026-10-15T12:00:00+03:00'));
    expect(merged).toMatchObject({ added: 0, updated: 1 });
    expect(merged.document.records).toHaveLength(2);
    const updated = merged.document.records.find((record) => record.id === 'job-00000001');
    expect(updated?.expectedContentType).toBe('personnel_recruitment');
    expect(merged.document.records.find((record) => record.id === 'old')).toBeDefined();
  });
});

describe('CLI uçtan uca (geçici dosya deposu)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-evalset-cli-'));
  const worksheetPath = join(dir, 'worksheet.json');
  const setPath = join(dir, 'labeled-set.json');

  /** Betik çıktısını döndürür; kabul edilmeyen kayıt durumunda exit kodu 1 olur (bilinçli). */
  function run(args: string[]): string {
    try {
      return execFileSync('npx', ['tsx', 'scripts/eval-build-set.ts', ...args], {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, DATA_DIR: dir, DATABASE_DRIVER: 'file', NODE_ENV: 'test', SOURCE_LIVE_FETCH: '0' },
        timeout: 120_000,
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      if (typeof failure.stdout === 'string') return failure.stdout + (failure.stderr ?? '');
      throw error;
    }
  }

  beforeAll(async () => {
    const store = new FileStore(dir);
    await store.init();
    const now = '2026-10-15T09:00:00.000Z';
    const baseJob: JobDoc = {
      id: 'job-test-0001',
      title: 'Personel alımı duyurusu',
      titleNormalized: 'personel alimi duyurusu',
      institution: 'Örnek Kurumu',
      institutionNormalized: 'ornek kurumu',
      unit: null,
      employmentType: 'sozlesmeli',
      status: 'active',
      statusReason: '',
      city: 'Ankara',
      cityNormalized: 'ankara',
      district: null,
      quota: 3,
      applicationStartAt: null,
      applicationEndAt: null,
      applicationEndDate: null,
      publishedAt: '2026-10-01',
      detailUrl: 'https://ornek.gov.tr/duyuru/1',
      normalizedUrl: 'https://ornek.gov.tr/duyuru/1',
      applicationUrl: null,
      applicationMethod: null,
      attachments: [],
      requirements: {
        educationLevels: [],
        departments: [],
        kpssScoreTypes: [],
        kpssMinScore: null,
        kpssYear: null,
        qualificationCodes: [],
        minAge: null,
        maxAge: null,
        certificates: [],
        minExperienceYears: null,
        foreignLanguages: [],
        specialConditions: [],
        },
      titles: [],
      textExcerpt: 'Sözleşmeli personel alımı yapılacaktır; başvurular e-Devlet üzerinden alınacaktır.',
      textNormalized: 'sozlesmeli personel alimi yapilacaktir; basvurular e-devlet uzerinden alinacaktir.',
      originalRefNo: null,
      sourceKeys: ['resmigazete-cestili-ilanlar'],
      primarySourceKey: 'resmigazete-cestili-ilanlar',
      classification: {
        decision: 'review',
        kind: 'job',
        employmentType: 'sozlesmeli',
        confidence: 0.5,
        reasons: ['tarih yok'],
        rules: [],
        negativeSignals: [],
        version: 'test',
        classifiedAt: now,
        contentType: 'uncertain',
      },
      extractionConfidence: 0.5,
      fieldSources: {},
      evidence: {},
      uncertainties: [],
      provenance: 'scraped',
      contentHash: 'a'.repeat(64),
      dedupeKey: 'b'.repeat(64),
      version: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await store.insertOne('jobs', baseJob);
    await store.insertOne('jobs', {
      ...baseJob,
      id: 'job-test-0002',
      provenance: 'sample',
      title: 'Demo kayıt',
      titleNormalized: 'demo kayit',
      normalizedUrl: 'https://ornek.test/demo',
      dedupeKey: 'c'.repeat(64),
      contentHash: 'd'.repeat(64),
      primarySourceKey: 'demo-kaynak',
      sourceKeys: ['demo-kaynak'],
    });
    const link: JobSourceDoc = {
      id: 'jsrc-test-0001',
      jobId: 'job-test-0001',
      sourceKey: 'resmigazete-cestili-ilanlar',
      sourceItemId: 'RG-1',
      url: 'https://ornek.gov.tr/duyuru/1',
      title: 'Personel alımı duyurusu',
      institution: 'Örnek Kurumu',
      sourceCategory: null,
      publishedAt: '2026-10-01',
      capturedTextCharacterCount: 100,
      capturedTextStatus: 'captured',
      attachments: [],
      active: true,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    await store.insertOne('jobSources', link);
    await store.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sayfa üretir, kuru içe aktarma yazmaz, --apply kümeye yazar', () => {
    const built = run(['--out', worksheetPath, '--filter', 'review', '--limit', '10']);
    expect(built).toMatch(/MOD: KURU/);
    expect(existsSync(worksheetPath)).toBe(true);
    const worksheet = JSON.parse(readFileSync(worksheetPath, 'utf8')) as {
      records: { id: string; origin: string }[];
    };

    // Yalnızca scraped + envanter kaynağı 'real' olur; demo kayıt sentetik sayılır.
    const real = worksheet.records.filter((record) => record.origin === 'real');
    expect(real.map((record) => record.id)).toEqual(['job-test-0001']);
    expect(worksheet.records.some((record) => record.id === 'job-test-0002')).toBe(true);

    // Etiket DOLDURULMADAN içe aktarma: hiçbir şey kabul edilmez, küme yazılmaz.
    const empty = run(['--import', worksheetPath, '--set', setPath]);
    expect(empty).toMatch(/kabul: 0/);
    expect(empty).toMatch(/küme dosyasına dokunulmadı/i);
    expect(existsSync(setPath)).toBe(false);

    // Sayfayı insan doldurmuş gibi işaretleyip içe aktar (önce kuru, sonra --apply).
    const raw = JSON.parse(readFileSync(worksheetPath, 'utf8')) as { records: Record<string, unknown>[] };
    for (const record of raw.records.filter((entry) => entry.origin === 'real')) {
      record.expectedContentType = 'personnel_recruitment';
      record.labelProvenance = 'human';
      record.labeledBy = 'test-etiketleyen';
      record.labeledAt = '2026-10-15T10:00:00+03:00';
      record.expectedFields = { city: 'Ankara', quota: 3 };
    }
    writeFileSync(worksheetPath, JSON.stringify({ ...raw, records: raw.records.filter((entry) => entry.origin === 'real') }, null, 2));

    const dry = run(['--import', worksheetPath, '--set', setPath]);
    expect(dry).toMatch(/KURU ÇALIŞTIRMA: küme dosyası yazılmadı/);
    expect(existsSync(setPath)).toBe(false);

    const applied = run(['--import', worksheetPath, '--set', setPath, '--apply']);
    expect(applied).toMatch(/Küme güncellendi/);
    const set = JSON.parse(readFileSync(setPath, 'utf8')) as {
      description: string;
      records: { id: string; origin: string; labelProvenance: string; expectedContentType: string }[];
    };
    expect(set.records).toHaveLength(1); // demo/sentetik kayıt insan doğrulaması olmadan girmez
    expect(set.records[0]).toMatchObject({
      origin: 'real',
      labelProvenance: 'human',
      expectedContentType: 'personnel_recruitment',
    });
    expect(set.description).toMatch(/İNSAN DOĞRULAMALI/);
  });
});
