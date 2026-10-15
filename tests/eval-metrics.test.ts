/**
 * Değerlendirme metriklerinin formülleri ve etiketli kümeye karşı kritik kapı.
 * Kapı: spesifikasyondaki personel alımı olmayan hiçbir başlık ilan olarak kabul edilmemeli.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import {
  computeEvalReport,
  computeHumanRealReport,
  MIN_HUMAN_PER_CLASS,
  type EvalRecord,
} from '../src/classification/eval';
import { CONTENT_TYPES, type ContentType } from '../src/domain/types';

const JOB: ContentType = 'personnel_recruitment';

describe('computeEvalReport', () => {
  it('sınıf bazında precision/recall ve kritik oranları formülle hesaplar', () => {
    const records: EvalRecord[] = [
      { id: 'a', expected: JOB, predicted: JOB, origin: 'synthetic' },
      { id: 'b', expected: JOB, predicted: 'uncertain', origin: 'synthetic' },
      { id: 'c', expected: 'news', predicted: JOB, origin: 'synthetic' },
      { id: 'd', expected: 'news', predicted: 'news', origin: 'synthetic' },
    ];
    const report = computeEvalReport(records, [JOB, 'news']);
    const job = report.classes.find((entry) => entry.contentType === JOB);
    const news = report.classes.find((entry) => entry.contentType === 'news');
    expect(job).toMatchObject({ support: 2, predicted: 2, truePositives: 1, precision: 0.5, recall: 0.5 });
    expect(news).toMatchObject({ support: 2, predicted: 1, truePositives: 1, precision: 1, recall: 0.5 });
    expect(report.falseAcceptRate).toBe(0.5); // 2 ilan dışı kayıttan 1'i ilan kabul edildi
    expect(report.falseRejectRate).toBe(0.5); // 2 ilandan 1'i kabul edilmedi
    expect(report.falseAcceptIds).toEqual(['c']);
  });

  it('örnek yoksa oranlar null döner (uydurma yüzde yok)', () => {
    const report = computeEvalReport([], [JOB]);
    expect(report.falseAcceptRate).toBeNull();
    expect(report.classes[0]?.precision).toBeNull();
    expect(report.realCount).toBe(0);
  });

  it('belirsiz inceleme oranı, karışıklık matrisi ve yanlış ret kimlikleri raporlanır', () => {
    const records: EvalRecord[] = [
      { id: 'j1', expected: JOB, predicted: JOB, origin: 'spec-title' },
      { id: 'j2', expected: JOB, predicted: 'uncertain', origin: 'spec-title' },
      { id: 'n1', expected: 'news', predicted: 'other', origin: 'spec-title' },
      { id: 'n2', expected: 'news', predicted: 'news', origin: 'spec-title' },
    ];
    const report = computeEvalReport(records, ['personnel_recruitment', 'news', 'other', 'uncertain']);
    expect(report.uncertaintyRate).toBeCloseTo(0.25);
    expect(report.uncertainIds).toEqual(['j2']);
    expect(report.falseRejectIds).toEqual(['j2']);
    // Sıfır olmayan hücreler, beklenen sırayla ve karışıklıklar ayrı ayrı yazılır.
    expect(report.confusion).toEqual([
      { expected: JOB, predicted: JOB, count: 1 },
      { expected: JOB, predicted: 'uncertain', count: 1 },
      { expected: 'news', predicted: 'news', count: 1 },
      { expected: 'news', predicted: 'other', count: 1 },
    ]);
  });

  it('origin kırılımı sentetik ve gerçek kayıtları AYRI sayar (karışık yüzde gerçek başarı olmaz)', () => {
    const records: EvalRecord[] = [
      { id: 'r1', expected: JOB, predicted: JOB, origin: 'real', labelProvenance: 'human' },
      { id: 'r2', expected: 'news', predicted: JOB, origin: 'real', labelProvenance: 'human' },
      { id: 's1', expected: 'news', predicted: 'news', origin: 'synthetic' },
    ];
    const report = computeEvalReport(records, [JOB, 'news']);
    const real = report.byOrigin.find((entry) => entry.origin === 'real');
    const synthetic = report.byOrigin.find((entry) => entry.origin === 'synthetic');
    // Gerçek alt kümedeki tek ilan-dışı kayıt ilan olarak kabul edildi → yanlış kabul oranı 1.
    // Karışık oran aynı hatayı daha küçük gösterirdi; ayrımın amacı budur.
    expect(real).toMatchObject({ total: 2, humanLabeled: 2, falseAcceptRate: 1, falseRejectRate: 0 });
    expect(synthetic).toMatchObject({ total: 1, humanLabeled: 0, falseAcceptRate: 0, falseRejectRate: null });
    expect(report.sufficiency).toMatchObject({ humanRealCount: 2, realCount: 2, syntheticCount: 1 });
    // Yeterlilik eşiğinin altında: "yetersiz veri" kararı açıkça belirtilir.
    expect(report.sufficiency.sufficient).toBe(false);
    expect(report.sufficiency.minPerClass).toBe(MIN_HUMAN_PER_CLASS);
    expect(report.sufficiency.reasons.join(' ')).toMatch(/Sınıf başına/);
  });

  it('makine önerisiyle etiketlenmiş gerçek kayıt insan doğrulaması sayılmaz', () => {
    const records: EvalRecord[] = [
      { id: 'm1', expected: JOB, predicted: JOB, origin: 'real', labelProvenance: 'machine' },
    ];
    const report = computeEvalReport(records, [JOB]);
    expect(report.sufficiency.humanRealCount).toBe(0);
    expect(computeHumanRealReport(records, [JOB])).toBeNull();
    expect(report.sufficiency.reasons.join(' ')).toMatch(/GERÇEK kayıt yok/);
  });

  it('kaynak bazlı hata ve belirsizlik oranları ayrı hesaplanır', () => {
    const records: EvalRecord[] = [
      { id: 'a', expected: JOB, predicted: JOB, origin: 'real', sourceKey: 'resmigazete' },
      { id: 'b', expected: JOB, predicted: 'uncertain', origin: 'real', sourceKey: 'resmigazete' },
      { id: 'c', expected: 'news', predicted: 'news', origin: 'real', sourceKey: 'ilan-gov-tr' },
    ];
    const report = computeEvalReport(records, [JOB, 'news', 'uncertain']);
    expect(report.bySource).toEqual([
      { sourceKey: 'ilan-gov-tr', total: 1, errors: 0, uncertain: 0, problemRate: 0 },
      { sourceKey: 'resmigazete', total: 2, errors: 1, uncertain: 1, problemRate: 0.5 },
    ]);
  });

  it('insan doğrulamalı gerçek alt küme ayrı raporlanır (karışık rapordan bağımsız)', () => {
    const records: EvalRecord[] = [
      { id: 'r1', expected: JOB, predicted: 'news', origin: 'real', labelProvenance: 'human' },
      { id: 's1', expected: JOB, predicted: JOB, origin: 'synthetic' },
    ];
    const realOnly = computeHumanRealReport(records, [JOB, 'news']);
    expect(realOnly?.total).toBe(1);
    expect(realOnly?.falseRejectRate).toBe(1);
    // Karışık rapor daha iyimser görünür — ayrımın nedeni tam olarak budur.
    expect(computeEvalReport(records, [JOB, 'news']).falseRejectRate).toBe(0.5);
  });
});

describe('etiketli küme kritik kapısı', () => {
  const file = join(process.cwd(), 'tests/fixtures/eval/labeled-set.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    records: Array<{
      id: string;
      origin: 'real' | 'synthetic' | 'spec-title';
      title: string;
      sourceCategory: string;
      bodyKind: 'news' | 'recruitment';
      expectedContentType: ContentType;
    }>;
  };
  const NEWS_BODY =
    'Kurum internet sitesinde yayımlanan haber metni. Ayrıntılar için kurum sayfasını ziyaret ediniz. Basın birimi tarafından paylaşılmıştır.';
  const RECRUITMENT_BODY =
    'Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır. Kadro unvanı Bilişim Personeli. Kontenjan 2. Başvuru e-Devlet üzerinden yapılacaktır. Lisans mezunu olmak şartı aranır.';

  const evalRecords: EvalRecord[] = parsed.records.map((record) => {
    const result = classify({
      title: record.title,
      body: record.bodyKind === 'recruitment' ? RECRUITMENT_BODY : NEWS_BODY,
      sourceCategory: record.sourceCategory,
    });
    return {
      id: record.id,
      expected: record.expectedContentType,
      predicted: result.contentType ?? 'uncertain',
      origin: record.origin,
    };
  });

  it('etiketli kümede yanlış ilan kabulü yok (ilan olmayan kayıt → accept/job 0)', () => {
    const report = computeEvalReport(evalRecords, CONTENT_TYPES);
    expect(report.falseAcceptIds).toEqual([]);
    expect(report.falseAcceptRate).toBe(0);
  });

  it('gerçek personel alımı etiketli kümede kabul edilir (yanlış ret yok)', () => {
    const report = computeEvalReport(evalRecords, CONTENT_TYPES);
    expect(report.falseRejectRate).toBe(0);
  });

  it('süreç duyurusu iş ilanı olarak sınıflanmaz', () => {
    const process = evalRecords.find((record) => record.id === 'proc-meb-bilisim-sinav');
    expect(process?.predicted).toBe('personnel_process_announcement');
  });
});
