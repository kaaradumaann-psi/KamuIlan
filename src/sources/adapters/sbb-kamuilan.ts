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
import { cleanInstitution, cleanTitle, parseListingDate } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

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
    try {
      response = await ctx.http.fetchText(ctx.source.listingUrl, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
      });
      requestCount += 1;
    } catch (error) {
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
      };
    }

    const html = response.decoded?.text ?? response.body.toString('utf8');
    const $ = loadHtml(html);
    const rows = this.parseListing($, response.finalUrl);

    if (rows.length === 0) {
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
      extractionConfidence: 0.5,
    }));

    notes.push(`${requestCount} istek, ${items.length} ilan hazırlandı (liste sayfasından).`);
    return {
      items,
      requestCount,
      notes,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: false,
    };
  }

  parseListing(
    $: ReturnType<typeof loadHtml>,
    pageUrl: string,
  ): { title: string; url: string; institution: string | null; city: string | null; publishedAt: string | null; summary: string }[] {
    const rows: { title: string; url: string; institution: string | null; city: string | null; publishedAt: string | null; summary: string }[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href) return;
      if (/^(?:mailto|javascript):/i.test(href)) return;
      const title = cleanTitle(elementText(node, 300));
      if (title.length < 12) return;
      const key = href.split('?')[0] ?? href;
      if (seen.has(key)) return;
      seen.add(key);

      const container = node.closest('li, tr, div, article');
      const containerText = container.length > 0 ? elementText(container, 700) : title;
      const institutionMatch = containerText.match(/([A-ZÇĞİÖŞÜ][^|•·]{5,90}?(?:Bakanlığı|Başkanlığı|Rektörlüğü|Müdürlüğü|Belediyesi|Üniversitesi|Kurumu|Genel Müdürlüğü))/u);
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

    return rows.slice(0, 60);
  }
}

function slugFor(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

export { SourceAccessError };
