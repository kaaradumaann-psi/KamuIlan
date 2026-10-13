/**
 * Başsız tarayıcı (Playwright/Chromium) oturumu — JS ile dolan ya da
 * tarayıcı-dışı istemciyi yavaşlatan resmî sayfalar için paylaşılan yardımcı.
 *
 * Playwright isteğe bağlı ve pahalı bir bağımlılıktır: yalnızca gerçekten
 * gereken kaynaklarda (Kariyer Kapısı, ilan.gov.tr yedeği, Resmî Gazete
 * yedeği) ve yalnızca gerektiğinde yüklenir/başlatılır.
 */
export interface BrowserPageLike {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<void>;
  evaluate(fn: (arg: string) => Promise<string>, arg: string): Promise<string>;
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

/** Chromium'u başlatır; çağıran `close()` çağırmakla yükümlüdür. */
export async function launchChromium(): Promise<ChromiumSession> {
  // Playwright isteğe bağlı bağımlılıktır: yalnızca gerektiğinde yüklenir.
  const moduleName = 'playwright';
  const playwright = (await import(/* @vite-ignore */ moduleName).catch(() => {
    throw new Error('playwright paketi kurulu değil.');
  })) as { chromium?: { launch(options: { headless: boolean }): Promise<BrowserLike> } };
  if (!playwright.chromium) throw new Error('playwright.chromium bulunamadı.');

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  return {
    page,
    async close(): Promise<void> {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

/** Tek kullanımlık oturum: iş bitince (hata da olsa) tarayıcı kapanır. */
export async function withChromiumPage<T>(run: (page: BrowserPageLike) => Promise<T>): Promise<T> {
  const session = await launchChromium();
  try {
    return await run(session.page);
  } finally {
    await session.close();
  }
}

/** Sayfayı tarayıcıyla açıp oluşturulmuş HTML'i döndürür. */
export async function renderPageHtml(url: string, options: { waitSelector?: string } = {}): Promise<string> {
  return withChromiumPage(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (options.waitSelector) {
      // Liste XHR ile dolabilir; satırların gelmesi için kısa bekleme (yoksa da devam).
      await page.waitForSelector(options.waitSelector, { timeout: 12_000 }).catch(() => undefined);
    }
    return page.content();
  });
}

/**
 * Tarayıcı hatasını okunabilir bir özete indirger.
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
  const summary = lines.slice(1).find((line) => /browser|chromium|executable|timeout|net::|ENOTFOUND|ECONN/i.test(line));
  const parts = [first];
  if (summary && summary !== first) parts.push(summary);
  if (/Executable doesn't exist|Please run the following command/i.test(raw)) {
    parts.push('Kurulum: npx playwright install chromium (ya da kaynağı manuel yönteme alın).');
  }
  return parts.join(' | ').slice(0, 400);
}
