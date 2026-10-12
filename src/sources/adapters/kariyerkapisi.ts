/**
 * Kariyer Kapısı — Kamu İşe Alım adaptörü.
 *
 * Neden tarayıcı gerekir: ilan tablosu istemci tarafında (JavaScript) üretilir;
 * düz HTTP isteğiyle liste okunamaz (12.10.2026 canlı doğrulama).
 *
 * Playwright kurulu değilse adaptör SESSİZCE boş liste DÖNDÜRMEZ; bunun yerine
 * "yetenek yok" hatası verir. Bu hata çalıştırma kaydına ve kaynak sağlığına
 * yazılır, panelde "atlandı" olarak görünür.
 *
 * CAPTCHA/erişim kontrolü aşılmaz; yalnızca herkese açık liste okunur.
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError, AdapterUnavailableError } from '../errors';
import { cleanTitle, parseListingDate } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

interface PlaywrightLike {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserLike>;
  };
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForLoadState(state: string, options?: Record<string, unknown>): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
}

export class KariyerKapisiAdapter implements SourceAdapter {
  readonly key = 'kariyerkapisi';
  readonly label = 'Kariyer Kapısı — Kamu İşe Alım';
  readonly method = 'browser';
  readonly notes =
    'İlan tablosu JavaScript ile üretilir; liste Playwright (headless Chromium) ile okunur. ' +
    'Playwright yoksa tarama atlanır ve durum panelde "yapılandırma eksik" olarak görünür.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const notes: string[] = [];
    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: tarayıcı açılmadı.');
      return { items: [], requestCount: 0, notes, etag: null, lastModified: null, notModified: false };
    }

    const playwright = await loadPlaywright();
    if (!playwright) {
      throw new AdapterUnavailableError(
        this.key,
        'Kariyer Kapısı için tarayıcı otomasyonu gerekli ancak Playwright kurulu değil.',
        'npm install (playwright bağımlılığı) + npx playwright install chromium',
      );
    }

    const browser = await playwright.chromium.launch({ headless: true });
    let requestCount = 0;
    const items: RawAnnouncement[] = [];

    try {
      const page = await browser.newPage();
      try {
        await page.goto(ctx.source.listingUrl, { waitUntil: 'networkidle', timeout: 45_000 });
        requestCount += 1;
        // Tablonun oluşması için makul bir bekleme; sonrasında içerik okunur.
        await page.waitForTimeout(2_500);
        const html = await page.content();
        const parsed = parseListingHtml(html);

        if (parsed.emptyNotice) {
          notes.push('Kariyer Kapısı o an aktif ilan göstermiyor ("Şu an aktif bir ilan bulunmamaktadır.").');
        }

        if (!parsed.hasTable && !parsed.emptyNotice) {
          throw new AdapterStructureError(
            this.key,
            'Kariyer Kapısı ilan tablosu bulunamadı.',
            'Sayfa açıldı ancak beklenen tablo/boş-list mesajı yok; arayüz değişmiş olabilir.',
          );
        }

        let detailFetches = 0;
        for (const row of parsed.rows) {
          const sourceItemId = `kariyerkapisi:${row.reference ?? row.detailUrl ?? row.title}`;
          if (ctx.knownItemIds?.has(sourceItemId)) continue;
          if (row.detailUrl && detailFetches < ctx.maxDetailFetches) {
            detailFetches += 1;
            try {
              await page.goto(row.detailUrl, { waitUntil: 'networkidle', timeout: 45_000 });
              requestCount += 1;
              const detailHtml = await page.content();
              const detailText = collapseWhitespace(stripTags(detailHtml));
              items.push({
                sourceKey: ctx.source.key,
                sourceItemId,
                url: row.detailUrl,
                title: row.title,
                bodyText: detailText.slice(0, 12_000),
                institution: row.institution ?? 'Belirtilmemiş kurum (Kariyer Kapısı)',
                ...(row.publishedAt ? { publishedAt: `${row.publishedAt}T00:00:00+03:00` } : {}),
                ...(row.applicationEndDate ? { applicationEndAt: `${row.applicationEndDate}T23:59:00+03:00` } : {}),
                attachments: [],
                sourceCategory: 'kariyerkapisi-isealim',
                rawExcerpt: detailText.slice(0, 1_200),
                extractionConfidence: 0.6,
                ...(row.reference ? { notes: [`İlan numarası: ${row.reference}`] } : {}),
              });
            } catch {
              notes.push(`İlan detayı okunamadı: ${row.title.slice(0, 60)}`);
            }
          } else {
            items.push({
              sourceKey: ctx.source.key,
              sourceItemId,
              url: row.detailUrl ?? ctx.source.listingUrl,
              title: row.title,
              institution: row.institution ?? 'Belirtilmemiş kurum (Kariyer Kapısı)',
              ...(row.publishedAt ? { publishedAt: `${row.publishedAt}T00:00:00+03:00` } : {}),
              ...(row.applicationEndDate ? { applicationEndAt: `${row.applicationEndDate}T23:59:00+03:00` } : {}),
              attachments: [],
              sourceCategory: 'kariyerkapisi-isealim',
              extractionConfidence: 0.4,
              notes: ['Yalnızca liste bilgisi alındı (detay okunmadı).'],
            });
          }
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    if (items.length === 0 && notes.length === 0) {
      notes.push('Aktif ilan bulunamadı.');
    }

    return { items, requestCount, notes, etag: null, lastModified: null, notModified: false };
  }
}

async function loadPlaywright(): Promise<PlaywrightLike | null> {
  try {
    const module = (await import('playwright')) as unknown as PlaywrightLike;
    return module.chromium ? module : null;
  } catch {
    return null;
  }
}

interface ParsedRow {
  title: string;
  detailUrl: string | null;
  institution: string | null;
  reference: string | null;
  publishedAt: string | null;
  applicationEndDate: string | null;
}

/**
 * Kariyer Kapısı liste HTML'ini satırlara çevirir.
 *
 * Not: Arayüz değişirse `hasTable` false döner ve adaptör yapı hatası verir;
 * böylece "ilan yok" ile "yapı bozuldu" birbirine karışmaz.
 */
