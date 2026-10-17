/**
 * Tek-kaynak fixture yakalama: `npm run fixtures:capture -- --live --source=<key>`
 *
 * Fail-closed: yalnız `--live`, `SOURCE_LIVE_FETCH=1`, tek etkin sourceKey ve
 * `--reviewed-public-data` birlikte verildiğinde en çok bir HTML/JSON listing
 * isteği yapılır. Ham response header/cookie kaydedilmez; body kişisel/secret
 * işaretleri için scrub edilir, SHA-256 ve provenans manifesti üretilir.
 * PDF/ek/detay indirilmez. Kaynak şartları ve scrub sonucu commit öncesi insan
 * tarafından ayrıca gözden geçirilmelidir. Bu komut bu oturumda çalıştırılmadı.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEnv, resetEnvCache } from '../src/config/env';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { HttpClient } from '../src/sources/fetcher';
import { createLogger } from '../src/lib/logger';
import { toIstanbulDateOnly } from '../src/domain';
import { inspectFixtureManifest } from '../src/sources/inventory';
import { scrubSnapshot, scrubSourceUrl } from '../src/sources/fixture-redaction';

interface FixtureEntry {
  sourceKey: string;
  sourceUrl: string;
  file: string;
  capturedAt: string;
  bytes: number;
  status: number;
  contentType: string;
  sha256: string;
  captureMethod: string;
  redacted: true;
  redactionNotes: string[];
}

const MAX_ALLOWED_BYTES = 5_000_000;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv.filter((argument) => argument.startsWith(prefix));
  return values.length === 1 ? values[0]!.slice(prefix.length) : null;
}

function hasDuplicateOption(name: string): boolean {
  const prefix = `--${name}=`;
  return process.argv.filter((argument) => argument.startsWith(prefix)).length > 1;
}

async function main(): Promise<void> {
  if (hasDuplicateOption('source') || hasDuplicateOption('max-bytes')) {
    console.error('Bir --source ve bir --max-bytes değerinden fazlası geçersiz; hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  if (!process.argv.includes('--live')) {
    console.error('Canlı fixture yakalama için --live zorunludur; hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  if (!process.argv.includes('--reviewed-public-data')) {
    console.error('Kaynak kullanım şartlarını ve herkese açık veri uygunluğunu incelediğinizi belirtmek için --reviewed-public-data gerekli; hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  const sourceKey = option('source');
  if (!sourceKey) {
    console.error('Tam olarak bir --source=<sourceKey> seçin; tüm kaynakları yakalama bu komutta desteklenmez.');
    process.exitCode = 2;
    return;
  }
  const parsedMaxBytes = Number(option('max-bytes') ?? '1000000');
  if (!Number.isSafeInteger(parsedMaxBytes) || parsedMaxBytes < 1 || parsedMaxBytes > MAX_ALLOWED_BYTES) {
    console.error(`--max-bytes 1 ile ${MAX_ALLOWED_BYTES} arasında pozitif tamsayı olmalıdır.`);
    process.exitCode = 2;
    return;
  }

  process.env.SOURCE_BROWSER_FALLBACK = '0';
  process.env.SOURCE_TLS_AIA_COMPLETION = '0';
  resetEnvCache();
  const env = getEnv();
  if (env.NODE_ENV === 'test') {
    console.error('NODE_ENV=test iken canlı fixture yakalama reddedildi; hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.error('TLS doğrulaması kapalı; canlı fixture yakalama reddedildi. NODE_TLS_REJECT_UNAUTHORIZED değiştirilmedi.');
    process.exitCode = 2;
    return;
  }
  if (!env.SOURCE_LIVE_FETCH) {
    console.error('SOURCE_LIVE_FETCH=0: canlı fixture yakalama reddedildi; hiçbir istek yapılmadı.');
    process.exitCode = 2;
    return;
  }
  const source = SOURCE_DEFINITIONS.find((item) => item.key === sourceKey);
  if (!source || !source.enabled || source.status === 'disabled' || source.method === 'manual-entry') {
    console.error(`Etkin ve otomatik bir sourceKey gerekli: ${sourceKey}. Hiçbir istek yapılmadı.`);
    process.exitCode = 2;
    return;
  }
  const existingManifest = inspectFixtureManifest();
  if (existingManifest.status === 'invalid') {
    console.error('Mevcut fixture manifesti geçersiz/provenansı eksik; elle inceleyip düzeltmeden canlı yakalama yapılmayacak.');
    process.exitCode = 2;
    return;
  }

  const logger = createLogger('fixtures', { level: 'info' });
  const http = new HttpClient({ logger, maxRequests: 1, maxTextRequests: 1 });
  try {
    const response = await http.fetchText(source.listingUrl, {
      allowedHosts: source.allowedHosts,
      minIntervalMs: source.minRequestIntervalMs,
      maxBytes: parsedMaxBytes,
      retries: 0,
      timeoutMs: Math.min(env.SCRAPE_TIMEOUT_MS, 30_000),
    });
    if (!response.contentType || !/text\/html|application\/xhtml\+xml|application\/json/i.test(response.contentType)) {
      throw new Error(`Fixture içerik türü kabul edilmedi: ${response.contentType ?? 'bilinmiyor'}`);
    }
    const sourceText = response.decoded?.text ?? response.body.toString('utf8');
    const scrubbed = scrubSnapshot(sourceText);
    const bytes = Buffer.from(scrubbed.text, 'utf8');
    const date = toIstanbulDateOnly(new Date());
    const extension = /application\/json/i.test(response.contentType) ? 'json' : 'html';
    const filename = `${source.key}-${date}.${extension}`;
    const root = resolve('fixtures/html');
    const filePath = join(root, filename);
    mkdirSync(root, { recursive: true });
    writeFileSync(filePath, bytes, { mode: 0o600 });
    const capturedAt = new Date().toISOString();
    const entry: FixtureEntry = {
      sourceKey: source.key,
      sourceUrl: scrubSourceUrl(source.listingUrl),
      file: `fixtures/html/${filename}`,
      capturedAt,
      bytes: bytes.length,
      status: response.status,
      contentType: response.contentType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      captureMethod: 'capture-fixtures/v1 HttpClient.fetchText (one listing request; no PDF/detail)',
      redacted: true,
      redactionNotes: scrubbed.notes,
    };

    const manifestPath = join(root, 'manifest.json');
    const previousEntries: FixtureEntry[] = existingManifest.entries
      .filter((item) => item.valid)
      .map(({ valid: _valid, errors: _errors, ...item }) => ({ ...item, redacted: true as const }));
    const entries = [...previousEntries.filter((item) => item.file !== entry.file), entry];
    const manifest = { version: 1, generatedAt: capturedAt, entries };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    console.log(`Fixture yakalandı: ${entry.file} (${entry.bytes} redakte bayt, SHA-256 ${entry.sha256}).`);
    console.log(`Provenans manifesti: fixtures/html/manifest.json; HTTP status ${entry.status}.`);
    console.log('Tek HTTP listing çağrısı yapıldı; PDF/detay indirilmedi. İnsan PII/ToS/lisans incelemesi olmadan commit etmeyin.');
  } finally {
    await http.close();
  }
}

main().catch((error: unknown) => {
  console.error('Fixture yakalama başarısız:', error instanceof Error ? error.message : 'beklenmeyen hata');
  process.exitCode = 1;
});
