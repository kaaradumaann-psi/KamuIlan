/**
 * Sınırlı ve açık opt-in canlı kaynak doğrulaması.
 *
 * Varsayılan kapalıdır: --live + tek --source=KEY veya --all + zorunlu
 * --max-requests/--max-pages/--max-details bayrakları gerekir. HTTP istek bütçesi
 * redirect/retry dahil tek HttpClient'da küreseldir; text/page bütçesi sayfa ve
 * detay HTML/JSON gövdelerini birlikte sayar (bilinçli tutucu sınır). Browser ve
 * AIA TLS ek istekleri bu tanı koşusunda kapalıdır; TLS doğrulaması açık kalır.
 * Üretim DB'sine yazılmaz/bağlanılmaz; başlık örnekleri dosyaya yazılmayıp hash'lenir.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetEnvCache, getEnv } from '../src/config/env';
import { SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { requireAdapter } from '../src/sources/registry';
import { describeTlsTrust, HttpClient, FetchError } from '../src/sources/fetcher';
import { createLogger } from '../src/lib/logger';
import { normalizeTr } from '../src/domain/text';
import { toIstanbulDateOnly } from '../src/domain';
import { assessSourceTerms, loadSourceTerms, MAX_TERMS_REVIEW_AGE_DAYS } from '../src/sources/terms';

interface LiveResult {
  key: string;
  adapterKey: string;
  status: 'complete' | 'failed' | 'blocked-budget';
  coverage: 'complete' | 'partial' | 'unknown';
  itemCount: number;
  httpRequestsSent: number;
  textFetchAttempts: number;
  httpStatuses: number[];
  durationMs: number;
  sampleTitleHashes: string[];
  error: { category: string; httpStatus: number | null; messageHash: string } | null;
  notes: { count: number; sampleHashes: string[] };
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv.filter((argument) => argument.startsWith(prefix));
  return values.length === 1 ? values[0]!.slice(prefix.length) : null;
}

function hasDuplicateOption(name: string): boolean {
  const prefix = `--${name}=`;
  return process.argv.filter((argument) => argument.startsWith(prefix)).length > 1;
}

function boundedInt(name: string, min: number, max: number): number | null {
  const raw = option(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function liveBudgetMs(): number {
  return Math.max(30_000, getEnv().SCRAPE_TIMEOUT_MS);
}

function safeFailure(error: unknown): LiveResult['error'] {
  const message = error instanceof Error ? error.message : 'beklenmeyen hata';
  const httpStatus = error instanceof FetchError ? error.status : null;
  const category =
    /bütçe doldu|budget.*exhausted/i.test(message)
      ? 'budget-exhausted'
      : httpStatus === 401 || httpStatus === 403
        ? 'access-denied'
        : httpStatus === 404
          ? 'not-found'
          : httpStatus === 429
            ? 'rate-limited'
            : httpStatus !== null && httpStatus >= 500
              ? 'upstream-server-error'
              : /timeout|timed out|zaman aşımı/i.test(message)
                ? 'timeout'
                : error instanceof FetchError && httpStatus === null
                  ? 'transport-or-policy-error'
                  : 'adapter-error';
  return {
    category,
    httpStatus,
    // Keep diagnostics reproducible without persisting raw URLs, page text, or PII.
    messageHash: createHash('sha256').update(message).digest('hex').slice(0, 16),
  };
}

function noteEvidence(notes: string[]): LiveResult['notes'] {
  return {
    count: notes.length,
    sampleHashes: notes.slice(0, 10).map((note) => createHash('sha256').update(note).digest('hex').slice(0, 16)),
  };
}

async function checkSource(
  source: SourceDefinition,
  http: HttpClient,
  logger: ReturnType<typeof createLogger>,
  maxDetailFetches: number,
  minDelayMs: number,
): Promise<LiveResult> {
  const started = Date.now();
  const httpStart = http.requestsMade;
  const textStart = http.textFetchesMade;
  const adapter = requireAdapter(source.adapterKey);
  const budgetMs = liveBudgetMs();
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(new Error(`Canlı koşum süre bütçesi doldu (${budgetMs} ms).`)), budgetMs);
  try {
    const boundedSource: SourceDefinition = {
      ...source,
      minRequestIntervalMs: Math.max(source.minRequestIntervalMs, minDelayMs),
    };
    const result = await adapter.run({
      source: boundedSource,
      http,
      logger,
      liveFetch: true,
      fetchedAt: new Date(),
      maxDetailFetches,
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + Math.max(5_000, budgetMs - 8_000)),
    });
    return {
      key: source.key,
      adapterKey: source.adapterKey,
      status:
        result.notes.some((note) => /bütçe doldu|budget.*exhausted|budget.*limit/i.test(note))
          ? 'blocked-budget'
          : 'complete',
      coverage: result.coverage?.status ?? 'unknown',
      itemCount: result.items.length,
      httpRequestsSent: http.requestsMade - httpStart,
      textFetchAttempts: http.textFetchesMade - textStart,
      httpStatuses: result.httpStatuses ?? [],
      durationMs: Date.now() - started,
      sampleTitleHashes: result.items.slice(0, 3).map((item) =>
        createHash('sha256').update(normalizeTr(item.title)).digest('hex').slice(0, 16),
      ),
      error: null,
      notes: noteEvidence(result.notes),
    };
  } catch (error) {
    const message = error instanceof FetchError ? error.message : error instanceof Error ? error.message : 'beklenmeyen hata';
    const blocked = /bütçe doldu/i.test(message);
    return {
      key: source.key,
      adapterKey: source.adapterKey,
      status: blocked ? 'blocked-budget' : 'failed',
      coverage: 'unknown',
      itemCount: 0,
      httpRequestsSent: http.requestsMade - httpStart,
      textFetchAttempts: http.textFetchesMade - textStart,
      httpStatuses: [],
      durationMs: Date.now() - started,
      sampleTitleHashes: [],
      error: safeFailure(error),
      notes: { count: 0, sampleHashes: [] },
    };
  } finally {
    clearTimeout(hardStop);
  }
}

async function main(): Promise<void> {
  const boundedOptions = ['source', 'max-requests', 'max-pages', 'max-details', 'min-delay-ms'];
  if (boundedOptions.some(hasDuplicateOption)) {
    console.error('Kaynak/bütçe bayrakları tekrarlanamaz; hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  const only = option('source');
  const all = hasFlag('all');
  if (!hasFlag('live') || (Boolean(only) === all)) {
    console.error('Canlı doğrulama için --live ve yalnızca bir seçim gerekir: --source=<key> veya --all. Hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  const maxRequests = boundedInt('max-requests', 1, 100);
  const maxPages = boundedInt('max-pages', 1, 100);
  const maxDetails = boundedInt('max-details', 0, 20);
  const minDelayMs = boundedInt('min-delay-ms', 0, 60_000);
  if (maxRequests === null || maxPages === null || maxDetails === null || minDelayMs === null) {
    console.error('--max-requests (1–100), --max-pages (1–100), --max-details (0–20) ve --min-delay-ms (0–60000) zorunludur. Hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }

  // Live source diagnostic deliberately disables only auxiliary browser/AIA paths,
  // not TLS certificate verification or the primary HTTP client.
  process.env.SOURCE_BROWSER_FALLBACK = '0';
  process.env.SOURCE_TLS_AIA_COMPLETION = '0';
  resetEnvCache();
  const env = getEnv();
  if (env.NODE_ENV === 'test') {
    console.error('NODE_ENV=test iken canlı kaynak doğrulaması reddedildi. Hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.error('TLS doğrulaması kapalı; canlı kaynak doğrulaması reddedildi. NODE_TLS_REJECT_UNAUTHORIZED değiştirilmedi.');
    process.exitCode = 2;
    return;
  }
  if (!env.SOURCE_LIVE_FETCH) {
    console.error('SOURCE_LIVE_FETCH=0: SOURCE_LIVE_FETCH=1 olmadan live fetch reddedildi. Hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }

  const targets = SOURCE_DEFINITIONS.filter(
    (source) => source.enabled && source.status !== 'disabled' && source.method !== 'manual-entry',
  ).filter((source) => (only ? source.key === only : true));
  if (targets.length === 0) {
    console.error(`Seçilen etkin kaynak bulunamadı${only ? `: ${only}` : ''}. Hiçbir istek yapılmadı.`);
    process.exitCode = 2;
    return;
  }

  // robots/ToS/insan incelemesi kapısı: staging ile aynı kural. Onay yoksa
  // HTTP istemcisi bile oluşturulmadan durulur; CAPTCHA/WAF aşılmaya çalışılmaz.
  const terms = loadSourceTerms();
  if (terms.status === 'invalid') {
    console.error(`Kaynak erişim şartları dosyası geçersiz:\n- ${terms.errors.join('\n- ')}\nHiçbir istek yapılmadı.`);
    process.exitCode = 4;
    return;
  }
  const blockedByTerms = targets
    .map((source) => ({
      key: source.key,
      assessment: assessSourceTerms(terms.entries.get(source.key) ?? null, new Date(), MAX_TERMS_REVIEW_AGE_DAYS),
    }))
    .filter((item) => !item.assessment.allowed);
  if (blockedByTerms.length > 0) {
    console.error(
      'Erişim şartları kapısı: aşağıdaki kaynak(lar) için robots.txt/kullanım şartları insan incelemesi yok. ' +
        'Hiçbir istek yapılmadı. `config/source-terms.json` dosyasını doldurun (docs/quality/SOURCE-TERMS.md).',
    );
    for (const item of blockedByTerms.slice(0, 10)) console.error(`  - ${item.key}: ${item.assessment.reason}`);
    process.exitCode = 5;
    return;
  }

  const logger = createLogger('live-check', { level: 'warn' });
  const http = new HttpClient({ logger, maxRequests, maxTextRequests: maxPages });
  const results: LiveResult[] = [];
  console.log(`TLS: ${describeTlsTrust()}`);
  console.log(`Opt-in: --live; kaynak seçimi: ${only ?? '--all'}; azami HTTP attempt: ${maxRequests}; azami text/page fetch: ${maxPages}; detail/source: ${maxDetails}; min delay: max(${minDelayMs} ms, kaynak tanımı).`);
  console.log('Browser fallback=0 · AIA TLS extra fetch=0 · TLS verification=ON · production DB=NOT USED.\n');

  for (const source of targets) {
    if (http.remainingRequestBudget === 0 || http.remainingTextRequestBudget === 0) {
      results.push({
        key: source.key,
        adapterKey: source.adapterKey,
        status: 'blocked-budget',
        coverage: 'unknown',
        itemCount: 0,
        httpRequestsSent: 0,
        textFetchAttempts: 0,
        httpStatuses: [],
        durationMs: 0,
        sampleTitleHashes: [],
        error: {
          category: 'budget-exhausted',
          httpStatus: null,
          messageHash: createHash('sha256').update('Küresel HTTP/text bütçesi önceki kaynakta tükendi.').digest('hex').slice(0, 16),
        },
        notes: { count: 0, sampleHashes: [] },
      });
      continue;
    }
    process.stdout.write(`→ ${source.key} (${source.adapterKey}) … `);
    const result = await checkSource(source, http, logger, maxDetails, minDelayMs);
    results.push(result);
    console.log(`${result.status}: ${result.itemCount} item, ${result.httpRequestsSent} HTTP, ${result.textFetchAttempts} text fetch, ${result.durationMs} ms`);
  }
  await http.close();

  const report = {
    checkedAt: new Date().toISOString(),
    date: toIstanbulDateOnly(new Date()),
    explicitLiveOptIn: true,
    sourceSelection: only ?? '--all',
    budgets: { maxRequests, maxPages, maxDetailsPerSource: maxDetails, minDelayMs },
    transport: { browserFallback: false, tlsAiaCompletion: false, tlsVerification: 'ON' },
    productionDatabase: 'NOT USED',
    results,
    summary: {
      total: results.length,
      complete: results.filter((result) => result.status === 'complete').length,
      failed: results.filter((result) => result.status === 'failed').length,
      blockedBudget: results.filter((result) => result.status === 'blocked-budget').length,
      items: results.reduce((sum, result) => sum + result.itemCount, 0),
      httpRequestsSent: http.requestsMade,
      textFetchAttempts: http.textFetchesMade,
    },
  };
  const reportDirectory = join('artifacts', 'live-check');
  mkdirSync(reportDirectory, { recursive: true });
  const reportPath = join(reportDirectory, `live-check-${report.checkedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log(`\nÖzet: ${report.summary.complete}/${report.summary.total} adapter çalıştı; ${report.summary.items} item; ${report.summary.httpRequestsSent}/${maxRequests} HTTP attempt.`);
  console.log(`Raporda notice başlığı yok; yalnızca hash örnekleri var: ${reportPath}`);

  if (report.summary.failed > 0) process.exitCode = 1;
  else if (report.summary.blockedBudget > 0) process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('Canlı doğrulama başarısız:', error instanceof Error ? error.message : 'beklenmeyen hata');
  process.exitCode = 1;
});
