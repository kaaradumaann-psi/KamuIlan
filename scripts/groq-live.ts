/**
 * Groq canlı denemesi: `npm run llm:groq`
 *
 * Neden var: #59 ile gelen model zinciri (`LLM_CLASSIFIER_FALLBACK_MODELS`) yalnız sahte
 * sağlayıcıyla test edildi. Bu betik kullanıcının Groq anahtarıyla, sınırlı sayıda gerçek
 * çağrıyla şunları ölçer:
 *   (a) GET /models → üç modelin erişilebilirliği (listede yoksa "ERİŞİLEMEZ", sessizce kullanılmaz)
 *   (b) model başına 1 küçük JSON çağrısı → gecikme, token, finish_reason, x-ratelimit-* başlıkları
 *   (c) `eval:classification --llm` alt süreci (en fazla 10 çağrı)
 *   (d) gerçek tarama hattı (`runSourceScrape`) + sahte adaptör + GERÇEK LLM kapısı (geçici FileStore)
 *
 * Anahtar: `GROQ_API_KEY` ortamda varsa o kullanılır; yoksa terminalde ekrana basılmadan
 * (ham mod) istenir. Anahtar YALNIZ bellekte tutulur: dosyaya, argümana veya loga yazılmaz;
 * alt sürece yalnız `LLM_API_KEY` ortam değişkeniyle geçer. Tüm çıktılar `redactSecret`'ten geçer.
 * 401/403 görülürse hiçbir model denenmeye devam edilmez.
 *
 * Çıkış kodları: 0 tamam · 1 adım hatası · 2 anahtar yok/iptal (hiç çağrı yok) · 3 anahtar reddedildi.
 * Rapor (anahtarsız): `.staging/groq-live/rapor-<zaman>.json` (git dışı).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnv } from '../src/config/env';
import type { SourceDefinition } from '../src/config/sources';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import type { JobDoc, LlmAnalysisDoc, SourceItemDecisionDoc } from '../src/db/schemas';
import type { RawAnnouncement } from '../src/domain';
import { createLlmClassificationGate, resetUnavailableLlmModels } from '../src/ai/classifier';
import { callChatCompletion, redactSecret, type LlmFetch, type LlmRateLimitInfo } from '../src/ai/llm';
import { runSourceScrape } from '../src/ingest/pipeline';
import { createLogger } from '../src/lib/logger';
import type { SourceAdapter } from '../src/sources/types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** Kullanıcının belirlediği sıra: ana model, sonra yedekler. */
export const GROQ_MODELS = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b'] as const;
/** gpt-oss akıl yürütme tokenı harcar; 256 kesilirse `finish_reason=length` raporlanır. */
export const PROBE_MAX_TOKENS = 256;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * Bütçe freni için muhafazakâr fiyat varsayımı (USD/Mtok). Ücretsiz planda fatura yoktur; bu değer
 * yalnız kapının `--max-cost-usd` sınırını hesaplayabilmesi içindir (fiyat bilgisi olmadan USD
 * sınırlı kapı çağrı yapmaz). Üç modelin Groq liste fiyatlarından yüksek tutuldu; DOĞRULANMADI.
 */
export const BUDGET_PRICE_INPUT_USD_PER_MTOK = '0.5';
export const BUDGET_PRICE_OUTPUT_USD_PER_MTOK = '1';
const EVAL_ARGS = [
  '--llm',
  '--reviewed-public-data',
  '--max-calls',
  '10',
  '--max-output-tokens',
  '512',
  '--max-cost-usd',
  '0.1',
] as const;
/** Koşu USD tavanı (varsayımsal fiyatla; `.env`'deki daha küçük değerler sonucu etkilemesin diye açıkça verilir). */
const RUN_COST_LIMIT_USD = '0.1';

export interface HiddenInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeListener(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'end', listener: () => void): unknown;
}

export interface Output {
  write(text: string): unknown;
}

export type KeyResolution =
  | { key: string; source: 'env' | 'prompt' }
  | { key: null; reason: 'no-tty' | 'empty' | 'cancelled' };

/**
 * Terminalden ekrana basmadan satır okur. Enter → bitir, Ctrl+C/Ctrl+D (boşken) → iptal,
 * Backspace → son karakteri sil. Diğer denetim karakterleri yok sayılır.
 */
