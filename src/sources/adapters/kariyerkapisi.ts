/**
 * Kariyer Kapısı (kariyerkapisi.gov.tr/isealim).
 *
 * Doğrulanmış yapı (13.10.2026; liste + detay sayfalarının gerçek DOM'u
 * kullanıcıdan alındı):
 *   Liste: #pnlIlanlar içinde satır satır: kurum logosu | kurum/birim |
 *   ilan başlığı | bitiş tarihi | "Başvur" (/IlanDetay?i=<uuid>) ya da
 *   "İlana Git" (kurumun kendi dış başvuru adresi) düğmesi. Sayfa
 *   sunucu tarafında üretilir; önce düz HTTP denenir, liste boş
 *   gelirse tarayıcı yedeğine düşülür.
 *   Detay: /IlanDetay?i=<uuid> — #lbl_ILN_NO (ILN...), #lbl_IlanTuru,
 *   #lbl_BasDate / #lbl_BitDate, #lbl_anailanmetni (tam metin),
 *   #href_BasvuruLinki (e-Devlet başvuru adresi), kontenjan bilgisi.
 */
import { collapseWhitespace, makeExcerpt, normalizeTr } from '../../domain/text';
import { firstDateOnlyIn, toIstanbulIso } from '../../domain/dates';
import { sha256Hex } from '../../domain/ids';
import { absoluteUrl, anchors, blockElementText, loadHtml, readableAnnouncementText } from '../../lib/html';
import { cleanInstitution, cleanTitle } from '../listing-utils';
import { AdapterUnavailableError } from '../errors';
import { assertSafeUrl, FetchError, isTransientTransportFailure } from '../fetcher';
import { describeBrowserFailure, withChromiumPage } from '../browser-session';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';
import { detectNextPage } from '../pagination';

export interface KariyerRow {
  sourceItemId: string;
  url: string;
  title: string;
  institution?: string;
  applicationEndAt?: string;
  /** Dış başvuru adresi (satır "İlana Git" diyorsa). */
  applicationUrl?: string;
}

export interface KariyerDetail {
  bodyText?: string;
  bodyTextTruncated?: boolean;
  referenceNo?: string;
  applicationStartAt?: string;
  applicationEndAt?: string;
  applicationUrl?: string;
  category?: string;
  quota?: number;
}

/** İlan detay adresindeki uuid en kararlı kimliktir; yoksa sondaki uzun sayı, o da yoksa null. */
function itemIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    for (const param of ['i', 'id']) {
      const value = parsed.searchParams.get(param);
      if (value && /^[0-9a-f-]{16,}$/i.test(value)) return value;
    }
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1] ?? '';
    return /(\d{6,})$/.exec(last)?.[1] ?? null;
  } catch {
    return null;
  }
}

