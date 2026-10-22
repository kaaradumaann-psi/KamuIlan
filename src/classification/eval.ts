/**
 * Sınıflandırma değerlendirme metrikleri (sınıf bazında precision/recall ve kritik oranlar).
 *
 * Girdi: etiketli örnekler (beklenen içerik türü + sistemin tahmini). Metrik yalnızca bu girdiden
 * hesaplanır; tahmini ya da uydurma yüzde üretilmez. Örnek sayısı küçükse rapor bunu belirtir.
 *
 * Ölçülenler:
 *  - Sınıf bazında destek/tahmin/DOĞRU + precision/recall.
 *  - Yanlış kabul (ilan olmayan → ilan) ve yanlış ret (ilan → ilan değil) oranları.
 *  - Belirsiz inceleme oranı (sistemin `uncertain` dediği kayıt payı).
 *  - Karışıklık matrisi (yalnızca sıfır olmayan hücreler).
 *  - Origin kırılımı: `real` (gerçek ilan kaydı) ile `synthetic`/`spec-title` ayrı sayılır;
 *    sentetik yüzde 100'ü gerçek başarı gibi göstermesin diye rapor gerçek etiket sayısını
 *    ve YETERSİZ VERİ kararını taşır.
 *  - Kaynak bazında hata/boş sonuç oranları (`sourceKey` verildiyse).
 */
import type { ContentType } from '../domain/types';

export type EvalOrigin = 'real' | 'synthetic' | 'spec-title';

export interface EvalRecord {
  id: string;
  expected: ContentType;
  predicted: ContentType;
  /** Kaynağın türü: 'real' gerçek ilan sayfası; diğerleri sentetik/başlık kaynaklı regresyon. */
  origin: EvalOrigin;
  /**
   * Etiket provenansı: `human` = insan tarafından doğrulanmış gerçek etiket,
   * `machine` = kural/model önerisi üzerine (doğrulanmamış), `spec` = spesifikasiyadaki
   * beklenen davranış. Gerçek metrikler YALNIZCA `human` etiketlerle iddia edilir.
   */
  labelProvenance?: 'human' | 'machine' | 'spec';
  /** Kaynak anahtarı (varsa): kaynak bazlı hata oranları için. */
  sourceKey?: string | null;
}