export function promptHidden(stdin: HiddenInput, out: Output, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    out.write(prompt);
    const finish = (result: string | null): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.setRawMode?.(false);
      stdin.pause();
      out.write('\n');
      resolve(result);
    };
    const onEnd = (): void => finish(null);
    const onData = (chunk: string | Buffer): void => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') return finish(value);
        if (char === '\u0003') return finish(null);
        if (char === '\u0004') return finish(value.length > 0 ? value : null);
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char < ' ') continue;
        value += char;
      }
    };
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume();
  });
}

export async function resolveGroqKey(deps: {
  env: Record<string, string | undefined>;
  stdin: HiddenInput;
  out: Output;
}): Promise<KeyResolution> {
  const fromEnv = deps.env.GROQ_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  if (!deps.stdin.isTTY || typeof deps.stdin.setRawMode !== 'function') return { key: null, reason: 'no-tty' };
  const typed = await promptHidden(deps.stdin, deps.out, 'Groq API anahtarı (ekranda görünmez, Enter ile bitir): ');
  if (typed === null) return { key: null, reason: 'cancelled' };
  const key = typed.trim();
  return key ? { key, source: 'prompt' } : { key: null, reason: 'empty' };
}

export type ModelListResult =
  | { ok: true; status: number; elapsedMs: number; ids: string[] }
  | { ok: false; status: number | null; elapsedMs: number; auth: boolean; detail: string };

export async function listGroqModels(key: string, fetchImpl: LlmFetch): Promise<ModelListResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${GROQ_BASE_URL}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    } as never);
    const text = await response.text();
    const elapsedMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, elapsedMs, auth: true, detail: redactSecret(text.slice(0, 240), key) };
    }
    if (response.status !== 200) {
      return { ok: false, status: response.status, elapsedMs, auth: false, detail: redactSecret(text.slice(0, 240), key) };
    }
    const parsed = JSON.parse(text) as { data?: { id?: unknown }[] };
    const ids = (parsed.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
    return { ok: true, status: 200, elapsedMs, ids };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, elapsedMs: Date.now() - started, auth: false, detail: redactSecret(detail, key) };
  }
}

export interface ProbeReport {
  model: string;
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Çıktı tokenlarının akıl yürütmeye giden kısmı (`completion_tokens_details.reasoning_tokens`). */
  reasoningTokens: number | null;
  rateLimit: LlmRateLimitInfo | null;
  failureCategory: string | null;
  detail: string;
}

export async function probeModel(key: string, model: string, fetchImpl: LlmFetch): Promise<ProbeReport> {
  const started = Date.now();
  const result = await callChatCompletion(
    { baseUrl: GROQ_BASE_URL, apiKey: key, model, timeoutMs: PROBE_TIMEOUT_MS },
    [
      { role: 'system', content: 'Bağlantı denetimi. Yalnızca şu JSON nesnesini döndür: {"durum":"hazir"}' },
      { role: 'user', content: 'durum?' },
    ],
    { fetchImpl, maxTokens: PROBE_MAX_TOKENS, temperature: 0, jsonMode: true, transport: 'openai-compat' },
  );
  const elapsedMs = Date.now() - started;
  if (result.ok) {
    return {
      model,
      ok: true,
      status: result.status,
      elapsedMs,
      finishReason: result.finishReason ?? null,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      reasoningTokens: result.thoughtsTokens ?? null,
      rateLimit: result.rateLimit ?? null,
      failureCategory: null,
      detail: redactSecret(result.content.slice(0, 120), key),
    };
  }
  return {
    model,
    ok: false,
    status: result.status,
    elapsedMs,
    finishReason: result.diagnostics?.finishReason ?? null,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    rateLimit: result.diagnostics?.rateLimit ?? null,
    failureCategory: result.failureCategory ?? null,
    detail: redactSecret(result.reason, key),
  };
}

function formatRateLimit(info: LlmRateLimitInfo | null): string {
  if (!info) return 'hız sınırı başlığı yok';
  const part = (remaining: number | null, limit: number | null, resetMs: number | null): string =>
    `${remaining ?? '?'}/${limit ?? '?'}${resetMs !== null ? ` (sıfırlama ${Math.round(resetMs / 1000)} sn)` : ''}`;
  return (
    `istek(gün) ${part(info.remainingRequests, info.limitRequests, info.resetRequestsMs)} · ` +
    `token(dk) ${part(info.remainingTokens, info.limitTokens, info.resetTokensMs)}` +
    (info.retryAfterMs !== null ? ` · retry-after ${Math.round(info.retryAfterMs / 1000)} sn` : '')
  );
}

