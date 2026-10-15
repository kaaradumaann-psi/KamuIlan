/**
 * Başsız tarayıcı (Playwright/Chromium) oturumu — JS ile dolan ya da
 * tarayıcı-dışı istemciyi yavaşlatan resmî sayfalar için paylaşılan yardımcı.
 *
 * Her oturumda ağ allowlistesi zorunludur. Playwright'ın kendi DNS çözümlemesi
 * host başına doğrulanmış IPv4'e sabitlenir ve izin listesinin dışındaki bütün
 * HTTP(S) istekleri route katmanında durdurulur; kaynak HTML'i özel ağlara
 * istek yaptıramaz.
 */
import { assertSafeUrl } from './fetcher';
import { resolvePublicAddresses } from './network-safety';

interface BrowserRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface BrowserPageLike {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<void>;
  evaluate(fn: (arg: string) => Promise<string>, arg: string): Promise<string>;
  route(url: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  routeWebSocket(
    url: string,
    handler: (socket: { close(options?: { code?: number; reason?: string }): void }) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

export interface ChromiumSession {
  page: BrowserPageLike;
  close(): Promise<void>;
}

function normalizedHost(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  // Source definitions and admin entries are hostnames, never URL fragments,
  // wildcard expressions, IP literals, or Chromium resolver-rule syntax.
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(
      candidate,
    )
  ) {
    throw new Error(`Tarayıcı allowlistesinde geçersiz host: ${value}`);
  }
  assertSafeUrl(`https://${candidate}/`, [candidate]);
  return candidate;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Chromium oturumu iptal edildi.');
}

async function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Chromium oturumu iptal edildi.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function pinPublicHosts(
  allowedHosts: readonly string[],
  signal?: AbortSignal,
): Promise<{
  hosts: Set<string>;
  resolverRules: string;
}> {
  throwIfAborted(signal);
  const requested = [...new Set(allowedHosts.map(normalizedHost))];
  const mappings = await waitForAbort(
    Promise.all(
      requested.map(async (host) => {
        try {
          const addresses = await resolvePublicAddresses(host, 4);
          const address = addresses.find((entry) => entry.family === 4)?.address;
          return address ? { host, address } : null;
        } catch {
          // An unresolvable or unsafe alias is not added; URLs using it will be
          // blocked by the route guard below. Other verified aliases may work.
          return null;
        }
      }),
    ),
    signal,
  );
  throwIfAborted(signal);
  const pinned = mappings.filter((entry): entry is { host: string; address: string } => entry !== null);
  if (pinned.length === 0) throw new Error('Tarayıcı için doğrulanmış genel IPv4 adresi bulunamadı.');
  const rules = [...pinned.map(({ host, address }) => `MAP ${host} ${address}`), 'MAP * ~NOTFOUND'].join(
    ', ',
  );
  return { hosts: new Set(pinned.map(({ host }) => host)), resolverRules: rules };
}

export function isSafeBrowserRequest(rawUrl: string, allowedHosts: ReadonlySet<string>): boolean {
  if (/^(?:about:|blob:|data:)/i.test(rawUrl)) return true;
  try {
    const url = assertSafeUrl(rawUrl, [...allowedHosts]);
    if (!allowedHosts.has(url.hostname.toLowerCase().replace(/\.$/, ''))) return false;
    if (url.protocol === 'https:' && url.port && url.port !== '443') return false;
    if (url.protocol === 'http:' && url.port && url.port !== '80') return false;
    return true;
  } catch {
    return false;
  }
}

/** Chromium'u başlatır; çağıran `close()` çağırmakla yükümlüdür. */
/**
 * Tarayıcı yedeği açık mı? (`SOURCE_BROWSER_FALLBACK`)
 *
 * `getEnv()` burada çağrılmaz: bu modül adaptörlerden ve betiklerden erken
 * yüklenir ve tüm ortamı doğrulamak (ör. eksik APP_SECRET) tarayıcı kararını
 * belirlememelidir. Anahtar okunamaz/boş ise varsayılan AÇIK'tır.
 */
export function browserFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['SOURCE_BROWSER_FALLBACK']?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

export async function launchChromium(options: {
  allowedHosts: readonly string[];
  signal?: AbortSignal;
}): Promise<ChromiumSession> {
  throwIfAborted(options.signal);
  if (!browserFallbackEnabled()) {
    throw new Error(
      'Tarayıcı yedeği kapalı (SOURCE_BROWSER_FALLBACK=0): Chromium başlatılmadı. ' +
        'Açmak için SOURCE_BROWSER_FALLBACK=1 yazın ve npx playwright install chromium çalıştırın.',
    );
  }
  const pinned = await pinPublicHosts(options.allowedHosts, options.signal);
  // Playwright isteğe bağlı bağımlılıktır: yalnızca gerektiğinde yüklenir.
  const moduleName = 'playwright';
  const playwright = (await waitForAbort(
    import(/* @vite-ignore */ moduleName).catch(() => {
      throw new Error('playwright paketi kurulu değil.');
    }),
    options.signal,
  )) as {
    chromium?: { launch(options: { headless: boolean; args: string[] }): Promise<BrowserLike> };
  };
  throwIfAborted(options.signal);
  if (!playwright.chromium) throw new Error('playwright.chromium bulunamadı.');

  const browser = await waitForAbort(
    playwright.chromium
      .launch({
        headless: true,
        args: [`--host-resolver-rules=${pinned.resolverRules}`, '--no-proxy-server', '--disable-webrtc'],
      })
      .then(async (launchedBrowser) => {
        if (options.signal?.aborted) {
          await launchedBrowser.close().catch(() => undefined);
          throwIfAborted(options.signal);
        }
        return launchedBrowser;
      }),
    options.signal,
  );
  let page: BrowserPageLike | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    options.signal?.removeEventListener('abort', onAbort);
    const pageToClose = page;
    closePromise = (async () => {
      await Promise.all([
        pageToClose?.close().catch(() => undefined),
        browser.close().catch(() => undefined),
      ]);
    })();
    return closePromise;
  };
  const onAbort = () => {
    void close();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    throwIfAborted(options.signal);
    const activePage = await browser.newPage();
    page = activePage;
    if (options.signal?.aborted) {
      await activePage.close().catch(() => undefined);
      throwIfAborted(options.signal);
    }
    await activePage.route('**/*', async (route) => {
      if (isSafeBrowserRequest(route.request().url(), pinned.hosts)) {
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    });
    // WebSocket traffic is not covered by Playwright's HTTP route hook. The
    // source pages are read-only HTML; disallow it rather than expose an
    // unfiltered browser egress path.
    await activePage.routeWebSocket('**/*', (socket) =>
      socket.close({ code: 1008, reason: 'network access blocked' }),
    );
    throwIfAborted(options.signal);
    return { page: activePage, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Tek kullanımlık oturum: iş bitince (hata da olsa) tarayıcı kapanır. */
export async function withChromiumPage<T>(
  run: (page: BrowserPageLike) => Promise<T>,
  options: { allowedHosts: readonly string[]; signal?: AbortSignal },
): Promise<T> {
  const session = await launchChromium(options);
  try {
    return await run(session.page);
  } finally {
    await session.close();
  }
}

/** Sayfayı tarayıcıyla açıp oluşturulmuş HTML'i döndürür. */
export async function renderPageHtml(
  url: string,
  options: { waitSelector?: string; allowedHosts?: readonly string[]; signal?: AbortSignal } = {},
): Promise<string> {
  const host = new URL(url).hostname;
  const allowedHosts = options.allowedHosts ?? [host];
  return withChromiumPage(
    async (page) => {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      if (options.waitSelector) {
        // Liste XHR ile dolabilir; satırların gelmesi için kısa bekleme (yoksa da devam).
        await page.waitForSelector(options.waitSelector, { timeout: 12_000 }).catch(() => undefined);
      }
      return page.content();
    },
    { allowedHosts, signal: options.signal },
  );
}

/**
 * Browser hatasını okunabilir bir özete indirger.
 *
 * Playwright, kurulum eksikliğinde çok satırlı bir kutu basar (kurulum
 * komutları, doküman bağlantıları, `Call log`). Bu metin olduğu gibi kaynak
 * sağlığına yazılırsa panel okunmaz hale gelir. İlk satırlar + kurulum ipucu
 * korunur; ayrıntı kısaltılır.
 */
export function describeBrowserFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0] ?? 'Bilinmeyen tarayıcı hatası';
  const summary = lines
    .slice(1)
    .find((line) => /browser|chromium|executable|timeout|net::|ENOTFOUND|ECONN/i.test(line));
  const parts = [first];
  if (summary && summary !== first) parts.push(summary);
  if (/Executable doesn't exist|Please run the following command/i.test(raw)) {
    parts.push('Kurulum: npx playwright install chromium (ya da kaynağı manuel yönteme alın).');
  }
  return parts.join(' | ').slice(0, 400);
}
