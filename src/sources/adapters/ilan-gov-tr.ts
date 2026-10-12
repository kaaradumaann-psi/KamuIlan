/**
 * ilan.gov.tr — Kamu/Akademik Personel kategorisi adaptörü (HTML liste).
 *
 * Doğrulanmış gerçekler (12.10.2026):
 *  - Liste adresi: /ilan/tum-ilanlar/personel-alimi?ats=5 (157 ilan, 14 sayfa)
 *  - Sayfalama: currentPage=N
 *  - Detay adresleri: /ilan/{id}/{slug}; kurum ve resmî numara (YOK/DPB/ILN) görünür.
 *
 * Yapı değişirse boş liste döndürmek yerine yapı hatası bildirilir; böylece
 * sessiz veri kaybı olmaz.
 */
import { collapseWhitespace } from '../../domain/text';
import type { JobAttachment, RawAnnouncement } from '../../domain';
import { AdapterStructureError } from '../errors';
import { loadHtml, readableText, absoluteUrl, elementText, type CheerioAPI } from '../../lib/html';
import {
  cleanInstitution,
  cleanTitle,
  extractReferenceNumbers,
  findPaginationLinks,
  parseListingDate,
} from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

const DETAIL_PATTERN = /\/ilan\/\d+/;

interface ListingCard {
  title: string;
  detailUrl: string;
  institution: string | null;
  city: string | null;
  referenceNo: string | null;
  publishedAt: string | null;
}

export class IlanGovTrAdapter implements SourceAdapter {
  readonly key = 'ilan-gov-tr';
  readonly method = 'http-html';
  readonly label = 'ilan.gov.tr — Personel Alımı';
  readonly notes =
    'Liste sayfaları HTML olarak okunur; kurum, ilan numarası ve il/ilçe listeden alınır. ' +
    'İlan metni ve başvuru bilgileri detay sayfasından çıkarılır.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const items: RawAnnouncement[] = [];
    const notes: string[] = [];
    let requestCount = 0;
    let detailFetches = 0;

    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: liste okunmadı.');
      return { items, requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    const baseUrl = ctx.source.listingUrl;
    const firstPage = await ctx.http.fetchText(baseUrl, {
      allowedHosts: ctx.source.allowedHosts,
      minIntervalMs: ctx.source.minRequestIntervalMs,
    });
    requestCount += 1;

    if (firstPage.notModified) {
      return {
        items,
        requestCount,
        notes: ['Liste içeriği değişmemiş (304).'],
        etag: firstPage.etag,
        lastModified: firstPage.lastModified,
        notModified: true,
      };
    }

    const firstHtml = firstPage.decoded?.text ?? firstPage.body.toString('utf8');
    const $first = loadHtml(firstHtml);
    const maxPages = 3;
    const pageUrls = [
      baseUrl,
      ...findPaginationLinks($first, baseUrl, { param: 'currentPage', maxPage: maxPages, currentPage: 1 }).map((link) => link.url),
    ].slice(0, maxPages);

    for (const pageUrl of pageUrls) {
      const $ = pageUrl === baseUrl ? $first : loadHtml((await ctx.http.fetchText(pageUrl, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
      })).decoded?.text ?? '');
      if (pageUrl !== baseUrl) requestCount += 1;

      const cards = this.parseListing($, pageUrl);
      if (pageUrl === baseUrl && cards.length === 0) {
        const pageText = readableText($, 'body', 2_000).toLocaleLowerCase('tr');
        if (!pageText.includes('ilan')) {
          throw new AdapterStructureError(
            this.key,
            'ilan.gov.tr liste sayfası beklenen biçimde değil.',
            'Sayfa yüklendi ancak ilan bağlantısı bulunamadı; liste HTML yapısı değişmiş olabilir.',
          );
        }
        notes.push('Liste yapısında ilan bulunamadı (o an için ilan olmayabilir).');
      }

      for (const card of cards) {
        const known = ctx.knownItemIds?.has(this.sourceItemId(card.detailUrl)) ?? false;
        if (known || detailFetches >= ctx.maxDetailFetches) {
          if (!known && detailFetches >= ctx.maxDetailFetches) {
            notes.push(`Detay indirme sınırı (${ctx.maxDetailFetches}) doldu; kalan ilanlar sonraki taramada alınacak.`);
            break;
          }
          continue;
        }
        detailFetches += 1;

        const detail = await ctx.http.fetchText(card.detailUrl, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
        });
        requestCount += 1;
        const detailHtml = detail.decoded?.text ?? detail.body.toString('utf8');
        const $detail = loadHtml(detailHtml);
        const bodyText = readableText($detail, 'main, .content, #content, body', 12_000);
        const attachments = collectAttachments($detail, detail.finalUrl);
        const detailDate = parseListingDate(readableText($detail, '.date, .tarih, time', 120)) ?? card.publishedAt;
        const institution = cleanInstitution(readableText($detail, '.kurum, .institution', 160)) ?? card.institution;
        const referenceNo =
          extractReferenceNumbers(bodyText)[0] ?? card.referenceNo ?? extractReferenceNumbers(readableText($detail, 'body', 3_000))[0] ?? null;

        items.push({
          sourceKey: ctx.source.key,
          sourceItemId: this.sourceItemId(card.detailUrl),
          url: card.detailUrl,
          title: card.title,
          bodyText,
          ...(institution ? { institution } : {}),
          ...(detailDate ? { publishedAt: `${detailDate}T00:00:00+03:00` } : {}),
          ...(card.city ? { city: card.city } : {}),
          attachments,
          sourceCategory: 'ilan-gov-tr-personel',
          rawExcerpt: collapseWhitespace(bodyText.slice(0, 1_200)),
          extractionConfidence: bodyText.length > 400 ? 0.7 : 0.4,
          ...(referenceNo ? { notes: [`Resmî ilan numarası: ${referenceNo}`] } : {}),
        });
      }

