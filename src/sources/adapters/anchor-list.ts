/**
 * Genel "bağlantı listesi" adaptörü.
 *
 * Aynı yapıyı paylaşan kurumsal duyuru listeleri (İŞKUR kamu ilan listeleri,
 * MEB personel duyuruları gibi) için tek, yapılandırılabilir uygulama.
 *
 * Liste sayfası beklenen kalıbı taşımıyorsa boş liste yerine yapı hatası verir.
 * 17.10 kuralı: yeni bir kurum eklemek için kod yazmak gerekmez — kaynak kaydı
 * yeterlidir (registry bu adaptörü paylaşır).
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError } from '../errors';
import { loadHtml, readableText, absoluteUrl, elementText } from '../../lib/html';
import { cleanTitle, findPaginationLinks, parseListingDate } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import { collectAttachments } from './ilan-gov-tr';

export interface AnchorListConfig {
  key: string;
  label: string;
  notes: string;
  /** Liste sayfasındaki bağlantıların uyması gereken desen. */
  linkPattern: RegExp;
  /** Detay sayfası okunacak mı? (liste sayfası yeterliyse false) */
  fetchDetail: boolean;
  /** Aynı anda taranacak en fazla liste sayfası. */
  maxPages?: number;
  /** Sayfalama parametresi (varsa). */
  paginationParam?: string;
  /** Detay sayfasında ilan metninin bulunduğu olası seçiciler. */
  detailSelectors?: string;
}

export class AnchorListAdapter implements SourceAdapter {
  readonly key: string;
  readonly label: string;
  readonly method = 'http-html';
  readonly notes: string;
  private readonly config: AnchorListConfig;