function detailUrlIn(
  href: string | undefined,
  listingUrl: string,
  allowedHosts: readonly string[],
  $: ReturnType<typeof loadHtml>,
): string | null {
  const candidate = absoluteUrl(href, listingUrl, $);
  if (!candidate) return null;
  const safeUrl = safeOfficialUrl(candidate, allowedHosts);
  if (!safeUrl) return null;
  try {
    const parsed = new URL(safeUrl);
    const id = parsed.searchParams.get('i');
    if (!/\/IlanDetay\/?$/i.test(parsed.pathname) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return `${parsed.origin}/IlanDetay?i=${id}`;
  } catch {
    return null;
  }
}

function safeOfficialUrl(rawUrl: string, allowedHosts: readonly string[]): string | null {
  try {
    return assertSafeUrl(rawUrl, allowedHosts).toString();
  } catch {
    return null;
  }
}

function safePublicExternalUrl(rawUrl: string): string | null {
  try {
    return assertSafeUrl(rawUrl).toString();
  } catch {
    return null;
  }
}

/**
 * HTTP listesi satırsız döndüğünde tanı notuna eklenir: sunucunun bot
 * istemciye gerçek liste yerine ne verdiği (örn. bekleme/engelleme
 * sayfası) bir sonraki koşumda başlığından anlaşılır.
 */
function pageTitleNote(html: string): string {
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim();
  return title ? ` (sayfa başlığı: "${makeExcerpt(title, 120)}")` : '';
}

const KARIYER_MAX_LIST_PAGES = 10;
const MAX_ITEMS = 40;

function findKariyerNextPage(
  html: string,
  currentUrl: string,
): { nextUrl: string | null; detected: boolean; endConfirmed: boolean } {
  const navigation = detectNextPage(html, currentUrl);
  return {
    nextUrl: navigation.nextUrl,
    detected: navigation.detected,
    endConfirmed: navigation.endConfirmed,
  };
}

function isClearlyEmptyKariyerPage(html: string): boolean {
  const $ = loadHtml(html);
  const text = normalizeTr($.root().text());
  // The presence of #pnlIlanlar is not proof of exhaustion: parser drift can
  // leave the container present while hiding or changing its rows.
  return /ilan bulunmamakt|aktif ilan yok|kayit bulunamadi|sonuc bulunamadi|sonuc yok/.test(text);
}

/** Satırdaki eylem bağlantısı mı (Başvur / İlana Git / detay adresi)? */
function isActionAnchor(text: string, href: string): boolean {
  // JS /i bayrağı Türkçe "İ" harfini "i" ile eşleştirmez; metin önce
  // Türkçe küçük harfe çevrilir ("İlana Git" → "ilana git").
  const normalized = text.toLocaleLowerCase('tr');
  return /IlanDetay\?i=/i.test(href) || normalized === 'başvur' || normalized === 'ilana git';
}

/**
 * Liste sayfasındaki ilanları ayrıştırır. Önce gerçek <table> düzeni,
 * yoksa eylem bağlantılarından satır kapsayıcısına tırmanan div düzeni.
 */
export function parseKariyerRows(
  html: string,
  listingUrl: string,
  allowedHosts: readonly string[] = [new URL(listingUrl).hostname],
): KariyerRow[] {
  const $ = loadHtml(html);
  const rows: KariyerRow[] = [];
  const seen = new Set<string>();

  $('table').each((_tableIndex, table) => {
    const headerText = collapseWhitespace($(table).find('tr').first().text()).toLocaleLowerCase('tr');
    const isIlanTable = headerText.includes('aktif ilanlar');
    $(table)
      .find('tr')
      .each((_rowIndex, tr) => {
        const cells = $(tr).find('td');
        if (cells.length < 3) return;
        const texts = cells.map((_cellIndex, td) => collapseWhitespace($(td).text())).get();
        const title = cleanTitle(texts[1] ?? '');
        if (title.length < 15) return;
        const dateOnly = firstDateOnlyIn(texts[2] ?? '') ?? firstDateOnlyIn(texts.join(' '));
        if (!isIlanTable && !dateOnly) return;

        const rowAnchors = $(tr).find('a[href]').toArray();
        const rawHrefs = rowAnchors.map((element) => $(element).attr('href') ?? '');
        const detailCandidates = rawHrefs.filter((href) => /IlanDetay\?i=/i.test(href));
        let url =
          rowAnchors
            .map((element) => detailUrlIn($(element).attr('href'), listingUrl, allowedHosts, $))
            .find((candidate): candidate is string => candidate !== null) ?? null;
        if (detailCandidates.length > 0 && !url) return;
        let applicationUrl: string | undefined;
        if (url) url = safeOfficialUrl(url, allowedHosts);
        if (!url) {
          const anchor = $(tr).find('a[href]').first();
          const href = anchor.attr('href');
          if (href) {
            const candidate = absoluteUrl(href, listingUrl, $);
            const official = candidate ? safeOfficialUrl(candidate, allowedHosts) : null;
            if (official) {
              url = official;
            } else if (
              !/IlanDetay\?i=/i.test(href) &&
              /başvur|basvur|ilana git/i.test(collapseWhitespace(anchor.text()))
            ) {
              applicationUrl = candidate ? (safePublicExternalUrl(candidate) ?? undefined) : undefined;
              url = listingUrl;
            }
          }
        }
        url ??= listingUrl;

        const institution = cleanInstitution(texts[0] ?? '') ?? undefined;
        const identityUrl = applicationUrl ?? url;
        const sourceItemId =
          itemIdFromUrl(identityUrl) ??
          `kk-${sha256Hex(`${institution ?? ''}|${title}|${dateOnly ?? ''}`).slice(0, 16)}`;
        if (seen.has(sourceItemId)) return;
        seen.add(sourceItemId);

        rows.push({
          sourceItemId,
          url,
          title,
          ...(institution ? { institution } : {}),
          ...(dateOnly ? { applicationEndAt: toIstanbulIso(dateOnly, '23:59') } : {}),
          ...(applicationUrl ? { applicationUrl } : {}),
        });
      });
  });

  if (rows.length === 0) return rowsFromActionAnchors($, listingUrl, allowedHosts);
  return rows;
}

/**
 * Div ızgara düzeni (gerçek sayfadaki yapı): her eylem bağlantısından
 * (Başvur / İlana Git) satır kapsayıcısına tırmanılır; kurum/başlık/bitiş
 * tarihi kapsayıcının metin hücrelerinden okunur. Dış adrese giden
 * satırlar da ilandır (başvuru adresi dış bağlantıdır).
 */
function rowsFromActionAnchors(
  $: ReturnType<typeof loadHtml>,
  listingUrl: string,
  allowedHosts: readonly string[],
): KariyerRow[] {
  const rows: KariyerRow[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_index, element) => {
    const anchorText = collapseWhitespace($(element).text());
    const rawHref = $(element).attr('href') ?? '';
    if (!isActionAnchor(anchorText, rawHref)) return;
    const candidateUrl = absoluteUrl(rawHref, listingUrl, $);
    if (!candidateUrl) return;
    const isDetailCandidate = /IlanDetay\?i=/i.test(rawHref);
    const officialUrl = safeOfficialUrl(candidateUrl, allowedHosts);
    if (isDetailCandidate && !officialUrl) return;
    const applicationUrl = officialUrl ? undefined : (safePublicExternalUrl(candidateUrl) ?? undefined);
    if (!officialUrl && !applicationUrl) return;
    const url = officialUrl ?? listingUrl;

    // Satır kapsayıcısı: tek eylem bağlantısı içeren ve tarih barındıran en küçük üst öğe.
    let container = $(element);
    for (let depth = 0; depth < 7; depth += 1) {
      const parent = container.parent();
      if (parent.length === 0) break;
      const actionCount = parent
        .find('a[href]')
        .toArray()
        .filter((candidate) =>
          isActionAnchor(collapseWhitespace($(candidate).text()), $(candidate).attr('href') ?? ''),
        ).length;
      if (actionCount !== 1) break;
      container = parent;
      const text = collapseWhitespace(container.text());
      if (text.length >= 60 && firstDateOnlyIn(text)) break;
    }

    const fullText = collapseWhitespace(container.text());
    const dateOnly = firstDateOnlyIn(fullText);
    if (!dateOnly) return;

    const cells = container
      .children()
      .map((_cellIndex, cell) => collapseWhitespace($(cell).text()))
      .get()
      .filter((text) => text.length > 0);
    let title = cells.length >= 3 ? cleanTitle(cells[1] ?? '') : '';
    let institutionText = cells.length >= 3 ? (cells[0] ?? '') : '';

    if (title.length < 15) {
      const pool = new Set<string>();
      container.find('*').each((_childIndex, child) => {
        const text = collapseWhitespace($(child).text());
        if (text) pool.add(text);
      });
      const candidates = [...pool].filter(
        (text) => text.length >= 15 && text !== fullText && !isActionAnchor(text, ''),
      );
      title = cleanTitle(candidates.sort((a, b) => b.length - a.length)[0] ?? '');
      institutionText ||=
        candidates.find(
          (text) =>
            text !== title && /(Bakanlı|Başkanlı|Üniversite|Müdürlüğü|Belediye|Kurumu|Ajansı)/i.test(text),
        ) ?? '';
    }
    if (title.length < 15) return;

    const isDetailLink = /IlanDetay\?i=/i.test(rawHref) && officialUrl !== null;
    const institution = cleanInstitution(institutionText) ?? undefined;
    const sourceItemId =
      itemIdFromUrl(applicationUrl ?? url) ??
      `kk-${sha256Hex(`${institution ?? ''}|${title}|${dateOnly}`).slice(0, 16)}`;
    if (seen.has(sourceItemId)) return;
    seen.add(sourceItemId);

    rows.push({
      sourceItemId,
      url,
      title,
      ...(institution ? { institution } : {}),
      applicationEndAt: toIstanbulIso(dateOnly, '23:59'),
      ...(!isDetailLink ? { applicationUrl: applicationUrl ?? url } : {}),
    });
  });

  return rows;
}