      if (detailFetches >= ctx.maxDetailFetches) break;
    }

    notes.push(`${requestCount} istek, ${items.length} ilan hazırlandı (detay çıkarımı yapıldı).`);
    return {
      items,
      requestCount,
      notes,
      etag: firstPage.etag,
      lastModified: firstPage.lastModified,
      notModified: false,
    };
  }

  private sourceItemId(detailUrl: string): string {
    const match = /\/ilan\/(\d+)/.exec(detailUrl);
    return match?.[1] ? `ilangovtr:${match[1]}` : `ilangovtr:${detailUrl}`;
  }

  /** Liste sayfasından ilan kartlarını çıkarır (çok biçimli sayfa yapısına dayanıklı). */
  parseListing($: CheerioAPI, pageUrl: string): ListingCard[] {
    const cards: ListingCard[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href || !DETAIL_PATTERN.test(href)) return;
      const normalized = href.split('?')[0] ?? href;
      if (seen.has(normalized)) return;

      const container = node.closest('div, li, article, tr');
      const containerText = container.length > 0 ? elementText(container, 800) : elementText(node, 400);
      const title = cleanTitle(elementText(node, 300) || containerText);
      if (title.length < 10) return;

      seen.add(normalized);
      const institutionMatch = containerText.match(/([A-ZÇĞİÖŞÜ][^|•·]{5,90}?(?:Bakanlığı|Başkanlığı|Rektörlüğü|Müdürlüğü|Belediyesi|Üniversitesi|Kurumu|Genel Müdürlüğü))/u);
      const cityMatch = /\b(Adana|Ankara|Antalya|Bursa|Diyarbakır|Erzurum|Eskişehir|Gaziantep|İstanbul|İzmir|Kayseri|Kocaeli|Konya|Mersin|Samsun|Şanlıurfa|Trabzon|Van)\b/u.exec(containerText);
      const reference = extractReferenceNumbers(containerText)[0] ?? null;

      cards.push({
        title,
        detailUrl: normalized,
        institution: cleanInstitution(institutionMatch?.[1] ?? null),
        city: cityMatch?.[1] ?? null,
        referenceNo: reference,
        publishedAt: parseListingDate(containerText),
      });
    });

    return cards;
  }
}

/** Detay sayfasındaki ek bağlantılarını (PDF, doküman) toplar. */
export function collectAttachments($: CheerioAPI, pageUrl: string): JobAttachment[] {
  const attachments: JobAttachment[] = [];
  $('a[href]').each((_index, element) => {
    const node = $(element);
    const href = absoluteUrl(node.attr('href'), pageUrl, $);
    if (!href) return;
    const label = elementText(node, 160);
    if (/\.pdf($|\?)/i.test(href)) {
      attachments.push({ url: href, label: label || 'İlan belgesi (PDF)', kind: 'pdf' });
    } else if (/\.(?:docx?|xlsx?)($|\?)/i.test(href)) {
      attachments.push({
        url: href,
        label: label || 'İlan belgesi',
        kind: /\.docx?($|\?)/i.test(href) ? 'doc' : 'excel',
      });
    }
  });
  return attachments.slice(0, 15);
}
