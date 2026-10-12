/**
 * Kariyer Kapısı (kariyerkapisi.gov.tr/isealim).
 *
 * Durum (canlı gözlem, 2026-10-12): sayfa istemci tarafında (JS) doldurulur;
 * basit HTML isteğinde "aktif ilan yok" görünür. Bu yüzden EN PAHALI yöntem
 * burada saklanır ama varsayılan değildir: adaptör bunu açıkça bildirir ve
 * tarayıcı bağımlılığı kurulu değilse uyarı olarak raporlar.
 *
 * Yöntem: yalnızca `playwright` kuruluysa başsız tarayıcı; aksi halde
 * "yapı tanınmadı" hatası (sessiz boş dönüş yok).
 */
import { anchors, loadHtml, readableText } from '../../lib/html';
import { cleanTitle } from '../listing-utils';
import { AdapterUnavailableError } from '../errors';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

interface BrowserLike {
  newPage(): Promise<{
    goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
    content(): Promise<string>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}

export class KariyerKapisiAdapter implements SourceAdapter {
  readonly key = 'kariyer-kapisi-isealim';
  readonly label = 'Kariyer Kapısı — kamu işe alım ilanları';
  readonly method = 'browser';
  readonly notes =
    'Liste JS ile doldurulur. Tarayıcı (Playwright) kuruluysa başsız tarayıcıyla okunur; kurulu değilse kaynak "erişilebilir ama otomatik toplanamıyor" olarak raporlanır. En pahalı yöntem olduğu için son tercihtir.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const { source, liveFetch } = ctx;
    if (!liveFetch) {
      return {
        items: [],
        requestCount: 0,
        notes: ['Canlı erişim kapalı (SOURCE_LIVE_FETCH=0): doğrulama modu, ilan toplanmadı.'],
        etag: null,
        lastModified: null,
        notModified: false,
        httpStatuses: [],
      };
    }

    const html = await this.renderWithBrowser(source.listingUrl).catch((error: unknown) => {
      throw new AdapterUnavailableError(
        source.key,
        describeBrowserFailure(error),
        'Başsız tarayıcı (playwright) gerekiyor: npm i -D playwright && npx playwright install chromium',
      );
    });

    const $ = loadHtml(html);
    const rows: RawAnnouncement[] = [];
    const seen = new Set<string>(ctx.knownItemIds ?? []);

    for (const anchor of anchors($, 'a[href]', source.listingUrl, 400)) {
      if (!/ilan|kadro|alim|alım/i.test(`${anchor.href} ${anchor.text}`)) continue;
      const itemId = /\/(\d{4,})/.exec(anchor.href)?.[1] ?? anchor.href.slice(-40);
      if (seen.has(itemId)) continue;
      const title = cleanTitle(anchor.text);
      if (title.length < 15) continue;
      rows.push({
        sourceKey: source.key,
        sourceItemId: itemId,
        url: anchor.href,
        title,
        institution: source.institution,
        attachments: [],
        sourceCategory: 'kariyer kapısı',
        extractionConfidence: 0.5,
      });
      seen.add(itemId);
      if (rows.length >= 30) break;
    }

    const pageText = readableText($, 'body', 400);
    return {
      items: rows,
      requestCount: 1,
      notes: [
        `Tarayıcı ile okundu: ${rows.length} ilan bağlantısı bulundu.`,
        rows.length === 0 ? `Sayfada ilan bulunamadı. Sayfa özeti: "${pageText.slice(0, 140)}"` : 'Kayıtlar başvuru bağlantısıyla birlikte alınır.',
      ],
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses: [200],
    };
  }

  private async renderWithBrowser(url: string): Promise<string> {
    // Playwright isteğe bağlı bağımlılıktır: yalnızca gerektiğinde yüklenir.
    const moduleName = 'playwright';
    const playwright = (await import(/* @vite-ignore */ moduleName).catch(() => {
      throw new Error('playwright paketi kurulu değil.');
    })) as { chromium?: { launch(options: { headless: boolean }): Promise<BrowserLike> } };
    if (!playwright.chromium) throw new Error('playwright.chromium bulunamadı.');

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      const html = await page.content();
      await page.close();
      return html;
    } finally {
      await browser.close();
    }
  }
}

/**
 * Tarayıcı hatasını okunabilir bir özete indirger.
 *
 * Playwright, kurulum eksikliğinde çok satırlı bir kutu basar (kurulum
 * komutları, doküman bağlantıları, `Call log`). Bu metin olduğu gibi kaynak
 * sağlığına yazılırsa panel okunmaz hale gelir. İlk satırlar + kurulum ipucu
 * korunur; ayrıntı kısaltılır.
 */
function describeBrowserFailure(error: unknown): string {
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