export function parseListingHtml(html: string): { rows: ParsedRow[]; hasTable: boolean; emptyNotice: boolean } {
  const emptyNotice = /şu an aktif bir ilan bulunmamaktadır/i.test(html);
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: ParsedRow[] = [];
  let hasTable = false;

  for (const match of html.matchAll(rowPattern)) {
    const rowHtml = match[1] ?? '';
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripTags(cell[1] ?? ''));
    if (cells.length < 2) continue;
    hasTable = true;

    const title = cleanTitle(cells[0] ?? '');
    if (title.length < 10) continue;
    const hrefMatch = /href="([^"]+)"/i.exec(rowHtml);
    const href = hrefMatch?.[1] ?? null;
    const reference = /\b([A-Z0-9]{4,})-\d+\b/.exec(cells.join(' '))?.[1] ?? null;
    const dates = cells.map((cell) => parseListingDate(cell)).filter((value): value is string => Boolean(value));

    rows.push({
      title,
      detailUrl: href && /^https?:/i.test(href) ? href : href ? new URL(href, 'https://kariyerkapisi.gov.tr').toString() : null,
      institution: cells.find((cell) => /(Bakanlığı|Başkanlığı|Rektörlüğü|Müdürlüğü|Belediyesi|Üniversitesi|Kurumu)/u.test(cell)) ?? null,
      reference,
      publishedAt: dates[0] ?? null,
      applicationEndDate: dates.length > 1 ? (dates[dates.length - 1] ?? null) : (dates[0] ?? null),
    });
  }

  return { rows, hasTable, emptyNotice };
}

function stripTags(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}
