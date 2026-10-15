/**
 * Kamu İlan (Strateji ve Bütçe Başkanlığı) adaptörü.
 *
 * Merkezî kamu ilan ekranı: memur, sözleşmeli, işçi ve akademik ilanları
 * kurum ayrımı olmadan listeler. Bu nedenle erişilebildiği ortamlarda kapsam
 * açısından en değerli kaynaktır.
 *
 * ERİŞİM KISITI: Bu ortamdan 403 "Geographic Restriction" (WAF) döndü
 * (12.10.2026). Kısıt AŞILMAYA ÇALIŞILMAZ; adaptör kısıtı açıkça bildirir ve
 * Türkiye'den çalışan bir kurulumda otomatik devreye girer.
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError, SourceAccessError } from '../errors';
import { loadHtml, readableText, absoluteUrl, elementText } from '../../lib/html';
import { cleanInstitution, cleanTitle, ownCardText, parseListingDate } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import { detectNextPage } from '../pagination';
import { assertSafeUrl } from '../fetcher';

const MAX_LIST_PAGES = 10;
const MAX_LIST_ITEMS = 300;

interface SbbListingRow {
  title: string;
  url: string;
  institution: string | null;
  city: string | null;
  publishedAt: string | null;
  summary: string;
}

export class SbbKamuIlanAdapter implements SourceAdapter {
  readonly key = 'sbb-kamuilan';
  readonly label = 'Kamu İlan (SBB)';
  readonly method = 'http-html';
  readonly notes =
    'Merkezî kamu ilan ekranı. Erişim kısıtlıysa (WAF/geo) kısıt aşılmaz; durum panelde ' +
    '"erişim kısıtlı" olarak görünür ve diğer kaynaklar çalışmaya devam eder.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const notes: string[] = [];
    let requestCount = 0;

    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: liste okunmadı.');
      return { items: [], requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    let response;
    const httpStatuses: number[] = [];
    try {
      response = await ctx.http.fetchText(ctx.source.listingUrl, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
      });
      requestCount += 1;
      httpStatuses.push(response.status);
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      const message = error instanceof Error ? error.message : String(error);
      if (/403|erişim reddedildi|Geographic/i.test(message)) {
        throw new SourceAccessError(
          ctx.source.key,
          'Kamu İlan (SBB) bu ortamdan erişilemiyor: HTTP 403 / Geographic Restriction. Kısıt aşılmaz.',
          403,
        );
      }
      throw error;
    }

    if (response.notModified) {
      return {
        items: [],
        requestCount,
        notes: ['İlan listesi değişmemiş (304).'],
        etag: response.etag,
        lastModified: response.lastModified,
        notModified: true,
        httpStatuses,
        coverage: {
          status: 'unknown',
          note: '304 yanıtı içeriğin değişmediğini gösterir; bu çalışmada sayfalar yeniden gezilmedi.',
        },
      };
    }

    let currentHtml = response.decoded?.text ?? response.body.toString('utf8');
    let currentUrl = response.finalUrl;
    const rowsByUrl = new Map<string, SbbListingRow>();
    const visitedPages = new Set<string>();
    let sawPagination = false;
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = 'Kamu İlan sayfası kapsamı bu çalışmada doğrulanamadı.';

    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const normalizedPageUrl = currentUrl;
      if (visitedPages.has(normalizedPageUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Sayfalama daha önce gezilen URL’ye döndü; tekrar döngüsü engellendi.';
        break;
      }
      visitedPages.add(normalizedPageUrl);

      const $ = loadHtml(currentHtml);
      const pageRows = this.parseListing($, currentUrl, ctx.source.allowedHosts);
      notes.push(`Sayfa ${page}: ${pageRows.length} ilan satırı.`);
      const repeated = pageRows.some((row) => rowsByUrl.has(row.url));
      let capExceeded = false;
      for (const row of pageRows) {
        if (rowsByUrl.has(row.url)) continue;
        if (rowsByUrl.size >= MAX_LIST_ITEMS) {
          capExceeded = true;
          break;
        }
        rowsByUrl.set(row.url, row);
      }
      if (repeated) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page} önceki kayıtları tekrarladı; sayfa parametresinin etkisi doğrulanamadı.`;
        break;
      }
      if (capExceeded) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_LIST_ITEMS} kayıtlık üst sınıra ulaşıldı; kalan liste kayıtları bu çalışmada alınmadı.`;
        break;
      }

      const navigation = detectNextPage(currentHtml, currentUrl);
      sawPagination ||= navigation.detected;
      if (!navigation.nextUrl) {
        coverageStatus = navigation.endConfirmed ? 'complete' : 'unknown';
        coverageNote = navigation.endConfirmed
          ? `${visitedPages.size} sayfa gezildi ve kaynak sayfalama denetimi son sayfayı doğruladı.`
          : sawPagination
            ? `${visitedPages.size} sayfa gezildi ancak son sayfa işareti doğrulanamadı; kapsam bilinmiyor.`
            : 'Sayfada doğrulanabilir sonraki/son sayfa işareti bulunmadı; tek sayfanın tüm duyurular olduğu varsayılmıyor.';
        break;
      }
      if (page >= MAX_LIST_PAGES) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_LIST_PAGES} sayfalık üst sınıra ulaşıldı; sonraki sayfa taranmadı.`;
        break;
      }
      const nextUrl = navigation.nextUrl;
      if (visitedPages.has(nextUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Kaynağın sonraki sayfa bağlantısı önceki sayfaya döndü.';
        break;
      }
      try {
        const nextPage = await ctx.http.fetchText(nextUrl, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
        });
        requestCount += 1;
        httpStatuses.push(nextPage.status);
        if (nextPage.notModified) {
          coverageStatus = 'unknown';
          coverageNote = 'Sonraki sayfa için 304 alındı; o sayfanın ilanları bu çalışmada doğrulanamadı.';
          break;
        }
        currentUrl = nextPage.finalUrl;
        currentHtml = nextPage.decoded?.text ?? nextPage.body.toString('utf8');
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        coverageStatus = 'partial';
        coverageNote = `Sonraki sayfa alınamadı (${error instanceof Error ? error.message : String(error)}); önceki sayfalar işlendi.`;
        notes.push(coverageNote);
        break;
      }
    }

    const rows = [...rowsByUrl.values()];
    if (rows.length === 0) {
      const $ = loadHtml(currentHtml);
      const pageText = readableText($, 'body', 2_000).toLocaleLowerCase('tr');
      if (!pageText.includes('ilan')) {
        throw new AdapterStructureError(
          this.key,
          'Kamu İlan (SBB) sayfası beklenen biçimde değil.',
          'Sayfa yüklendi ancak ilan listesi bulunamadı; arayüz değişmiş olabilir.',
        );
      }
      notes.push('Liste yapısı doğrulandı, o an ilan bulunamadı.');
    }

    const items: RawAnnouncement[] = rows.map((row) => ({
      sourceKey: ctx.source.key,
      sourceItemId: `sbb:${slugFor(row.url)}`,
      url: row.url,
      title: row.title,
      institution: row.institution ?? 'Belirtilmemiş kurum',
      ...(row.publishedAt ? { publishedAt: `${row.publishedAt}T00:00:00+03:00` } : {}),
      ...(row.city ? { city: row.city } : {}),
      attachments: [],
      sourceCategory: 'kamuilan-sbb',
      rawExcerpt: collapseWhitespace(row.summary).slice(0, 1_200),
      bodyText: row.summary,
      bodyTextSource: 'listing',
      extractionConfidence: 0.5,
    }));

    notes.push(
      `${requestCount} istek, ${items.length} ilan hazırlandı (${visitedPages.size} sayfa tarandı).`,
    );
    notes.push(
      `Liste kapsamı: ${coverageStatus === 'complete' ? 'tam' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`,
    );
    return {
      items,
      requestCount,
      notes,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: false,
      httpStatuses,
      coverage: { status: coverageStatus, note: coverageNote },
    };
  }

  parseListing(
    $: ReturnType<typeof loadHtml>,
    pageUrl: string,
    allowedHosts: readonly string[] = [new URL(pageUrl).hostname],
  ): SbbListingRow[] {
    const rows: SbbListingRow[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href) return;
      let safeUrl: string;
      try {
        safeUrl = assertSafeUrl(href, allowedHosts).toString();
      } catch {
        return;
      }
      const title = cleanTitle(elementText(node, 300));
      if (title.length < 12) return;
      const key = safeUrl.split('?')[0] ?? safeUrl;
      if (seen.has(key)) return;
      seen.add(key);

      // Paylaşılmış kapsayıcıda kurum/il komşu ilandan alınmaz.
      const containerText =
        ownCardText(node, 'li, tr, div, article', (value) => value.split('?')[0] || null, 700) ?? title;
      const institutionMatch = containerText.match(
        /([A-ZÇĞİÖŞÜ][^|•·]{5,90}?(?:Bakanlığı|Başkanlığı|Rektörlüğü|Müdürlüğü|Belediyesi|Üniversitesi|Kurumu|Genel Müdürlüğü))/u,
      );
      const cityMatch = /İl\s*[:.]?\s*([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)/u.exec(containerText);

      rows.push({
        title,
        url: key,
        institution: cleanInstitution(institutionMatch?.[1] ?? null),
        city: cityMatch?.[1] ?? null,
        publishedAt: parseListingDate(containerText),
        summary: collapseWhitespace(containerText),
      });
    });

    return rows;
  }
}

function slugFor(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

export { SourceAccessError };