/** Detay sayfasından ilan numarası, tarihler, tür, kontenjan ve gövde metnini çıkarır. */
export function parseKariyerDetail(html: string, detailUrl = 'https://kariyerkapisi.gov.tr/'): KariyerDetail {
  const $ = loadHtml(html);
  const detail: KariyerDetail = {};
  const byId = (id: string): string => collapseWhitespace($(`#${id}`).first().text());

  // Önce kararlı öğe kimlikleri (gerçek sayfada doğrulandı).
  const referenceNo = byId('lbl_ILN_NO');
  if (/\bILN\d{5,}\b/.test(referenceNo)) detail.referenceNo = referenceNo.match(/\bILN\d{5,}\b/)?.[0];

  const startDate = firstDateOnlyIn(byId('lbl_BasDate'));
  if (startDate) detail.applicationStartAt = toIstanbulIso(startDate, '00:00');
  const endDate = firstDateOnlyIn(byId('lbl_BitDate'));
  if (endDate) detail.applicationEndAt = toIstanbulIso(endDate, '23:59');

  const category = byId('lbl_IlanTuru');
  if (category.length >= 3) detail.category = category;

  const applyHref =
    $('#href_BasvuruLinki').first().attr('href') ?? $('a[href*="turkiye.gov.tr"]').first().attr('href');
  if (applyHref) {
    const candidate = absoluteUrl(applyHref, detailUrl, $);
    if (candidate) detail.applicationUrl = safePublicExternalUrl(candidate) ?? undefined;
  }

  const mainNode = $('#lbl_anailanmetni').first();
  const mainText = mainNode.length > 0 ? blockElementText(mainNode, 100_001) : '';
  if (mainText.length > 200) {
    detail.bodyTextTruncated = mainText.length > 100_000;
    detail.bodyText = mainText.slice(0, 100_000);
  }

  const quotaMatch = /Kontenjan\s*\((\d+)\)/.exec(collapseWhitespace($('#div_AltIlan').first().text()));
  if (quotaMatch?.[1]) detail.quota = Number.parseInt(quotaMatch[1], 10);

  // Kimlikler bulunamazsa (yapı değişimi) metin kalıplarına düşülür.
  const text = readableAnnouncementText(
    $,
    ['main', 'article', '#lbl_anailanmetni', '#pnlIlanDetay', 'body'],
    100_001,
  );
  // Metadata may live in portal chrome/aside elements, which the notice-body
  // reader intentionally removes. Keep a separate, bounded raw-text view for
  // explicitly labelled fields so those values are not lost.
  const metadataText = collapseWhitespace($.root().text()).slice(0, 150_000);
  if (!detail.referenceNo) {
    const reference = /\bILN\d{5,}\b/.exec(metadataText);
    if (reference) detail.referenceNo = reference[0];
  }
  if (!detail.applicationStartAt) {
    const start = /Başvuru Başlangıç\s*:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(metadataText);
    const parsed = start ? firstDateOnlyIn(start[1] ?? '') : null;
    if (parsed) detail.applicationStartAt = toIstanbulIso(parsed, '00:00');
  }
  if (!detail.applicationEndAt) {
    const end = /Başvuru Bitiş\s*:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(metadataText);
    const parsed = end ? firstDateOnlyIn(end[1] ?? '') : null;
    if (parsed) detail.applicationEndAt = toIstanbulIso(parsed, '23:59');
  }
  if (!detail.category) {
    const categoryMatch =
      /İlan Türü\s*:?\s*([A-ZÇĞİÖŞÜ][^|]{2,60}?)(?=\s+Başvuru Başlangıç|\s+Kalan Zaman|\s+BAŞVUR\b|$)/.exec(
        metadataText,
      );
    if (categoryMatch) detail.category = collapseWhitespace(categoryMatch[1] ?? '');
  }
  if (!detail.bodyText && text.length > 200) {
    detail.bodyTextTruncated = text.length > 100_000;
    detail.bodyText = text.slice(0, 100_000);
  }

  return detail;
}

