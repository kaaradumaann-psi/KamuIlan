/**
 * Kariyer Kapısı (kariyerkapisi.gov.tr/isealim).
 *
 * Doğrulanmış yapı (13.10.2026; liste + detay sayfalarının gerçek DOM'u
 * kullanıcıdan alındı):
 *   Liste: #pnlIlanlar içinde satır satır: kurum logosu | kurum/birim |
 *   ilan başlığı | bitiş tarihi | "Başvur" (/IlanDetay?i=<uuid>) ya da
 *   "İlana Git" (kurumun kendi dış başvuru adresi) düğmesi. Sayfa
 *   sunucu tarafında üretilir; önce düz HTTP denenir, liste boş
 *   gelirse tarayıcı yedeğine düşülür.
 *   Detay: /IlanDetay?i=<uuid> — #lbl_ILN_NO (ILN...), #lbl_IlanTuru,
 *   #lbl_BasDate / #lbl_BitDate, #lbl_anailanmetni (tam metin),
 *   #href_BasvuruLinki (e-Devlet başvuru adresi), kontenjan bilgisi.
 */
import { collapseWhitespace } from '../../domain/text';
import { firstDateOnlyIn, toIstanbulIso } from '../../domain/dates';
import { sha256Hex } from '../../domain/ids';
import { absoluteUrl, anchors, loadHtml, readableText } from '../../lib/html';
import { cleanInstitution, cleanTitle } from '../listing-utils';
import { AdapterUnavailableError } from '../errors';
import { describeBrowserFailure, withChromiumPage } from '../browser-session';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

export interface KariyerRow {
  sourceItemId: string;
  url: string;
  title: string;
  institution?: string;
  applicationEndAt?: string;
  /** Dış başvuru adresi (satır "İlana Git" diyorsa). */
  applicationUrl?: string;
}

export interface KariyerDetail {
  bodyText?: string;
  referenceNo?: string;
  applicationStartAt?: string;
  applicationEndAt?: string;
  applicationUrl?: string;
  category?: string;
  quota?: number;
}

/** İlan detay adresindeki uuid en kararlı kimliktir; yoksa sondaki uzun sayı, o da yoksa null. */
function itemIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    for (const param of ['i', 'id']) {
      const value = parsed.searchParams.get(param);
      if (value && /^[0-9a-f-]{16,}$/i.test(value)) return value;
    }
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1] ?? '';
    return /(\d{6,})$/.exec(last)?.[1] ?? null;
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

/** Satırdaki eylem bağlantısı mı (Başvur / İlana Git / detay adresi)? */
function isActionAnchor(text: string, href: string): boolean {
  // JS /i bayrağı Türkçe "İ" harfini "i" ile eşleştirmez; metin önce
  // Türkçe küçük harfe çevrilir ("İlana Git" → "ilana git").
  const normalized = text.toLocaleLowerCase('tr');
  return /IlanDetay\?i=/i.test(href) || normalized === 'başvur' || normalized === 'ilana git';
}

/**
 * Liste sayfasındaki ilanları ayrıştırır. Önce gerçek <table> düzeni,
 * yoksa eylem bağlantılarından satır kapsayıcısına tırmanan div düzeni.
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

  if (rows.length === 0) return rowsFromActionAnchors($, listingUrl);
  return rows;
}

/**
 * Div ızgara düzeni (gerçek sayfadaki yapı): her eylem bağlantısından
 * (Başvur / İlana Git) satır kapsayıcısına tırmanılır; kurum/başlık/bitiş
 * tarihi kapsayıcının metin hücrelerinden okunur. Dış adrese giden
 * satırlar da ilandır (başvuru adresi dış bağlantıdır).
 */
