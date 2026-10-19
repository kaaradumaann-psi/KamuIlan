#!/usr/bin/env node
/**
 * Tek kaynaklı, yalıtılmış operatör staging koşumu.
 *
 * Kullanım:
 *   npm run staging:capture -- --source=<key> --dry-run
 *   npm run staging:capture -- --source=<key> --live --max-requests=3 --max-pages=2 \
 *     --max-details=1 --min-delay-ms=1500 --confirmed-empty
 *
 * Tasarım ilkeleri:
 *  - İki aşamalı opt-in: `--live` + kaynak allowlist + `config/source-terms.json`
 *    içinde insan tarafından `allowed` işaretlenmiş kayıt. Biri eksikse ağa çıkılmaz.
 *  - `--confirmed-empty` olmadan 0 ilan "başarı" sayılmaz; rapor not-observed der.
 *  - Veritabanı daima izole geçici dizindeki dosya deposudur. DATABASE_DRIVER,
 *    POSTGRES_URL ve MONGODB_URI gibi üretim işaretleri reddedilir.
 *  - Scheduler/worker/email/Telegram/AI/browser kapatılır; TLS doğrulaması açılır.
 *  - Tek paylaşımlı HttpClient bütçesi: sayfa + detay + yönlendirme + retry.
 *  - Rapor JSON'u gizli değer içermez; URL yalnızca host + yol hash'i olarak yazılır.
 *
 * NOT: Bu komut veriyi kalıcı veritabanına YAZMAZ. Snapshot (HTML/PDF) kaydı
 * ayrı, insan onaylı `npm run fixtures:capture` adımıdır.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getEnv, resetEnvCache } from '../src/config/env.ts';
import { APP_VERSION } from '../src/config/app.ts';
import { SOURCE_DEFINITIONS } from '../src/config/sources.ts';
import { isStagingSourceAllowed, STAGING_DEFAULT_BUDGETS, STAGING_DATA_ROOT } from '../src/config/staging.ts';
import { createLogger } from '../src/lib/logger.ts';
import { HttpClient } from '../src/sources/fetcher.ts';
import { getAdapter } from '../src/sources/registry.ts';
import { assessSourceTerms, loadSourceTerms, MAX_TERMS_REVIEW_AGE_DAYS } from '../src/sources/terms.ts';
import { createRepos } from '../src/db/repos/index.ts';
import { createStore } from '../src/db/store.ts';
import { runSourceScrape, type RunSourceResult } from '../src/ingest/pipeline.ts';
import { buildStagingReport, formatStagingReport, stagingExitCode } from '../src/staging/report.ts';

/**
 * Üretim veritabanına işaret edebilecek TÜM bilinen anahtarlar. Değerler asla
 * yazdırılmaz; yalnızca anahtar adı raporlanır. `DATABASE_URL` uygulamanın
 * desteklediği alternatif Postgres adıdır ve burada da reddedilmelidir.
 */
const PROD_DB_KEYS = [
  'DATABASE_DRIVER',
  'POSTGRES_URL',
  'DATABASE_URL',
  'MONGODB_URI',
  'MONGO_URL',
  'PRODUCTION_DATABASE_URL',
];

type IntegerResult = { ok: true; value: number } | { ok: false; message: string };

function parseInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): IntegerResult {
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, message: `--${name} ${min}–${max} arasında tam sayı olmalı (verilen: ${raw}).` };
  }
  return { ok: true, value };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      live: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'confirmed-empty': { type: 'boolean', default: false },
      'max-requests': { type: 'string' },
      'max-pages': { type: 'string' },
      'max-details': { type: 'string' },
      'min-delay-ms': { type: 'string' },
      'data-root': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (process.env.NODE_ENV === 'test') {
    process.stderr.write('Bu komut NODE_ENV=test altında çalışmaz.\n');
    return 2;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    process.stderr.write('NODE_TLS_REJECT_UNAUTHORIZED=0 reddedildi; TLS doğrulaması kapatılamaz.\n');
    return 3;
  }
  if (values.live && values['dry-run']) {
    process.stderr.write('--live ve --dry-run birlikte kullanılamaz.\n');
    return 2;
  }

  const sourceKey = values.source;
  if (!sourceKey) {
    process.stderr.write(
      '--source zorunlu. İzinli kaynaklar: resmigazete-cestili-ilanlar, osym-duyurular, iskur-kamu-memur-alim, iskur-kurumdisi-kamu-isci\n',
    );
    return 2;
  }
  if (!isStagingSourceAllowed(sourceKey)) {
    process.stderr.write(
      `Kaynak "${sourceKey}" operatör staging allowlist'inde değil; bu komut başka kaynağa istek atmaz.\n`,
    );
    return 3;
  }

  // Üretim veritabanı işaretleri: değerleri asla yazdırmadan yalnızca anahtar adı.
  const presentProdKeys = PROD_DB_KEYS.filter((key) => {
    if (key === 'DATABASE_DRIVER') {
      const value = (process.env.DATABASE_DRIVER ?? '').trim().toLowerCase();
      return value.length > 0 && value !== 'file';
    }
    return (process.env[key] ?? '').trim().length > 0;
  });
  if (presentProdKeys.length > 0) {
    process.stderr.write(
      `Üretim veritabanı değişkenleri dolu: ${presentProdKeys.join(', ')}. Staging izolasyonu için bunları boşaltın.\n`,
    );
    return 4;
  }

  const def = SOURCE_DEFINITIONS.find((item) => item.key === sourceKey);
  if (!def) {
    process.stderr.write(`Kaynak tanımı bulunamadı: ${sourceKey}\n`);
    return 2;
  }
  if (!getAdapter(def.adapterKey)) {
    process.stderr.write(`Adaptör bulunamadı: ${def.adapterKey}\n`);
    return 2;
  }
  if (!def.enabled) {
    process.stderr.write(`Kaynak devre dışı: ${sourceKey}\n`);
    return 2;
  }

  const maxRequests = parseInteger('max-requests', values['max-requests'], STAGING_DEFAULT_BUDGETS.maxRequests, 1, 100);
  if (!maxRequests.ok) {
    process.stderr.write(`${maxRequests.message}\n`);
    return 2;
  }
  const maxPages = parseInteger('max-pages', values['max-pages'], STAGING_DEFAULT_BUDGETS.maxPages, 1, 100);
  if (!maxPages.ok) {
    process.stderr.write(`${maxPages.message}\n`);
    return 2;
  }
  const maxDetails = parseInteger('max-details', values['max-details'], STAGING_DEFAULT_BUDGETS.maxDetails, 0, 20);
  if (!maxDetails.ok) {
    process.stderr.write(`${maxDetails.message}\n`);
    return 2;
  }
  const minDelayMs = parseInteger('min-delay-ms', values['min-delay-ms'], STAGING_DEFAULT_BUDGETS.minDelayMs, 0, 60_000);
  if (!minDelayMs.ok) {
    process.stderr.write(`${minDelayMs.message}\n`);
    return 2;
  }
  if (maxPages.value > maxRequests.value) {
    process.stderr.write(
      `--max-pages (${maxPages.value}) --max-requests (${maxRequests.value}) değerini aşamaz: toplam bütçe tek havuzdur.\n`,
    );
    return 2;
  }

  const terms = loadSourceTerms();
  if (terms.status === 'invalid') {
    process.stderr.write(`Kaynak şartları dosyası geçersiz:\n- ${terms.errors.join('\n- ')}\n`);
    return 4;
  }
  const assessment = assessSourceTerms(terms.entries.get(sourceKey) ?? null, new Date(), MAX_TERMS_REVIEW_AGE_DAYS);
  const live = values.live === true;
  if (live && !assessment.allowed) {
    process.stderr.write(
      `Canlı koşum engellendi (robots/ToS kapısı): ${assessment.reason}\n` +
        'config/source-terms.json içinde insan incelemesini tamamlayın. Kuru çalışma için --dry-run kullanın.\n',
    );
    return 5;
  }

  const dataRoot = resolve(values['data-root'] ?? STAGING_DATA_ROOT);
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const dataDir = join(dataRoot, `${sourceKey}-${stamp}`);
  const reportDir = join(dataDir, 'report');
  if (existsSync(dataDir)) {
    process.stderr.write(`Staging dizini zaten var: ${dataDir}\n`);
    return 2;
  }
  mkdirSync(join(dataDir, 'data'), { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  // Yalıtım: yalnızca bu süreç için dosya sürücüsü ve özel veri dizini.
  process.env.DATABASE_DRIVER = 'file';
  process.env.DATA_DIR = join(dataDir, 'data');
  process.env.SCHEDULER_ENABLED = '0';
  process.env.SOURCE_LIVE_FETCH = live ? '1' : '0';
  process.env.SOURCE_BROWSER_FALLBACK = '0';
  process.env.SOURCE_MIN_REQUEST_INTERVAL_MS = String(Math.max(minDelayMs.value, def.minRequestIntervalMs));
  process.env.EMAIL_PROVIDER = 'file';
  process.env.AI_ASSISTANT_ENABLED = '0';
  process.env.LLM_CLASSIFIER_ENABLED = '0';
  for (const key of ['RESEND_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'TELEGRAM_BOT_TOKEN']) {
    delete process.env[key];
  }
  resetEnvCache();

  const env = getEnv();
  const logger = createLogger('staging', { level: 'warn' });
  const http = new HttpClient({
    logger,
    userAgent: env.SCRAPE_USER_AGENT,
    maxRequests: maxRequests.value,
    maxTextRequests: maxPages.value,
  });

  let runResult: RunSourceResult | null = null;
  let runError: string | null = null;
  // Kuru çalışmada depo HİÇ açılmaz: ne ağa çıkılır ne de veri dosyası oluşur.
  let store: ReturnType<typeof createStore> | null = null;
  try {
    if (live) {
      store = createStore(env);
      await store.init();
      await store.ensureIndexes();
      const repos = createRepos(store, { now: () => new Date() });
      await repos.sources.seed();
      const sourceDoc = await repos.sources.getByKey(def.key);
      if (!sourceDoc) {
        runError = `Kaynak envanteri veritabanına yazılamadı: ${def.key}`;
      } else {
        const started = Date.now();
        try {
          runResult = await runSourceScrape({
            source: sourceDoc,
            repos,
            trigger: 'manual',
            workerId: `staging-${createHash('sha256').update(String(process.pid)).digest('hex').slice(0, 8)}`,
            http,
            logger,
            liveFetch: true,
            adapter: getAdapter(def.adapterKey) ?? undefined,
            maxDetailFetches: maxDetails.value,
            queueNotifications: false,
            now: new Date(started),
          });
        } catch (error) {
          runError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  } finally {
    await http.close().catch(() => undefined);
    await store?.close().catch(() => undefined);
  }

  const report = buildStagingReport({
    sourceKey: def.key,
    sourceName: def.name,
    adapterKey: def.adapterKey,
    listingUrl: def.listingUrl,
    generatedAt: new Date().toISOString(),
    dataDir: join(dataDir, 'data'),
    live,
    confirmedEmpty: values['confirmed-empty'] === true,
    budgets: {
      maxRequests: maxRequests.value,
      maxPages: maxPages.value,
      maxDetails: maxDetails.value,
      minDelayMs: minDelayMs.value,
    },
    terms: assessment,
    http: {
      requestsMade: http.requestsMade,
      textFetchesMade: http.textFetchesMade,
      redirectsMade: http.redirectsMade,
      binaryFetchesMade: http.binaryFetchesMade,
    },
    run: runResult,
    runError,
  });
  const reportPath = join(reportDir, 'staging-report.json');
  writeFileSync(reportPath, `${JSON.stringify({ appVersion: APP_VERSION, ...report }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(reportDir, 'summary.txt'), `${formatStagingReport(report)}\n`);
  process.stdout.write(`${formatStagingReport(report)}\n\nRapor: ${reportPath}\n`);
  const exitCode = stagingExitCode({
    live,
    runError: runError !== null,
    runStatus: report.run?.status ?? null,
    zeroResultReason: report.zeroResultReason,
  });
  if (exitCode === 6) {
    process.stderr.write(
      '0 ilan doğrulanmış boş sonuç değil: gösterge/selector değişimi, engel veya kapsam eksikliği olabilir. ' +
        'Exit 6 — başarı sayılmadı. Rapor nedenini inceleyin.\n',
    );
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Staging çalışması çöktü: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