export class KariyerKapisiAdapter implements SourceAdapter {
  /** Test dikişi: sayfaları oluşturan işlev (varsayılan: gerçek Chromium). */
  constructor(
    private readonly renderPagesFn?: (urls: string[], signal?: AbortSignal) => Promise<Map<string, string>>,
  ) {}

  readonly key = 'kariyer-kapisi-isealim';
  readonly label = 'Kariyer Kapısı — kamu işe alım ilanları';
  readonly method = 'html-list';
  readonly notes =
    'Liste sunucu tarafında üretilir: önce düz HTTP ile satırlar okunur; liste boş gelirse aynı ayrıştırma ' +
    'başsız tarayıcıyla açılmış sayfada koşulur. Detaylar (/IlanDetay?i=) sınırlı sayıda çekilir: ilan numarası, ' +
    'başvuru tarihleri, tür, kontenjan ve tam metin alınır; başvuru adresi e-Devlet bağlantısıdır. ' +
    'Detay bütçesi önce daha önce görülmemiş ilanlara harcanır.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const { source, liveFetch } = ctx;
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
    let requestCount = 0;
    let failedDetailFetches = 0;
    let detailsWithoutUsableText = 0;
    let rows: KariyerRow[] = [];
    let viaBrowser = false;
    let listHtml = '';

