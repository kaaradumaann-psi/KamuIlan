/**
 * ÖSYM duyuruları.
 *
 * Canlı doğrulama (2026-10-12): `https://www.osym.gov.tr/Duyurular/Index`
 * listesi erişilebilir; duyuru bağlantıları site kökünde slug biçimindedir
 * (ör. `/2026-yds-2-gec-basvuru`) ve gerçek başvuru tarihlerini içerir.
 * AIS (ais.osym.gov.tr) giriş gerektirdiği için kapsam dışıdır ve kapsam
 * raporunda bu şekilde belirtilir.
 *
 * Yöntem: HTML listesi (tek sayfa) + duyuru detayı. PDF bağlantıları ek olarak
 * kaydedilir; PDF metni hattaki PDF çıkarıcı ile okunur.
 */
import type { AnyNode } from 'domhandler';
import { elementText, loadHtml, readableText } from '../../lib/html';
import { cleanTitle, parseListingDate } from '../listing-utils';
import { normalizeUrl } from '../../domain/urls';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

const SLUG_PATTERN = /^\/[a-z0-9][a-z0-9-]{8,}$/i;
const MAX_ITEMS = 25;

interface Candidate {
  element: AnyNode;
  url: string;
  text: string;
}

export class OsymAdapter implements SourceAdapter {
  readonly key = 'osym-duyuru';
  readonly label = 'ÖSYM duyuruları';
  readonly method = 'html-list';
  readonly notes =
    'ÖSYM duyuru listesi HTML olarak okunur. Sınav/başvuru duyuruları ilan olarak sınıflandırılır; AIS girişi gerektiren içerik kapsam dışıdır.';

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
        notes: ['Duyuru listesi değişmedi (ETag/Last-Modified).'],
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
      .map((element) => ({
        element: element as AnyNode,
        url: normalizeUrl($(element).attr('href') ?? '', source.listingUrl),
        text: elementText($(element), 300),
      }))
      .filter((candidate): candidate is Candidate => candidate.url !== null)
      .filter((candidate) => {
        try {
          return SLUG_PATTERN.test(new URL(candidate.url).pathname);
        } catch {
          return false;
        }
      });

    const seen = new Set<string>(ctx.knownItemIds ?? []);
    const items: RawAnnouncement[] = [];

    for (const candidate of candidates) {
      if (items.length >= MAX_ITEMS) break;
      const slug = new URL(candidate.url).pathname.replace(/^\//, '');
      if (seen.has(slug)) continue;
      const title = cleanTitle(candidate.text);
      if (title.length < 15) continue;

      const rowText = elementText($(candidate.element).closest('li, tr, article, div'), 600);
      const publishedAt = parseListingDate(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.exec(rowText)?.[0] ?? null);
      const detail = await this.readDetail(ctx, candidate.url);
      requestCount += detail.requests;
      httpStatuses.push(...detail.statuses);

      items.push({
        sourceKey: source.key,
        sourceItemId: slug,
        url: candidate.url,
        title,
        institution: 'ÖSYM',
        ...(publishedAt ? { publishedAt } : {}),
        sourceCategory: 'sınav duyurusu',
        ...(detail.bodyText ? { bodyText: detail.bodyText } : {}),
        ...(detail.bodyText ? { rawExcerpt: detail.bodyText.slice(0, 400) } : {}),
        attachments: detail.attachments,
        ...(detail.applicationUrl ? { applicationUrl: detail.applicationUrl } : {}),
        extractionConfidence: 0.55,
      });
      seen.add(slug);
    }

    notes.push(`Duyuru listesinden ${items.length} yeni kayıt işlendi.`);
    if (items.length === 0) notes.push('Yeni duyuru yok (tümü daha önce görülmüş olabilir).');

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
        maxBytes: 2_500_000,
      });
      const html = response.decoded?.text ?? response.body.toString('utf8');
      const $ = loadHtml(html);
      const text = readableText($, 'main, article, .icerik, .content', 20_000) || readableText($, 'body', 20_000);
      const links = $('a[href]')
        .toArray()
        .map((element) => ({ text: elementText($(element), 200), url: normalizeUrl($(element).attr('href') ?? '', url) }))
        .filter((link): link is { text: string; url: string } => link.url !== null);

      const attachments = links
        .filter((link) => /\.(pdf|docx?)(\?|$)/i.test(link.url))
        .slice(0, 5)
        .map((link) => ({
          url: link.url,
          label: link.text.slice(0, 160) || 'Duyuru belgesi',
          kind: (/\.pdf(\?|$)/i.test(link.url) ? 'pdf' : 'doc') as 'pdf' | 'doc',
        }));
      const application = links.find((link) => /kariyerkapisi\.gov\.tr|ais\.osym\.gov\.tr|turkiye\.gov\.tr/i.test(link.url));

      return {
        bodyText: text.length > 80 ? text : null,
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
