/**
 * ilan.gov.tr — Kamu/Akademik Personel kategorisi adaptörü.
 *
 * Doğrulanmış akış (12.10.2026, canlı):
 *   /ilan/tum-ilanlar/personel-alimi?ats=5  → 14 sayfa, 157 ilan
 *   satır: [kurum logosu] KURUM ADI / İlan başlığı / YOK853479 / ŞEHİR
 *   detay: /ilan/{id}/{slug}
 *
 * Ayrıştırma sınıf adlarına bağımlı değildir: satır bağlantısı ve içindeki
 * metin blokları sırayla değerlendirilir; kurum, ilan numarası ve şehir
 * heuristikleri uygulanır. Böylece şablon değişse de yapı bozulması
 * `AdapterStructureError` ile açıkça raporlanır.
 */
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { collapseWhitespace } from '../../domain/text';
import type { JobAttachment, RawAnnouncement } from '../../domain';
import { PROVINCES } from '../../domain/provinces';
import { absoluteUrl, links, loadHtml, readableText } from '../../lib/html';
import { AdapterStructureError } from '../errors';
import { cleanInstitution, cleanTitle, extractReferenceNo } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import { collectAttachmentLinks, extractApplicationUrl } from '../../extraction/engine';

interface ListingRow {
  itemId: string;
  url: string;
  title: string;
  institution: string | null;
  referenceNo: string | null;
  city: string | null;
  publishedAt: string | null;
  summary: string | null;
}

const PROVINCE_UPPER = new Set(PROVINCES.map((province) => province.name.toLocaleUpperCase('tr')));

export class IlanGovTrAdapter implements SourceAdapter {
  readonly key = 'ilan-gov-tr';
  readonly label = 'ilan.gov.tr — Kamu/Akademik Personel';

  listingUrl(source: { listingUrl: string }): string {
    return source.listingUrl;
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const httpStatuses: number[] = [];
    const notes: string[] = [];
    const items: RawAnnouncement[] = [];
    let notModified = false;
    const pages = Math.max(1, ctx.limits.maxListingPages);
    const rowsSeen = new Set<string>();

    for (let page = 1; page <= pages; page += 1) {
      const url = page === 1 ? ctx.source.listingUrl : this.withPage(ctx.source.listingUrl, page);
      const response = await ctx.fetcher.fetchText(url, {
        source: ctx.source,
        conditional: page === 1 ? { etag: ctx.source.health.etag, lastModified: ctx.source.health.lastModified } : undefined,
      });
      httpStatuses.push(response.status);

      if (response.notModified && page === 1) {
        notModified = true;
        notes.push('Liste sayfası değişmemiş (304).');
        break;
      }
      if (!response.text) continue;

      const rows = this.parseListing(response.text, response.finalUrl, ctx.clock.now().toISOString());
      if (page === 1 && rows.length === 0) {
        throw new AdapterStructureError(
          ctx.source.key,
          'Liste sayfasında ilan satırı bulunamadı: sayfa yapısı değişmiş olabilir.',
          response.finalUrl,
        );
      }
      notes.push(`${page}. sayfa: ${rows.length} ilan satırı.`);

      for (const row of rows) {
        if (rowsSeen.has(row.itemId)) continue;
        rowsSeen.add(row.itemId);

        const known = ctx.knownItemIds?.has(row.itemId) ?? false;
        let body = row.summary ?? '';
        let attachments: JobAttachment[] = [];
        let applicationUrl: string | null = null;

        if (ctx.liveFetch && !known) {
          try {
            const detail = await ctx.fetcher.fetchText(row.url, { source: ctx.source });
            httpStatuses.push(detail.status);
            if (detail.text) {
              const parsed = this.parseDetail(detail.text, detail.finalUrl);
              body = parsed.body || body;
              attachments = parsed.attachments;
              applicationUrl = parsed.applicationUrl;
            }
          } catch (error) {
            notes.push(`${row.itemId}: detay sayfası alınamadı (${(error as Error).message})`);
          }
        }

        items.push({
          sourceKey: ctx.source.key,
          sourceItemId: row.itemId,
          url: row.url,
          title: row.title,
          bodyText: body || undefined,
          institution: row.institution ?? undefined,
          publishedAt: row.publishedAt ?? undefined,
          applicationUrl: applicationUrl ?? undefined,
          city: row.city ?? undefined,
          attachments,
          sourceCategory: 'Kamu-Akademik Personel',
          rawExcerpt: collapseWhitespace(body).slice(0, 2_000),
          extractionConfidence: body.length > 200 ? 0.7 : 0.4,
          notes: [],
        });
      }

      if (!this.hasNextPage(response.text)) break;
    }

    return {
      items,
      httpStatuses,
      notes,
      notModified,
      cacheHeaders: { etag: ctx.source.health.etag, lastModified: ctx.source.health.lastModified, contentHash: null },
    };
  }

  private withPage(listingUrl: string, page: number): string {
    const url = new URL(listingUrl);
    url.searchParams.set('currentPage', String(page));
    return url.toString();
  }

  private hasNextPage(html: string): boolean {
    const root = loadHtml(html);
    return root('a[href*="currentPage="]').length > 0;
  }

