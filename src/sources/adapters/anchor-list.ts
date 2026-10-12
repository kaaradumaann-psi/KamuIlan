/**
 * Tarih + başlık biçimindeki kurumsal duyuru listeleri için ortak adaptör.
 *
 * İŞKUR ve MEB Personel sayfaları bu yapıya uyar: liste hâlinde bağlantılar,
 * yanlarında yayım tarihi. Sınıf adları bilinmediği için ayrıştırma
 * yapısal bağlantı kalıplarına dayanır; kayıt bulunamazsa yapı uyarısı üretilir.
 *
 * Ayrıştırma kuralları (yapılandırılabilir):
 *  - `hrefPattern`: detay bağlantısı kalıbı (ör. /ilanlar/…, /icerik/…)
 *  - `minTitleLength`: başlık uzunluğu eşiği
 *  - `containerSelector`: liste kapsayıcısı (opsiyonel)
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { absoluteUrl, loadHtml, readableText } from '../../lib/html';
import { AdapterStructureError } from '../errors';
import { cleanInstitution, cleanTitle, firstDateIn, sourceItemIdFromUrl } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

export interface AnchorListConfig {
  hrefPattern: RegExp;
  minTitleLength: number;
  /** Başlıkların arandığı kapsayıcı; boşsa tüm belge. */
  containerSelector?: string;
  /** Bağlantı metninde aranan zorunlu ifade (opsiyonel). */
  titleMustContain?: RegExp;
  /** Detay sayfaları indirilsin mi? */
  fetchDetails?: boolean;
}

export class AnchorListAdapter implements SourceAdapter {
  readonly key: string;
  readonly label: string;
  private readonly config: AnchorListConfig;

  constructor(key: string, label: string, config: AnchorListConfig) {
    this.key = key;
    this.label = label;
    this.config = config;
  }

  listingUrl(source: { listingUrl: string }): string {
    return source.listingUrl;
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
      return { items: [], httpStatuses, notes: ['Liste değişmemiş (304).'], notModified: true };
    }
    if (!response.text) {
      throw new AdapterStructureError(this.key, 'Liste sayfası boş döndü.', response.finalUrl);
    }

    const rows = this.parseRows(response.text, response.finalUrl);
    if (rows.length === 0) {
      throw new AdapterStructureError(
        this.key,
        'Liste sayfasında kayıt bulunamadı: HTML yapısı değişmiş olabilir. Kaynak devre dışı bırakılmadan önce yönetici incelemesi gerekir.',
        response.finalUrl,
      );
    }
    notes.push(`${rows.length} kayıt bulundu.`);

    const detailBudget = this.config.fetchDetails ? ctx.limits.maxDetailFetches : 0;
    let fetched = 0;

    for (const row of rows) {
      let body = '';
      if (ctx.liveFetch && detailBudget > 0 && fetched < detailBudget && !(ctx.knownItemIds?.has(row.itemId) ?? false)) {
        fetched += 1;
        try {
          const detail = await ctx.fetcher.fetchText(row.url, { source: ctx.source });
          httpStatuses.push(detail.status);
          if (detail.text) {
            const root = loadHtml(detail.text);
            const container = root('article, main, [class*="content"], .icerik').first();
            body = readableText(root, container.length > 0 ? container : root('body')).slice(0, 20_000);
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
        institution: row.institution ?? undefined,
        publishedAt: row.publishedAt ?? undefined,
        attachments: [],
        sourceCategory: ctx.source.name,
        rawExcerpt: collapseWhitespace(body || row.title).slice(0, 2_000),
        extractionConfidence: body.length > 200 ? 0.6 : 0.35,
        notes: [],
      });
    }

    return {
      items,
      httpStatuses,
      notes,
      notModified: false,
      cacheHeaders: { etag: response.etag, lastModified: response.lastModified, contentHash: response.contentHash },
    };
  }

  parseRows(
    html: string,
    baseUrl: string,
  ): { itemId: string; url: string; title: string; publishedAt: string | null; institution: string | null }[] {
    const root = loadHtml(html);
    const scope = this.config.containerSelector ? root(this.config.containerSelector) : root('body');
    const rows: { itemId: string; url: string; title: string; publishedAt: string | null; institution: string | null }[] = [];
    const seen = new Set<string>();

    scope.find('a[href]').each((_, anchor) => {
      const element = root(anchor);
      const url = absoluteUrl(element.attr('href'), baseUrl);
      if (!url) return;
      if (!this.config.hrefPattern.test(new URL(url).pathname)) return;

      const rawTitle = collapseWhitespace(element.text());
      if (rawTitle.length < this.config.minTitleLength) return;
      if (this.config.titleMustContain && !this.config.titleMustContain.test(rawTitle)) return;

      const itemId = sourceItemIdFromUrl(url);
      if (seen.has(itemId)) return;
      seen.add(itemId);

      const contextElement = element.closest('li, tr, article, div[class*="item"], div[class*="card"]');
      const contextText = collapseWhitespace(contextElement.length > 0 ? contextElement.text() : element.parent().text());
      rows.push({
        itemId,
        url,
        title: cleanTitle(rawTitle),
        publishedAt: firstDateIn(contextText),
        institution: cleanInstitution(this.institutionFromContext(contextText, rawTitle)),
      });
    });

    return rows;
  }

  private institutionFromContext(contextText: string, title: string): string | null {
    const pattern = /([A-ZÇĞİÖŞÜ][\wçğıöşüÇĞİÖŞÜ.,'’\- ]{5,90}(?:Bakanlığı|Başkanlığı|Müdürlüğü|Belediyesi|Üniversitesi|Kurumu|Valiliği))/u;
    const match = pattern.exec(contextText);
    if (match?.[1]) return match[1];
    const upperMatch = /([A-ZÇĞİÖŞÜ]{4,}(?:\s+[A-ZÇĞİÖŞÜ]{2,}){1,6})/.exec(contextText);
    if (upperMatch?.[1] && !title.includes(upperMatch[1])) return upperMatch[1];
    return null;
  }
}

/** İŞKUR ilan listeleri (memur ve kurum dışı işçi alımı). */
export function createIskurAdapter(): AnchorListAdapter {
  return new AnchorListAdapter('iskur-liste', 'İŞKUR — İlan listesi', {
    hrefPattern: /\/ilan/i,
    minTitleLength: 12,
    containerSelector: 'main, #content, .content, body',
    fetchDetails: true,
  });
}

/** MEB Personel Genel Müdürlüğü haber/duyuru listesi. */
export function createMebAdapter(): AnchorListAdapter {
  return new AnchorListAdapter('meb-personel', 'MEB Personel — Duyurular', {
    hrefPattern: /\/icerik\//,
    minTitleLength: 12,
    containerSelector: 'main, #content, .content, body',
    fetchDetails: true,
  });
}