    // 1) Düz HTTP: sayfa sunucu tarafında üretiliyor (doğrulandı).
    try {
      const response = await ctx.http.fetchText(source.listingUrl, {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
      });
      requestCount += 1;
      httpStatuses.push(response.status);
      listHtml = response.decoded?.text ?? response.body.toString('utf8');
      rows = parseKariyerRows(listHtml, source.listingUrl, source.allowedHosts);
      if (rows.length > 0) {
        notes.push(`Liste HTTP ile okundu: ${rows.length} ilan satırı.`);
      } else {
        // 5. canlı koşumda HTTP 200 döndü ama satır ayrıştırılamadı; sunucunun
        // tarayıcı-dışı istemciye ne verdiği bu notla görünür hale gelir.
        notes.push(
          `HTTP listesi ${response.status} ile alındı (${listHtml.length} karakter) ancak satır ayrıştırılamadı${pageTitleNote(listHtml)}; tarayıcı denenecek.`,
        );
      }
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      if (!isTransientTransportFailure(error)) throw error;
      notes.push(
        `HTTP listesi alınamadı (${error instanceof Error ? error.message : String(error)}); geçici aktarım hatası için tarayıcı yedeği denenebilir.`,
      );
    }

    // 2) Tarayıcı yedeği: sayfa boşsa veya HTTP geçici aktarım hatası verdiyse.
    if (rows.length === 0) {
      const pages = await this.renderPages([source.listingUrl], source.allowedHosts, ctx.signal).catch(
        (error: unknown) => {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
          throw new AdapterUnavailableError(
            source.key,
            describeBrowserFailure(error),
            'Başsız tarayıcı (playwright) gerekiyor: npm i -D playwright && npx playwright install chromium',
          );
        },
      );
      listHtml = pages.get(source.listingUrl) ?? '';
      rows = parseKariyerRows(listHtml, source.listingUrl, source.allowedHosts);
      viaBrowser = true;
      requestCount += 1;
      if (rows.length > 0) notes.push(`Liste tarayıcı ile okundu: ${rows.length} ilan satırı.`);
    }
    if (rows.length === 0) {
      notes.push(
        `Liste sayfası alındı (${listHtml.length} karakter) ancak ilan satırı ayrıştırılamadı; sayfa yapısı değişmiş olabilir.`,
      );
      const coverage = {
        status: 'unknown' as const,
        note: 'İlk sayfadan satır okunamadığı için kaynak kapsamı bilinmiyor.',
      };
      return {
        items: [],
        requestCount,
        notes,
        etag: null,
        lastModified: null,
        notModified: false,
        coverage,
        httpStatuses,
      };
    }

