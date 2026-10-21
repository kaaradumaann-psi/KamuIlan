/**
 * robots.txt yasak yolları istek katmanında uygulanır.
 *
 * Eski davranış: robots yalnız operatör onay kaydında (`config/source-terms.json`) bir not
 * olarak vardı; istemci İŞKUR'un yasakladığı `/*?*` yoluna (ör. sayfalama `?page=2`) ve
 * yönlendirmeyle gelen `/api/` adresine istek gönderebiliyordu. İŞKUR robots.txt
 * (21.10.2026, `User-agent: *`): `Disallow: /api/`, `Disallow: /*?*`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { FetchError, HostRateLimiter, HttpClient, robotsDisallowMatch } from '../src/sources/fetcher';
import { createLogger } from '../src/lib/logger';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { runSourceScrape } from '../src/ingest/pipeline';
import type { SourceAdapter } from '../src/sources/types';

const ORIGIN = 'https://www.iskur.gov.tr';
const ALLOWED = ['iskur.gov.tr', 'www.iskur.gov.tr'];
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const iskur = SOURCE_DEFINITIONS.find((source) => source.key === 'iskur-kamu-memur-alim');

const cleanup: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const item of cleanup.splice(0)) await item.close();
});

function client(mock: MockAgent): HttpClient {
  const http = new HttpClient({
    logger: silentLogger,
    sleep: async () => undefined,
    dispatcher: mock,
    rateLimiter: new HostRateLimiter(),
    disallowedPaths: iskur?.robotsDisallow,
  });
  cleanup.push(http, mock);
  return http;
}

describe('robotsDisallowMatch', () => {
  const rules = ['/api/', '/*?*'];
  it.each([
    ['/api/ilanlar', '/api/'],
    ['/ilanlar/kamu-memur-alim-ilanlari/?page=2', '/*?*'],
    ['/?q=1', '/*?*'],
  ])('%s yasak (%s)', (path, rule) => {
    expect(robotsDisallowMatch(new URL(`${ORIGIN}${path}`), rules)).toBe(rule);
  });
  it.each(['/ilanlar/kamu-memur-alim-ilanlari/', '/apiler/', '/'])('%s serbest', (path) => {
    expect(robotsDisallowMatch(new URL(`${ORIGIN}${path}`), rules)).toBeNull();
  });
  it('"$" sonu sabitler', () => {
    expect(robotsDisallowMatch(new URL(`${ORIGIN}/a.pdf`), ['/*.pdf$'])).toBe('/*.pdf$');
    expect(robotsDisallowMatch(new URL(`${ORIGIN}/a.pdf.html`), ['/*.pdf$'])).toBeNull();
  });
});

describe('HttpClient robots kapısı (İŞKUR)', () => {
  it('İŞKUR tanımları incelenmiş robots kurallarını taşır', () => {
    for (const key of ['iskur-kamu-memur-alim', 'iskur-kurumdisi-kamu-isci']) {
      expect(SOURCE_DEFINITIONS.find((source) => source.key === key)?.robotsDisallow).toEqual(['/api/', '/*?*']);
    }
  });

  it('sorgu dizeli adrese istek GÖNDERİLMEZ ve yeniden denenmez', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const http = client(mock);
    const error = await http
      .fetchText(`${ORIGIN}/ilanlar/kamu-memur-alim-ilanlari/?page=2`, { allowedHosts: ALLOWED, retries: 3 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).message).toContain('robots.txt');
    expect((error as FetchError).retryable).toBe(false);
    expect(http.requestsMade).toBe(0);
  });

  it('yönlendirmeyle gelen yasak adres izlenmez', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/ilanlar/kamu-memur-alim-ilanlari/', method: 'GET' })
      .reply(302, '', { headers: { location: '/api/ilan-listesi' } });
    const http = client(mock);
    const error = await http
      .fetchText(`${ORIGIN}/ilanlar/kamu-memur-alim-ilanlari/`, { allowedHosts: ALLOWED, retries: 0 })
      .catch((caught: unknown) => caught);
    expect((error as FetchError).message).toContain('robots.txt');
    expect(http.requestsMade).toBe(1);
  });

  it('adaptör: "?page=2" sonraki sayfası istenmez; 1. sayfa işlenir, kapsam tam sayılmaz', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const listing = new URL(iskur!.listingUrl);
    mock
      .get(ORIGIN)
      .intercept({ path: listing.pathname, method: 'GET' })
      .reply(
        200,
        `<html><body><main><ul><li><a href="/ilanlar/2026/123456">Ankara Üniversitesi sözleşmeli personel alım ilanı</a>
        <time>12.10.2026</time></li></ul><nav class="pagination"><a rel="next" href="?page=2">Sonraki</a></nav></main></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    const http = client(mock);
    const { createIskurAdapter } = await import('../src/sources/adapters/anchor-list');
    const result = await createIskurAdapter().run({
      source: iskur!,
      http,
      logger: createLogger('test', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: new Date('2026-10-23T09:00:00.000Z'),
      maxDetailFetches: 0,
    });
    expect(result.notes).toContain('Sayfa 1: 1 ilan bağlantısı.');
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('robots.txt');
    expect(http.requestsMade).toBe(1);
  });

  it('tarama hattı kaynağın robots kurallarını kendi oluşturduğu istemciye geçirir', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-robots-')));
    await store.init();
    const repos = createRepos(store, fixedClock(new Date('2026-10-23T09:00:00.000Z')));
    await repos.sources.seed([iskur!]);
    const source = await repos.sources.getByKey(iskur!.key);
    let observed = '';
    const adapter: SourceAdapter = {
      key: iskur!.adapterKey,
      label: 'robots sınaması',
      method: 'html-list',
      notes: 'Ağa çıkmaz; yalnız istemci kuralını gözler.',
      run: async (ctx) => {
        observed = await ctx.http
          .fetchText(`${ORIGIN}/ilanlar/kamu-memur-alim-ilanlari/?page=2`, { allowedHosts: ALLOWED, retries: 0 })
          .then(() => 'istek gitti')
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        return { items: [], requestCount: 0, notes: [], etag: null, lastModified: null, notModified: false, httpStatuses: [] };
      },
    };
    await runSourceScrape({
      repos,
      source: source!,
      trigger: 'manual',
      workerId: 'robots-test',
      adapter,
      logger: createLogger('test', { level: 'silent' }),
    });
    // Kural geçmeseydi istek Vitest çevrim dışı korumasına takılırdı (farklı mesaj).
    expect(observed).toContain('robots.txt');
    await store.close();
  });

  it('serbest yol normal çalışır', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/ilanlar/kamu-memur-alim-ilanlari/', method: 'GET' })
      .reply(200, '<html><body>liste</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const response = await client(mock).fetchText(`${ORIGIN}/ilanlar/kamu-memur-alim-ilanlari/`, {
      allowedHosts: ALLOWED,
      retries: 0,
    });
    expect(response.status).toBe(200);
  });
});