/** Uygulama kapısı ve eval alt süreci için ortak ortam (anahtar yalnız burada). */
export function gateEnvOverrides(key: string, models: readonly string[]): Record<string, string> {
  return {
    NODE_ENV: 'development',
    LLM_CLASSIFIER_ENABLED: '1',
    LLM_BASE_URL: GROQ_BASE_URL,
    LLM_API_KEY: key,
    LLM_CLASSIFIER_MODEL: models[0] ?? '',
    LLM_CLASSIFIER_FALLBACK_MODELS: models.slice(1).join(','),
    LLM_COST_USD_PER_MTOK_INPUT: BUDGET_PRICE_INPUT_USD_PER_MTOK,
    LLM_COST_USD_PER_MTOK_OUTPUT: BUDGET_PRICE_OUTPUT_USD_PER_MTOK,
    LLM_RUN_COST_LIMIT_USD: RUN_COST_LIMIT_USD,
    LLM_DAILY_COST_LIMIT_USD: RUN_COST_LIMIT_USD,
    LLM_RETRY_MAX: '1',
    LLM_MAX_CONCURRENCY: '1',
  };
}

export interface EvalRunResult {
  exitCode: number | null;
  elapsedMs: number;
  output: string;
}

/** `eval:classification --llm` alt süreci; çıktı satır satır maskelenerek aktarılır. */
export function runEvalSubprocess(key: string, models: readonly string[], out: Output): Promise<EvalRunResult> {
  const started = Date.now();
  const env: Record<string, string | undefined> = { ...process.env, ...gateEnvOverrides(key, models) };
  delete env.GROQ_API_KEY;
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'scripts/eval-classification.ts', ...EVAL_ARGS], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const relay = (chunk: Buffer): void => {
      const text = redactSecret(chunk.toString('utf8'), key);
      output += text;
      out.write(text);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (error) => {
      const text = redactSecret(`alt süreç başlatılamadı: ${error.message}\n`, key);
      output += text;
      out.write(text);
    });
    child.on('close', (code) => resolve({ exitCode: code, elapsedMs: Date.now() - started, output }));
  });
}

const SCRAPE_DEFINITION: SourceDefinition = {
  key: 'groq-canli-deneme',
  name: 'Groq canlı deneme kaynağı',
  group: 'kurum',
  sourceType: 'institution-page',
  institution: 'Deneme Kurumu',
  homepageUrl: 'https://deneme.test/',
  listingUrl: 'https://deneme.test/duyurular',
  adapterKey: 'groq-canli-adapter',
  method: 'html-list',
  status: 'method-defined',
  statusNote: 'Yalnızca npm run llm:groq için.',
  lastVerifiedAt: null,
  verificationEvidence: 'scripts/groq-live.ts',
  coverageNote: 'Sentetik.',
  enabled: true,
  intervalMinutes: 60,
  minRequestIntervalMs: 0,
  maxConcurrency: 1,
  allowedHosts: ['deneme.test'],
  tags: ['deneme'],
};

function syntheticItem(id: string, title: string, bodyText: string): RawAnnouncement {
  return {
    sourceKey: SCRAPE_DEFINITION.key,
    sourceItemId: id,
    url: `https://deneme.test/duyuru/${id}`,
    title,
    bodyText,
    bodyTextSource: 'detail',
    institution: 'Deneme Kurumu',
    publishedAt: new Date().toISOString().slice(0, 10),
    attachments: [],
    extractionConfidence: 0.6,
  };
}

/**
 * Kuralların `review` dediği sentetik (kişi adı içermeyen) metinler; başlıklar bilerek belirsiz.
 * Beklenen: alım → ilan, toplantı haberi → ret, sınav aşaması → süreç, işçi alımı → ilan.
 */
