/**
 * Sınıflandırma ve alan çıkarımı değerlendirmesi: etiketli örnekleri çalıştırır ve
 * sınıf bazında precision/recall ile kritik oranları yazar.
 *
 *   npm run eval:classification                 → tests/fixtures/eval/labeled-set.json (yalnız kurallar)
 *   npm run eval:classification -- --file <yol> → başka etiketli dosya
 *   npm run eval:classification -- --llm        → kurallar + LLM kapısı (env'de LLM_CLASSIFIER_*
 *                                                  yapılandırması gereklidir; gerçek API çağrısı yapar)
 *   npm run eval:classification -- --json r.json→ makine okunur tam rapor (ayrı dosyaya)
 *
 * `--llm` modunda deterministik motorun `review` dediği örnekler LLM kapısından geçirilir;
 * kapının çözdüğü ve çözemediği örnek sayıları, ölçülen gecikme/token/maliyet ayrıca
 * raporlanır. Sağlayıcı hatasında örnek `uncertain` kalır (üretim davranışıyla aynı).
 *
 * GERÇEK/SENTETİK AYRIMI: `origin: "real"` + `labelProvenance: "human"` olmayan hiçbir
 * kayıt gerçek başarı iddiası üretmez. Gerçek etiket yoksa rapor "VERİ YETERSİZ" yazar
 * ve oranlar `null` kalır; sentetik kümedeki %100 gerçek başarı sayılmaz.
 *
 * `--llm` modu gerçek sağlayıcıya gider. Yerel/izole bir sağlayıcı taklidiyle çalıştırmak
 * için LLM_BASE_URL'i o adrese verin (ör. http://127.0.0.1:8787/v1); rapor bunu
 * "doğrulama amaçlı yerel uç nokta" olarak etiketler — gerçek sağlayıcı testi diye sunmaz.
 *
 * Salt okunur: üretim veritabanına yazmaz (--llm modu geçici bir dosya deposu kullanır).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classify } from '../src/classification/engine';
import { CONTENT_TYPES, type ContentType } from '../src/domain/types';
import {
  assessGateScenario,
  computeEvalReport,
  computeHumanRealReport,
  formatRate,
  type EvalOrigin,
  type EvalRecord,
  type EvalReport,
  type GateScenarioOutcome,
} from '../src/classification/eval';
import { extract, type ExtractedJob } from '../src/extraction/engine';
import { getEnv } from '../src/config/env';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { createLogger } from '../src/lib/logger';
import { redactSecret } from '../src/ai/llm';
import { computeLlmTelemetry, createLlmClassificationGate, llmClassifierConfig, type LlmTelemetryStats } from '../src/ai/classifier';

const NEWS_BODY =
  'Kurum internet sitesinde yayımlanan haber metni. Ayrıntılar için kurum sayfasını ziyaret ediniz. Basın birimi tarafından paylaşılmıştır.';
const RECRUITMENT_BODY =
  'Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır. Kadro unvanı Bilişim Personeli. Kontenjan 2. Başvuru e-Devlet üzerinden yapılacaktır. Lisans mezunu olmak şartı aranır.';

interface LabeledRecord {
  id: string;
  origin: EvalOrigin;
  title: string;
  sourceCategory: string;
  bodyKind: 'news' | 'recruitment';
  expectedContentType: ContentType;
  /** Gerçek örneklerde gövde ilan metninden gelir; bu alan yalnızca sentetik kayıtlarda kullanılır. */
  body?: string;
  /** Kaynak anahtarı (gerçek kayıtlarda doldurulur; kaynak bazlı hata oranı için). */
  sourceKey?: string | null;
  /** Etiket provenansı; gerçek metrikler yalnızca 'human' ile iddia edilir. */
  labelProvenance?: 'human' | 'machine' | 'spec';
  /** İnsan tarafından doğrulanmış beklenen alanlar (alan çıkarımı doğruluğu için). */
  expectedFields?: Partial<Record<keyof ExtractedJob, string | number | null>>;
  /**
   * Bu senaryoda kabul EDİLMEMESİ gereken içerik türleri.
   * Örnek: istem enjeksiyonu metninde `personnel_recruitment` (uydurma alım kararı).
   */
  forbiddenContentTypes?: ContentType[];
  /** Senaryonun geçme kuralını açıklayan not (insan okur). */
  note?: string;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}` : value.padEnd(width);
}

function printReport(report: EvalReport): void {
  console.log(
    `Kayıt sayısı: ${report.total} · gerçek kaynaklı: ${report.sufficiency.realCount} ` +
      `(insan doğrulamalı: ${report.sufficiency.humanRealCount}) · sentetik/başlık: ${report.sufficiency.syntheticCount}`,
  );
  console.log('\nSınıf                              destek  tahmin  doğru  precision  recall       f1');
  for (const entry of report.classes) {
    const precision = entry.precision === null ? '—' : `${(entry.precision * 100).toFixed(1)}%`;
    const recall = entry.recall === null ? '—' : `${(entry.recall * 100).toFixed(1)}%`;
    const f1 = entry.f1 === null ? '—' : `${(entry.f1 * 100).toFixed(1)}%`;
    console.log(
      `${pad(entry.contentType, 34)} ${String(entry.support).padStart(6)} ${String(entry.predicted).padStart(7)} ` +
        `${String(entry.truePositives).padStart(6)} ${precision.padStart(10)} ${recall.padStart(7)} ${f1.padStart(8)}`,
    );
  }
  console.log(`\nYanlış kabul (ilan olmayan → ilan):      ${formatRate(report.falseAcceptRate)}`);
  console.log(`Yanlış ret (ilan → ilan değil):           ${formatRate(report.falseRejectRate)}`);
  console.log(`Belirsiz inceleme oranı (uncertain):      ${formatRate(report.uncertaintyRate)}`);
  if (report.falseAcceptIds.length > 0) console.log(`  yanlış kabul: ${report.falseAcceptIds.join(', ')}`);
  if (report.falseRejectIds.length > 0) console.log(`  yanlış ret:    ${report.falseRejectIds.join(', ')}`);

  if (report.byOrigin.length > 0) {
    console.log('\nOrigin kırılımı (sentetik sonuç gerçek başarı sayılmaz):');
    for (const entry of report.byOrigin) {
      console.log(
        `  ${pad(entry.origin, 12)} kayıt ${String(entry.total).padStart(3)} · insan etiketli ${String(entry.humanLabeled).padStart(3)} · ` +
          `yanlış kabul ${formatRate(entry.falseAcceptRate)} · yanlış ret ${formatRate(entry.falseRejectRate)} · ` +
          `belirsiz ${formatRate(entry.uncertainRate)}`,
      );
    }
  }

  const offDiagonal = report.confusion.filter((cell) => cell.expected !== cell.predicted);
  console.log('\nKarışıklık matrisi (beklenen → tahmin; sıfır olmayan hücreler):');
  for (const cell of report.confusion) {
    if (cell.expected === cell.predicted) continue;
    console.log(`  ${pad(cell.expected, 34)} → ${pad(cell.predicted, 34)} ${cell.count}`);
  }
  if (offDiagonal.length === 0) console.log('  (karışıklık yok: her beklenen sınıf kendi tahmininde)');

  if (report.bySource.length > 0) {
    console.log('\nKaynak bazında hata / boş (belirsiz) oranları:');
    for (const entry of report.bySource) {
      console.log(
        `  ${pad(entry.sourceKey, 28)} kayıt ${String(entry.total).padStart(3)} · hata ${String(entry.errors).padStart(3)} · ` +
          `belirsiz ${String(entry.uncertain).padStart(3)} · sorun oranı ${formatRate(entry.problemRate)}`,
      );
    }
  }

  if (!report.sufficiency.sufficient) {
    console.log('\n⚠ VERİ YETERSİZ — yukarıdaki oranlar gerçek dünya doğruluğu olarak SUNULAMAZ:');
    for (const reason of report.sufficiency.reasons) console.log(`   · ${reason}`);
  }
}

function printFieldAccuracy(records: readonly LabeledRecord[], extracted: Map<string, ExtractedJob>): void {
  const withFields = records.filter((record) => record.expectedFields && Object.keys(record.expectedFields).length > 0);
  if (withFields.length === 0) {
    console.log(
      '\nAlan çıkarımı doğruluğu: ÖLÇÜLEMEDİ — etiketli kümede insan doğrulamalı beklenen alan yok ' +
        '(expectedFields). Kurum/unvan/şehir/kontenjan/tarih/başvuru bağlantısı doğruluğu için ' +
        'gerçek kayıt etiketlemesi gerekir (npm run eval:build-set).',
    );
    return;
  }
  const fields = [...new Set(withFields.flatMap((record) => Object.keys(record.expectedFields ?? {})))].sort();
  console.log(`\nAlan çıkarımı doğruluğu (${withFields.length} etiketli kayıt, ${fields.length} alan):`);
  for (const field of fields) {
    let checked = 0;
    let correct = 0;
    let missing = 0;
    for (const record of withFields) {
      const expected = record.expectedFields?.[field as keyof ExtractedJob];
      if (expected === undefined) continue;
      checked += 1;
      const actual = extracted.get(record.id)?.[field as keyof ExtractedJob];
      if (actual === null || actual === undefined || (Array.isArray(actual) && actual.length === 0)) missing += 1;
      if (String(actual ?? '') === String(expected ?? '')) correct += 1;
    }
    const rate = checked === 0 ? '—' : `${((correct / checked) * 100).toFixed(1)}%`;
    console.log(`  ${pad(field, 24)} doğrulanan ${String(checked).padStart(3)} · doğru ${String(correct).padStart(3)} · boş ${String(missing).padStart(3)} · ${rate}`);
  }
  console.log('  Not: yalnızca İNSAN tarafından doğrulanmış beklenen değerler kullanılır; çıkarımın kendi çıktısı etiket sayılmaz.');
}

async function main(): Promise<void> {
  const file = argValue('--file') ?? join(process.cwd(), 'tests/fixtures/eval/labeled-set.json');
  const jsonOut = argValue('--json');
  const useLlm = process.argv.includes('--llm');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records: LabeledRecord[] };

  const env = getEnv();
  let gateDir: string | null = null;
  let gateStore: FileStore | null = null;
  let gate: ReturnType<typeof createLlmClassificationGate> | null = null;
  let gateRepos: ReturnType<typeof createRepos> | null = null;
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
    gateRepos = createRepos(gateStore);
    gate = createLlmClassificationGate({
      repos: gateRepos,
      env,
      logger: createLogger('eval-llm', { level: 'warn' }),
    });
  }

  const evalRecords: EvalRecord[] = [];
  const extracted = new Map<string, ExtractedJob>();
  const gateRows: GateScenarioOutcome[] = [];
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
        const verdict = outcome.opinion?.verdict ?? null;
        gateRows.push({
          id: record.id,
          expected: record.expectedContentType,
          predicted,
          verdict,
          decision: outcome.classification.decision,
          evidenceVerified:
            (verdict === 'ilan' || verdict === 'surec' || verdict === 'ilan-degil') &&
            outcome.opinion?.contentType != null,
          forbidden: record.forbiddenContentTypes ?? [],
        });
      }
    }
    evalRecords.push({
      id: record.id,
      expected: record.expectedContentType,
      predicted,
      origin: record.origin,
      labelProvenance: record.labelProvenance ?? (record.origin === 'real' ? 'human' : 'spec'),
      sourceKey: record.sourceKey ?? null,
    });
    extracted.set(record.id, extract({ title: record.title, body }));
  }

  const providerKind = /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?\//.test(`${env.LLM_BASE_URL}/`)
    ? 'yerel/izole uç nokta (doğrulama amaçlı; GERÇEK SAĞLAYICI TESTİ DEĞİLDİR)'
    : 'uzak sağlayıcı';
  console.log(
    `Mod: ${useLlm ? `kurallar + LLM kapısı — ${providerKind}` : 'yalnız kurallar (deterministik)'}` +
      (useLlm ? `\nSağlayıcı: ${env.LLM_BASE_URL} · model: ${env.LLM_CLASSIFIER_MODEL || env.LLM_MODEL}` : '') +
      `\nKüme: ${file}\n`,
  );
  const report = computeEvalReport(evalRecords, CONTENT_TYPES);
  printReport(report);

  // Yalnızca insan doğrulamalı gerçek kayıtlarla ayrı rapor: karışık yüzdeyi gerçek
  // dünya doğruluğu gibi göstermemek için metrikler ayrıca hesaplanır.
  const realReport = computeHumanRealReport(evalRecords, CONTENT_TYPES);
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log('İnsan doğrulamalı GERÇEK kayıtlarla metrikler (asıl ölçüt budur):');
  if (!realReport) {
    console.log(
      '  VERİ YETERSİZ — origin "real" + labelProvenance "human" kaydı yok. Precision/recall ' +
        'iddiası üretilmiyor. Küme kurulumu: npm run eval:build-set (bkz. docs/eval-gercek-veri.md).',
    );
  } else {
    console.log(
      `  kayıt ${realReport.total} · yanlış kabul ${formatRate(realReport.falseAcceptRate)} · ` +
        `yanlış ret ${formatRate(realReport.falseRejectRate)} · belirsiz ${formatRate(realReport.uncertaintyRate)}`,
    );
  }
  printFieldAccuracy(parsed.records, extracted);

  let telemetry: LlmTelemetryStats | null = null;
  if (useLlm && gate && gateRepos) {
    const summary = gate.summary();
    const rows = await gateRepos.store.find('llmAnalyses', {}, { limit: 5_000, sort: [['createdAt', -1]] });
    telemetry = computeLlmTelemetry(rows, env);
    console.log('\nLLM kapısı ölçümü (yalnızca bu koşumda yapılan çağrılar):');
    console.log(
      `  belirsiz kayıt ${reviewCount} · çözülen ${llmResolved} · API çağrısı ${summary.calls} ` +
        `(belirsiz kayda oran ${reviewCount > 0 ? ((summary.calls / reviewCount) * 100).toFixed(1) : '0.0'}%) · ` +
        `önbellek isabeti ${summary.cacheHits} · bütçe/kota engeli ${summary.blocked}`,
    );
    console.log(
      `  kararlar: ilan ${summary.upgradedToJob} · süreç ${summary.upgradedToProcess} · ` +
        `kanıtlı ret ${summary.rejected} · belirsiz kaldı ${summary.keptReview} · doğrulanamadı ${summary.invalid} · hata ${summary.errors}`,
    );
    const latency = telemetry.latency;
    console.log(
      `  gecikme: n=${latency.count} ortalama ${latency.avgMs ?? '—'} ms · p50 ${latency.p50Ms ?? '—'} ms · ` +
        `p95 ${latency.p95Ms ?? '—'} ms · en yüksek ${latency.maxMs ?? '—'} ms`,
    );
    console.log(
      `  token: ${telemetry.tokens.prompt} girdi + ${telemetry.tokens.completion} çıktı ` +
        `(kullanım bildiren çağrı oranı ${telemetry.tokens.reportedShare === null ? '—' : `${(telemetry.tokens.reportedShare * 100).toFixed(0)}%`}) · ` +
        `hata oranı ${formatRate(telemetry.errorRate)}`,
    );
    console.log(
      `  maliyet: ${telemetry.cost.usd === null ? 'raporlanmadı' : `~$${telemetry.cost.usd.toFixed(4)}`} · ${telemetry.cost.note}`,
    );
    if (gateRows.length > 0) {
      console.log('\nSenaryo bazında kapı kararı (bu koşum):');
      for (const row of gateRows) {
        const assessment = assessGateScenario(row);
        const etiket =
          assessment === 'uygun' ? '✓ uygun' : assessment === 'uygunsuz' ? '✗ UYGUNSUZ' : '· kapı çalışmadı';
        console.log(
          `  ${pad(row.id, 20)} beklenen ${pad(row.expected, 30)} model kararı ${pad(String(row.verdict ?? '—'), 16)}` +
            ` çıktı ${pad(row.predicted, 30)} kayıt ${pad(row.decision, 9)} ${etiket}`,
        );
      }
      const sayim = {
        uygun: gateRows.filter((row) => assessGateScenario(row) === 'uygun').length,
        uygunsuz: gateRows.filter((row) => assessGateScenario(row) === 'uygunsuz').length,
        kapicalismadi: gateRows.filter((row) => assessGateScenario(row) === 'kapi-calismadi').length,
      };
      console.log(
        `  Özet: uygun ${sayim.uygun} · UYGUNSUZ ${sayim.uygunsuz} · kapı çalışmadı ${sayim.kapicalismadi}` +
          ` (kapı çalışmadıysa kayıt incelemede kalır; uydurma bilgi yazılmaz)`,
      );
      if (sayim.kapicalismadi > 0) {
        console.log('  Kapının çalışmadığı senaryolarda sağlayıcı hatası varsa koşumu yoğunluk geçtikten sonra YİNELEYİN.');
      }
    }
    const errorTexts = [
      ...new Set(
        rows
          .filter((row) => row.status !== 'ok' && (row.error ?? '').trim().length > 0)
          .map((row) => redactSecret(String(row.error), env.LLM_API_KEY).replace(/\s+/g, ' ').trim().slice(0, 200)),
      ),
    ];
    if (errorTexts.length > 0) {
      console.log('\nBu koşumdaki sağlayıcı hataları (anahtar maskeli, en fazla 3 farklı metin):');
      for (const text of errorTexts.slice(0, 3)) console.log(`  · ${text}`);
    }
    console.log('Not: --llm modu GERÇEK sağlayıcı çağrısı yapar; maliyet ve veri koşulları sağlayıcıya tabidir.');
  } else if (useLlm === false) {
    console.log(
      '\nLLM kapısı ölçümü: yapılmadı (--llm verilmedi). Kurallarla karşılaştırmalı ölçüm için: ' +
        'npm run eval:classification -- --llm',
    );
  }

  if (jsonOut) {
    writeFileSync(
      resolve(jsonOut),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: useLlm ? 'rules+llm' : 'rules',
          provider: useLlm ? { baseUrl: env.LLM_BASE_URL, model: env.LLM_CLASSIFIER_MODEL || env.LLM_MODEL, kind: providerKind } : null,
          file,
          report,
          humanRealReport: realReport,
          llm: telemetry,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\nMakine okunur rapor: ${jsonOut}`);
  }

  if (gateStore) await gateStore.close();
  if (gateDir) rmSync(gateDir, { recursive: true, force: true });
}

await main();
