/**
 * Vitest global kurulumu.
 * - src/db/file-store gibi modüllerin testte gerçek data/ dizinine dokunmaması için
 *   geçici veri dizini verilir.
 * - Testler hiçbir zaman gerçek kaynaklara istek atmaz (fetch engellenir);
 *   canlı doğrulama ayrı: `npm run test:live`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.APP_SECRET = process.env.APP_SECRET ?? 'test-secret-please-ignore-0123456789abcdef';
process.env.SOURCE_LIVE_FETCH = '0';
// Chromium gerçek ağa çıkar: sahte HTTP istemcisiyle çalışan adaptör testlerinde
// tarayıcı yedeği AÇIK kalırsa test canlı siteyi okur ve sonuç makineye göre
// değişir (Playwright kuruluysa farklı, kurulu değilse farklı). Bu yüzden
// testlerde kapalıdır; tarayıcı katmanının kendi testleri (playwright mock'lu)
// anahtarı kendi içinde geçici olarak açar.
process.env.SOURCE_BROWSER_FALLBACK = '0';

const testDataDir = mkdtempSync(join(tmpdir(), 'kamuilan-test-'));
process.env.DATA_DIR = process.env.DATA_DIR ?? testDataDir;
process.env.KAMUILAN_TEST_DATA_DIR = testDataDir;

beforeEach(() => {
  vi.restoreAllMocks();
});
