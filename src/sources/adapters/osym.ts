/**
 * ÖSYM duyuruları.
 *
 * Canlı doğrulama (2026-10-12): `https://www.osym.gov.tr/Duyurular/Index`
 * listesi erişilebilir; duyuru bağlantıları site kökünde slug biçimindedir
 * (ör. `/2026-yds-2-gec-basvuru`) ve gerçek başvuru tarihlerini içerir.
 * AIS (ais.osym.gov.tr) giriş gerektirdiği için kapsam dışıdır ve kapsam
 * raporunda bu şekilde belirtilir.
 *
 * Yöntem: HTML listesi (sayfalama göstergesi varsa izlenir) + duyuru detayı.
 * PDF/Word bağlantıları ek olarak kaydedilir; bu adaptör ek dosya içeriğini
 * indirmez veya OCR/PDF metin çıkarımı yapmaz.
 */
import { elementText, loadHtml, readableAnnouncementText } from '../../lib/html';
import { cleanTitle, ownCardText, parseListingDate, prioritizeByListingTitle } from '../listing-utils';
import { isOfficialApplicationUrl, normalizeUrl } from '../../domain/urls';
import { detectNextPage } from '../pagination';
import { assertSafeUrl, describeFetchFailure, FetchError } from '../fetcher';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

const SLUG_PATTERN = /^\/[a-z0-9][a-z0-9-]{8,}$/i;
const MAX_ITEMS = 25;
const MAX_LIST_PAGES = 10;

interface Candidate {
  itemId: string;
  url: string;
  title: string;
  publishedAt: string | null;
}