export const SCRAPE_ITEMS: RawAnnouncement[] = [
  syntheticItem(
    'alim',
    'Önemli Duyuru',
    'Kurumumuz merkez teşkilatında istihdam edilmek üzere 5 (beş) sözleşmeli personel alımı yapılacaktır. ' +
      'Başvurular 01.11.2026 - 15.11.2026 tarihleri arasında e-Devlet üzerinden alınacaktır. ' +
      'Adayların lisans mezunu olması ve KPSS P3 puan türünden en az 70 puan almış olması gerekmektedir.',
  ),
  syntheticItem(
    'haber',
    'Akademik birimlerde toplantı yapıldı',
    'Rektörümüz, üniversitemiz akademik birimlerini ziyaret ederek kadro planlaması hakkında görüş alışverişinde bulunmuştur. ' +
      'Ziyaret kapsamında yapılan toplantıda önümüzdeki döneme ilişkin personel alımı planları değerlendirilmiştir. ' +
      'Basın ve halkla ilişkiler birimi tarafından paylaşılmıştır.',
  ),
  syntheticItem(
    'surec',
    'Kurumumuzdan sınav hakkında duyuru',
    'Sözleşmeli destek personeli alımı kapsamında yapılacak sınava ilişkin bilgiler aşağıda yer almaktadır. ' +
      'Sözlü sınav sonuçları kurum internet sitesinde ilan edilecektir. Adaylara ayrıca tebligat yapılmayacaktır. ' +
      'Sınav yeri ve saati değişmemiştir.',
  ),
  syntheticItem(
    'isci',
    'Duyuru',
    'Kurumumuz bünyesinde 4857 sayılı İş Kanunu kapsamında çalıştırılmak üzere 3 (üç) temizlik görevlisi ' +
      'Türkiye İş Kurumu aracılığıyla alınacaktır. Başvurular 05.11.2026 tarihine kadar İŞKUR internet sitesi ' +
      'üzerinden yapılacaktır. Adayların en az ilköğretim mezunu olması gerekmektedir.',
  ),
];

export interface ScrapeIntegrationReport {
  status: string;
  jobsCreated: number;
  itemsReview: number;
  itemsRejected: number;
  llm: Record<string, unknown>;
  jobs: { title: string; kind: string; decision: string; model: string | null; evidenceVerified: boolean | null }[];
  decisions: { sourceItemId: string; decision: string }[];
  analyses: {
    url: string;
    model: string;
    status: string;
    verdict: string | null;
    latencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    error: string | null;
  }[];
}

