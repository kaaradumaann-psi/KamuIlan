/**
 * Sınıflandırma değerlendirmesi: etiketli örnekleri çalıştırır ve sınıf bazında precision/recall
 * ile kritik oranları yazar.
 *
 *   npm run eval:classification                 → tests/fixtures/eval/labeled-set.json (yalnız kurallar)
 *   npm run eval:classification -- --file <yol> → başka etiketli dosya
 *   npm run eval:classification -- --llm        → kurallar + LLM kapısı (env'de LLM_CLASSIFIER_*
 *                                                  yapılandırması gereklidir; gerçek API çağrısı yapar)
 *
 * `--llm` modunda deterministik motorun `review` dediği örnekler LLM kapısından geçirilir;
 * kapının çözdüğü ve çözemediği örnek sayıları ayrıca raporlanır. Sağlayıcı hatasında örnek
 * `uncertain` kalır (üretim davranışıyla aynı).
 *
 * Gerçek ilan (origin: "real") örneği yoksa rapor bunu açıkça belirtir; metrik uydurulmaz.
 * Salt okunur: üretim veritabanına yazmaz (--llm modu geçici bir dosya deposu kullanır).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../src/classification/engine';
import { CONTENT_TYPES, type ContentType } from '../src/domain/types';
import { computeEvalReport, formatRate, type EvalRecord } from '../src/classification/eval';
import { getEnv } from '../src/config/env';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { createLogger } from '../src/lib/logger';
import { createLlmClassificationGate, llmClassifierConfig } from '../src/ai/classifier';

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

function printReport(evalRecords: EvalRecord[], realCount: number): void {
  const report = computeEvalReport(evalRecords, CONTENT_TYPES);
  console.log(`Kayıt sayısı: ${report.total} (gerçek ilan örneği: ${realCount})`);
  if (realCount === 0) {
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

async function main(): Promise<void> {
  const file = argValue('--file') ?? join(process.cwd(), 'tests/fixtures/eval/labeled-set.json');
  const useLlm = process.argv.includes('--llm');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records: LabeledRecord[] };

  const env = getEnv();
  let gateDir: string | null = null;
  let gateStore: FileStore | null = null;
  let gate: ReturnType<typeof createLlmClassificationGate> | null = null;
  if (useLlm) {
    if (!llmClassifierConfig(env)) {
      console.error(
        '--llm modu için LLM_CLASSIFIER_ENABLED=1 ve LLM_BASE_URL/LLM_API_KEY/LLM_CLASSIFIER_MODEL (veya LLM_MODEL) gereklidir.',
      );
      process.exitCode = 1;
      return;
    }
    gateDir = mkdtempSync(join(tmpdir(), 'kamuilan-eval-llm-'));
    gateStore = new FileStore(gateDir);
    await gateStore.init();
    const repos = createRepos(gateStore);
    gate = createLlmClassificationGate({
      repos,
      env,
      logger: createLogger('eval-llm', { level: 'warn' }),
    });
  }

  const evalRecords: EvalRecord[] = [];
  let reviewCount = 0;
  let llmResolved = 0;
  for (const record of parsed.records) {
    const body = record.body ?? (record.bodyKind === 'recruitment' ? RECRUITMENT_BODY : NEWS_BODY);
    const result = classify({ title: record.title, body, sourceCategory: record.sourceCategory });
    let predicted = result.contentType ?? ('uncertain' as ContentType);
    if (result.decision === 'review') {
      reviewCount += 1;
      if (gate) {
        const outcome = await gate.evaluate({
          title: record.title,
          body,
          sourceCategory: record.sourceCategory ?? null,
          sourceKey: 'eval',
          url: `https://eval.test/${encodeURIComponent(record.id)}`,
          base: result,
        });
        predicted = outcome.classification.contentType ?? 'uncertain';
        if (outcome.classification.decision !== 'review') llmResolved += 1;
      }
    }
    evalRecords.push({ id: record.id, expected: record.expectedContentType, predicted, origin: record.origin });
  }

  console.log(
    `Mod: ${useLlm ? 'kurallar + LLM kapısı (canlı sağlayıcı)' : 'yalnız kurallar (deterministik)'}\n`,
  );
  printReport(evalRecords, evalRecords.filter((r) => r.origin === 'real').length);
  if (useLlm && gate) {
    const summary = gate.summary();
    console.log(
      `\nLLM kapısı: ${reviewCount} belirsiz kaydın ${llmResolved} tanesini çözdü · ` +
        `${summary.calls} API çağrısı · ${summary.cacheHits} önbellek · ${summary.invalid} doğrulanamadı · ${summary.errors} hata`,
    );
    console.log('Not: --llm modu GERÇEK sağlayıcı çağrısı yapar; maliyet ve veri koşulları sağlayıcıya tabidir.');
  }

  if (gateStore) await gateStore.close();
  if (gateDir) rmSync(gateDir, { recursive: true, force: true });
}

await main();