function parseCandidates(html: string, baseUrl: string, allowedHosts: readonly string[]): Candidate[] {
  const $ = loadHtml(html);
  const candidates = new Map<string, Candidate>();
  $('a[href]').each((_index, element) => {
    const node = $(element);
    const url = normalizeUrl(node.attr('href') ?? '', baseUrl);
    if (!url) return;
    let path: string;
    try {
      const safeUrl = assertSafeUrl(url, allowedHosts);
      path = safeUrl.pathname;
    } catch {
      return;
    }
    if (!SLUG_PATTERN.test(path)) return;
    const itemId = path.replace(/^\//, '').replace(/\/$/, '');
    const title = cleanTitle(elementText(node, 300));
    if (title.length < 15 || candidates.has(itemId)) return;
    // Paylaşılmış satırda komşu duyurunun tarihi atanmasın (yalnız kendi metni).
    const rowText =
      ownCardText(
        node,
        'li, tr, article, div',
        (value) => {
          try {
            const path = new URL(value, baseUrl).pathname;
            return SLUG_PATTERN.test(path) ? path : null;
          } catch {
            return null;
          }
        },
        600,
      ) ?? elementText(node, 300);
    const publishedAt = parseListingDate(/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}/.exec(rowText)?.[0] ?? null);
    candidates.set(itemId, { itemId, url: assertSafeUrl(url, allowedHosts).toString(), title, publishedAt });
  });
  return [...candidates.values()];
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
        coverage: {
          status: 'unknown',
          note: '304 yanıtı içeriğin değişmediğini gösterir; bu çalışmada sayfalar yeniden gezilmedi.',
        },
        etag: listing.etag,
        lastModified: listing.lastModified,
        notModified: true,
        httpStatuses,
      };
    }

    const firstHtml = listing.decoded?.text ?? listing.body.toString('utf8');
    const candidatesById = new Map<string, Candidate>();
    const visitedPages = new Set<string>();
    let currentUrl = source.listingUrl;
    let currentHtml = firstHtml;
    let sawPagination = false;
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = 'ÖSYM liste kapsamı bu çalışmada doğrulanamadı.';

    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const normalizedPageUrl = normalizeUrl(currentUrl) ?? currentUrl;
      if (visitedPages.has(normalizedPageUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Sayfalama daha önce gezilen URL’ye döndü; tekrar döngüsü engellendi.';
        break;
      }
      visitedPages.add(normalizedPageUrl);

      const pageCandidates = parseCandidates(currentHtml, currentUrl, source.allowedHosts);
      notes.push(`Sayfa ${page}: ${pageCandidates.length} duyuru bağlantısı.`);
      const repeated = pageCandidates.some((candidate) => candidatesById.has(candidate.itemId));
      for (const candidate of pageCandidates) {
        if (!candidatesById.has(candidate.itemId)) candidatesById.set(candidate.itemId, candidate);
      }
      if (repeated) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page} önceki ilan kimliklerini tekrarladı; sayfa parametresinin etkisi doğrulanamadı.`;
        break;
      }

      const navigation = detectNextPage(currentHtml, currentUrl);
      sawPagination ||= navigation.detected;
      if (!navigation.nextUrl) {
        coverageStatus = navigation.endConfirmed ? 'complete' : 'unknown';
        coverageNote = navigation.endConfirmed
          ? `${visitedPages.size} sayfa gezildi ve kaynak sayfalama denetimi son sayfayı doğruladı.`
          : sawPagination
            ? `${visitedPages.size} sayfa gezildi ancak son sayfa işareti doğrulanamadı; kapsam bilinmiyor.`
            : 'Duyuru sayfasında doğrulanabilir sonraki/son sayfa işareti bulunmadı; kapsam bilinmiyor.';
        break;
      }
      if (page >= MAX_LIST_PAGES) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_LIST_PAGES} sayfalık üst sınıra ulaşıldı; sonraki sayfa taranmadı.`;
        break;
      }

      const normalizedNextUrl = normalizeUrl(navigation.nextUrl, currentUrl) ?? navigation.nextUrl;
      let nextUrl: string;
      try {
        nextUrl = assertSafeUrl(normalizedNextUrl, source.allowedHosts).toString();
      } catch {
        coverageStatus = 'unknown';
        coverageNote =
          'Sonraki sayfa bağlantısı kaynak host allowlistesi dışına çıktığı için izlenmedi; kapsam bilinmiyor.';
        break;
      }
      if (visitedPages.has(nextUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Kaynağın sonraki sayfa bağlantısı daha önce gezilen URL’ye döndü.';
        break;
      }
      try {
        const nextPage = await http.fetchText(nextUrl, {
          allowedHosts: source.allowedHosts,
          minIntervalMs: source.minRequestIntervalMs,
        });
        requestCount += 1;
        httpStatuses.push(nextPage.status);
        if (nextPage.notModified) {
          coverageStatus = 'unknown';
          coverageNote = 'Sonraki sayfa için 304 alındı; o sayfanın duyuruları bu çalışmada doğrulanamadı.';
          break;
        }
        currentUrl = nextUrl;
        currentHtml = nextPage.decoded?.text ?? nextPage.body.toString('utf8');
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        coverageStatus = 'partial';
        coverageNote = `Sonraki sayfa alınamadı (${error instanceof Error ? error.message : String(error)}); önceki sayfalar işlendi.`;
        notes.push(coverageNote);
        break;
      }
    }

    const discovered = [...candidatesById.values()];
    const known = new Set<string>(ctx.knownItemIds ?? []);
    const knownWithDetail = new Set<string>(ctx.knownItemIdsWithDetail ?? []);
    const fresh = prioritizeByListingTitle(
      discovered.filter((candidate) => !known.has(candidate.itemId)),
      (candidate) => candidate.title,
    );
    const pendingDetail = discovered.filter(
      (candidate) => known.has(candidate.itemId) && !knownWithDetail.has(candidate.itemId),
    );
    const selected = [...fresh, ...pendingDetail].slice(0, Math.min(MAX_ITEMS, ctx.maxDetailFetches));
    const items: RawAnnouncement[] = [];
    let failedDetailFetches = 0;
    let detailsWithoutUsableText = 0;

    for (const candidate of selected) {
      const detail = await this.readDetail(ctx, candidate.url);
      requestCount += detail.requests;
      httpStatuses.push(...detail.statuses);
      if (detail.failure) {
        failedDetailFetches += 1;
        notes.push(`Detay isteği başarısız (${candidate.url}): ${detail.failure}`);
      } else if (!detail.bodyText) {
        detailsWithoutUsableText += 1;
        notes.push(`Detay sayfası kullanılabilir duyuru metni vermedi (${candidate.url}).`);
      }

      items.push({
        sourceKey: source.key,
        sourceItemId: candidate.itemId,
        url: candidate.url,
        title: candidate.title,
        institution: 'ÖSYM',
        ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
        sourceCategory: 'sınav duyurusu',
        ...(detail.bodyText ? { bodyText: detail.bodyText, bodyTextSource: 'detail' as const } : {}),
        ...(detail.bodyTextTruncated ? { bodyTextTruncated: true } : {}),
        ...(detail.bodyText ? { rawExcerpt: detail.bodyText.slice(0, 400) } : {}),
        attachments: detail.attachments,
        ...(detail.applicationUrl ? { applicationUrl: detail.applicationUrl } : {}),
        extractionConfidence: 0.55,
      });
    }

    const deferred = Math.max(0, fresh.length + pendingDetail.length - selected.length);
    notes.push(
      `Duyuru listesinden ${items.length} kayıt işlendi (${discovered.length} benzersiz duyuru bulundu).`,
    );
    if (items.length === 0) notes.push('Yeni duyuru yok ve detay metni eksik kayıt kalmadı.');
    if (deferred > 0)
      notes.push(`${deferred} duyuru sonraki taramalara bırakıldı (detay bütçesi ${ctx.maxDetailFetches}).`);

    const detailCoverageNotes: string[] = [];
    if (failedDetailFetches > 0)
      detailCoverageNotes.push(`${failedDetailFetches} detay isteği başarısız oldu.`);
    if (detailsWithoutUsableText > 0)
      detailCoverageNotes.push(
        `${detailsWithoutUsableText} detay sayfasından kullanılabilir duyuru metni çıkarılamadı.`,
      );
    if (deferred > 0)
      detailCoverageNotes.push(`${deferred} duyuru detay bütçesi nedeniyle sonraki taramaya ertelendi.`);
    const finalCoverageStatus = detailCoverageNotes.length > 0 ? 'partial' : coverageStatus;
    const finalCoverageNote = [
      `Sayfa kapsamı: ${coverageStatus === 'complete' ? 'tam' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`,
      ...detailCoverageNotes,
    ].join(' ');
    notes.push(
      `Toplam kapsam: ${finalCoverageStatus === 'complete' ? 'tam' : finalCoverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${finalCoverageNote}`,
    );

    return {
      items,
      requestCount,
      notes,
      etag: listing.etag,
      lastModified: listing.lastModified,
      notModified: false,
      coverage: { status: finalCoverageStatus, note: finalCoverageNote },
      httpStatuses,
    };
  }

  private async readDetail(
    ctx: AdapterContext,
    url: string,
  ): Promise<{
    bodyText: string | null;
    bodyTextTruncated: boolean;
    attachments: RawAnnouncement['attachments'];
    applicationUrl: string | null;
    requests: number;
    statuses: number[];
    failure: string | null;
  }> {
    try {
      const response = await ctx.http.fetchText(url, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
        maxBytes: 2_500_000,
      });
      const html = response.decoded?.text ?? response.body.toString('utf8');
      const $ = loadHtml(html);
      const text = readableAnnouncementText(
        $,
        ['article', 'main', '.icerik', '.content', '#content', 'body'],
        100_001,
      );
      const truncated = text.length > 100_000;
      const capturedText = text.slice(0, 100_000);
      const links = $('a[href]')
        .toArray()
        .map((element) => ({
          text: elementText($(element), 200),
          url: normalizeUrl($(element).attr('href') ?? '', url),
        }))
        .filter((link): link is { text: string; url: string } => link.url !== null);

      const attachments = links
        .filter((link) => /\.(pdf|docx?)(\?|$)/i.test(link.url))
        .slice(0, 5)
        .map((link) => ({
          url: link.url,
          label: link.text.slice(0, 160) || 'Duyuru belgesi',
          kind: (/\.pdf(\?|$)/i.test(link.url) ? 'pdf' : 'doc') as 'pdf' | 'doc',
        }));
      const application = links.find((link) => isOfficialApplicationUrl(link.url));

      return {
        bodyText: capturedText.length > 80 ? capturedText : null,
        bodyTextTruncated: truncated,
        attachments,
        applicationUrl: application?.url ?? null,
        requests: 1,
        statuses: [response.status],
        failure: null,
      };
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      return {
        bodyText: null,
        bodyTextTruncated: false,
        attachments: [],
        applicationUrl: null,
        requests: 1,
        statuses: error instanceof FetchError && error.status !== null ? [error.status] : [],
        failure: describeFetchFailure(error),
      };
    }
  }
}
