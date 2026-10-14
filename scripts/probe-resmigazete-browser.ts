/**
 * Resmî Gazete canlı probe: adaptörün GERÇEK bölüm sayfasını (HTTP ve Chromium yedeği) ayrı ayrı dener.
 *
 *   npm run probe:resmigazete            # bugün ve dün (İstanbul) için
 *
 * Adres ve ayrıştırma adaptörle aynı koddan gelir (resmiGazeteSectionUrl, describeSectionPage),
 * böylece probe sonucu adaptörün davranışını birebir yansıtır.
 *
 * Kimlik politikası: HTTP istemcisi projenin açık botu (SCRAPE_USER_AGENT) ile çalışır; tarayıcı
 * kimliği taklit edilmez. Chromium yedeği Playwright'ın kendi kimliğini kullanır ve TLS doğrulaması
 * kapatılmaz. Sayfa içeriği kaydedilmez; yalnızca sayımlar, başlık ve kısa bir menü metni yazılır.
 * Veritabanına yazmaz. Sonuç `data/probe-resmigazete-<tarih>.json` dosyasına yazılır (data/ gitignore'dadır).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toIstanbulDateOnly, addDaysDateOnly } from '../src/domain/dates';
import { launchChromium } from '../src/sources/browser-session';
import {
  describeSectionPage,
  resmiGazeteSectionUrl,
  type SectionPageDiagnostics,
} from '../src/sources/adapters/resmigazete';
import { FetchError, HttpClient } from '../src/sources/fetcher';

const HOST = 'www.resmigazete.gov.tr';

interface ProbeRow {
  date: string;
  url: string;
  http: {
    ok: boolean;
    status: number | null;
    bytes: number | null;
    error: string | null;
    diagnostics: SectionPageDiagnostics | null;
  };
  chromium: {
    ok: boolean;
    browserUserAgent: string | null;
    diagnostics: SectionPageDiagnostics | null;
    error: string | null;
  };
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeHttp(url: string): Promise<ProbeRow['http']> {
  const http = new HttpClient({});
  try {
    const response = await http.fetchText(url, { allowedHosts: [HOST], retries: 0 });
    const html = response.decoded?.text ?? response.body.toString('utf8');
    return {
      ok: true,
      status: response.status ?? null,
      bytes: response.body.byteLength,
      error: null,
      diagnostics: describeSectionPage(html, url),
    };
  } catch (error) {
    const status = error instanceof FetchError ? error.status : null;
    return { ok: false, status, bytes: null, error: failureOf(error), diagnostics: null };
  }
}

async function probeChromium(url: string): Promise<ProbeRow['chromium']> {
  let session: Awaited<ReturnType<typeof launchChromium>> | null = null;
  try {
    session = await launchChromium({ allowedHosts: [HOST] });
    await session.page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    const html = await session.page.content();
    const userAgent = await session.page.evaluate(
      async (_arg: string) =>
        (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent,
      '',
    );
    const diagnostics = describeSectionPage(html, url);
    return {
      ok: diagnostics.parsedRows > 0,
      browserUserAgent: userAgent,
      diagnostics,
      error:
        diagnostics.parsedRows > 0
          ? null
          : `Adaptör bu sayfadan satır çıkaramadı (PDF bağlantısı: ${diagnostics.pdfLinkCount}).`,
    };
  } catch (error) {
    return { ok: false, browserUserAgent: null, diagnostics: null, error: failureOf(error) };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

function printRow(row: ProbeRow): void {
  const h = row.http;
  console.log(`  HTTP (proje botu): ${h.ok ? `durum ${h.status}, ${h.bytes} bayt` : `HATA ${h.error}`}`);
  if (h.diagnostics) console.log(`    yapı: ${JSON.stringify(stripText(h.diagnostics))}`);
  const c = row.chromium;
  console.log(
    `  Chromium yedeği:   ${c.ok ? `${c.diagnostics?.parsedRows} satır çıkarıldı` : `HATA ${c.error}`}`,
  );
  if (c.diagnostics) console.log(`    yapı: ${JSON.stringify(stripText(c.diagnostics))}`);
  if (c.browserUserAgent) console.log(`  Tarayıcı kimliği:  ${c.browserUserAgent}`);
}

function stripText(d: SectionPageDiagnostics): Omit<SectionPageDiagnostics, 'textHead'> {
  const { textHead: _textHead, ...rest } = d;
  return rest;
}

async function main(): Promise<void> {
  const today = toIstanbulDateOnly(new Date());
  const dates = [today, addDaysDateOnly(today, -1)];
  const rows: ProbeRow[] = [];
  for (const date of dates) {
    const url = resmiGazeteSectionUrl(date);
    console.log(`\n${date}  ${url}`);
    const http = await probeHttp(url);
    const chromium = await probeChromium(url);
    const row: ProbeRow = { date, url, http, chromium };
    printRow(row);
    rows.push(row);
  }

  mkdirSync('data', { recursive: true });
  const outPath = join('data', `probe-resmigazete-${today}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), host: HOST, rows }, null, 2),
    'utf8',
  );
  console.log(`\nSonuç dosyası: ${outPath}`);
}

main().catch((error: unknown) => {
  console.error('Probe başarısız:', failureOf(error));
  process.exit(1);
});
