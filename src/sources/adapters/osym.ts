/**
 * ÖSYM duyuru adaptörü.
 *
 * Doğrulanmış yapı (12.10.2026, canlı): duyuru listesi tarih + başlık +
 * göreli olmayan bağlantı (`/2026-ales3-basvurularin-alinmasi`) biçiminde.
 * Detay sayfasında duyuru metni, kılavuz ve başvuru bağlantıları bulunur.
 *
 * Süzgeç: ÖSYM duyurularının çoğu sınav sonucu/kılavuz/logistik duyurusudur.
 * Adaptör listeyi olduğu gibi toplar; karar sınıflandırma motoruna aittir
 * (tek karar noktası). Derin bağlantı indirmesi yalnızca sınıflandırmanın
 * "detay gerekli" dediği kayıtlar için yapılır — bu çağrı ingest katmanında
 * yapılır, adaptör burada tüm detayları indirmez.
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { absoluteUrl, links, loadHtml, readableText } from '../../lib/html';
import { AdapterStructureError } from '../errors';
import { parseListingDate } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

interface OsymRow {
  itemId: string;
  url: string;
  title: string;
  publishedAt: string | null;
}

export class OsymAdapter implements SourceAdapter {
  readonly key = 'osym-duyuru';
  readonly label = 'ÖSYM — Duyurular';

  listingUrl(source: { listingUrl: string }): string {
    return source.listingUrl || 'https://www.osym.gov.tr/Duyurular/Index';
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const httpStatuses: number[] = [];
    const notes: string[] = [];
    const items: RawAnnouncement[] = [];

    const response = await ctx.fetcher.fetchText(this.listingUrl(ctx.source), {
      source: ctx.source,
      conditional: { etag: ctx.source.health.etag, lastModified: ctx.source.health.lastModified },
    });
    httpStatuses.push(response.status);

    if (response.notModified) {
      return { items: [], httpStatuses, notes: ['Duyuru listesi değişmemiş (304).'], notModified: true };
    }
    if (!response.text) {
      throw new AdapterStructureError(ctx.source.key, 'ÖSYM duyuru listesi boş yanıt döndü.', response.finalUrl);
    }

    const rows = this.parseListing(response.text, response.finalUrl);
    if (rows.length === 0) {
      throw new AdapterStructureError(
        ctx.source.key,
        'ÖSYM duyuru listesinde kayıt bulunamadı: sayfa yapısı değişmiş olabilir.',
        response.finalUrl,
      );
    }
    notes.push(`${rows.length} duyuru bulundu.`);

    const limit = Math.max(ctx.limits.maxDetailFetches, 0);
    let enriched = 0;

    for (const row of rows) {
      const known = ctx.knownItemIds?.has(row.itemId) ?? false;
      let body = '';
      let attachments: RawAnnouncement['attachments'] = [];

      // Detay yalnızca: canlı erişim açık, kayıt yeni ve sınır içinde.
      if (ctx.liveFetch && !known && enriched < limit) {
        enriched += 1;
        try {
          const detail = await ctx.fetcher.fetchText(row.url, { source: ctx.source });
          httpStatuses.push(detail.status);
          if (detail.text) {
            const root = loadHtml(detail.text);
            const container = root('main, article, [class*="content"], .duyuru').first();
            body = readableText(root, container.length > 0 ? container : root('body')).slice(0, 20_000);
            attachments = links(root, container.length > 0 ? container : root('body'), detail.finalUrl)
              .filter((link) => /\.pdf$/i.test(link.url))
              .slice(0, 10)
              .map((link) => ({ url: link.url, label: collapseWhitespace(link.text).slice(0, 160) || 'Belge (PDF)', kind: 'pdf' as const }));
          }
        } catch (error) {
          notes.push(`${row.itemId}: detay alınamadı (${(error as Error).message})`);
        }
      }

      items.push({
        sourceKey: ctx.source.key,
        sourceItemId: row.itemId,
        url: row.url,
        title: row.title,
        bodyText: body || undefined,
        institution: 'ÖSYM Başkanlığı',
        publishedAt: row.publishedAt ?? undefined,
        attachments,
        sourceCategory: 'ÖSYM Duyuruları',
        rawExcerpt: collapseWhitespace(body || row.title).slice(0, 2_000),
        extractionConfidence: body.length > 200 ? 0.65 : 0.4,
        notes: [],
      });
    }

    return {
      items,
      httpStatuses,
      notes,
      notModified: false,
      cacheHeaders: {
        etag: response.etag,
        lastModified: response.lastModified,
        contentHash: response.contentHash,
      },
    };
  }

  /** Duyuru bağlantılarını ve tarihlerini toplar (sınıf adından bağımsız). */
  parseListing(html: string, baseUrl: string): OsymRow[] {
    const root = loadHtml(html);
    const rows: OsymRow[] = [];
    const seen = new Set<string>();

    root('a[href]').each((_, anchor) => {
      const element = root(anchor);
      const href = element.attr('href');
      if (!href) return;
      const url = absoluteUrl(href, baseUrl);
      if (!url) return;
      const path = new URL(url).pathname.replace(/\/+$/, '');
      // Duyuru detayları kök seviyede tek parçalı slug'dır.
      if (!/^\/[a-z0-9][a-z0-9-]{12,}$/i.test(path)) return;
      const title = collapseWhitespace(element.text());
      if (title.length < 20) return;
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host !== 'osym.gov.tr') return;

      const itemId = path.slice(1);
      if (seen.has(itemId)) return;
      seen.add(itemId);

      const rowText = collapseWhitespace(element.parent().text() || element.closest('li,tr,div').text());
      const publishedAt = parseListingDate(rowText);
      rows.push({ itemId, url, title, publishedAt });
    });

    return rows;
  }
}
