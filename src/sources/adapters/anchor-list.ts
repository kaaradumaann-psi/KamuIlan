/**
 * "Tarihli bağlantı listesi" adaptörü (İŞKUR, MEB gibi kurumsal sayfalar).
 *
 * Bu sayfalar ortak bir biçim izler: bir liste içinde bağlantı + yanında tarih.
 * Adaptör yalnızca bu ortak biçimi okur; kaynağa özgü farklar yapılandırma
 * (yol kalıbı, kapsayıcı seçici, asgari başlık uzunluğu) ile verilir.
 *
 * Önemli: Sayfa yapısı beklenenden farklıysa adaptör sessizce boş dönmez;
 * "liste yapısı tanınmadı" hatası fırlatır ki kaynak sağlığında ve tarama
 * kaydında hata olarak görünsün (HTML değişikliği sessizce veri kaybına
 * dönüşmesin).
 */
import type { AnyNode } from 'domhandler';
import { elementText, loadHtml, readableText } from '../../lib/html';
import { cleanTitle, parseListingDate } from '../listing-utils';
import { normalizeUrl } from '../../domain/urls';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

export interface AnchorListConfig {
  key: string;
  label: string;
  notes: string;
  /** Detay bağlantılarını tanıyan yol kalıbı. */
  pathPattern: RegExp;
  /** Satır metnini okumak için kapsayıcı seçici. */
  rowSelector: string;
  minTitleLength: number;
  defaultInstitution: string;
  sourceCategory: string;
  /** Detay sayfası okunacak mı? */
  fetchDetail?: boolean;
  maxItems?: number;
}

interface Candidate {
  element: AnyNode;
  url: string;
}

export class AnchorListAdapter implements SourceAdapter {
  readonly key: string;
  readonly label: string;
  readonly method = 'html-list';
  readonly notes: string;

  constructor(private readonly config: AnchorListConfig) {
    this.key = config.key;
    this.label = config.label;
    this.notes = config.notes;
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const { source, http, liveFetch } = ctx;
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
    const listing = await http.fetchText(source.listingUrl, {
      allowedHosts: source.allowedHosts,
      minIntervalMs: source.minRequestIntervalMs,
    });
    let requestCount = 1;
    httpStatuses.push(listing.status);

    if (listing.notModified) {
      return {
        items: [],
        requestCount,
        notes: ['Liste değişmedi (ETag/Last-Modified).'],
        etag: listing.etag,
        lastModified: listing.lastModified,
        notModified: true,
        httpStatuses,
      };
    }

    const html = listing.decoded?.text ?? listing.body.toString('utf8');
    const $ = loadHtml(html);
    const candidates: Candidate[] = $('a[href]')
      .toArray()
      .map((element) => ({ element: element as AnyNode, url: normalizeUrl($(element).attr('href') ?? '', source.listingUrl) }))
      .filter((candidate): candidate is Candidate => candidate.url !== null)
      .filter((candidate) => {
        try {
          return this.config.pathPattern.test(new URL(candidate.url).pathname);
        } catch {
          return false;
        }
      });

    if (candidates.length === 0) {
      const pageText = readableText($, 'body', 300);
      throw new Error(
        `Liste yapısı tanınmadı (${source.key}): beklenen bağlantı kalıbı ${String(this.config.pathPattern)} bulunamadı. ` +
          `Sayfa özeti: "${pageText.slice(0, 160)}" — adaptör seçicileri güncellenmeli.`,
      );
    }

    const seen = new Set<string>(ctx.knownItemIds ?? []);
    const items: RawAnnouncement[] = [];
    const maxItems = this.config.maxItems ?? 30;

    for (const candidate of candidates) {
      if (items.length >= maxItems) break;
      const itemId = itemIdOf(candidate.url);
      if (!itemId || seen.has(itemId)) continue;

      const anchorText = elementText($(candidate.element), 400);
      const rowText = elementText($(candidate.element).closest(this.config.rowSelector), 900) || anchorText;
      const title = cleanTitle(anchorText.length >= this.config.minTitleLength ? anchorText : rowText);
      if (title.length < this.config.minTitleLength) continue;

      const publishedAt = parseListingDate(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.exec(rowText)?.[0] ?? null);
      const detail = this.config.fetchDetail === false ? null : await this.readDetail(ctx, candidate.url);
      if (detail) {
        requestCount += detail.requests;
        httpStatuses.push(...detail.statuses);
      }
      const bodyText = detail?.bodyText ?? (rowText.length > 140 ? rowText.slice(0, 2_000) : null);

      items.push({
        sourceKey: source.key,
        sourceItemId: itemId,
        url: candidate.url,
        title,
        institution: source.institution || this.config.defaultInstitution,
        ...(publishedAt ? { publishedAt } : {}),
        sourceCategory: this.config.sourceCategory,
        ...(bodyText ? { bodyText } : {}),
        ...(rowText ? { rawExcerpt: rowText.slice(0, 400) } : {}),
        attachments: detail?.attachments ?? [],
        ...(detail?.applicationUrl ? { applicationUrl: detail.applicationUrl } : {}),
        extractionConfidence: 0.5,
      });
      seen.add(itemId);
    }

    notes.push(`${candidates.length} bağlantı bulundu, ${items.length} yeni kayıt işlendi.`);
    if (items.length === 0) notes.push('Yeni kayıt yok (tümü daha önce görülmüş olabilir).');

    return {
      items,
      requestCount,
      notes,
      etag: listing.etag,
      lastModified: listing.lastModified,
      notModified: false,
      httpStatuses,
    };
  }

