/**
 * Sınıflandırma değerlendirme metrikleri (sınıf bazında precision/recall ve kritik oranlar).
 *
 * Girdi: etiketli örnekler (beklenen içerik türü + sistemin tahmini). Metrik yalnızca bu girdiden
 * hesaplanır; tahmini ya da uydurma yüzde üretilmez. Örnek sayısı küçükse rapor bunu belirtir.
 */
import type { ContentType } from '../domain/types';

export interface EvalRecord {
  id: string;
  expected: ContentType;
  predicted: ContentType;
  /** Kaynağın türü: 'real' gerçek ilan sayfası; diğerleri sentetik/başlık kaynaklı regresyon. */
  origin: 'real' | 'synthetic' | 'spec-title';
}

export interface ClassMetrics {
  contentType: ContentType;
  support: number;
  predicted: number;
  truePositives: number;
  precision: number | null;
  recall: number | null;
}

export interface EvalReport {
  total: number;
  realCount: number;
  classes: ClassMetrics[];
  /** Gerçek olmayan ilan (expected !== personnel_recruitment) iken ilan olarak kabul edilen oran. */
  falseAcceptRate: number | null;
  /** Gerçek ilan (expected personnel_recruitment) iken ilan olarak kabul edilmeyen oran. */
  falseRejectRate: number | null;
  /** Yanlış kabul edilen kayıt kimlikleri (ilk 20). */
  falseAcceptIds: string[];
}

const JOB: ContentType = 'personnel_recruitment';

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function computeEvalReport(
  records: readonly EvalRecord[],
  classes: readonly ContentType[],
): EvalReport {
  const metrics: ClassMetrics[] = classes.map((contentType) => {
    const support = records.filter((record) => record.expected === contentType).length;
    const predicted = records.filter((record) => record.predicted === contentType).length;
    const truePositives = records.filter(
      (record) => record.expected === contentType && record.predicted === contentType,
    ).length;
    return {
      contentType,
      support,
      predicted,
      truePositives,
      precision: safeRatio(truePositives, predicted),
      recall: safeRatio(truePositives, support),
    };
  });

  const nonJob = records.filter((record) => record.expected !== JOB);
  const job = records.filter((record) => record.expected === JOB);
  const falseAccepts = nonJob.filter((record) => record.predicted === JOB);
  const falseRejects = job.filter((record) => record.predicted !== JOB);

  return {
    total: records.length,
    realCount: records.filter((record) => record.origin === 'real').length,
    classes: metrics,
    falseAcceptRate: safeRatio(falseAccepts.length, nonJob.length),
    falseRejectRate: safeRatio(falseRejects.length, job.length),
    falseAcceptIds: falseAccepts.slice(0, 20).map((record) => record.id),
  };
}

export function formatRate(value: number | null): string {
  return value === null ? 'ölçülemedi (örnek yok)' : `${(value * 100).toFixed(1)}%`;
}
