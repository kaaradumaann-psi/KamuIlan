/**
 * ilan.gov.tr (Basın İlan Kurumu) — Kamu/Akademik Personel kategorisi.
 *
 * Canlı doğrulama (2026-10-12): `?ats=5` filtresi "Personel Alımı" ilanlarını
 * verir; liste sayfalanır (`currentPage=N`); her ilanda kurum, resmî ilan
 * numarası (YOK/DPB/ILN…), şehir ve detay bağlantısı bulunur.
 *
 * Yöntem: HTML listesi + detay sayfası (detay isteği sayısı bütçeyle sınırlıdır).
 */
import { elementText, loadHtml, readableText } from '../../lib/html';
import { cleanTitle, extractReferenceNumbers, parseListingDate } from '../listing-utils';
import { PROVINCES } from '../../domain';
import { normalizeUrl } from '../../domain/urls';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

const MAX_PAGES = 5;
const MAX_ITEMS = 40;
const ITEM_ID_PATTERN = /\/ilan\/(\d+)/;

interface Row {
  url: string;
  itemId: string;
  title: string;
  institution: string | null;
  city: string | null;
  publishedAt: string | null;
  refNo: string | null;
}

export class IlanGovTrAdapter implements SourceAdapter {
  readonly key = 'ilan-gov-tr';
  readonly label = 'ilan.gov.tr — personel alımı';
  readonly method = 'html-list';
  readonly notes =
    'Basın İlan Kurumu portalı. Liste sayfaları HTML olarak okunur; her ilanın detay sayfasından metin ve ek belgeler alınır.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const { source, http, liveFetch } = ctx;
    const notes: string[] = [];
    const httpStatuses: number[] = [];
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

    let requestCount = 0;
    const rows: Row[] = [];
    let notModified = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(source.listingUrl);
      if (page > 1) url.searchParams.set('currentPage', String(page));
      const response = await http.fetchText(url.toString(), {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
      });
      requestCount += 1;
      httpStatuses.push(response.status);
      if (page === 1 && response.notModified) {
        notModified = true;
        notes.push('Liste içeriği değişmedi (ETag/Last-Modified) — ayrıntı isteği yapılmadı.');
        break;
      }
      const pageRows = parseListing(response.decoded?.text ?? response.body.toString('utf8'), source.listingUrl);
      notes.push(`Sayfa ${page}: ${pageRows.length} ilan satırı.`);
      if (pageRows.length === 0) break;
      const before = rows.length;
      rows.push(...pageRows);
      if (new Set(rows.map((row) => row.itemId)).size < rows.length) break; // tekrar eden sayfa = son
      if (rows.length === before) break;
    }

    const seen = new Set<string>(ctx.knownItemIds ?? []);
    const fresh = rows.filter((row) => !seen.has(row.itemId)).slice(0, MAX_ITEMS);
    const items: RawAnnouncement[] = [];

    for (const row of fresh) {
      const detail = await this.readDetail(ctx, row);
      requestCount += detail.requests;
      httpStatuses.push(...detail.statuses);
      items.push({
        sourceKey: source.key,
        sourceItemId: row.itemId,
        url: row.url,
        title: row.title,
        institution: row.institution ?? source.institution,
        ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
        sourceCategory: 'personel alımı',
        ...(detail.bodyText ? { bodyText: detail.bodyText } : {}),
        ...(detail.bodyText ? { rawExcerpt: detail.bodyText.slice(0, 400) } : {}),
        attachments: detail.attachments,
        ...(detail.applicationUrl ? { applicationUrl: detail.applicationUrl } : {}),
        ...(row.refNo ? { referenceNo: row.refNo } : {}),
        ...(row.city ? { city: row.city } : {}),
        extractionConfidence: 0.6,
      });
    }

    if (fresh.length === 0 && rows.length > 0) {
      notes.push('Yeni ilan yok (tümü daha önce görülmüş) — idempotent tarama.');
    }
    notes.push(`Listede ${rows.length} ilan, işlenen ${items.length}.`);

    return { items, requestCount, notes, etag: null, lastModified: null, notModified, httpStatuses };
  }

  private async readDetail(
    ctx: AdapterContext,
    row: Row,
  ): Promise<{
    bodyText: string | null;
    attachments: RawAnnouncement['attachments'];
    applicationUrl: string | null;
    requests: number;
    statuses: number[];
  }> {
    const { http, source } = ctx;
    try {
      const response = await http.fetchText(row.url, {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
        maxBytes: 3_000_000,
      });
      const html = response.decoded?.text ?? response.body.toString('utf8');
      const $ = loadHtml(html);
      const body = readableText($, 'article, .ad-detail, .ilan-detay, main', 20_000) || readableText($, 'body', 20_000);
      const links = $('a[href]')
        .toArray()
        .map((element) => ({ href: $(element).attr('href') ?? '', text: elementText($(element), 200), url: normalizeUrl($(element).attr('href') ?? '', row.url) }))
        .filter((link): link is { href: string; text: string; url: string } => link.url !== null);

      const attachments = links
        .filter((link) => /\.(pdf|docx?|xlsx?)(\?|$)/i.test(link.url))
        .slice(0, 6)
        .map((link) => ({
          url: link.url,
          label: link.text.slice(0, 160) || 'İlan belgesi',
          kind: (/\.pdf(\?|$)/i.test(link.url) ? 'pdf' : /\.docx?(\?|$)/i.test(link.url) ? 'doc' : 'excel') as 'pdf' | 'doc' | 'excel',
        }));

      const applicationCandidates = links.filter((link) => /kariyerkapisi\.gov\.tr|esube\.iskur\.gov\.tr|turkiye\.gov\.tr/i.test(link.url));
      const application = applicationCandidates.find((link) => /ba[sş]vuru/i.test(link.text)) ?? applicationCandidates[0];

      return {
        bodyText: body.length > 80 ? body : null,
        attachments,
        applicationUrl: application?.url ?? null,
        requests: 1,
        statuses: [response.status],
      };
    } catch {
      // Detay alınamazsa liste bilgisiyle devam edilir; eksik alanlar "belirtilmemiş" kalır.
      return { bodyText: null, attachments: [], applicationUrl: null, requests: 1, statuses: [] };
    }
  }
}