  constructor(config: AnchorListConfig) {
    this.config = config;
    this.key = config.key;
    this.label = config.label;
    this.notes = config.notes;
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const items: RawAnnouncement[] = [];
    const notes: string[] = [];
    let requestCount = 0;

    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: liste okunmadı.');
      return { items, requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    const listingUrl = ctx.source.listingUrl;
    const firstPage = await ctx.http.fetchText(listingUrl, {
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

    const maxPages = this.config.maxPages ?? 2;
    const firstHtml = firstPage.decoded?.text ?? firstPage.body.toString('utf8');
    const $first = loadHtml(firstHtml);
    const pageUrls = [listingUrl];

    if (this.config.paginationParam) {
      const pagination = findPaginationLinks($first, listingUrl, {
        param: this.config.paginationParam,
        maxPage: maxPages,
        currentPage: 1,
      });
      for (const link of pagination) if (pageUrls.length < maxPages) pageUrls.push(link.url);
    }

    let found = 0;
    let detailFetches = 0;

    for (const pageUrl of pageUrls) {
      let $ = $first;
      if (pageUrl !== listingUrl) {
        const page = await ctx.http.fetchText(pageUrl, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
        });
        requestCount += 1;
        $ = loadHtml(page.decoded?.text ?? '');
      }

      const links = this.parseLinks($, pageUrl);
      found += links.length;

      for (const link of links) {
        const sourceItemId = `${this.key}:${slugFor(link.url)}`;
        const known = ctx.knownItemIds?.has(sourceItemId) ?? false;
        if (known) continue;
        if (this.config.fetchDetail && detailFetches >= ctx.maxDetailFetches) {
          notes.push(`Detay sınırı (${ctx.maxDetailFetches}) doldu; kalan ilanlar sonraki taramada alınacak.`);
          break;
        }

        let bodyText = link.summary;
        let attachments: RawAnnouncement['attachments'] = [];
        let institution: string | null = null;

        if (this.config.fetchDetail) {
          detailFetches += 1;
          const detail = await ctx.http.fetchText(link.url, {
            allowedHosts: ctx.source.allowedHosts,
            minIntervalMs: ctx.source.minRequestIntervalMs,
          });
          requestCount += 1;
          const detailHtml = detail.decoded?.text ?? detail.body.toString('utf8');
          const $detail = loadHtml(detailHtml);
          bodyText = readableText(
            $detail,
            this.config.detailSelectors ?? 'main, .content, #content, .icerik, article, body',
            12_000,
          );
          attachments = collectAttachments($detail, detail.finalUrl);
          institution = cleanTitle(readableText($detail, '.kurum, .institution', 120)) || null;
        }

        items.push({
          sourceKey: ctx.source.key,
          sourceItemId,
          url: link.url,
          title: link.title,
          bodyText,
          ...(institution ? { institution } : {}),
          ...(link.date ? { publishedAt: `${link.date}T00:00:00+03:00` } : {}),
          attachments,
          sourceCategory: this.key,
          rawExcerpt: collapseWhitespace(bodyText.slice(0, 1_200)),
          extractionConfidence: bodyText.length > 300 ? 0.6 : 0.35,
        });
      }
    }

    if (found === 0) {
      const pageText = readableText($first, 'body', 2_000).toLocaleLowerCase('tr');
      if (!pageText.includes('ilan') && !pageText.includes('duyuru')) {
        throw new AdapterStructureError(
          this.key,
          `${this.label} liste sayfası beklenen biçimde değil.`,
          'Sayfa yüklendi ancak ilan/duyuru bağlantısı bulunamadı; HTML yapısı değişmiş olabilir.',
        );
      }
      notes.push('Listede şu anda ilan bağlantısı yok (sayfa yapısı doğrulandı).');
    }

    notes.push(`${requestCount} istek, ${items.length} ilan hazırlandı.`);
    return {
      items,
      requestCount,
      notes,
      etag: firstPage.etag,
      lastModified: firstPage.lastModified,
      notModified: false,
    };
  }

  /** Sayfadaki ilan bağlantılarını toplar (başlık + tarih + özet). */
  parseLinks(
    $: ReturnType<typeof loadHtml>,
    pageUrl: string,
  ): { title: string; url: string; date: string | null; summary: string }[] {
    const links: { title: string; url: string; date: string | null; summary: string }[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href) return;
      if (!this.config.linkPattern.test(href)) return;
      if (/\.(pdf|docx?|xlsx?|jpg|png)($|\?)/i.test(href)) return;

      const title = cleanTitle(elementText(node, 400) || node.attr('title') || '');
      if (title.length < 12) return;
      const key = href.split('?')[0] ?? href;
      if (seen.has(key)) return;
      seen.add(key);

      const container = node.closest('li, tr, div, article');
      const containerText = container.length > 0 ? elementText(container, 600) : title;
      links.push({
        title,
        url: key,
        date: parseListingDate(containerText),
        summary: collapseWhitespace(containerText.replace(title, '')).slice(0, 600),
      });
    });

    return links.slice(0, 40);
  }
}

function slugFor(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

/** İŞKUR kamu ilan listeleri için yapılandırma. */
export function createIskurAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'iskur-liste',
    label: 'İŞKUR — Kamu İlan Listeleri',
    notes:
      'Kamu memur ve kurum dışı kamu işçi alım ilanları listeleri HTML olarak okunur; ' +
      'ilan detay sayfası varsa metin ve ekler alınır, yoksa liste özeti kullanılır.',
    linkPattern: /iskur\.gov\.tr\/.*(?:ilan|duyuru|haber)/i,
    fetchDetail: true,
    maxPages: 2,
    paginationParam: 'page',
  });
}

/** MEB personel duyuruları için yapılandırma. */
export function createMebAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'meb-liste',
    label: 'MEB Personel Genel Müdürlüğü — Duyurular',
    notes:
      'Personel Genel Müdürlüğü duyuru listesi okunur. Atama/yer değiştirme içerikleri ' +
      'sınıflandırma motorunda reddedilir; yalnızca alım ilanları yayımlanır.',
    linkPattern: /personel\.meb\.gov\.tr\/.*(?:haber|duyuru|icerik)/i,
    fetchDetail: true,
    maxPages: 2,
    paginationParam: 'sayfa',
  });
}