  /** Liste sayfasındaki ilan satırlarını okur. */
  parseListing(html: string, baseUrl: string, nowIso: string): ListingRow[] {
    const root = loadHtml(html);
    const rows: ListingRow[] = [];
    const seen = new Set<string>();

    root('a[href*="/ilan/"]').each((_, anchor) => {
      const element = root(anchor);
      const url = absoluteUrl(element.attr('href'), baseUrl);
      if (!url) return;
      const itemId = this.itemIdOf(url);
      if (!itemId || seen.has(itemId)) return;

      const rawText = collapseWhitespace(element.text());
      if (rawText.length < 10) return;
      seen.add(itemId);

      const blocks = this.textBlocks(root, element);
      const logoAlt = collapseWhitespace(element.find('img[alt]').first().attr('alt') ?? '');
      const referenceNo = extractReferenceNo(rawText);
      const city = this.findCity(blocks);
      const institution = this.findInstitution(blocks, logoAlt);
      const title = this.findTitle(blocks, { referenceNo, city, institution, rawText });
      const publishedAt = this.findDate(blocks, element, nowIso);

      rows.push({
        itemId,
        url,
        title: cleanTitle(title) || cleanTitle(rawText),
        institution,
        referenceNo,
        city,
        publishedAt,
        summary: rawText.slice(0, 600),
      });
    });

    return rows;
  }

  private itemIdOf(url: string): string | null {
    const match = /\/ilan\/(\d+)/.exec(url);
    return match?.[1] ?? null;
  }

  /** Satır içindeki metin blokları (sınıf adından bağımsız). */
  private textBlocks(root: ReturnType<typeof loadHtml>, element: Cheerio<AnyNode>): string[] {
    const blocks: string[] = [];
    const push = (value: string) => {
      const text = collapseWhitespace(value);
      if (text.length >= 2 && !blocks.includes(text)) blocks.push(text);
    };
    element
      .find('h1,h2,h3,h4,h5,span,div,p,strong,b,time,li')
      .each((_index, node) => push(root(node).text()));
    if (blocks.length === 0) push(element.text());
    return blocks;
  }

  private findCity(blocks: string[]): string | null {
    for (const block of blocks) {
      const upper = block.toLocaleUpperCase('tr');
      if (PROVINCE_UPPER.has(upper)) return block;
    }
    return null;
  }

  private findInstitution(blocks: string[], logoAlt: string): string | null {
    const institutionPattern =
      /(BAKANLIĞI|BAKANLIGI|BELEDİYE|BELEDIYE|ÜNİVERSİTE|UNIVERSITE|MÜDÜRLÜĞÜ|MUDURLUGU|BAŞKANLIĞI|BASKANLIGI|GENEL MÜDÜRLÜĞÜ|KURUMU|BAŞKANLIK|İDARESİ|AJANSI|FONU|VALİLİĞİ|REKTÖRLÜĞÜ|REKTORLUGU|DAİRE)/i;
    for (const block of blocks) {
      if (block.length > 8 && institutionPattern.test(block)) return cleanInstitution(block);
    }
    if (logoAlt.length > 3) return cleanInstitution(logoAlt);
    return null;
  }

  private findTitle(
    blocks: string[],
    context: { referenceNo: string | null; city: string | null; institution: string | null; rawText: string },
  ): string {
    const candidates = blocks.filter((block) => {
      if (block.length < 12) return false;
      if (context.city && block === context.city) return false;
      if (context.institution && block === context.institution) return false;
      if (context.referenceNo && block.replace(/\s/g, '').includes(context.referenceNo)) return false;
      if (/^\d{2}[./]\d{2}[./]\d{4}/.test(block)) return false;
      if (/^\d+\s*(saat|dakika|gün)\s*önce$/i.test(block)) return false;
      return true;
    });
    if (candidates.length === 0) return context.rawText.slice(0, 200);
    // En uzun metin genellikle başlıktır; eşitlikte ilk görünen seçilir.
    return candidates.reduce((best, current) => (current.length > best.length ? current : best), candidates[0] as string);
  }

  private findDate(blocks: string[], element: Cheerio<AnyNode>, nowIso: string): string | null {
    const text = `${blocks.join(' ')} ${element.attr('title') ?? ''}`;
    const relative = /(\d+)\s*(dakika|saat|gün)\s*önce/i.exec(text);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = (relative[2] ?? '').toLowerCase();
      const ms = unit === 'dakika' ? amount * 60_000 : unit === 'saat' ? amount * 3_600_000 : amount * 86_400_000;
      return new Date(new Date(nowIso).getTime() - ms).toISOString();
    }
    const absolute = /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4})/.exec(text);
    if (absolute?.[1]) {
      const parsed = /(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})/.exec(absolute[1]);
      if (parsed) {
        const [, day, month, year] = parsed;
        const iso = `${year}-${(month ?? '').padStart(2, '0')}-${(day ?? '').padStart(2, '0')}T00:00:00+03:00`;
        if (!Number.isNaN(new Date(iso).getTime())) return iso;
      }
    }
    return null;
  }

  /** Detay sayfasından metin, ekler ve başvuru bağlantısı. */
  parseDetail(html: string, baseUrl: string): {
    body: string;
    attachments: JobAttachment[];
    applicationUrl: string | null;
  } {
    const root = loadHtml(html);
    const container =
      root('article').length > 0
        ? root('article').first()
        : root('[class*="ilan-detay"], [class*="detail"], main').length > 0
          ? root('[class*="ilan-detay"], [class*="detail"], main').first()
          : root('body');
    const body = readableText(root, container).slice(0, 20_000);
    const allLinks = links(root, container.length > 0 ? container : root('body'), baseUrl);
    return {
      body,
      attachments: collectAttachmentLinks(allLinks, baseUrl),
      applicationUrl: extractApplicationUrl(allLinks, baseUrl),
    };
  }
}
