/**
 * Değerlendirme metriklerinin formülleri ve etiketli kümeye karşı kritik kapı.
 * Kapı: spesifikasyondaki personel alımı olmayan hiçbir başlık ilan olarak kabul edilmemeli.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { computeEvalReport, type EvalRecord } from '../src/classification/eval';
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