/** Liste sayfasından ilan satırlarını çıkarır (yapı değişirse boş liste döner → hata kaydı). */
function parseListing(html: string, baseUrl: string): Row[] {
  const $ = loadHtml(html);
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const element of $('a[href]').toArray()) {
    const href = $(element).attr('href') ?? '';
    const match = ITEM_ID_PATTERN.exec(href);
    if (!match?.[1]) continue;
    const itemId = match[1];
    if (seen.has(itemId)) continue;
    const url = normalizeUrl(href, baseUrl);
    if (!url) continue;

    const anchorText = elementText($(element), 400);
    const containerText = elementText($(element).closest('article, li, .card, .ad-list-item, div'), 900) || anchorText;
    const lines = containerText
      .split(/\s{2,}|\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 1);
    const titleCandidates = lines.filter((line) => line.length >= 12);
    const province = PROVINCES.find((candidate) =>
      lines.some((line) => line.toLocaleUpperCase('tr-TR') === candidate.name.toLocaleUpperCase('tr-TR')),
    );
    const refNos = extractReferenceNumbers(containerText);
    const title = cleanTitle([...titleCandidates].sort((a, b) => b.length - a.length)[0] ?? anchorText);
    if (title.length < 12) continue;

    const institutionLine = titleCandidates.find((line) =>
      /(Bakanlı|Başkanlı|Üniversite|Müdürlüğü|Genel Müdürlük|Kurum|Belediye|Valiliğ)/i.test(line),
    );
    const publishedAt = parseListingDate(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.exec(containerText)?.[0] ?? null);

    seen.add(itemId);
    rows.push({
      url,
      itemId,
      title,
      institution: institutionLine && institutionLine !== title ? institutionLine.slice(0, 160) : null,
      city: province?.name ?? null,
      publishedAt,
      refNo: refNos[0] ?? null,
    });
  }

  return rows;
}
