/**
 * Kariyer Kapısı (kariyerkapisi.gov.tr/isealim).
 *
 * Doğrulanmış yapı (13.10.2026, kullanıcı ekran görüntüleriyle):
 *   Liste: "Kurum/Birim | Aktif İlanlar | Bitiş Tarihi | Başvur" tablo
 *   satırları. İlan başlığı hücre metnidir (bağlantı değil); satırdaki
 *   Başvur düğmesi detaya gider.
 *   Detay: /IlanDetay?i=<uuid> — sayfada İlan Numarası (ILN...), İlan Türü,
 *   Başvuru Başlangıç/Bitiş tarihleri ve ilanın tam metni bulunur.
 *
 * Liste JS ile doldurulduğu için sayfa başsız tarayıcıyla okunur;
 * detaylar da aynı tarayıcı oturumunda (sınırlı sayıda) ziyaret edilir.
 * Tarayıcı kurulu değilse adaptör bunu açıkça raporlar (sessiz boş yok).
 */
import { collapseWhitespace } from '../../domain/text';
import { firstDateOnlyIn, toIstanbulIso } from '../../domain/dates';
import { sha256Hex } from '../../domain/ids';
import { absoluteUrl, anchors, loadHtml, readableText } from '../../lib/html';
import { describeBrowserFailure, withChromiumPage } from '../browser-session';
import { cleanInstitution, cleanTitle } from '../listing-utils';
import { AdapterUnavailableError } from '../errors';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

export interface KariyerRow {
  sourceItemId: string;
  url: string;
  title: string;
  institution?: string;
  applicationEndAt?: string;
}

export interface KariyerDetail {
  bodyText?: string;
  referenceNo?: string;
  applicationStartAt?: string;
  applicationEndAt?: string;
  category?: string;
}

/** İlan detay adresindeki `i` (uuid) parametresi en kararlı kimliktir. */
function itemIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const uuid = parsed.searchParams.get('i');
    if (uuid && /^[0-9a-f-]{16,}$/i.test(uuid)) return uuid;
    return /(\d{4,})/.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function detailUrlIn(rowHtml: string, listingUrl: string): string | null {
  const match = /IlanDetay\?i=([0-9a-f-]{36})/i.exec(rowHtml);
  if (!match) return null;
  try {
    return `${new URL(listingUrl).origin}/IlanDetay?i=${match[1]}`;
  } catch {
    return null;
  }
}

/**
 * Liste sayfasındaki ilan tablosunu ayrıştırır. İmza: başlığında
 * "Aktif İlanlar" geçen tablo; imzasız tablolarda tarihli satırlar kabul
 * edilir. Başlık hücre metnidir; detay adresi satırın HTML'inden
 * (bağlantı/düğme fark etmez) çıkarılır, yoksa liste adresi kullanılır.
 */
export function parseKariyerRows(html: string, listingUrl: string): KariyerRow[] {
  const $ = loadHtml(html);
  const rows: KariyerRow[] = [];
  const seen = new Set<string>();

  $('table').each((_tableIndex, table) => {
    const headerText = collapseWhitespace($(table).find('tr').first().text()).toLocaleLowerCase('tr');
    const isIlanTable = headerText.includes('aktif ilanlar');
    $(table)
      .find('tr')
      .each((_rowIndex, tr) => {
        const cells = $(tr).find('td');
        if (cells.length < 3) return;
        const texts = cells.map((_cellIndex, td) => collapseWhitespace($(td).text())).get();
        const title = cleanTitle(texts[1] ?? '');
        if (title.length < 15) return;
        const dateOnly = firstDateOnlyIn(texts[2] ?? '') ?? firstDateOnlyIn(texts.join(' '));
        if (!isIlanTable && !dateOnly) return;

        const rowHtml = $(tr).html() ?? '';
        let url = detailUrlIn(rowHtml, listingUrl);
        if (!url) {
          const href = $(tr).find('a[href]').first().attr('href');
          if (href) {
            try {
              url = new URL(href, listingUrl).toString();
            } catch {
              url = null;
            }
          }
        }
        url ??= listingUrl;

        const institution = cleanInstitution(texts[0] ?? '') ?? undefined;
        const sourceItemId =
          itemIdFromUrl(url) ?? `kk-${sha256Hex(`${institution ?? ''}|${title}|${dateOnly ?? ''}`).slice(0, 16)}`;
        if (seen.has(sourceItemId)) return;
        seen.add(sourceItemId);

        rows.push({
          sourceItemId,
          url,
          title,
          ...(institution ? { institution } : {}),
          ...(dateOnly ? { applicationEndAt: toIstanbulIso(dateOnly, '23:59') } : {}),
        });
      });
  });

  if (rows.length === 0) return rowsFromDetailAnchors($, listingUrl);
  return rows;
}

