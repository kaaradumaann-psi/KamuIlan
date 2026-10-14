/**
 * ilan.gov.tr (Basın İlan Kurumu) — Kamu/Akademik Personel kategorisi.
 *
 * Canlı doğrulama (2026-10-12): `?ats=5` filtresi "Personel Alımı" ilanlarını
 * verir; liste sayfalanır (`currentPage=N`); her ilanda kurum, resmî ilan
 * numarası (YOK/DPB/ILN…), şehir ve detay bağlantısı bulunur.
 *
 * Yöntem: HTML listesi + detay sayfası (detay isteği sayısı bütçeyle sınırlıdır).
 */
import { makeExcerpt, normalizeTr } from '../../domain/text';
import {
  blockElementText,
  elementText,
  loadHtml,
  readableAnnouncementText,
  readableText,
} from '../../lib/html';
import { cleanTitle, extractReferenceNumbers, parseListingDate } from '../listing-utils';
import { PROVINCES } from '../../domain';
import { isOfficialApplicationUrl, normalizeUrl } from '../../domain/urls';
import { assertSafeUrl, describeFetchFailure, FetchError, type FetchResponse } from '../fetcher';
import { describeBrowserFailure, renderPageHtml } from '../browser-session';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

const MAX_PAGES = 20;
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
  constructor(private readonly renderListing?: (url: string, signal?: AbortSignal) => Promise<string>) {}

  readonly key = 'ilan-gov-tr';
  readonly label = 'ilan.gov.tr — personel alımı';
  readonly method = 'html-list';
  readonly notes =
    'Basın İlan Kurumu portalı. Liste önce düz HTTP ile okunur; liste JS ile dolduğu için boş gelirse (canlıda görüldü) sayfalar tarayıcıyla izlenir. Her ilanın detay sayfasından metin ve ek belgeler alınır.';

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
    let browserMode = false;
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = 'Sayfa kapsamı doğrulanamadı.';
    const pageItemIds = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(source.listingUrl);
      if (page > 1) url.searchParams.set('currentPage', String(page));

      let pageRows: Row[];
      let emptyPageConfirmed = false;
      if (browserMode) {
        const rendered = await this.renderRows(url.toString(), notes, source.allowedHosts, ctx.signal);
        requestCount += 1;
        if (rendered === null) {
          coverageStatus = 'partial';
          coverageNote = `Tarayıcıyla sayfa ${page} okunamadı; kalan sayfalar doğrulanmadı.`;
          break;
        }
        pageRows = rendered;
      } else {
        let response: FetchResponse;
        requestCount += 1;
        try {
          response = await http.fetchText(url.toString(), {
            allowedHosts: source.allowedHosts,
            minIntervalMs: source.minRequestIntervalMs,
          });
        } catch (error) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
          if (page === 1) throw error;
          coverageStatus = 'partial';
          coverageNote = `Sayfa ${page} alınamadı (${describeFetchFailure(error)}); önceki sayfalar işlendi.`;
          notes.push(coverageNote);
          break;
        }
        httpStatuses.push(response.status);
        if (page === 1 && response.notModified) {
          notModified = true;
          coverageStatus = 'unknown';
          coverageNote = 'Liste 304 döndürdü; bu çalışmada sayfalar tek tek gezilmedi.';
          notes.push('Liste içeriği değişmedi (ETag/Last-Modified) — ayrıntı isteği yapılmadı.');
          break;
        }
        const html = response.decoded?.text ?? response.body.toString('utf8');
        pageRows = parseListing(html, url.toString(), source.allowedHosts);
        emptyPageConfirmed = pageRows.length === 0 && isClearlyEmptyListingPage(html);
        if (page === 1 && pageRows.length === 0 && !emptyPageConfirmed) {
          // Liste JS ile doluyor olabilir (düz HTTP kabuk döndürür): tarayıcı yedeği.
          requestCount += 1;
          const recovered = await this.recoverWithBrowser(
            url.toString(),
            notes,
            source.allowedHosts,
            ctx.signal,
          );
          if (recovered.length > 0) {
            pageRows = recovered;
            browserMode = true;
          } else {
            const excerpt = readableText(loadHtml(html), 'body', 200);
            notes.push(`Sayfa özeti: "${makeExcerpt(excerpt, 200)}"`);
            coverageStatus = 'unknown';
            coverageNote =
              'İlk liste sayfasında ilan satırı okunamadı; kaynak yapısı veya sayfalama bilinmiyor.';
            break;
          }
        }
      }

      notes.push(`Sayfa ${page}: ${pageRows.length} ilan satırı${browserMode ? ' (tarayıcı)' : ''}.`);
      if (pageRows.length === 0) {
        coverageStatus = emptyPageConfirmed ? 'complete' : 'unknown';
        coverageNote = emptyPageConfirmed
          ? page === 1
            ? 'İlk sayfanın ilan listesi açıkça boş durumunu bildirdi.'
            : `${page - 1} dolu sayfa gezildi; sonraki sayfanın ilan listesi açıkça boş durumunu bildirdi.`
          : 'Sayfa satır döndürmedi ancak boş liste durumu doğrulanamadı; kapsam bilinmiyor.';
        break;
      }

      const duplicatePage = pageRows.some((row) => pageItemIds.has(row.itemId));
      if (duplicatePage) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page} önceki sayfalardaki ilan kimliklerini tekrarladı; sayfa parametresinin etkisi doğrulanamadı.`;
        notes.push(coverageNote);
        break;
      }
      for (const row of pageRows) pageItemIds.add(row.itemId);
      rows.push(...pageRows);

      if (page === MAX_PAGES) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_PAGES} sayfalık üst sınıra ulaşıldı; daha ileri sayfalar bu çalışmada taranmadı.`;
      }
    }

    const uniqueRows = [...new Map(rows.map((row) => [row.itemId, row])).values()];
    const known = new Set<string>(ctx.knownItemIds ?? []);
    const knownWithDetail = new Set<string>(ctx.knownItemIdsWithDetail ?? []);
    const internalDetailRows = uniqueRows.filter((row) => /IlanDetay\?i=/i.test(row.url));
    const freshDetailRows = internalDetailRows.filter((row) => !known.has(row.itemId));
    const pendingDetailRows = internalDetailRows.filter(
      (row) => known.has(row.itemId) && !knownWithDetail.has(row.itemId),
    );
    const detailRows = [...freshDetailRows, ...pendingDetailRows].slice(
      0,
      Math.min(ctx.maxDetailFetches, MAX_ITEMS),
    );
    const externalFreshRows = uniqueRows.filter(
      (row) => !/IlanDetay\?i=/i.test(row.url) && !known.has(row.itemId),
    );
    const selectedExternalRows = externalFreshRows.slice(0, Math.max(0, MAX_ITEMS - detailRows.length));
    const selectedRows = [...detailRows, ...selectedExternalRows];
    const items: RawAnnouncement[] = [];
    let failedDetailFetches = 0;
    let detailsWithoutUsableText = 0;

    for (const row of selectedRows) {
      const hasInternalDetail = /IlanDetay\?i=/i.test(row.url);
      const detail = hasInternalDetail ? await this.readDetail(ctx, row) : null;
      if (detail) {
        requestCount += detail.requests;
        httpStatuses.push(...detail.statuses);
        if (detail.failure) {
          failedDetailFetches += 1;
          notes.push(`Detay isteği başarısız (${row.url}): ${detail.failure}`);
        } else if (!detail.bodyText) {
          detailsWithoutUsableText += 1;
          notes.push(`Detay sayfası kullanılabilir ilan metni vermedi (${row.url}).`);
        }
      }
      items.push({
        sourceKey: source.key,
        sourceItemId: row.itemId,
        url: row.url,
        title: row.title,
        institution: row.institution ?? source.institution,
        ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
        sourceCategory: 'personel alımı',
        ...(detail?.bodyText ? { bodyText: detail.bodyText, bodyTextSource: 'detail' as const } : {}),
        ...(detail?.bodyTextTruncated ? { bodyTextTruncated: true } : {}),
        ...(detail?.bodyText ? { rawExcerpt: detail.bodyText.slice(0, 400) } : {}),
        attachments: detail?.attachments ?? [],
        ...(detail?.applicationUrl ? { applicationUrl: detail.applicationUrl } : {}),
        ...(row.refNo ? { referenceNo: row.refNo } : {}),
        ...(row.city ? { city: row.city } : {}),
        extractionConfidence: detail?.bodyText ? 0.8 : 0.45,
      });
    }

    if (selectedRows.length === 0 && uniqueRows.length > 0) {
      notes.push(
        'Yeni ilan yok; yeni kayıt veya daha önce eksik kalan detay metni bulunamadı — idempotent tarama.',
      );
    }
    const deferredDetails = Math.max(
      0,
      freshDetailRows.length + pendingDetailRows.length - detailRows.length,
    );
    const deferredExternalRows = Math.max(0, externalFreshRows.length - selectedExternalRows.length);
    notes.push(`Listede ${uniqueRows.length} benzersiz ilan, bu çalışmada ${items.length} kayıt işlendi.`);
    if (deferredDetails > 0)
      notes.push(
        `${deferredDetails} ilan detayı sonraki taramalara bırakıldı (detay bütçesi ${ctx.maxDetailFetches}).`,
      );
    if (deferredExternalRows > 0)
      notes.push(
        `${deferredExternalRows} dış bağlantılı ilan çıktı sınırı nedeniyle sonraki taramaya bırakıldı (kayıt sınırı ${MAX_ITEMS}).`,
      );

    const detailCoverageNotes: string[] = [];
    if (failedDetailFetches > 0) detailCoverageNotes.push(`${failedDetailFetches} detay isteği başarısız oldu.`);
    if (detailsWithoutUsableText > 0)
      detailCoverageNotes.push(`${detailsWithoutUsableText} detay sayfasından kullanılabilir ilan metni çıkarılamadı.`);
    if (deferredDetails > 0)
      detailCoverageNotes.push(`${deferredDetails} iç ilan detayı bütçe nedeniyle sonraki taramaya ertelendi.`);
    if (deferredExternalRows > 0)
      detailCoverageNotes.push(`${deferredExternalRows} dış bağlantılı ilan kayıt sınırı nedeniyle sonraki taramaya ertelendi.`);

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
      etag: null,
      lastModified: null,
      notModified,
      coverage: { status: finalCoverageStatus, note: finalCoverageNote },
      httpStatuses,
    };
  }

  /** Sayfayı tarayıcıyla açıp satırları ayrıştırır; hata olursa not düşüp null döner. */
  private async renderRows(
    url: string,
    notes: string[],
    allowedHosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Row[] | null> {
    try {
      const safeUrl = assertSafeUrl(url, allowedHosts).toString();
      const render =
        this.renderListing ??
        ((target: string, abortSignal?: AbortSignal) =>
          renderPageHtml(target, { allowedHosts, signal: abortSignal }));
      return parseListing(await render(safeUrl, signal), safeUrl, allowedHosts);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      notes.push(`Tarayıcı sayfası açılamadı: ${describeBrowserFailure(error)}`);
      return null;
    }
  }

  /** Düz HTTP listesi boşsa sayfayı tarayıcıyla açıp aynı ayrıştırıcıyı koşar. */
  private async recoverWithBrowser(
    url: string,
    notes: string[],
    allowedHosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Row[]> {
    const rows = await this.renderRows(url, notes, allowedHosts, signal);
    const recovered = rows ?? [];
    notes.push(`Liste HTTP ile boş geldi; tarayıcı ile ${recovered.length} ilan satırı bulundu.`);
    return recovered;
  }

  private async readDetail(
    ctx: AdapterContext,
    row: Row,
  ): Promise<{
    bodyText: string | null;
    bodyTextTruncated: boolean;
    attachments: RawAnnouncement['attachments'];
    applicationUrl: string | null;
    requests: number;
    statuses: number[];
    failure: string | null;
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
      const body = readableAnnouncementText(
        $,
        ['article', '.ad-detail', '.ilan-detay', 'main', '.icerik', '.content', '#content', 'body'],
        100_001,
      );
      const truncated = body.length > 100_000;
      const capturedText = body.slice(0, 100_000);
      const links = $('a[href]')
        .toArray()
        .map((element) => ({
          href: $(element).attr('href') ?? '',
          text: elementText($(element), 200),
          url: normalizeUrl($(element).attr('href') ?? '', row.url),
        }))
        .filter((link): link is { href: string; text: string; url: string } => link.url !== null);

      const attachments = links
        .filter((link) => /\.(pdf|docx?|xlsx?)(\?|$)/i.test(link.url))
        .slice(0, 6)
        .map((link) => ({
          url: link.url,
          label: link.text.slice(0, 160) || 'İlan belgesi',
          kind: (/\.pdf(\?|$)/i.test(link.url)
            ? 'pdf'
            : /\.docx?(\?|$)/i.test(link.url)
              ? 'doc'
              : 'excel') as 'pdf' | 'doc' | 'excel',
        }));

      const applicationCandidates = links.filter((link) => isOfficialApplicationUrl(link.url));
      const application =
        applicationCandidates.find((link) => /ba[sş]vuru/i.test(link.text)) ?? applicationCandidates[0];

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
      // Detay alınamazsa liste bilgisiyle devam edilir; eksik alanlar "belirtilmemiş" kalır.
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

function isClearlyEmptyListingPage(html: string): boolean {
  const $ = loadHtml(html);
  const text = normalizeTr($.root().text());
  const hasItemLink = $('a[href]')
    .toArray()
    .some((element) => ITEM_ID_PATTERN.test($(element).attr('href') ?? ''));
  const hasExplicitEmptyMessage =
    /ilan bulunmamakt|aktif ilan yok|kayit bulunamadi|sonuc bulunamadi|sonuc yok/.test(text);
  // A rendered list container can also be empty because markup or JS parsing
  // failed. Require explicit no-results text before declaring a page exhausted.
  return !hasItemLink && hasExplicitEmptyMessage;
}

/** Liste sayfasından ilan satırlarını çıkarır (yapı değişirse boş liste döner → hata kaydı). */
function parseListing(html: string, baseUrl: string, allowedHosts: readonly string[]): Row[] {
  const $ = loadHtml(html);
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const element of $('a[href]').toArray()) {
    const href = $(element).attr('href') ?? '';
    const match = ITEM_ID_PATTERN.exec(href);
    if (!match?.[1]) continue;
    const itemId = match[1];
    if (seen.has(itemId)) continue;
    const normalizedUrl = normalizeUrl(href, baseUrl);
    if (!normalizedUrl) continue;
    let url: string;
    try {
      url = assertSafeUrl(normalizedUrl, allowedHosts).toString();
    } catch {
      continue;
    }

    // Blok sınırları korunarak okunur: kurum / il / tarih kartın ayrı
    // bloklarında durur ve ancak satır satır ayrıştırılabilir.
    const anchorText = blockElementText($(element), 400);
    const containerText =
      blockElementText($(element).closest('article, li, .card, .ad-list-item, div'), 900) || anchorText;
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

    // Kurum satırı: kurum kalıbına uyan ve BAŞLIK OLMAYAN ilk satır. Başlıkta
    // kurum adı geçtiği için (ör. "… Bakanlığı 25 … alımı") eşitlik denetimi
    // yapılmazsa kurum alanı başlığın kendisiyle dolar.
    const institutionLine = titleCandidates.find(
      (line) =>
        line !== title &&
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
