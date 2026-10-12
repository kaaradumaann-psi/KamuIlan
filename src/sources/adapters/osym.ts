/**
 * ÖSYM — Duyurular adaptörü (HTML).
 *
 * Not: ÖSYM duyurularının çoğu sınav/sonuç/yerleştirme duyurusudur; bunlar
 * sınıflandırma motoru tarafından reddedilir. Adaptör hepsini toplar, kararı
 * sınıflandırma verir (tek karar noktası).
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError } from '../errors';
import { loadHtml, readableText, absoluteUrl, elementText } from '../../lib/html';
import { cleanTitle, parseListingDate, extractReferenceNumbers } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import { collectAttachments } from './ilan-gov-tr';

const LISTING_URL = 'https://www.osym.gov.tr/Duyurular/Index';

interface DuyuruLink {
  title: string;
  url: string;
  date: string | null;
}

export class OsymAdapter implements SourceAdapter {
  readonly key = 'osym-duyuru';
  readonly label = 'ÖSYM — Duyurular';
  readonly method = 'http-html';
  readonly notes =
    'Duyuru listesi HTML olarak okunur; detay sayfasından metin ve ekler alınır. ' +
    'Sonuç/kılavuz/cevap anahtarı duyuruları sınıflandırma motorunda reddedilir.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const items: RawAnnouncement[] = [];
    const notes: string[] = [];
    let requestCount = 0;

    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: liste okunmadı.');
      return { items, requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    const response = await ctx.http.fetchText(LISTING_URL, {
      allowedHosts: ctx.source.allowedHosts,
      minIntervalMs: ctx.source.minRequestIntervalMs,
    });
    requestCount += 1;

    if (response.notModified) {
      return {
        items,
        requestCount,
        notes: ['Duyuru listesi değişmemiş (304).'],
        etag: response.etag,
        lastModified: response.lastModified,
        notModified: true,
      };
    }

    const html = response.decoded?.text ?? response.body.toString('utf8');
    const $ = loadHtml(html);
    const links = this.parseListing($, response.finalUrl);

    if (links.length === 0) {
      const pageText = readableText($, 'body', 2_000).toLocaleLowerCase('tr');
      if (!pageText.includes('duyuru')) {
        throw new AdapterStructureError(
          this.key,
          'ÖSYM duyuru listesi beklenen biçimde değil.',
          'Sayfa yüklendi ancak duyuru bağlantısı bulunamadı; HTML yapısı değişmiş olabilir.',
        );
      }
      notes.push('Listede duyuru bağlantısı yok (sayfa yapısı doğrulandı).');
    }

    let detailFetches = 0;
    for (const link of links) {
      if (detailFetches >= ctx.maxDetailFetches) {
        notes.push(`Detay sınırı (${ctx.maxDetailFetches}) doldu; kalan duyurular sonraki taramada alınacak.`);
        break;
      }
      detailFetches += 1;

      const detail = await ctx.http.fetchText(link.url, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
      });
      requestCount += 1;
      const detailHtml = detail.decoded?.text ?? detail.body.toString('utf8');
      const $detail = loadHtml(detailHtml);
      const bodyText = readableText($detail, 'main, .content, #content, body', 10_000);
      const attachments = collectAttachments($detail, detail.finalUrl);
      const referenceNo = extractReferenceNumbers(`${link.title} ${bodyText}`)[0] ?? null;

      items.push({
        sourceKey: ctx.source.key,
        sourceItemId: `osym:${slugFor(link.url)}`,
        url: link.url,
        title: link.title,
        bodyText,
        institution: 'ÖSYM Başkanlığı',
        ...(link.date ? { publishedAt: `${link.date}T00:00:00+03:00` } : {}),
        attachments,
        sourceCategory: 'osym-duyuru',
        rawExcerpt: collapseWhitespace(bodyText.slice(0, 1_200)),
        extractionConfidence: bodyText.length > 300 ? 0.65 : 0.35,
        ...(referenceNo ? { notes: [`Duyuru numarası: ${referenceNo}`] } : {}),
      });
    }

    notes.push(`${requestCount} istek, ${items.length} duyuru hazırlandı.`);
    return {
      items,
      requestCount,
      notes,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: false,
    };
  }

  /** Duyuru listesindeki başlık + tarih + bağlantı üçlülerini bulur. */
  parseListing($: ReturnType<typeof loadHtml>, pageUrl: string): DuyuruLink[] {
    const links: DuyuruLink[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href) return;
      if (!/osym\.gov\.tr/i.test(href)) return;
      if (/\.(pdf|docx?|xlsx?)($|\?)/i.test(href)) return;
      if (/\/(Duyurular|TR,\d+|Icerik)/i.test(href) === false && !/\d{4,}/.test(href)) return;

      const title = cleanTitle(elementText(node, 400) || node.attr('title') || '');
      if (title.length < 12) return;
      const key = href.split('?')[0] ?? href;
      if (seen.has(key)) return;
      seen.add(key);

      const container = node.closest('li, tr, div, article');
      const containerText = container.length > 0 ? elementText(container, 400) : '';
      links.push({ title, url: key, date: parseListingDate(containerText) });
    });

    return links.slice(0, 40);
  }
}

function slugFor(url: string): string {
  const cleaned = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-');
  return cleaned.replace(/^-|-$/g, '').slice(0, 80);
}