/**
 * Tablo öğesi kullanılmayan (div ızgarası) liste düzeni: her "Başvur"
 * bağlantısından satır kapsayıcısına tırmanılır; kurum/başlık/bitiş tarihi
 * kapsayıcının hücrelerinden (doğrudan çocuklar) okunur.
 */
function rowsFromDetailAnchors($: ReturnType<typeof loadHtml>, listingUrl: string): KariyerRow[] {
  const rows: KariyerRow[] = [];
  const seen = new Set<string>();

  $('a[href*="IlanDetay?i="]').each((_index, element) => {
    const url = absoluteUrl($(element).attr('href'), listingUrl, $);
    if (!url) return;
    const sourceItemId = itemIdFromUrl(url);
    if (!sourceItemId || seen.has(sourceItemId)) return;

    // Satır kapsayıcısı: tek detay bağlantısı içeren ve tarih barındıran en küçük üst öğe.
    let container = $(element);
    for (let depth = 0; depth < 7; depth += 1) {
      const parent = container.parent();
      if (parent.length === 0) break;
      if (parent.find('a[href*="IlanDetay?i="]').length !== 1) break;
      container = parent;
      const text = collapseWhitespace(container.text());
      if (text.length >= 60 && firstDateOnlyIn(text)) break;
    }

    const fullText = collapseWhitespace(container.text());
    const dateOnly = firstDateOnlyIn(fullText);
    if (!dateOnly) return;

    const cells = container
      .children()
      .map((_cellIndex, cell) => collapseWhitespace($(cell).text()))
      .get()
      .filter((text) => text.length > 0);
    let title = cells.length >= 3 ? cleanTitle(cells[1] ?? '') : '';
    let institutionText = cells.length >= 3 ? (cells[0] ?? '') : '';

    if (title.length < 15) {
      const pool = new Set<string>();
      container.find('*').each((_childIndex, child) => {
        const text = collapseWhitespace($(child).text());
        if (text) pool.add(text);
      });
      const candidates = [...pool].filter(
        (text) => text.length >= 15 && text !== fullText && !/^ba[sş]vur$/i.test(text),
      );
      title = cleanTitle(candidates.sort((a, b) => b.length - a.length)[0] ?? '');
      institutionText ||= candidates.find(
        (text) => text !== title && /(Bakanlı|Başkanlı|Üniversite|Müdürlüğü|Belediye|Kurumu|Ajansı)/i.test(text),
      ) ?? '';
    }
    if (title.length < 15) return;

    seen.add(sourceItemId);
    const institution = cleanInstitution(institutionText) ?? undefined;
    rows.push({
      sourceItemId,
      url,
      title,
      ...(institution ? { institution } : {}),
      applicationEndAt: toIstanbulIso(dateOnly, '23:59'),
    });
  });

  return rows;
}

/** Detay sayfasından ilan numarası, tarihler, tür ve gövde metnini çıkarır. */
export function parseKariyerDetail(html: string): KariyerDetail {
  const $ = loadHtml(html);
  const text = readableText($, 'body', 20_000);
  const detail: KariyerDetail = {};

  const reference = /\bILN\d{5,}\b/.exec(text);
  if (reference) detail.referenceNo = reference[0];

  const start = /Başvuru Başlangıç\s*:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(text);
  const startDate = start ? firstDateOnlyIn(start[1] ?? '') : null;
  if (startDate) detail.applicationStartAt = toIstanbulIso(startDate, '00:00');

  const end = /Başvuru Bitiş\s*:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(text);
  const endDate = end ? firstDateOnlyIn(end[1] ?? '') : null;
  if (endDate) detail.applicationEndAt = toIstanbulIso(endDate, '23:59');

  const category = /İlan Türü\s*:?\s*([A-ZÇĞİÖŞÜ][^|]{2,60}?)(?=\s+Başvuru Başlangıç|\s+Kalan Zaman|\s+BAŞVUR\b|$)/.exec(text);
  if (category) detail.category = collapseWhitespace(category[1] ?? '');

  if (text.length > 200) detail.bodyText = text;
  return detail;
}

export class KariyerKapisiAdapter implements SourceAdapter {
  readonly key = 'kariyer-kapisi-isealim';
  readonly label = 'Kariyer Kapısı — kamu işe alım ilanları';
  readonly method = 'browser';
  readonly notes =
    'Liste JS ile doldurulur; başsız tarayıcıyla tablo satırları okunur, detaylar (/IlanDetay?i=) aynı oturumda sınırlı sayıda ziyaret edilir. ' +
    'Tarayıcı (Playwright) kurulu değilse kaynak "erişilebilir ama otomatik toplanamıyor" olarak raporlanır. En pahalı yöntem olduğu için son tercihtir.';

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