export async function runScrapeIntegration(
  key: string,
  models: readonly string[],
  fetchImpl?: LlmFetch,
): Promise<ScrapeIntegrationReport> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-groq-live-'));
  const store = new FileStore(dir);
  try {
    await store.init();
    const repos = createRepos(store);
    await repos.sources.seed([SCRAPE_DEFINITION]);
    const source = await repos.sources.getByKey(SCRAPE_DEFINITION.key);
    if (!source) throw new Error('deneme kaynağı oluşturulamadı');
    const adapter: SourceAdapter = {
      key: SCRAPE_DEFINITION.adapterKey,
      label: 'Groq canlı deneme adaptörü',
      method: 'html-list',
      notes: 'sentetik',
      run: async () => ({
        items: SCRAPE_ITEMS,
        requestCount: 0,
        notes: [],
        etag: null,
        lastModified: null,
        notModified: false,
        coverage: { status: 'complete' as const, note: 'Sentetik kapsam.' },
      }),
    };
    const logger = createLogger('groq-live', { level: 'warn' });
    const gate = createLlmClassificationGate({
      repos,
      env: getEnv({ ...gateEnvOverrides(key, models), LLM_MAX_CALLS_PER_RUN: '12' }),
      logger,
      maxCallsPerRun: 12,
      maxOutputTokens: 512,
      runCostLimitUsd: Number(RUN_COST_LIMIT_USD),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    // Probe/eval adımlarındaki model atlamaları bu süreçte birikmesin (kapı ölçümü bağımsız olsun).
    resetUnavailableLlmModels();
    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: 'groq-live',
      adapter,
      llmGate: gate,
      queueNotifications: false,
      logger,
    });
    const jobs: JobDoc[] = await repos.store.find('jobs', {});
    const decisions: SourceItemDecisionDoc[] = await repos.jobs.listSourceItemDecisions(SCRAPE_DEFINITION.key);
    const analyses: LlmAnalysisDoc[] = await repos.store.find('llmAnalyses', {});
    return {
      status: result.status,
      jobsCreated: result.jobsCreated,
      itemsReview: result.itemsReview,
      itemsRejected: result.itemsRejected,
      llm: { ...result.llm },
      jobs: jobs.map((job) => ({
        title: job.title,
        kind: job.classification.kind,
        decision: job.classification.decision,
        model: job.classification.llm?.model ?? null,
        evidenceVerified: job.classification.llm?.evidenceVerified ?? null,
      })),
      decisions: decisions.map((entry) => ({ sourceItemId: entry.sourceItemId, decision: entry.decision })),
      analyses: analyses.map((row) => ({
        url: row.url,
        model: row.model,
        status: row.status,
        verdict: row.verdict,
        latencyMs: row.latencyMs,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        error: row.error ? redactSecret(row.error, key) : null,
      })),
    };
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface GroqLiveDeps {
  env: Record<string, string | undefined>;
  stdin: HiddenInput;
  out: Output;
  fetchImpl: LlmFetch;
  runEval: (key: string, models: readonly string[], out: Output) => Promise<EvalRunResult>;
  runScrape: (key: string, models: readonly string[]) => Promise<ScrapeIntegrationReport>;
  /** Raporu yazar (anahtar önceden maskelenmiş JSON metni); testlerde bellekte tutulur. */
  writeReport: (json: string) => string | null;
}

export async function runGroqLive(deps: GroqLiveDeps): Promise<number> {
  const { out } = deps;
  const resolution = await resolveGroqKey(deps);
  if (resolution.key === null) {
    const message =
      resolution.reason === 'no-tty'
        ? 'Terminal (TTY) yok ve GROQ_API_KEY tanımlı değil. Kendi PowerShell penceresinde çalıştır:\n' +
          '  cd D:\\coding\\claude\\kamuradar; npm run llm:groq\n'
        : resolution.reason === 'empty'
          ? 'Boş anahtar girildi.\n'
          : 'İptal edildi.\n';
    out.write(`${message}Hiçbir sağlayıcı çağrısı yapılmadı.\n`);
    return 2;
  }
  const key = resolution.key;
  const say = (text: string): void => {
    out.write(redactSecret(text, key));
  };
  say(`Anahtar alındı (${resolution.source === 'env' ? 'GROQ_API_KEY' : 'gizli giriş'}, ${key.length} karakter).\n`);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), baseUrl: GROQ_BASE_URL, models: GROQ_MODELS };
  let exitCode = 0;

  say('\n(a) Model listesi: GET /models\n');
  const listed = await listGroqModels(key, deps.fetchImpl);
  report.modelList = listed.ok ? { ...listed, ids: listed.ids.filter((id) => (GROQ_MODELS as readonly string[]).includes(id)) } : listed;
  if (!listed.ok) {
    say(`  BAŞARISIZ: HTTP ${listed.status ?? 'yok'} (${listed.elapsedMs} ms) — ${listed.detail}\n`);
    if (listed.auth) {
      say('  Anahtar reddedildi (401/403). Model denemesi YAPILMADI. Anahtarı console.groq.com/keys üzerinden doğrula.\n');
      deps.writeReport(redactSecret(JSON.stringify({ ...report, exitCode: 3 }, null, 2), key));
      return 3;
    }
    deps.writeReport(redactSecret(JSON.stringify({ ...report, exitCode: 1 }, null, 2), key));
    return 1;
  }
  const available = GROQ_MODELS.filter((model) => listed.ids.includes(model));
  for (const model of GROQ_MODELS) {
    say(`  ${model}: ${available.includes(model) ? 'erişilebilir' : 'ERİŞİLEMEZ (listede yok; kullanılmayacak)'}\n`);
  }
  say(`  (${listed.ids.length} model listelendi, ${listed.elapsedMs} ms)\n`);
  if (available.length === 0) {
    say('Hiçbir hedef model erişilebilir değil; sonraki adımlar atlandı.\n');
    deps.writeReport(redactSecret(JSON.stringify({ ...report, exitCode: 1 }, null, 2), key));
    return 1;
  }

  say(`\n(b) Model başına 1 JSON çağrısı (max_tokens ${PROBE_MAX_TOKENS})\n`);
  const probes: ProbeReport[] = [];
  for (const model of available) {
    const probe = await probeModel(key, model, deps.fetchImpl);
    probes.push(probe);
    const tokens =
      `token ${probe.promptTokens ?? '?'} girdi / ${probe.completionTokens ?? '?'} çıktı` +
      (probe.reasoningTokens !== null ? ` (akıl yürütme ${probe.reasoningTokens})` : '');
    say(
      `  ${model}: ${probe.ok ? 'OK' : `HATA (${probe.failureCategory ?? '?'})`} · HTTP ${probe.status ?? 'yok'} · ` +
        `${probe.elapsedMs} ms · ${tokens} · finish_reason ${probe.finishReason ?? '?'}\n` +
        `    ${formatRateLimit(probe.rateLimit)}\n` +
        `    ${probe.ok ? 'yanıt' : 'ayrıntı'}: ${probe.detail}\n`,
    );
    if (probe.ok && probe.finishReason === 'length') {
      say('    UYARI: yanıt token sınırında kesildi (akıl yürütme tokenları bütçeyi tüketmiş olabilir).\n');
    }
    if (probe.failureCategory === 'auth') {
      say('  Anahtar reddedildi (401/403); diğer modeller DENENMEDİ.\n');
      report.probes = probes;
      deps.writeReport(redactSecret(JSON.stringify({ ...report, exitCode: 3 }, null, 2), key));
      return 3;
    }
  }
  report.probes = probes;
  const chain = available.filter((model) => probes.find((probe) => probe.model === model)?.ok);
  if (chain.length === 0) {
    say('Hiçbir model başarılı yanıt vermedi; eval ve tarama adımları atlandı.\n');
    deps.writeReport(redactSecret(JSON.stringify({ ...report, exitCode: 1 }, null, 2), key));
    return 1;
  }
  say(`  Kullanılacak zincir: ${chain.join(' → ')}\n`);

  say(`\n(c) eval:classification ${EVAL_ARGS.join(' ')}\n`);
  const evalResult = await deps.runEval(key, chain, out);
  report.eval = { exitCode: evalResult.exitCode, elapsedMs: evalResult.elapsedMs, outputTail: evalResult.output.slice(-6_000) };
  say(`  eval çıkış kodu ${evalResult.exitCode ?? 'yok'} (${evalResult.elapsedMs} ms)\n`);
  if (evalResult.exitCode !== 0) exitCode = 1;

  say('\n(d) Tarama hattı + gerçek LLM kapısı (geçici dosya DB, sentetik 4 kayıt, bildirim yok)\n');
  try {
    const scrape = await deps.runScrape(key, chain);
    report.scrape = scrape;
    say(
      `  durum ${scrape.status} · ilan ${scrape.jobsCreated} · inceleme ${scrape.itemsReview} · ret ${scrape.itemsRejected}\n` +
        `  kapı özeti: ${JSON.stringify(scrape.llm)}\n`,
    );
    for (const row of scrape.analyses) {
      say(
        `  [${row.url.split('/').pop()}] ${row.model} · ${row.status} · karar ${row.verdict ?? '-'} · ${row.latencyMs} ms · ` +
          `token ${row.promptTokens ?? '?'}/${row.completionTokens ?? '?'}${row.error ? ` · hata: ${row.error}` : ''}\n`,
      );
    }
    for (const job of scrape.jobs) {
      say(`  ilan: "${job.title}" → ${job.kind}/${job.decision} · model ${job.model ?? '-'} · kanıt doğrulandı ${job.evidenceVerified ?? '-'}\n`);
    }
    for (const decision of scrape.decisions) say(`  tarama belleği: ${decision.sourceItemId} → ${decision.decision}\n`);
  } catch (error) {
    exitCode = 1;
    say(`  BAŞARISIZ: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const path = deps.writeReport(redactSecret(JSON.stringify({ ...report, exitCode }, null, 2), key));
  say(`\nBitti (çıkış ${exitCode}).${path ? ` Rapor: ${path}` : ''}\n`);
  return exitCode;
}

function writeReportFile(json: string): string | null {
  try {
    const dir = join(process.cwd(), '.staging', 'groq-live');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rapor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(path, json, 'utf8');
    return path;
  } catch {
    return null;
  }
}

/** Betik doğrudan çalıştırıldı mı? (Windows'ta `file://` URL karşılaştırması sürücü harfine takılır.) */
export function isDirectGroqLiveExecution(entry = process.argv[1]): boolean {
  return Boolean(entry) && /(?:^|\/)groq-live\.(?:[cm]?[jt]s|tsx?)$/i.test(String(entry).replace(/\\/g, '/'));
}

if (isDirectGroqLiveExecution()) {
  runGroqLive({
    env: process.env,
    stdin: process.stdin,
    out: process.stdout,
    fetchImpl: (url, init) => fetch(url, init as RequestInit) as never,
    runEval: runEvalSubprocess,
    runScrape: (key, models) => runScrapeIntegration(key, models),
    writeReport: writeReportFile,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`Beklenmeyen hata: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