export interface ClassMetrics {
  contentType: ContentType;
  support: number;
  predicted: number;
  truePositives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface ConfusionCell {
  expected: ContentType;
  predicted: ContentType;
  count: number;
}

export interface OriginMetrics {
  origin: EvalOrigin;
  total: number;
  humanLabeled: number;
  falseAcceptRate: number | null;
  falseRejectRate: number | null;
  uncertainRate: number | null;
}

export interface SourceMetrics {
  sourceKey: string;
  total: number;
  /** Tahmin ile etiket farklı olan kayıt sayısı (yanlış kabul + yanlış ret + sınıf hatası). */
  errors: number;
  /** Sistemin `uncertain` (inceleme) dediği kayıt sayısı. */
  uncertain: number;
  /** Hatalı ya da belirsiz çıkan kayıt payı. */
  problemRate: number | null;
}

export interface DataSufficiency {
  /** Gerçek etiketli (`origin: real` + `labelProvenance: human`) kayıt sayısı. */
  humanRealCount: number;
  realCount: number;
  syntheticCount: number;
  /** Yeterli sayı eşiği (sınıf başına insan doğrulamalı hedef). */
  minPerClass: number;
  sufficient: boolean;
  /** Neden yeterli değil? (rapor aynen yazar; okuyucu oranı yanlış yorumlamaz) */
  reasons: string[];
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
  /** Yanlış reddedilen kayıt kimlikleri (ilk 20). */
  falseRejectIds: string[];
  /** Sistemin belirsiz bıraktığı (incelemeye yönlendirdiği) kayıt payı. */
  uncertaintyRate: number | null;
  uncertainIds: string[];
  /** Sıfır olmayan karışıklık hücreleri (satır=beklenen, sütun=tahmin). */
  confusion: ConfusionCell[];
  byOrigin: OriginMetrics[];
  bySource: SourceMetrics[];
  sufficiency: DataSufficiency;
}

const JOB: ContentType = 'personnel_recruitment';
const UNCERTAIN: ContentType = 'uncertain';

/** Sınıf başına insan doğrulamalı minimum örnek hedefi (altında metrik iddiası yoktur). */
export const MIN_HUMAN_PER_CLASS = 20;

/**
 * Etiket provenansının etkin değeri. İnsan doğrulaması YALNIZ açıkça `labelProvenance: "human"`
 * yazılmışsa kabul edilir: provenansı boş gerçek kayıt `machine` sayılır (ajan/kural etiketli bir
 * kayıt elle eklendiğinde sahte precision/recall üretmesin). Sentetik/başlık kayıtlarında etiket
 * spesifikasyondan gelir. `computeHumanRealReport` ve yeterlilik kararı bu tek tanımdan beslenir.
 */
export function effectiveProvenance(record: Pick<EvalRecord, 'origin' | 'labelProvenance'>): 'human' | 'machine' | 'spec' {
  return record.labelProvenance ?? (record.origin === 'real' ? 'machine' : 'spec');
}

export function isHumanReal(record: EvalRecord): boolean {
  return record.origin === 'real' && effectiveProvenance(record) === 'human';
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function computeClassMetrics(records: readonly EvalRecord[], classes: readonly ContentType[]): ClassMetrics[] {
  return classes.map((contentType) => {
    const support = records.filter((record) => record.expected === contentType).length;
    const predicted = records.filter((record) => record.predicted === contentType).length;
    const truePositives = records.filter(
      (record) => record.expected === contentType && record.predicted === contentType,
    ).length;
    const precision = safeRatio(truePositives, predicted);
    const recall = safeRatio(truePositives, support);
    const f1 =
      precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
    return { contentType, support, predicted, truePositives, precision, recall, f1 };
  });
}

function criticalRates(records: readonly EvalRecord[]) {
  const nonJob = records.filter((record) => record.expected !== JOB);
  const job = records.filter((record) => record.expected === JOB);
  const falseAccepts = nonJob.filter((record) => record.predicted === JOB);
  const falseRejects = job.filter((record) => record.predicted !== JOB);
  return {
    falseAcceptRate: safeRatio(falseAccepts.length, nonJob.length),
    falseRejectRate: safeRatio(falseRejects.length, job.length),
    falseAcceptIds: falseAccepts.slice(0, 20).map((record) => record.id),
    falseRejectIds: falseRejects.slice(0, 20).map((record) => record.id),
  };
}

function confusionMatrix(
  records: readonly EvalRecord[],
  classes: readonly ContentType[],
): ConfusionCell[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = `${record.expected}\u0000${record.predicted}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cells: ConfusionCell[] = [];
  for (const expected of classes) {
    for (const predicted of classes) {
      const count = counts.get(`${expected}\u0000${predicted}`) ?? 0;
      if (count > 0) cells.push({ expected, predicted, count });
    }
  }
  return cells;
}

function assessSufficiency(records: readonly EvalRecord[], classes: readonly ContentType[]): DataSufficiency {
  const humanReal = records.filter(isHumanReal);
  const reasons: string[] = [];
  if (humanReal.length === 0) {
    reasons.push(
      'İnsan tarafından doğrulanmış GERÇEK kayıt yok (origin: "real" + labelProvenance: "human"). ' +
        'Aşağıdaki oranlar yalnızca sentetik/başlık regresyonudur; gerçek precision/recall DEĞİLDİR.',
    );
  }
  const thinClasses = classes
    .map((contentType) => ({
      contentType,
      count: humanReal.filter((record) => record.expected === contentType).length,
    }))
    .filter((entry) => entry.count < MIN_HUMAN_PER_CLASS)
    .map((entry) => `${entry.contentType}: ${entry.count}/${MIN_HUMAN_PER_CLASS}`);
  if (humanReal.length > 0 && thinClasses.length > 0) {
    reasons.push(`Sınıf başına insan doğrulamalı örnek hedefinin (${MIN_HUMAN_PER_CLASS}) altında: ${thinClasses.join(', ')}.`);
  }
  if (records.length > 0 && humanReal.length === 0 && reasons.length === 0) {
    reasons.push('Etiketler makine önerisinden geliyor; ölçüm insan doğrulaması bekliyor.');
  }
  return {
    humanRealCount: humanReal.length,
    realCount: records.filter((record) => record.origin === 'real').length,
    syntheticCount: records.filter((record) => record.origin !== 'real').length,
    minPerClass: MIN_HUMAN_PER_CLASS,
    sufficient: reasons.length === 0,
    reasons,
  };
}

export function computeEvalReport(
  records: readonly EvalRecord[],
  classes: readonly ContentType[],
): EvalReport {
  const rates = criticalRates(records);
  const uncertainIds = records.filter((record) => record.predicted === UNCERTAIN).map((record) => record.id);
  const byOrigin: OriginMetrics[] = (['real', 'synthetic', 'spec-title'] as const)
    .map((origin) => {
      const subset = records.filter((record) => record.origin === origin);
      const own = { ...criticalRates(subset) };
      return {
        origin,
        total: subset.length,
        humanLabeled: subset.filter((record) => effectiveProvenance(record) === 'human').length,
        falseAcceptRate: own.falseAcceptRate,
        falseRejectRate: own.falseRejectRate,
        uncertainRate: safeRatio(
          subset.filter((record) => record.predicted === UNCERTAIN).length,
          subset.length,
        ),
      };
    })
    .filter((entry) => entry.total > 0);

  const bySource: SourceMetrics[] = (() => {
    const keys = [
      ...new Set(
        records
          .map((record) => record.sourceKey)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ].sort();
    return keys.map((sourceKey) => {
      const subset = records.filter((record) => record.sourceKey === sourceKey);
      const errors = subset.filter((record) => record.expected !== record.predicted).length;
      const uncertain = subset.filter((record) => record.predicted === UNCERTAIN).length;
      return {
        sourceKey,
        total: subset.length,
        errors,
        uncertain,
        problemRate: safeRatio(
          subset.filter((record) => record.expected !== record.predicted || record.predicted === UNCERTAIN).length,
          subset.length,
        ),
      };
    });
  })();

  return {
    total: records.length,
    realCount: records.filter((record) => record.origin === 'real').length,
    classes: computeClassMetrics(records, classes),
    ...rates,
    uncertaintyRate: safeRatio(uncertainIds.length, records.length),
    uncertainIds: uncertainIds.slice(0, 20),
    confusion: confusionMatrix(records, classes),
    byOrigin,
    bySource,
    sufficiency: assessSufficiency(records, classes),
  };
}

/**
 * Yalnızca insan doğrulamalı GERÇEK kayıtlar için rapor.
 *
 * Ayrı hesaplamanın nedeni: sentetik kayıtlarla karışık bir yüzde, gerçek dünyada
 * ne kadar iyi olunduğuna dair yanlış izlenim üretir. Gerçek etiket yoksa bu fonksiyon
 * `sufficient: false` ve null oranlar döner — uydurulmuş bir 0%/100% yerine.
 */
export function computeHumanRealReport(
  records: readonly EvalRecord[],
  classes: readonly ContentType[],
): EvalReport | null {
  const subset = records.filter(isHumanReal);
  if (subset.length === 0) return null;
  return computeEvalReport(subset, classes);
}

export function formatRate(value: number | null): string {
  return value === null ? 'ölçülemedi (örnek yok)' : `${(value * 100).toFixed(1)}%`;
}

/** Kapının bir senaryo için verdiği karar (ölçüm satırı). */
export interface GateScenarioOutcome {
  id: string;
  expected: ContentType;
  predicted: ContentType;
  /** Kapının ham kararı: `ilan`/`surec`/`ilan-degil`/`belirsiz`, `dogrulanamadi`, `hata` ya da çağrı yapılmadıysa null. */
  verdict: string | null;
  /** Nihai karar (kapı kaydı değiştirmediyse kural kararı). */
  decision: string;
  /** Kapının gösterdiği kanıt kaynak metinde birebir bulundu mu (doğrulama geçti mi)? */
  evidenceVerified: boolean;
  /** Bu senaryoda kabul EDİLMEMESİ gereken türler (ör. enjeksiyon senaryosunda personel alımı). */
  forbidden?: readonly ContentType[];
}

export type GateScenarioAssessment = 'uygun' | 'uygunsuz' | 'kapi-calismadi';

/**
 * Kapı koşumunda senaryo beklenen sonuca uydu mu?
 *
 * Dürüstlük kuralı: model karar vermediyse (`hata`, `dogrulanamadi`, `belirsiz`)
 * bu ne başarı ne başarısızlıktır — kayıt inceleme kuyruğunda kalır ve uydurma
 * bilgi yazılmaz. Böyle durumlar `kapi-calismadi` olarak raporlanır; yani
 * "hata oranı yüksek" tek başına "kapı yanlış çalışıyor" demek değildir.
 */
export function assessGateScenario(outcome: GateScenarioOutcome): GateScenarioAssessment {
  const decided =
    outcome.verdict === 'ilan' || outcome.verdict === 'surec' || outcome.verdict === 'ilan-degil';
  if (!decided) return 'kapi-calismadi';
  if (outcome.forbidden?.includes(outcome.predicted)) return 'uygunsuz';
  return outcome.predicted === outcome.expected ? 'uygun' : 'uygunsuz';
}
