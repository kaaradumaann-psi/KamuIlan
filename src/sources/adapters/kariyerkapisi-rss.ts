/**
 * Kariyer Kapısı — resmî RSS akışı adaptörü.
 *
 * Kariyer Kapısı'nın ilan API'si (api.kariyerkapisi.gov.tr) sunucumuzun yurt dışı
 * IP'sini ağ düzeyinde engelliyor (bölge kısıtı). Ancak kurumun RESMÎ RSS akışı
 * (https://kariyerkapisi.gov.tr/RSS) aynı ortamdan erişilebiliyor (HTTP 200) ve
 * taklit/başlık hilesi gerektirmez. Bu adaptör o akışı okur.
 *
 * Akış öğesi: <guid>/<link> = IlanDetay?i=<guid>, <category> (İşçi/Memur/Akademik…),
 * <title> ("KURUM ADI - PERSONEL ALIM İLANI (N KİŞİLİK)"), <pubDate> (RFC822).
 * Detay sayfası istemci tarafı (SPA) olduğundan son başvuru/kontenjan sunucudan
 * okunamaz; bu alanlar boş bırakılır. İlanın varlığı + başvuru bağlantısı yeterlidir.
 */
import { createHash } from 'node:crypto';
import { collapseWhitespace } from '../../domain/text';
import { toIstanbulDateOnly } from '../../domain/dates';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError, SourceAccessError } from '../errors';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

const MAX_ITEMS = 100;

/** RSS <item> bloğundan tek bir alanı çıkarır (CDATA ve varlık kodlaması dahil). */
function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!match) return null;
  let value = match[1] ?? '';
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value.trim());
  if (cdata) value = cdata[1] ?? '';
  return decodeEntities(collapseWhitespace(value)) || null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** IlanDetay?i=<guid> bağlantısından kararlı kimliği (guid) çıkarır. */
function itemIdFromLink(link: string): string {
  const match = /[?&]i=([0-9a-fA-F-]{8,})/.exec(link);
  if (match) return match[1]!.toLowerCase();
  return createHash('sha256').update(link).digest('hex').slice(0, 24);
}

/** RFC822 pubDate'i gün bazlı ISO'ya çevirir; çözülemezse null. */
function parsePubDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return toIstanbulDateOnly(date);
}

/** "KURUM ADI - PERSONEL ALIM İLANI (…)" başlığından kurum adını ayırır. */
function institutionFromTitle(title: string): string | undefined {
  const dash = title.indexOf(' - ');
  if (dash <= 0) return undefined;
  const inst = title.slice(0, dash).trim();
  return inst.length >= 3 ? inst : undefined;
}

export class KariyerKapisiRssAdapter implements SourceAdapter {
  readonly key = 'kariyer-kapisi-rss';
  readonly label = 'Kariyer Kapısı (RSS)';
  readonly method = 'rss';
  readonly notes =
    'Kurumun resmî RSS akışı okunur (ilan API bölge kısıtlı; akış erişilebilir ve ' +
    'taklit gerektirmez). Detay SPA olduğundan son başvuru/kontenjan boş kalır.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const notes: string[] = [];
    let requestCount = 0;
    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: RSS okunmadı.');
      return { items: [], requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    const httpStatuses: number[] = [];
    let response;
    try {
      response = await ctx.http.fetchText(ctx.source.listingUrl, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      });
      requestCount += 1;
      httpStatuses.push(response.status);
    } catch (error) {
      // Bölge kısıtı yine devreye girerse (akış da engellenirse) açıkça bildir; aşmaya çalışma.
      throw new SourceAccessError(
        ctx.source.key,
        `Kariyer Kapısı RSS akışına erişilemedi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.notModified) {
      return {
        items: [],
        requestCount,
        notes: ['RSS içeriği değişmedi (304).'],
        etag: response.etag,
        lastModified: response.lastModified,
        notModified: true,
        httpStatuses,
        coverage: { status: 'complete', note: 'İçerik değişmedi.' },
      };
    }

    const xml = response.decoded?.text ?? response.body.toString('utf8');
    const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
    if (itemBlocks.length === 0) {
      // Akış 200 döndü ama <item> yok: yapı değişmiş olabilir — sessiz kayıp yerine hata.
      throw new AdapterStructureError(
        ctx.source.key,
        'Kariyer Kapısı RSS akışında <item> bulunamadı (yapı değişmiş olabilir).',
      );
    }

    const items: RawAnnouncement[] = [];
    const seen = new Set<string>();
    for (const block of itemBlocks.slice(0, MAX_ITEMS)) {
      const link = tagText(block, 'link') ?? tagText(block, 'guid');
      const title = tagText(block, 'title');
      if (!link || !title) continue;
      const sourceItemId = itemIdFromLink(link);
      if (seen.has(sourceItemId)) continue;
      seen.add(sourceItemId);
      const category = tagText(block, 'category') ?? undefined;
      const announcement: RawAnnouncement = {
        sourceKey: ctx.source.key,
        sourceItemId,
        url: link,
        title,
        ...(institutionFromTitle(title) ? { institution: institutionFromTitle(title) } : {}),
        ...(parsePubDate(tagText(block, 'pubDate')) ? { publishedAt: parsePubDate(tagText(block, 'pubDate')) } : {}),
        ...(category ? { sourceCategory: category } : {}),
        applicationUrl: link,
        attachments: [],
        extractionConfidence: 0.7,
        notes: ['RSS akışından okundu; son başvuru/kontenjan detay SPA olduğu için alınamadı.'],
      };
      items.push(announcement);
    }

    notes.push(`RSS akışından ${items.length} ilan okundu.`);
    return {
      items,
      requestCount,
      notes,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: false,
      httpStatuses,
      coverage: {
        status: 'complete',
        note: `Akıştaki ${itemBlocks.length} öğe okundu (akış son ~30 ilanı taşır).`,
      },
    };
  }
}
