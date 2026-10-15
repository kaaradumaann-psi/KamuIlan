/**
 * Canlı kaynak doğrulaması: `npm run test:live`
 *
 * Ne yapar: kaynak adaptörlerini GERÇEK ağa karşı çalıştırır, kaç ilan
 * görüldüğünü ve HTTP durumlarını raporlar. Veritabanına YAZMAZ (kuru çalışma).
 *
 * Neden: “kaynak entegre edildi” demenin tek kanıtı budur. Ağ erişimi olmayan
 * ortamda (CI) çalıştırılmaz; hata mesajı hangi kaynağın erişilemediğini söyler.
 *
 * Kullanım:
 *   npm run test:live                 # tüm kaynaklar
 *   npm run test:live -- --source=ilan-gov-tr-personel
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv } from '../src/config/env';
import { SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { requireAdapter } from '../src/sources/registry';
import { describeTlsTrust, HttpClient, FetchError } from '../src/sources/fetcher';
import { createLogger } from '../src/lib/logger';
import { toIstanbulDateOnly } from '../src/domain';

interface LiveResult {
  key: string;
  adapterKey: string;
  ok: boolean;
  itemCount: number;
  requests: number;
  httpStatuses: number[];
  durationMs: number;
  samples: string[];
  error: string | null;
  notes: string[];
}

/**
 * Kaynak başına zaman bütçesi.
 *
 * Eski davranış: `test:live` adaptöre hiçbir süre sınırı vermiyordu; tek bir
 * kaynak (Resmî Gazete) 560 sn sürebiliyor ve tüm koşum takılıyordu. Artık
 * worker ile AYNI bütçe (`SCRAPE_TIMEOUT_MS`) uygulanır: burada başarısız olan
 * kaynak worker'da da başarısız olur, yani rapor üretim davranışını yansıtır.
 */
function liveBudgetMs(): number {
  return Math.max(30_000, getEnv().SCRAPE_TIMEOUT_MS);
}

async function checkSource(
  source: SourceDefinition,
  http: HttpClient,
  logger: ReturnType<typeof createLogger>,
): Promise<LiveResult> {
  const started = Date.now();
  const adapter = requireAdapter(source.adapterKey);
  const budgetMs = liveBudgetMs();
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(new Error(`Canlı koşum bütçesi doldu (${budgetMs} ms).`)), budgetMs);
  try {
    const result = await adapter.run({
      source,
      http,
      logger,
      liveFetch: true,
      fetchedAt: new Date(),
      maxDetailFetches: 5,
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + Math.max(5_000, budgetMs - 8_000)),
    });
    return {
      key: source.key,
      adapterKey: source.adapterKey,
      ok: true,
      itemCount: result.items.length,
      requests: result.requestCount,
      httpStatuses: result.httpStatuses ?? [],
      durationMs: Date.now() - started,
      samples: result.items.slice(0, 3).map((item) => item.title.slice(0, 110)),
      error: null,
      notes: result.notes,
    };
  } catch (error) {
    return {
      key: source.key,
      adapterKey: source.adapterKey,
      ok: false,
      itemCount: 0,
      requests: 0,
      httpStatuses: [],
      durationMs: Date.now() - started,
      samples: [],
      error:
        error instanceof FetchError
          ? `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`
          : error instanceof Error
            ? error.message
            : String(error),
      notes: [],
    };
  } finally {
    clearTimeout(hardStop);
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.SOURCE_LIVE_FETCH) {
    console.error(
      '✖ SOURCE_LIVE_FETCH=0: bu betik gerçek ağ erişimi gerektirir. .env dosyasında SOURCE_LIVE_FETCH=1 yapın.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`TLS: ${describeTlsTrust()}`);
  console.log(`Kaynak başına zaman bütçesi: ${liveBudgetMs()} ms (SCRAPE_TIMEOUT_MS — worker ile aynı)\n`);
  const only = process.argv.find((argument) => argument.startsWith('--source='))?.split('=')[1];
  const targets = SOURCE_DEFINITIONS.filter(
    (source) => source.enabled && source.status !== 'disabled',
  ).filter((source) => !only || source.key === only);
  if (targets.length === 0) {
    console.error(`✖ Doğrulanacak kaynak bulunamadı${only ? ` (--source=${only})` : ''}.`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger('live-check', { level: 'info' });
  const http = new HttpClient({ logger });
  const results: LiveResult[] = [];

  for (const source of targets) {
    process.stdout.write(`→ ${source.key} (${source.adapterKey}) … `);
    const result = await checkSource(source, http, logger);
    results.push(result);
    console.log(
      result.ok
        ? `✓ ${result.itemCount} ilan, ${result.requests} istek, ${result.durationMs} ms`
        : `✖ ${result.error ?? 'bilinmeyen hata'}`,
    );
    if (result.ok && result.samples.length > 0) {
      for (const sample of result.samples) console.log(`    · ${sample}`);
    }
  }

  await http.close();

  const report = {
    checkedAt: new Date().toISOString(),
    date: toIstanbulDateOnly(new Date()),
    liveFetch: true,
    results,
    summary: {
      total: results.length,
      ok: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      items: results.reduce((sum, result) => sum + result.itemCount, 0),
    },
  };
  mkdirSync(join(env.DATA_DIR), { recursive: true });
  const reportPath = join(env.DATA_DIR, `live-check-${report.date}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(
    `\nÖzet: ${report.summary.ok}/${report.summary.total} kaynak erişilebilir, toplam ${report.summary.items} ilan görüldü.`,
  );
  console.log(`Rapor: ${reportPath}`);
  console.log(
    'Not: Bu rapor veritabanına yazmaz. Kaynak sağlığını ve ilanları görmek için worker’ı çalıştırıp ' +
      'admin panelden "şimdi tara" kullanın.',
  );
  if (report.summary.failed > 0) {
    console.log('\nErişilemeyen kaynaklar:');
    for (const result of results.filter((item) => !item.ok))
      console.log(`  ✖ ${result.key}: ${result.error}`);
    console.log('Bu kaynaklar için durum güncellenmeli (config/sources.ts status + statusNote).');
  }
  process.exitCode = report.summary.ok === 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('Canlı doğrulama başarısız:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
