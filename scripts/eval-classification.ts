/**
 * Sınıflandırma ve alan çıkarımı değerlendirmesi: etiketli örnekleri çalıştırır ve
 * sınıf bazında precision/recall ile kritik oranları yazar.
 *
 *   npm run eval:classification                 → tests/fixtures/eval/labeled-set.json (yalnız kurallar)
 *   npm run eval:classification -- --file <yol> → başka etiketli dosya
 *   npm run eval:classification -- --llm --reviewed-public-data --max-calls 2 --max-output-tokens 128 --max-cost-usd 0.01
 *                                                → açık opt-in, scrub uygulanmış veriyle sınırlı gerçek provider değerlendirmesi
 *   npm run eval:classification -- --json r.json→ makine okunur tam rapor (ayrı dosyaya)
 *                                                  (yol verilmezse rapor YAZILMAZ ve uyarı basılır)
 *
 * `--llm` modunda deterministik motorun `review` dediği örnekler LLM kapısından geçirilir;
 * kapının çözdüğü ve çözemediği örnek sayıları, ölçülen gecikme/token/maliyet ayrıca
 * raporlanır. Sağlayıcı hatasında örnek `uncertain` kalır (üretim davranışıyla aynı).
 *
 * GERÇEK/SENTETİK AYRIMI: `origin: "real"` + `labelProvenance: "human"` olmayan hiçbir
 * kayıt gerçek başarı iddiası üretmez. Gerçek etiket yoksa rapor "VERİ YETERSİZ" yazar
 * ve oranlar `null` kalır; sentetik kümedeki %100 gerçek başarı sayılmaz.
 *
 * `--llm` modu yalnızca `--reviewed-public-data` ve zorunlu --max-calls/--max-output-tokens/
 * --max-cost-usd sınırlarıyla çalışır. LLM'ye gönderilen başlık/gövde PII-benzeri e-posta,
 * telefon ve 11 basamaklı kimlik numarasından scrub edilir; rules değerlendirmesi ham fixture
 * üzerinde kalır. Fiyat varsayımları `.env` içindeki pozitif LLM_*_USD_PER_MTOK alanlarıdır.
 * Yerel/izole bir sağlayıcı taklidi de açık bütçe bayrakları ister; rapor bunu gerçek sağlayıcı
 * testi diye sunmaz.
 *
 * Salt okunur: üretim veritabanına yazmaz (--llm modu geçici bir dosya deposu kullanır).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonOutputArg, writeJsonReport } from '../src/lib/json-output';
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
  const indexes = process.argv.flatMap((argument, index) => (argument === flag ? [index] : []));
  if (indexes.length > 1) throw new Error(`${flag} bir kez verilmelidir.`);
  return indexes.length === 1 ? (process.argv[indexes[0]! + 1] ?? null) : null;
}

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}` : value.padEnd(width);
}

function safeRecordId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function positiveIntegerOption(name: string, max: number): number | null {
  const raw = argValue(`--${name}`);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
}

function positiveUsdOption(name: string): number | null {
  const raw = argValue(`--${name}`);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 10 ? value : null;
}

function redactProviderUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '[INVALID-URL]';
  }
}

function scrubProviderText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
    .replace(/\b[1-9]\d{10}\b/g, '[TCKN-LIKE REDACTED]')
    .replace(/\b(?:\+90|0090|0)?[\s().-]*\(?5\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/g, '[PHONE REDACTED]')
    .replace(/([?&](?:token|access_token|api[_-]?key|apikey|session(?:id)?|sid|csrf|nonce|auth|password|secret)=)[^&\s"'<>#]+/gi, '$1[REDACTED]')
    .replace(/(authorization|x-goog-api-key|api[_-]?key|apikey|access_token|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}

function redactProviderDiagnostic(value: string, apiKey: string): string {
  return redactSecret(value, apiKey)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactProviderUrl(url))
    .replace(/(authorization|x-goog-api-key|api[_-]?key|apikey|access_token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
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
  const jsonArg = parseJsonOutputArg(process.argv);
  const useLlm = process.argv.includes('--llm');
  const budgetOptionsPresent = ['--max-calls', '--max-output-tokens', '--max-cost-usd'].some((flag) =>
    process.argv.includes(flag),
  );
  if (!useLlm && (budgetOptionsPresent || process.argv.includes('--reviewed-public-data'))) {
    console.error('LLM bütçe/inceleme bayrakları yalnızca --llm ile kullanılabilir; provider çağrısı yapılmadı.');
    process.exitCode = 2;
    return;
  }

  let maxLlmCalls: number | undefined;
  let maxOutputTokens: number | undefined;
  let maxCostUsd: number | undefined;
  if (useLlm) {
    maxLlmCalls = positiveIntegerOption('max-calls', 20) ?? undefined;
    maxOutputTokens = positiveIntegerOption('max-output-tokens', 900) ?? undefined;
    maxCostUsd = positiveUsdOption('max-cost-usd') ?? undefined;
    if (
      !process.argv.includes('--reviewed-public-data') ||
      maxLlmCalls === undefined ||
      maxOutputTokens === undefined ||
      maxCostUsd === undefined
    ) {
      console.error('Canlı eval için --llm --reviewed-public-data --max-calls 1..20 --max-output-tokens 1..900 --max-cost-usd <USD> zorunludur. Provider çağrısı yapılmadı.');
      process.exitCode = 2;
      return;
    }
  }

  const file = argValue('--file') ?? join(process.cwd(), 'tests/fixtures/eval/labeled-set.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records: LabeledRecord[] };

  const env = getEnv();
  if (useLlm && env.NODE_ENV === 'test') {
    console.error('NODE_ENV=test iken canlı eval provider çağrısı reddedildi.');
    process.exitCode = 2;
    return;
  }
  if (useLlm && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.error('TLS doğrulaması kapalı; canlı eval provider çağrısı reddedildi.');
    process.exitCode = 2;
    return;
  }
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
      maxCallsPerRun: maxLlmCalls,
      maxOutputTokens,
      runCostLimitUsd: maxCostUsd,
      logger: createLogger('eval-llm', { level: 'warn' }),
    });
  }

  const evalRecords: EvalRecord[] = [];
  const extracted = new Map<string, ExtractedJob>();
  const gateRows: GateScenarioOutcome[] = [];
  let reviewCount = 0;
  let llmResolved = 0;
  for (const record of parsed.records) {
    const reportId = safeRecordId(record.id);
    const body = record.body ?? (record.bodyKind === 'recruitment' ? RECRUITMENT_BODY : NEWS_BODY);
    const result = classify({ title: record.title, body, sourceCategory: record.sourceCategory });
    let predicted = result.contentType ?? ('uncertain' as ContentType);
    if (result.decision === 'review') {
      reviewCount += 1;
      if (gate) {
        const outcome = await gate.evaluate({
          title: scrubProviderText(record.title),
          body: scrubProviderText(body),
          sourceCategory: record.sourceCategory ?? null,
          sourceKey: 'eval',
          url: `https://eval.test/${reportId}`,
          base: result,
        });
        predicted = outcome.classification.contentType ?? 'uncertain';
        if (outcome.classification.decision !== 'review') llmResolved += 1;
        const verdict = outcome.opinion?.verdict ?? null;
        gateRows.push({
          id: reportId,
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
      id: reportId,
      expected: record.expectedContentType,
      predicted,
      origin: record.origin,
      labelProvenance: record.labelProvenance ?? (record.origin === 'real' ? 'human' : 'spec'),
      sourceKey: record.sourceKey ?? null,
    });
    extracted.set(record.id, extract({ title: record.title, body }));
  }

  const providerBaseUrl = redactProviderUrl(env.LLM_BASE_URL);
  const providerKind = /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?\//.test(`${env.LLM_BASE_URL}/`)
    ? 'yerel/izole uç nokta (doğrulama amaçlı; GERÇEK SAĞLAYICI TESTİ DEĞİLDİR)'
    : 'uzak sağlayıcı';
  console.log(
    `Mod: ${useLlm ? `kurallar + LLM kapısı — ${providerKind}` : 'yalnız kurallar (deterministik)'}` +
      (useLlm
        ? `\nSağlayıcı: ${providerBaseUrl} · model: ${env.LLM_CLASSIFIER_MODEL || env.LLM_MODEL} · ` +
          `azami çağrı ${maxLlmCalls}, çıktı ${maxOutputTokens} token, koşu maliyet tavanı ~$${maxCostUsd?.toFixed(6)} ` +
          '(muhafazakâr tahmin; sağlayıcı faturası değildir; girdi/çıktı fiyatları .env varsayımıdır)'
        : '') +
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
          .map((row) => redactProviderDiagnostic(String(row.error), env.LLM_API_KEY).replace(/\s+/g, ' ').trim().slice(0, 200)),
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

  if (jsonArg.mode === 'stdout') {
    // Sessiz kalmak yanıltıcıydı: kullanıcı raporun yazıldığını sandı (canlı kanıt 16.10.2026).
    console.log(
      '\n⚠ --json için dosya yolu verilmedi; makine okunur rapor YAZILMADI (ör. --json data\\ai-kapisi-sonuc.json).',
    );
  } else if (jsonArg.mode === 'dosya') {
    const written = writeJsonReport(jsonArg.path, {
      generatedAt: new Date().toISOString(),
      mode: useLlm ? 'rules+llm' : 'rules',
      provider: useLlm
        ? {
            baseUrl: providerBaseUrl,
            model: env.LLM_CLASSIFIER_MODEL || env.LLM_MODEL,
            kind: providerKind,
            redaction: 'email/TCKN-like/phone scrubbed before LLM; deterministic rules use fixture text',
            budgets: { maxCalls: maxLlmCalls, maxOutputTokens, maxEstimatedCostUsd: maxCostUsd },
          }
        : null,
      file,
      report,
      humanRealReport: realReport,
      llm: telemetry,
    });
    if (written.ok) {
      console.log(`\nMakine okunur rapor: ${written.path}`);
    } else {
      console.error(
        `\n✖ Makine okunur rapor YAZILAMADI (${jsonArg.path}): ${written.message}\n` +
          '  Klasörün var olduğundan emin olun (ör. data) ya da yolu tam verin.',
      );
      process.exitCode = 1;
    }
  }

  if (gateStore) await gateStore.close();
  if (gateDir) rmSync(gateDir, { recursive: true, force: true });
}

await main();