    const pages = await this.renderPages([source.listingUrl]).catch((error: unknown) => {
      throw new AdapterUnavailableError(
        source.key,
        describeBrowserFailure(error),
        'Başsız tarayıcı (playwright) gerekiyor: npm i -D playwright && npx playwright install chromium',
      );
    });
    const html = pages.get(source.listingUrl) ?? '';

    const $ = loadHtml(html);
    const rows: RawAnnouncement[] = [];
    const seen = new Set<string>(ctx.knownItemIds ?? []);
    const detailByUrl = new Map<string, KariyerDetail>();

    const tableRows = parseKariyerRows(html, source.listingUrl);
    for (const row of tableRows) {
      if (seen.has(row.sourceItemId) || rows.length >= 30) continue;
      seen.add(row.sourceItemId);
      rows.push({
        sourceKey: source.key,
        sourceItemId: row.sourceItemId,
        url: row.url,
        title: row.title,
        institution: row.institution ?? source.institution,
        ...(row.applicationEndAt ? { applicationEndAt: row.applicationEndAt } : {}),
        attachments: [],
        sourceCategory: 'kariyer kapısı',
        extractionConfidence: 0.45,
      });
    }

    // Tablo bulunamazsa eski bağlantı taraması yedek olarak denenir.
    if (rows.length === 0) {
      for (const anchor of anchors($, 'body', source.listingUrl, 400)) {
        if (!/ilan|kadro|alim|alım/i.test(`${anchor.href} ${anchor.text}`)) continue;
        const itemId = itemIdFromUrl(anchor.href) ?? anchor.href.slice(-40);
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
    }

    // Detaylar: aynı oturumda, sınırlı sayıda (ctx.maxDetailFetches).
    const detailUrls = rows
      .map((row) => row.url)
      .filter((url) => /IlanDetay\?i=/i.test(url))
      .slice(0, Math.max(0, ctx.maxDetailFetches));
    let detailCount = 0;
    if (detailUrls.length > 0) {
      const detailPages = await this.renderPages(detailUrls).catch(() => new Map<string, string>());
      for (const [url, detailHtml] of detailPages) {
        detailByUrl.set(url, parseKariyerDetail(detailHtml));
        detailCount += 1;
      }
      for (const row of rows) {
        const detail = detailByUrl.get(row.url);
        if (!detail) continue;
        if (detail.bodyText) row.bodyText = detail.bodyText;
        if (detail.referenceNo) row.referenceNo = detail.referenceNo;
        if (detail.applicationStartAt) row.applicationStartAt = detail.applicationStartAt;
        if (detail.applicationEndAt) row.applicationEndAt = detail.applicationEndAt;
        if (detail.category) row.sourceCategory = detail.category;
        row.applicationUrl = row.url;
        row.extractionConfidence = 0.6;
      }
    }

    const pageText = readableText($, 'body', 400);
    // 0 ilan bulunduğunda sayfadaki gerçek bağlantı biçimini rapora yaz:
    // bir sonraki düzeltme tahmine değil bu gözleme dayanır.
    const anchorSamples =
      rows.length === 0
        ? anchors($, 'body', source.listingUrl, 400)
            .slice(0, 12)
            .map((anchor) => `"${anchor.text.slice(0, 60)}" -> ${anchor.href.slice(0, 120)}`)
        : [];
    const notes = [
      `Tarayıcı ile okundu: ${rows.length} ilan bulundu.`,
      ...(detailCount > 0 ? [`${detailCount} ilanın detay sayfası da okundu (ilan no/tarihler/metin).`] : []),
      ...(rows.length === 0 ? [`Sayfada ilan bulunamadı. Sayfa özeti: "${pageText.slice(0, 140)}"`] : []),
      ...(anchorSamples.length > 0 ? [`Bağlantı örnekleri: ${anchorSamples.join(' | ')}`] : []),
    ];

    return {
      items: rows,
      requestCount: 1 + detailCount,
      notes,
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses: [200],
    };
  }

  /** Verilen adresleri tek tarayıcı oturumunda sırayla açar; adres→HTML döndürür. */
  private async renderPages(urls: string[]): Promise<Map<string, string>> {
    const rendered = new Map<string, string>();
    await withChromiumPage(async (page) => {
      for (const url of urls) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        // Liste XHR ile dolar; satırların yerleşmesi için kısa bekleme.
        await page.waitForTimeout(1_500);
        rendered.set(url, await page.content());
      }
    });
    return rendered;
  }
}