function rowsFromActionAnchors($: ReturnType<typeof loadHtml>, listingUrl: string): KariyerRow[] {
  const rows: KariyerRow[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_index, element) => {
    const anchorText = collapseWhitespace($(element).text());
    const rawHref = $(element).attr('href') ?? '';
    if (!isActionAnchor(anchorText, rawHref)) return;
    const url = absoluteUrl(rawHref, listingUrl, $);
    if (!url) return;

    // Satır kapsayıcısı: tek eylem bağlantısı içeren ve tarih barındıran en küçük üst öğe.
    let container = $(element);
    for (let depth = 0; depth < 7; depth += 1) {
      const parent = container.parent();
      if (parent.length === 0) break;
      const actionCount = parent
        .find('a[href]')
        .toArray()
        .filter((candidate) => isActionAnchor(collapseWhitespace($(candidate).text()), $(candidate).attr('href') ?? ''))
        .length;
      if (actionCount !== 1) break;
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
        (text) =>
          text.length >= 15 &&
          text !== fullText &&
          !isActionAnchor(text, ''),
      );
      title = cleanTitle(candidates.sort((a, b) => b.length - a.length)[0] ?? '');
      institutionText ||= candidates.find(
        (text) => text !== title && /(Bakanlı|Başkanlı|Üniversite|Müdürlüğü|Belediye|Kurumu|Ajansı)/i.test(text),
      ) ?? '';
    }
    if (title.length < 15) return;

    const isDetailLink = /IlanDetay\?i=/i.test(url);
    const institution = cleanInstitution(institutionText) ?? undefined;
    const sourceItemId =
      itemIdFromUrl(url) ?? `kk-${sha256Hex(`${institution ?? ''}|${title}|${dateOnly}`).slice(0, 16)}`;
    if (seen.has(sourceItemId)) return;
    seen.add(sourceItemId);

    rows.push({
      sourceItemId,
      url,
      title,
      ...(institution ? { institution } : {}),
      applicationEndAt: toIstanbulIso(dateOnly, '23:59'),
      ...(isDetailLink ? {} : { applicationUrl: url }),
    });
  });

  return rows;
}

/** Detay sayfasından ilan numarası, tarihler, tür, kontenjan ve gövde metnini çıkarır. */
export function parseKariyerDetail(html: string): KariyerDetail {
  const $ = loadHtml(html);
  const detail: KariyerDetail = {};
  const byId = (id: string): string => collapseWhitespace($(`#${id}`).first().text());

  // Önce kararlı öğe kimlikleri (gerçek sayfada doğrulandı).
  const referenceNo = byId('lbl_ILN_NO');
  if (/\bILN\d{5,}\b/.test(referenceNo)) detail.referenceNo = referenceNo.match(/\bILN\d{5,}\b/)?.[0];

  const startDate = firstDateOnlyIn(byId('lbl_BasDate'));
  if (startDate) detail.applicationStartAt = toIstanbulIso(startDate, '00:00');
  const endDate = firstDateOnlyIn(byId('lbl_BitDate'));
  if (endDate) detail.applicationEndAt = toIstanbulIso(endDate, '23:59');

  const category = byId('lbl_IlanTuru');
  if (category.length >= 3) detail.category = category;

  const applyHref = $('#href_BasvuruLinki').first().attr('href') ?? $('a[href*="turkiye.gov.tr"]').first().attr('href');
  if (applyHref) detail.applicationUrl = applyHref;

  const mainText = collapseWhitespace($('#lbl_anailanmetni').first().text());
  if (mainText.length > 200) detail.bodyText = mainText.slice(0, 20_000);

  const quotaMatch = /Kontenjan\s*\((\d+)\)/.exec(collapseWhitespace($('#div_AltIlan').first().text()));
  if (quotaMatch?.[1]) detail.quota = Number.parseInt(quotaMatch[1], 10);

  // Kimlikler bulunamazsa (yapı değişimi) metin kalıplarına düşülür.
  const text = readableText($, 'body', 20_000);
  if (!detail.referenceNo) {
    const reference = /\bILN\d{5,}\b/.exec(text);
    if (reference) detail.referenceNo = reference[0];
  }
  if (!detail.applicationStartAt) {
    const start = /Başvuru Başlangıç\s*:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(text);
    const parsed = start ? firstDateOnlyIn(start[1] ?? '') : null;
    if (parsed) detail.applicationStartAt = toIstanbulIso(parsed, '00:00');
  }
  if (!detail.applicationEndAt) {
    const end = /Başvuru Bitiş\s*:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(text);
    const parsed = end ? firstDateOnlyIn(end[1] ?? '') : null;
    if (parsed) detail.applicationEndAt = toIstanbulIso(parsed, '23:59');
  }
  if (!detail.category) {
    const categoryMatch = /İlan Türü\s*:?\s*([A-ZÇĞİÖŞÜ][^|]{2,60}?)(?=\s+Başvuru Başlangıç|\s+Kalan Zaman|\s+BAŞVUR\b|$)/.exec(text);
    if (categoryMatch) detail.category = collapseWhitespace(categoryMatch[1] ?? '');
  }
  if (!detail.bodyText && text.length > 200) detail.bodyText = text;

  return detail;
}

