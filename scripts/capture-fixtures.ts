/**
 * Fixture yakalama: `npm run fixtures:capture`
 *
 * Gerçek kaynak sayfalarını indirip `fixtures/html` (ve varsa `fixtures/pdf`)
 * altına kaydeder. Böylece birim testleri canlı ağ olmadan gerçek HTML ile
 * çalışır (HTML değişince hata raporu da bu dosyalarla üretilir).
 *
 * Gerçek ağ erişimi gerekir; indirilen sayfalar yalnızca teste yönelik saklanır
 * ve kaynak sitelerin telif/şartlarına saygı gösterilir (yalnızca herkese açık
 * ilan listeleri, tek istek, hız sınırı).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEnv } from '../src/config/env';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { HttpClient } from '../src/sources/fetcher';
import { createLogger } from '../src/lib/logger';
import { toIstanbulDateOnly } from '../src/domain';

interface FixtureEntry {
  sourceKey: string;
  url: string;
  file: string;
  fetchedAt: string;
  bytes: number;
  status: number;
  contentType: string | null;
}

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.SOURCE_LIVE_FETCH) {
    console.error('✖ SOURCE_LIVE_FETCH=0: fixture yakalamak için gerçek ağ erişimi gerekir (.env → SOURCE_LIVE_FETCH=1).');
    process.exitCode = 1;
    return;
  }

  const only = process.argv.find((argument) => argument.startsWith('--source='))?.split('=')[1];
  const targets = SOURCE_DEFINITIONS.filter((source) => source.status === 'verified').filter(
    (source) => !only || source.key === only,
  );
  if (targets.length === 0) {
    console.error('✖ Yakalanacak doğrulanmış kaynak yok.');
    process.exitCode = 1;
    return;
  }

  const htmlDir = resolve('fixtures/html');
  const pdfDir = resolve('fixtures/pdf');
  mkdirSync(htmlDir, { recursive: true });
  mkdirSync(pdfDir, { recursive: true });

  const logger = createLogger('fixtures', { level: 'info' });
  const http = new HttpClient({ logger });
  const date = toIstanbulDateOnly(new Date());
  const manifest: FixtureEntry[] = [];

  for (const source of targets) {
    try {
      const response = await http.fetchText(source.listingUrl, {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
      });
      const file = join(htmlDir, `${source.key}-${date}.html`);
      writeFileSync(file, response.body);
      manifest.push({
        sourceKey: source.key,
        url: source.listingUrl,
        file: `fixtures/html/${source.key}-${date}.html`,
        fetchedAt: new Date().toISOString(),
        bytes: response.bytes,
        status: response.status,
        contentType: response.contentType,
      });
      console.log(`✓ ${source.key}: ${response.bytes} bayt → ${file}`);

      // Resmî Gazete gibi PDF tabanlı kaynaklar için ilk PDF de saklanır (metin katmanı testi).
      if (source.method === 'pdf-index') {
        const pdfMatch = /href="([^"]+\.pdf)"/i.exec(response.decoded?.text ?? response.body.toString('utf8'));
        if (pdfMatch?.[1]) {
          const pdfUrl = new URL(pdfMatch[1], source.homepageUrl).toString();
          const pdf = await http.fetchBinary(pdfUrl, { allowedHosts: source.allowedHosts });
          const pdfFile = join(pdfDir, `${source.key}-${date}.pdf`);
          writeFileSync(pdfFile, pdf.body);
          console.log(`  ↳ PDF: ${pdfUrl} (${pdf.bytes} bayt)`);
        }
      }
    } catch (error) {
      console.error(`✖ ${source.key}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  await http.close();
  const manifestPath = join(htmlDir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), entries: manifest }, null, 2),
    'utf8',
  );
  console.log(`\n✔ ${manifest.length} fixture kaydedildi. Bildirim: ${manifestPath}`);
  console.log('Bu dosyalar testlerde kullanılır; üretim verisi değildir.');
}

main().catch((error: unknown) => {
  console.error('Fixture yakalama başarısız:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
