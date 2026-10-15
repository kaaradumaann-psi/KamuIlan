/**
 * Sınıflandırma değerlendirmesi: etiketli örnekleri çalıştırır ve sınıf bazında precision/recall
 * ile kritik oranları yazar.
 *
 *   npm run eval:classification                 → tests/fixtures/eval/labeled-set.json
 *   npm run eval:classification -- --file <yol> → başka etiketli dosya
 *
 * Gerçek ilan (origin: "real") örneği yoksa rapor bunu açıkça belirtir; metrik uydurulmaz.
 * Salt okunur: hiçbir veritabanına yazmaz.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../src/classification/engine';
import { CONTENT_TYPES, type ContentType } from '../src/domain/types';
import { computeEvalReport, formatRate, type EvalRecord } from '../src/classification/eval';

const NEWS_BODY =
  'Kurum internet sitesinde yayımlanan haber metni. Ayrıntılar için kurum sayfasını ziyaret ediniz. Basın birimi tarafından paylaşılmıştır.';
const RECRUITMENT_BODY =
  'Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır. Kadro unvanı Bilişim Personeli. Kontenjan 2. Başvuru e-Devlet üzerinden yapılacaktır. Lisans mezunu olmak şartı aranır.';

interface LabeledRecord {
  id: string;
  origin: 'real' | 'synthetic' | 'spec-title';
  title: string;
  sourceCategory: string;
  bodyKind: 'news' | 'recruitment';
  expectedContentType: ContentType;
  /** Gerçek örneklerde gövde ilan metninden gelir; bu alan yalnızca sentetik kayıtlarda kullanılır. */
  body?: string;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function main(): void {
  const file = argValue('--file') ?? join(process.cwd(), 'tests/fixtures/eval/labeled-set.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records: LabeledRecord[] };
  const evalRecords: EvalRecord[] = parsed.records.map((record) => {
    const body = record.body ?? (record.bodyKind === 'recruitment' ? RECRUITMENT_BODY : NEWS_BODY);
    const result = classify({ title: record.title, body, sourceCategory: record.sourceCategory });
    return {
      id: record.id,
      expected: record.expectedContentType,
      predicted: result.contentType ?? 'uncertain',
      origin: record.origin,
    };
  });

  const report = computeEvalReport(evalRecords, CONTENT_TYPES);
  console.log(`Kayıt sayısı: ${report.total} (gerçek ilan örneği: ${report.realCount})`);
  if (report.realCount === 0) {
    console.log(
      'UYARI: Gerçek ilan (origin: "real") örneği yok. Aşağıdaki sayılar yalnızca başlık/sentetik regresyon içindir; gerçek precision/recall DEĞİLDİR.',
    );
  }
  console.log('\nSınıf                              destek  tahmin  doğru  precision  recall');
  for (const entry of report.classes) {
    const precision = entry.precision === null ? '—' : `${(entry.precision * 100).toFixed(1)}%`;
    const recall = entry.recall === null ? '—' : `${(entry.recall * 100).toFixed(1)}%`;
    console.log(
      `${entry.contentType.padEnd(34)} ${String(entry.support).padStart(6)} ${String(entry.predicted).padStart(7)} ${String(entry.truePositives).padStart(6)} ${precision.padStart(10)} ${recall.padStart(7)}`,
    );
  }
  console.log(`\nYanlış ilan kabulü oranı (ilan olmayan → ilan): ${formatRate(report.falseAcceptRate)}`);
  console.log(`Yanlış ret oranı (ilan → ilan değil):          ${formatRate(report.falseRejectRate)}`);
  if (report.falseAcceptIds.length > 0)
    console.log(`Yanlış kabul edilenler: ${report.falseAcceptIds.join(', ')}`);
}

main();