export class KariyerKapisiAdapter implements SourceAdapter {
  readonly key = 'kariyer-kapisi-isealim';
  readonly label = 'Kariyer Kapısı — kamu işe alım ilanları';
  readonly method = 'html-list';
  readonly notes =
    'Liste sunucu tarafında üretilir: önce düz HTTP ile satırlar okunur; liste boş gelirse aynı ayrıştırma ' +
    'başsız tarayıcıyla açılmış sayfada koşulur. Detaylar (/IlanDetay?i=) sınırlı sayıda çekilir: ilan numarası, ' +
    'başvuru tarihleri, tür, kontenjan ve tam metin alınır; başvuru adresi e-Devlet bağlantısıdır.';

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

    const notes: string[] = [];
    const httpStatuses: number[] = [];
    let requestCount = 0;
    let rows: KariyerRow[] = [];
    let viaBrowser = false;
    let listHtml = '';

    // 1) Düz HTTP: sayfa sunucu tarafında üretiliyor (doğrulandı).
    try {
      const response = await ctx.http.fetchText(source.listingUrl, {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
      });
      requestCount += 1;
      httpStatuses.push(response.status);
      listHtml = response.decoded?.text ?? response.body.toString('utf8');
      rows = parseKariyerRows(listHtml, source.listingUrl);
      if (rows.length > 0) notes.push(`Liste HTTP ile okundu: ${rows.length} ilan satırı.`);
    } catch (error) {
      notes.push(
        `HTTP listesi alınamadı (${error instanceof Error ? error.message : String(error)}); tarayıcı denenecek.`,
      );
    }

    // 2) Tarayıcı yedeği: liste boşsa ya da HTTP hata verdiyse.
    if (rows.length === 0) {
      const pages = await this.renderPages([source.listingUrl]).catch((error: unknown) => {
        throw new AdapterUnavailableError(
          source.key,
          describeBrowserFailure(error),
          'Başsız tarayıcı (playwright) gerekiyor: npm i -D playwright && npx playwright install chromium',
        );
      });
      listHtml = pages.get(source.listingUrl) ?? '';
      rows = parseKariyerRows(listHtml, source.listingUrl);
      viaBrowser = true;
      requestCount += 1;
      if (rows.length > 0) notes.push(`Liste tarayıcı ile okundu: ${rows.length} ilan satırı.`);
    }
    if (rows.length === 0) {
      notes.push(
        `Liste sayfası alındı (${listHtml.length} karakter) ancak ilan satırı ayrıştırılamadı; sayfa yapısı değişmiş olabilir.`,
      );
      return { items: [], requestCount, notes, etag: null, lastModified: null, notModified: false, httpStatuses };
    }

    // 3) Detaylar: yalnız iç detay bağlantısı (/IlanDetay?i=) taşıyan satırlar
    //    için ve ctx.maxDetailFetches sınırıyla. Dış "İlana Git" satırlarında
    //    çekilecek detay sayfası yoktur; başvuru adresi satırın kendisidir.
    const items: RawAnnouncement[] = [];
    let detailFetches = 0;
    let limitNoted = false;