  private async readDetail(
    ctx: AdapterContext,
    url: string,
  ): Promise<{
    bodyText: string | null;
    attachments: RawAnnouncement['attachments'];
    applicationUrl: string | null;
    requests: number;
    statuses: number[];
  }> {
    try {
      const response = await ctx.http.fetchText(url, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
        maxBytes: 3_000_000,
      });
      const html = response.decoded?.text ?? response.body.toString('utf8');
      const $ = loadHtml(html);
      const text = readableText($, 'main, article, .icerik, .content, #content', 20_000) || readableText($, 'body', 20_000);
      const links = $('a[href]')
        .toArray()
        .map((element) => ({ text: elementText($(element), 200), url: normalizeUrl($(element).attr('href') ?? '', url) }))
        .filter((link): link is { text: string; url: string } => link.url !== null);

      const attachments = links
        .filter((link) => /\.(pdf|docx?)(\?|$)/i.test(link.url))
        .slice(0, 6)
        .map((link) => ({
          url: link.url,
          label: link.text.slice(0, 160) || 'Belge',
          kind: (/\.pdf(\?|$)/i.test(link.url) ? 'pdf' : 'doc') as 'pdf' | 'doc',
        }));
      const application = links.find((link) => /kariyerkapisi\.gov\.tr|esube\.iskur\.gov\.tr|turkiye\.gov\.tr/i.test(link.url));

      return {
        bodyText: text.length > 120 ? text : null,
        attachments,
        applicationUrl: application?.url ?? null,
        requests: 1,
        statuses: [response.status],
      };
    } catch {
      return { bodyText: null, attachments: [], applicationUrl: null, requests: 1, statuses: [] };
    }
  }
}

function itemIdOf(url: string): string | null {
  try {
    const pathname = new URL(url).pathname.replace(/\/$/, '');
    const match = /([a-z0-9-]{6,}|\d{3,})$/i.exec(pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** İŞKUR kamu işçi/memur alım ilanları. */
export function createIskurAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'iskur-ilan-listesi',
    label: 'İŞKUR — kamu personel alım ilanları',
    notes:
      'İŞKUR ilan listesi HTML olarak okunur. Başvurular e-Devlet/İŞKUR üzerinden yapılır; ' +
      'esube arama ekranı (ASP.NET postback) ve TYP listesi otomatik taranmaz — kapsam raporunda belirtilir.',
    pathPattern: /\/ilan/i,
    rowSelector: 'li, tr, article, .card, div',
    minTitleLength: 20,
    defaultInstitution: 'Türkiye İş Kurumu (İŞKUR)',
    sourceCategory: 'kamu personel alımı',
    maxItems: 30,
  });
}

/**
 * Genel kurum duyuru listesi (bakanlıklar ve bağlı kurumlar).
 *
 * Kurumun resmî duyuru sayfasındaki bağlantıları okur; kurum adı kaynak
 * kaydından gelir. Sayfa yapısı uymazsa adaptör boş dönmez, yapı hatası
 * fırlatır — hata tarama kaydında ve kaynak sağlığında görünür. "Personel
 * alımı" olmayan duyurular (ihale, sonuç, atama) sınıflandırma hattında elenir.
 */
export function createKurumAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'kurum-duyuru-listesi',
    label: 'Kurum duyuru listesi (genel)',
    notes:
      'Kurum duyuru sayfası HTML olarak okunur; yalnızca personel alımı duyuruları kabul edilir, ' +
      'diğer duyurular sınıflandırmada elenir. Yapı değişirse tarama kaydı hata gösterir.',
    pathPattern: /\/(duyuru|duyurular|haber|haberler|ilan|ilanlar|icerik|detay|sayfa)/i,
    rowSelector: 'li, tr, article, .card, div',
    minTitleLength: 18,
    defaultInstitution: '',
    sourceCategory: 'personel alım duyurusu',
    maxItems: 25,
  });
}

/** Millî Eğitim Bakanlığı personel duyuruları. */
export function createMebAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'meb-duyuru-listesi',
    label: 'MEB — personel duyuruları',
    notes:
      'MEB duyuru listesi HTML olarak okunur. Atama/yer değiştirme duyuruları sınıflandırmada ' +
      '"yeni ilan değil" olarak işaretlenir (sonuç/atama içerikleri reddedilir).',
    pathPattern: /\/www\/[a-z0-9-]+\/icerik\/\d+/i,
    rowSelector: 'li, tr, article, .card, div',
    minTitleLength: 20,
    defaultInstitution: 'T.C. Millî Eğitim Bakanlığı',
    sourceCategory: 'personel duyurusu',
    maxItems: 30,
  });
}