    // Follow visible next-page links where the portal exposes them. If it does
    // not, mark the archive extent unknown rather than treating page one as all.
    const rowsById = new Map(rows.map((row) => [row.sourceItemId, row]));
    let currentUrl = source.listingUrl;
    let currentHtml = listHtml;
    let paginationDetected = false;
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = '';
    const visitedPages = new Set<string>([source.listingUrl]);
    for (let page = 1; page <= KARIYER_MAX_LIST_PAGES; page += 1) {
      const pagination = findKariyerNextPage(currentHtml, currentUrl);
      paginationDetected ||= pagination.detected;
      if (!pagination.nextUrl) {
        coverageStatus = pagination.endConfirmed ? 'complete' : 'unknown';
        coverageNote = pagination.endConfirmed
          ? `${page} sayfa gezildi ve kaynak sayfalama denetimi son sayfayı doğruladı.`
          : paginationDetected
            ? `${page} sayfa gezildi ancak son sayfa işareti doğrulanamadı; kapsam bilinmiyor.`
            : 'Sayfada doğrulanabilir sonraki sayfa/arşiv işareti bulunmadı; liste kapsamı bilinmiyor.';
        break;
      }
      if (page >= KARIYER_MAX_LIST_PAGES) {
        coverageStatus = 'partial';
        coverageNote = `${KARIYER_MAX_LIST_PAGES} sayfalık üst sınıra ulaşıldı; sonraki sayfa taranmadı.`;
        break;
      }
      let nextUrl: string;
      try {
        nextUrl = assertSafeUrl(pagination.nextUrl, source.allowedHosts).toString();
      } catch {
        coverageStatus = 'unknown';
        coverageNote =
          'Sonraki sayfa kaynak host allowlistesi dışına çıktığı için izlenmedi; kapsam bilinmiyor.';
        break;
      }
      if (visitedPages.has(nextUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Kaynağın sonraki sayfa bağlantısı daha önce gezilen URL’ye döndü.';
        break;
      }
      visitedPages.add(nextUrl);
      let nextHtml = '';
      try {
        if (viaBrowser) {
          const rendered = await this.renderPages([nextUrl], source.allowedHosts, ctx.signal);
          nextHtml = rendered.get(nextUrl) ?? '';
          requestCount += 1;
        } else {
          const response = await ctx.http.fetchText(nextUrl, {
            allowedHosts: source.allowedHosts,
            minIntervalMs: source.minRequestIntervalMs,
          });
          requestCount += 1;
          httpStatuses.push(response.status);
          if (response.notModified) {
            coverageStatus = 'unknown';
            coverageNote = 'Sonraki sayfa için 304 alındı; içeriği bu çalışmada doğrulanamadı.';
            break;
          }
          nextHtml = response.decoded?.text ?? response.body.toString('utf8');
        }
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        coverageStatus = 'partial';
        coverageNote = `Sonraki sayfa alınamadı (${describeBrowserFailure(error)}); önceki sayfalar işlendi.`;
        notes.push(coverageNote);
        break;
      }
      const nextRows = parseKariyerRows(nextHtml, nextUrl, source.allowedHosts);
      notes.push(`Sayfa ${page + 1}: ${nextRows.length} ilan satırı${viaBrowser ? ' (tarayıcı)' : ''}.`);
      if (nextRows.length === 0) {
        const emptyPageConfirmed = isClearlyEmptyKariyerPage(nextHtml);
        coverageStatus = emptyPageConfirmed ? 'complete' : 'unknown';
        coverageNote = emptyPageConfirmed
          ? `${page} dolu sayfa gezildi; sonraki sayfanın beklenen ilan listesi açıkça boştu.`
          : 'Sonraki sayfa satır döndürmedi ancak boş ilan listesi doğrulanamadı; kapsam bilinmiyor.';
        break;
      }
      const duplicateIds = nextRows.filter((row) => rowsById.has(row.sourceItemId));
      if (duplicateIds.length > 0) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page + 1} önceki ilan kimliklerini tekrarladı; sayfa parametresinin etkisi doğrulanamadı.`;
        break;
      }
      for (const row of nextRows) rowsById.set(row.sourceItemId, row);
      currentUrl = nextUrl;
      currentHtml = nextHtml;
      if (page === KARIYER_MAX_LIST_PAGES - 1) {
        const lastPagination = findKariyerNextPage(currentHtml, currentUrl);
        if (lastPagination.nextUrl) {
          coverageStatus = 'partial';
          coverageNote = `${KARIYER_MAX_LIST_PAGES} sayfalık üst sınıra ulaşıldı; sonraki sayfa taranmadı.`;
        }
      }
    }
    rows = [...rowsById.values()];
    if (!coverageNote) coverageNote = 'Sayfa kapsamı doğrulanamadı.';

    // 3) Only process new records and records whose detail text was not
    // captured earlier. New entries are drained first so a failing detail does
    // not block later pages indefinitely.
    const detailByItemId = new Map<string, KariyerDetail>();
    const detailLinksByItemId = new Map<string, { text: string; url: string }[]>();
    const knownItemIds = new Set<string>(ctx.knownItemIds ?? []);
    const knownItemIdsWithDetail = new Set<string>(ctx.knownItemIdsWithDetail ?? []);
    const internalRows = rows.filter((row) => /IlanDetay\?i=/i.test(row.url));
    const freshDetailRows = internalRows.filter((row) => !knownItemIds.has(row.sourceItemId));
    const pendingDetailRows = internalRows.filter(
      (row) => knownItemIds.has(row.sourceItemId) && !knownItemIdsWithDetail.has(row.sourceItemId),
    );
    const selectedDetailRows = [...freshDetailRows, ...pendingDetailRows].slice(
      0,
      Math.min(ctx.maxDetailFetches, MAX_ITEMS),
    );
    const externalFreshRows = rows.filter(
      (row) => !/IlanDetay\?i=/i.test(row.url) && !knownItemIds.has(row.sourceItemId),
    );
    const selectedExternalRows = externalFreshRows.slice(
      0,
      Math.max(0, MAX_ITEMS - selectedDetailRows.length),
    );
    const selectedRows = [...selectedDetailRows, ...selectedExternalRows];

    for (const candidate of selectedDetailRows) {
      requestCount += 1;
      const fetched = await this.fetchDetailHtml(ctx, candidate.url, viaBrowser).catch((error: unknown) => {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        failedDetailFetches += 1;
        if (error instanceof FetchError && error.status !== null) httpStatuses.push(error.status);
        notes.push(`Detay okunamadı (${candidate.url}): ${describeBrowserFailure(error)}`);
        return null;
      });
      if (!fetched) continue;
      if (fetched.status) httpStatuses.push(fetched.status);
      const detail = parseKariyerDetail(fetched.html, candidate.url);
      if (!detail.bodyText) detailsWithoutUsableText += 1;
      detailByItemId.set(candidate.sourceItemId, detail);
      const detailLinks = anchors(loadHtml(fetched.html), 'body', candidate.url)
        .filter((link) => /başvur/i.test(link.text) || link.href.includes('turkiye.gov.tr'))
        .slice(0, 10)
        .map((link) => ({ text: link.text, url: link.href }));
      if (detailLinks.length > 0) detailLinksByItemId.set(candidate.sourceItemId, detailLinks);
    }
    if (detailByItemId.size > 0) {
      notes.push(`${detailByItemId.size} ilanın detay sayfası da okundu (ilan no/tarihler/metin).`);
    }

    const items: RawAnnouncement[] = [];
    for (const row of selectedRows) {
      const itemNotes: string[] = [];
      if (viaBrowser) itemNotes.push('Liste tarayıcı ile okundu.');
      const item: RawAnnouncement = {
        sourceKey: source.key,
        sourceItemId: row.sourceItemId,
        url: row.url,
        title: row.title,
        ...(row.institution ? { institution: row.institution } : {}),
        ...(row.applicationEndAt ? { applicationEndAt: row.applicationEndAt } : {}),
        ...(row.applicationUrl ? { applicationUrl: row.applicationUrl } : {}),
        sourceCategory: 'personel alımı',
        attachments: [],
        extractionConfidence: 0.55,
        ...(itemNotes.length > 0 ? { notes: itemNotes } : {}),
      };

      const detail = detailByItemId.get(row.sourceItemId);
      if (detail) {
        if (detail.referenceNo) item.referenceNo = detail.referenceNo;
        if (detail.applicationStartAt) item.applicationStartAt = detail.applicationStartAt;
        if (detail.applicationEndAt) item.applicationEndAt = detail.applicationEndAt;
        if (detail.applicationUrl) item.applicationUrl = detail.applicationUrl;
        if (detail.category) item.sourceCategory = detail.category;
        if (detail.quota) item.quota = detail.quota;
        if (detail.bodyText) {
          item.bodyText = detail.bodyText;
          item.bodyTextSource = 'detail';
          if (detail.bodyTextTruncated) item.bodyTextTruncated = true;
          item.rawExcerpt = detail.bodyText.slice(0, 1_200);
          item.extractionConfidence = 0.8;
        }
        const detailLinks = detailLinksByItemId.get(row.sourceItemId);
        if (detailLinks) item.links = detailLinks;
      }
      items.push(item);
    }

    const deferredDetails = Math.max(
      0,
      freshDetailRows.length + pendingDetailRows.length - selectedDetailRows.length,
    );
    const deferredExternalRows = Math.max(0, externalFreshRows.length - selectedExternalRows.length);
    notes.push(`${requestCount} istek yapıldı, ${items.length} ilan işlendi.`);
    if (deferredDetails > 0)
      notes.push(
        `${deferredDetails} detay sonraki taramalara bırakıldı (detay bütçesi ${ctx.maxDetailFetches}).`,
      );
    if (deferredExternalRows > 0)
      notes.push(
        `${deferredExternalRows} dış bağlantılı ilan çıktı sınırı nedeniyle sonraki taramaya bırakıldı (kayıt sınırı ${MAX_ITEMS}).`,
      );
    if (items.length === 0 && rows.length > 0)
      notes.push('Yeni ilan yok ve detay metni eksik kayıt kalmadı.');

    const detailCoverageNotes: string[] = [];
    if (failedDetailFetches > 0)
      detailCoverageNotes.push(`${failedDetailFetches} detay isteği başarısız oldu.`);
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
      notModified: false,
      coverage: { status: finalCoverageStatus, note: finalCoverageNote },
      httpStatuses,
    };
  }

  /**
   * Detay sayfasını okur: liste tarayıcıdan geldiyse doğrudan tarayıcı,
   * aksi halde önce düz HTTP (boş/hata durumunda tarayıcı yedeği).
   */
  private async fetchDetailHtml(
    ctx: AdapterContext,
    url: string,
    preferBrowser: boolean,
  ): Promise<{ html: string; status: number | null }> {
    const safeUrl = assertSafeUrl(url, ctx.source.allowedHosts).toString();
    if (!preferBrowser) {
      try {
        const response = await ctx.http.fetchText(safeUrl, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
        });
        const html = response.decoded?.text ?? response.body.toString('utf8');
        if (html.length > 0) return { html, status: response.status };
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        if (!isTransientTransportFailure(error)) throw error;
        // Yalnızca geçici aktarım hatasında tarayıcı yedeği kullanılabilir.
      }
    }
    const pages = await this.renderPages([safeUrl], ctx.source.allowedHosts, ctx.signal);
    return { html: pages.get(safeUrl) ?? '', status: null };
  }

  /** Adresleri tek Chromium oturumunda sırayla açıp oluşturulmuş HTML'lerini döndürür. */
  private async renderPages(
    urls: string[],
    allowedHosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const safeUrls = urls.map((url) => assertSafeUrl(url, allowedHosts).toString());
    if (this.renderPagesFn) return this.renderPagesFn(safeUrls, signal);
    const pages = new Map<string, string>();
    await withChromiumPage(
      async (page) => {
        for (const url of safeUrls) {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
          await page.waitForTimeout(500);
          pages.set(url, await page.content());
        }
      },
      { allowedHosts, signal },
    );
    return pages;
  }
}