    for (const row of rows) {
      const itemNotes: string[] = [];
      if (viaBrowser) itemNotes.push('Liste tarayıcı ile okundu.');
      const item: RawAnnouncement = {
        sourceKey: source.key,
        sourceItemId: row.sourceItemId,
        url: row.url,
        title: row.title,
        ...(row.institution ? { institution: row.institution } : {}),
        ...(row.applicationEndAt ? { applicationEndAt: row.applicationEndAt } : {}),
        ...(row.applicationUrl ? { applicationUrl: row.applicationUrl } : {}),
        attachments: [],
        extractionConfidence: 0.6,
        ...(itemNotes.length > 0 ? { notes: itemNotes } : {}),
      };

      if (/IlanDetay\?i=/i.test(row.url)) {
        if (detailFetches >= ctx.maxDetailFetches) {
          if (!limitNoted) {
            limitNoted = true;
            notes.push(
              `Detay çekme sınırı (${ctx.maxDetailFetches}) doldu; kalan ilanlar liste verisiyle kaydedildi.`,
            );
          }
        } else {
          detailFetches += 1;
          const fetched = await this.fetchDetailHtml(ctx, row.url, viaBrowser).catch((error: unknown) => {
            notes.push(`Detay okunamadı (${row.url}): ${describeBrowserFailure(error)}`);
            return null;
          });
          if (fetched) {
            requestCount += 1;
            if (fetched.status) httpStatuses.push(fetched.status);
            const detail = parseKariyerDetail(fetched.html);
            if (detail.referenceNo) item.referenceNo = detail.referenceNo;
            if (detail.applicationStartAt) item.applicationStartAt = detail.applicationStartAt;
            if (detail.applicationEndAt) item.applicationEndAt = detail.applicationEndAt;
            if (detail.applicationUrl) item.applicationUrl = detail.applicationUrl;
            if (detail.category) item.sourceCategory = detail.category;
            if (detail.quota) item.quota = detail.quota;
            if (detail.bodyText) {
              item.bodyText = detail.bodyText;
              item.rawExcerpt = detail.bodyText.slice(0, 1_200);
              item.extractionConfidence = 0.8;
            }
            const detailLinks = anchors(loadHtml(fetched.html), 'body', row.url)
              .filter((link) => /başvur/i.test(link.text) || link.href.includes('turkiye.gov.tr'))
              .slice(0, 10)
              .map((link) => ({ text: link.text, url: link.href }));
            if (detailLinks.length > 0) item.links = detailLinks;
          }
        }
      }

      items.push(item);
    }

    notes.push(`${requestCount} istek yapıldı, ${items.length} ilan hazırlandı.`);
    return { items, requestCount, notes, etag: null, lastModified: null, notModified: false, httpStatuses };
  }

  /**
   * Detay sayfasını okur: liste tarayıcıdan geldiyse doğrudan tarayıcı,
   * aksi halde önce düz HTTP (boş/hata durumunda tarayıcı yedeği).
   */
  private async fetchDetailHtml(
    ctx: AdapterContext,
    url: string,
    preferBrowser: boolean,
  ): Promise<{ html: string; status: number | null }> {
    if (!preferBrowser) {
      try {
        const response = await ctx.http.fetchText(url, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
        });
        const html = response.decoded?.text ?? response.body.toString('utf8');
        if (html.length > 0) return { html, status: response.status };
      } catch {
        // Detay HTTP ile okunamazsa tarayıcı yedeğine düşülür.
      }
    }
    const pages = await this.renderPages([url]);
    return { html: pages.get(url) ?? '', status: null };
  }

  /** Adresleri tek Chromium oturumunda sırayla açıp oluşturulmuş HTML'lerini döndürür. */
  private async renderPages(urls: string[]): Promise<Map<string, string>> {
    const pages = new Map<string, string>();
    await withChromiumPage(async (page) => {
      for (const url of urls) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForTimeout(500);
        pages.set(url, await page.content());
      }
    });
    return pages;
  }
}
