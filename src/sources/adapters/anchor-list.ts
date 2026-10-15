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
import { AdapterStructureError } from '../errors';
import type { AnyNode } from 'domhandler';
import {
  elementText,
  loadHtml,
  loadXml,
  chromeFreeText,
  describePageStructure,
  readableAnnouncementText,
  readableText,
  stripPageChrome,
} from '../../lib/html';
import { browserFallbackEnabled, describeBrowserFailure, withChromiumPage } from '../browser-session';
import { collapseWhitespace, isSiteChromeTitle, makeExcerpt, normalizeTr } from '../../domain/text';
import { cleanTitle, parseListingDate } from '../listing-utils';
import { isOfficialApplicationUrl, normalizeUrl } from '../../domain/urls';
import { assertSafeUrl, describeFetchFailure, FetchError } from '../fetcher';
import { detectNextPage } from '../pagination';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import type { RawAnnouncement } from '../../domain';

/** Tarayıcı yedeği zaman sınırları (kariyer-kapısı adaptörüyle aynı mertebede). */
const BROWSER_PAGE_TIMEOUT_MS = 45_000;
const BROWSER_SETTLE_MS = 2_500;

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
  /** Maximum listing pages to follow in one scan (remaining pages are reported partial). */
  maxPages?: number;
  /**
   * Liste biçimi. Bazı kurumların (MEB) liste sayfası JS ile yüklenir;
   * onlar için resmî RSS beslemesi okunur ('rss'), detaylar yine HTML'dir.
   */
  listingFormat?: 'html' | 'rss';
}

/** Liste sayfasından/beslemesinden çıkarılmış, biçimi ortaklaştırılmış kayıt. */
interface ListEntry {
  url: string;
  title: string;
  rowText: string;
  publishedAt: string | null;
}

interface Candidate {
  element: AnyNode;
  url: string;
}

function listingDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:page|p|sayfa|currentpage|pageindex|sayfano)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/$/, '') || '/'}?${url.searchParams.toString()}`;
  } catch {
    return null;
  }
}

function isChromeLikeTitle(value: string): boolean {
  if (normalizeTr(value).length > 180) return true;
  return isSiteChromeTitle(value);
}

function isClearlyEmptyListingPage(html: string): boolean {
  const text = normalizeTr(readableText(loadHtml(html), 'body'));
  return /(?:duyuru|haber|ilan|kayit|sonuc)\s+bulunmamakt|(?:duyuru|haber|ilan|kayit|sonuc)\s+bulunamadi|aktif\s+(?:duyuru|haber|ilan)\s+yok|sonuc\s+yok/.test(
    text,
  );
}

function parseAnchorListPage(
  html: string,
  pageUrl: string,
  listingUrl: string,
  config: AnchorListConfig,
  allowedHosts: readonly string[],
): {
  entries: ListEntry[];
  nextPageUrl: string | null;
  paginationDetected: boolean;
  paginationEndConfirmed: boolean;
} {
  const $ = loadHtml(html);
  const detectedNavigation = detectNextPage(html, pageUrl);
  let nextPageUrl = detectedNavigation.nextUrl;
  let paginationEndConfirmed = detectedNavigation.endConfirmed;
  if (nextPageUrl) {
    try {
      nextPageUrl = assertSafeUrl(nextPageUrl, allowedHosts).toString();
    } catch {
      // An off-host next link is not followed or counted as a confirmed end.
      nextPageUrl = null;
      paginationEndConfirmed = false;
    }
  }
  stripPageChrome($.root());
  const scopeSelector = [
    'main',
    '[role="main"]',
    '#contentBox',
    '#DeltaPlaceHolderMain',
    '#content',
    '.main-content',
  ].find((selector) => $(selector).length > 0);
  const scope = scopeSelector ? $(scopeSelector).first() : $.root();
  const listingIdentity = listingDocumentIdentity(listingUrl);
  const candidates: Candidate[] = scope
    .find('a[href]')
    .toArray()
    .map((element) => ({
      element: element as AnyNode,
      url: normalizeUrl($(element).attr('href') ?? '', pageUrl),
    }))
    .filter((candidate): candidate is Candidate => candidate.url !== null)
    .filter((candidate) => {
      try {
        assertSafeUrl(candidate.url, allowedHosts);
        if (listingDocumentIdentity(candidate.url) === listingIdentity) return false;
        const pattern = new RegExp(config.pathPattern.source, config.pathPattern.flags.replace('g', ''));
        return pattern.test(new URL(candidate.url).pathname);
      } catch {
        return false;
      }
    });

  const entries: ListEntry[] = [];
  const candidateElements = new Set<AnyNode>(candidates.map((candidate) => candidate.element));
  for (const candidate of candidates) {
    const anchorText = elementText($(candidate.element), 400);
    // Satır yalnızca bu bağlantıya aitse satır metni (tarih, kısa özet) kullanılır. Aynı satırda
    // birden çok aday bağlantı varsa satır paylaşılıyordur: ilk bulunan tarih ya da gövde komşu
    // duyuruya ait olabilir. Bu durumda yalnızca bağlantının kendi metni kullanılır.
    const row = $(candidate.element).closest(config.rowSelector);
    const sharedRow =
      row.length > 0 &&
      row
        .find('a[href]')
        .toArray()
        .filter((anchor) => candidateElements.has(anchor as AnyNode)).length > 1;
    const rowText = sharedRow ? anchorText : elementText(row, 900) || anchorText;
    const title = cleanTitle(anchorText.length >= config.minTitleLength ? anchorText : rowText);
    if (title.length < config.minTitleLength || isChromeLikeTitle(title)) continue;
    entries.push({
      url: candidate.url,
      title,
      rowText,
      publishedAt: parseListingDate(rowText),
    });
  }
  return {
    entries,
    nextPageUrl,
    paginationDetected: detectedNavigation.detected,
    paginationEndConfirmed,
  };
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
    const isRss = this.config.listingFormat === 'rss';
    const listing = await http.fetchText(source.listingUrl, {
      allowedHosts: source.allowedHosts,
      minIntervalMs: source.minRequestIntervalMs,
      ...(isRss
        ? {
            expectedContentTypes: [
              'application/rss+xml',
              'application/atom+xml',
              'application/xml',
              'text/xml',
              'text/html',
              'text/plain',
            ],
          }
        : {}),
    });
    let requestCount = 1;
    httpStatuses.push(listing.status);

    if (listing.notModified) {
      return {
        items: [],
        requestCount,
        notes: ['Liste değişmedi (ETag/Last-Modified); bu istekte sayfalama yeniden doğrulanmadı.'],
        etag: listing.etag,
        lastModified: listing.lastModified,
        notModified: true,
        coverage: {
          status: 'unknown',
          note: '304 yanıtı liste değişmediğini gösterir; bu çalışmada arşiv/sayfa kapsamı yeniden gezilmedi.',
        },
        httpStatuses,
      };
    }

    let html = listing.decoded?.text ?? listing.body.toString('utf8');
    if (isRss) {
      return this.runFromRss(ctx, listing, html, notes, httpStatuses, requestCount);
    }

    // 2026-10-15 canlı çıktısında iskur/sgk benzeri JS ile çizilen listeler düz HTTP
    // yanıtında satır bırakmadı; hata mesajı da çerez modali ve erişilebilirlik araç
    // çubuğu metnini "sayfa özeti" diye gösterdi. Önce satır var mı diye bakılır, yoksa
    // kariyer-kapısı adaptöründeki gibi başsız tarayıcıyla yeniden çizilir.
    let browserFallbackNote = '';
    // Ön-kontrol ayrıştırması döngünün 1. sayfasında yeniden kullanılır; aynı HTML iki
    // kez ayrıştırılmaz (tarayıcı yedeği varsayılan olarak açık).
    let firstPageParse: ReturnType<typeof parseAnchorListPage> | null = null;
    if (browserFallbackEnabled()) {
      const firstPass = parseAnchorListPage(html, source.listingUrl, source.listingUrl, this.config, source.allowedHosts);
      firstPageParse = firstPass;
      if (firstPass.entries.length === 0) {
        const httpLength = html.length;
        try {
          const rendered = await this.renderListingHtml(source, ctx);
          requestCount += 1;
          if (rendered.length > 0) {
            const renderedPass = parseAnchorListPage(
              rendered,
              source.listingUrl,
              source.listingUrl,
              this.config,
              source.allowedHosts,
            );
            if (renderedPass.entries.length > firstPass.entries.length) {
              html = rendered;
              firstPageParse = renderedPass;
              notes.push(
                `HTTP listesi satır üretmedi (${httpLength} karakter); sayfa tarayıcıda çizildi ve ${renderedPass.entries.length} ilan bağlantısı bulundu.`,
              );
            } else {
              notes.push(
                `Tarayıcı çizimi de satır üretmedi (${rendered.length} karakter); HTTP yanıtıyla devam ediliyor.`,
              );
            }
          }
        } catch (error) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
          browserFallbackNote = describeBrowserFailure(error);
          notes.push(`Tarayıcı yedeği kullanılamadı: ${browserFallbackNote}`);
        }
      }
    }

    const entriesByUrl = new Map<string, ListEntry>();
    const seenEntryIdentities = new Set<string>();
    const entryIdentity = (entry: ListEntry): string => {
      const itemId = itemIdOf(entry.url);
      return itemId ? `item:${itemId}` : `url:${normalizeUrl(entry.url) ?? entry.url}`;
    };
    const visitedPages = new Set<string>();
    const maxPages = this.config.maxPages ?? 10;
    let currentUrl = source.listingUrl;
    let currentHtml = html;
    let paginationDetected = false;
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = '';

    for (let page = 1; page <= maxPages; page += 1) {
      const normalizedPageUrl = normalizeUrl(currentUrl) ?? currentUrl;
      if (visitedPages.has(normalizedPageUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Sayfalama aynı URL’ye döndü; tekrar döngüsü engellendi ve tam kapsam doğrulanamadı.';
        break;
      }
      visitedPages.add(normalizedPageUrl);

      const parsedPage =
        page === 1 && firstPageParse
          ? firstPageParse
          : parseAnchorListPage(currentHtml, currentUrl, source.listingUrl, this.config, source.allowedHosts);
      if (page === 1) firstPageParse = null;
      paginationDetected ||= parsedPage.paginationDetected;
      const repeatedEntry =
        page > 1 && parsedPage.entries.some((entry) => seenEntryIdentities.has(entryIdentity(entry)));
      for (const entry of parsedPage.entries) {
        if (!entriesByUrl.has(entry.url)) entriesByUrl.set(entry.url, entry);
        seenEntryIdentities.add(entryIdentity(entry));
      }
      notes.push(`Sayfa ${page}: ${parsedPage.entries.length} ilan bağlantısı.`);
      if (repeatedEntry) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page} önceki sayfalardaki aynı ilan kimliklerini tekrarladı; sayfalama kapsamı doğrulanamadı.`;
        break;
      }

      if (!parsedPage.nextPageUrl) {
        coverageStatus = parsedPage.paginationEndConfirmed ? 'complete' : 'unknown';
        coverageNote = parsedPage.paginationEndConfirmed
          ? `${visitedPages.size} sayfa gezildi ve kaynak sayfalama denetimi son sayfayı doğruladı.`
          : paginationDetected
            ? `${visitedPages.size} sayfa gezildi ancak son sayfa işareti doğrulanamadı; kapsam bilinmiyor.`
            : 'Sayfada doğrulanabilir sonraki sayfa/arşiv işareti bulunmadı; tek sayfanın tüm duyurular olduğu varsayılmıyor.';
        break;
      }

      const normalizedNext = normalizeUrl(parsedPage.nextPageUrl) ?? parsedPage.nextPageUrl;
      if (visitedPages.has(normalizedNext)) {
        coverageStatus = 'unknown';
        coverageNote = 'Kaynağın sonraki sayfa bağlantısı önceki sayfaya döndü; tam kapsam bilinmiyor.';
        break;
      }
      if (page >= maxPages) {
        coverageStatus = 'partial';
        coverageNote = `${maxPages} sayfa üst sınırına ulaşıldı ve sonraki sayfa mevcut; kalan kayıtlar bu çalışmada taranmadı.`;
        break;
      }

      try {
        const nextPage = await http.fetchText(parsedPage.nextPageUrl, {
          allowedHosts: source.allowedHosts,
          minIntervalMs: source.minRequestIntervalMs,
        });
        requestCount += 1;
        httpStatuses.push(nextPage.status);
        if (nextPage.notModified) {
          coverageStatus = 'unknown';
          coverageNote = 'Sonraki sayfa için 304 alındı; o sayfanın satırları bu çalışmada doğrulanamadı.';
          break;
        }
        currentUrl = parsedPage.nextPageUrl;
        currentHtml = nextPage.decoded?.text ?? nextPage.body.toString('utf8');
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        coverageStatus = 'partial';
        coverageNote = `Sonraki sayfa alınamadı (${error instanceof Error ? error.message : String(error)}); önceki sayfalar işlendi.`;
        notes.push(coverageNote);
        break;
      }
    }

    const entries = [...entriesByUrl.values()];
    if (entries.length === 0) {
      if (isClearlyEmptyListingPage(html)) {
        coverageStatus = 'unknown';
        coverageNote = 'Liste açıkça boş sonuç bildirdi; kaynak arşivinin tamamı bu çalışmada doğrulanmadı.';
        notes.push(coverageNote);
        return this.buildItems(ctx, [], notes, httpStatuses, requestCount, listing, {
          status: coverageStatus,
          note: coverageNote,
        });
      }
      const pageText = chromeFreeText(html, 300);
      const structure = describePageStructure(html, currentUrl);
      throw new AdapterStructureError(
        source.key,
        `Liste yapısı tanınmadı (${source.key}): beklenen bağlantı kalıbı ${String(this.config.pathPattern)} bulunamadı. ` +
          `Sayfa yapısı: ${structure.anchors} bağlantı (${structure.sameHostAnchors} aynı alan adı), ` +
          `${structure.scripts} script, ${structure.iframes} iframe, ${structure.forms} form, ` +
          `görünür metin ${structure.bodyTextLength} karakter` +
          (structure.topPathPrefixes.length > 0 ? `, sık geçen yollar: ${structure.topPathPrefixes.join(', ')}` : '') +
          `. Sayfa özeti (iskelet temizlendikten sonra): "${makeExcerpt(pageText, 160)}" — ` +
          (structure.anchors === 0
            ? 'sayfada hiç bağlantı yok; içerik büyük olasılıkla JavaScript ile yükleniyor (SOURCE_BROWSER_FALLBACK=1 ve Playwright gerekli).'
            : 'pathPattern/listContainers seçicileri bu yollara göre güncellenmeli.') +
          // Tarayıcı yedeği denendiyse nedeni hata mesajında da görünür: notlar hata
          // fırlatılınca operatöre ulaşmıyor.
          (browserFallbackNote ? ` Tarayıcı yedeği sonucu: ${browserFallbackNote}.` : ''),
      );
    }

    if (!coverageNote) coverageNote = 'Sayfalama kapsamı bu çalışmada doğrulanamadı.';
    notes.push(
      `Liste kapsamı: ${coverageStatus === 'complete' ? 'tam' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`,
    );
    return this.buildItems(ctx, entries, notes, httpStatuses, requestCount, listing, {
      status: coverageStatus,
      note: coverageNote,
    });
  }

  /** RSS beslemesinden (MEB gibi JS'li listeler) aynı akışa giriş. */
  /** Liste sayfasını başsız Chromium ile çizip HTML'i döndürür (ağ izin listesi korunur). */
  private async renderListingHtml(source: AdapterContext['source'], ctx: AdapterContext): Promise<string> {
    return withChromiumPage(
      async (page) => {
        await page.goto(source.listingUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_PAGE_TIMEOUT_MS });
        // JS ile basılan satırlar için kısa bir oturma süresi; networkidle analitik
        // isteklerinde takılabildiği için tercih edilmiyor.
        await page.waitForTimeout(BROWSER_SETTLE_MS);
        return page.content();
      },
      { allowedHosts: source.allowedHosts, signal: ctx.signal },
    );
  }

  private async runFromRss(
    ctx: AdapterContext,
    listing: { etag: string | null; lastModified: string | null },
    xml: string,
    notes: string[],
    httpStatuses: number[],
    requestCount: number,
  ): Promise<AdapterRunResult> {
    const { source } = ctx;
    const $ = loadXml(xml);
    const entries: ListEntry[] = [];
    $('item').each((_index, element) => {
      const node = $(element);
      const link = collapseWhitespace(node.find('link').first().text());
      const title = cleanTitle(collapseWhitespace(node.find('title').first().text()));
      const normalizedUrl = link ? normalizeUrl(link, source.listingUrl) : null;
      if (!normalizedUrl || title.length === 0) return;
      let url: string;
      try {
        url = assertSafeUrl(normalizedUrl, source.allowedHosts).toString();
      } catch {
        return;
      }
      const rawDate = collapseWhitespace(node.find('pubDate').first().text());
      const parsed = rawDate ? new Date(rawDate) : null;
      entries.push({
        url,
        title,
        rowText: title,
        publishedAt:
          parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : parseListingDate(title),
      });
    });

    if (entries.length === 0) {
      if ($('rss > channel').length > 0) {
        const coverage = {
          status: 'unknown' as const,
          note: 'Yapısal olarak geçerli RSS beslemesi bu çalışmada öğe döndürmedi; geçmiş/arşiv kapsamı doğrulanmadı.',
        };
        notes.push(coverage.note);
        return this.buildItems(ctx, [], notes, httpStatuses, requestCount, listing, coverage);
      }
      throw new AdapterStructureError(
        source.key,
        `Liste yapısı tanınmadı (${source.key}): RSS beslemesinde kayıt bulunamadı. ` +
          `Sayfa özeti: "${makeExcerpt(collapseWhitespace(xml.replace(/<[^>]+>/g, ' ')), 160)}" — besleme biçimi değişmiş olabilir.`,
      );
    }
    const coverage = {
      status: 'unknown' as const,
      note: `RSS beslemesi bu çalışmada ${entries.length} öğe döndürdü; bunun kaynağın tüm arşivi olup olmadığı ve ek sayfalama kapsamı doğrulanmadı.`,
    };
    notes.push(`RSS beslemesinde ${entries.length} kayıt bulundu. ${coverage.note}`);
    return this.buildItems(ctx, entries, notes, httpStatuses, requestCount, listing, coverage);
  }

  /** Ortak kayıt üretim döngüsü: detay okuma + RawAnnouncement oluşturma. */
  private async buildItems(
    ctx: AdapterContext,
    entries: ListEntry[],
    notes: string[],
    httpStatuses: number[],
    requestCount: number,
    listing: { etag: string | null; lastModified: string | null },
    coverage: { status: 'complete' | 'partial' | 'unknown'; note: string },
  ): Promise<AdapterRunResult> {
    const { source } = ctx;
    const seen = new Set<string>(ctx.knownItemIds ?? []);
    const knownWithDetail = new Set<string>(ctx.knownItemIdsWithDetail ?? []);
    const maxItems = this.config.maxItems ?? 30;
    const fetchDetail = this.config.fetchDetail !== false;
    const candidatesByItemId = new Map<string, ListEntry>();
    for (const entry of entries) {
      const itemId = itemIdOf(entry.url);
      if (!itemId || entry.title.length < this.config.minTitleLength || candidatesByItemId.has(itemId))
        continue;
      candidatesByItemId.set(itemId, entry);
    }
    if (candidatesByItemId.size < entries.length) {
      notes.push(
        `${entries.length - candidatesByItemId.size} yinelenen/geçersiz bağlantı tekilleştirildi veya atlandı.`,
      );
    }
    const eligible = [...candidatesByItemId.entries()]
      .map(([itemId, entry]) => ({ entry, itemId }))
      .filter(
        (candidate) => !seen.has(candidate.itemId) || (fetchDetail && !knownWithDetail.has(candidate.itemId)),
      );
    const fresh = eligible.filter((candidate) => !seen.has(candidate.itemId));
    const pendingDetail = eligible.filter((candidate) => seen.has(candidate.itemId));
    // Drain new listing records first, then retry old records whose detail text
    // was unavailable. A failing detail must not starve later pages forever.
    const processLimit = fetchDetail ? Math.min(maxItems, ctx.maxDetailFetches) : maxItems;
    const selected = [...fresh, ...pendingDetail].slice(0, processLimit);
    const items: RawAnnouncement[] = [];
    let failedDetailReads = 0;
    let detailPagesWithoutText = 0;

    for (const { entry, itemId } of selected) {
      const title = entry.title;
      const publishedAt = entry.publishedAt;
      const candidate = { url: entry.url };
      const rowText = entry.rowText;
      const detail = fetchDetail ? await this.readDetail(ctx, candidate.url) : null;
      if (detail) {
        requestCount += detail.requests;
        httpStatuses.push(...detail.statuses);
        if (detail.failure) {
          failedDetailReads += 1;
          notes.push(`Detay isteği başarısız (${candidate.url}): ${detail.failure}`);
        } else if (!detail.bodyText) {
          detailPagesWithoutText += 1;
          notes.push(`Detay sayfası kullanılabilir ilan metni vermedi (${candidate.url}).`);
        }
      }
      const bodyText = detail?.bodyText ?? (rowText.length > 140 ? rowText.slice(0, 2_000) : null);
      const bodyTextSource = detail?.bodyText ? 'detail' : bodyText ? 'listing' : undefined;

      items.push({
        sourceKey: source.key,
        sourceItemId: itemId,
        url: candidate.url,
        title,
        institution: source.institution || this.config.defaultInstitution,
        ...(publishedAt ? { publishedAt } : {}),
        sourceCategory: this.config.sourceCategory,
        ...(bodyText ? { bodyText } : {}),
        ...(bodyTextSource ? { bodyTextSource: bodyTextSource as 'detail' | 'listing' } : {}),
        ...(detail?.bodyTextTruncated ? { bodyTextTruncated: true } : {}),
        ...(rowText ? { rawExcerpt: rowText.slice(0, 400) } : {}),
        attachments: detail?.attachments ?? [],
        ...(detail?.applicationUrl ? { applicationUrl: detail.applicationUrl } : {}),
        extractionConfidence: 0.5,
      });
      seen.add(itemId);
    }

    const deferred = Math.max(0, eligible.length - selected.length);
    notes.push(`${entries.length} bağlantı tarandı; ${items.length} kayda detay isteği yapıldı.`);
    if (deferred > 0)
      notes.push(
        `${deferred} yeni/eksik detay sonraki taramalara bırakıldı (detay bütçesi ${processLimit}).`,
      );
    if (items.length === 0) notes.push('İşlenecek yeni veya ayrıntı metni eksik kayıt bulunamadı.');

    const detailCoverageNotes: string[] = [];
    if (failedDetailReads > 0) detailCoverageNotes.push(`${failedDetailReads} detay isteği başarısız oldu.`);
    if (detailPagesWithoutText > 0)
      detailCoverageNotes.push(
        `${detailPagesWithoutText} detay sayfasından kullanılabilir ilan metni çıkarılamadı.`,
      );
    if (deferred > 0)
      detailCoverageNotes.push(`${deferred} yeni/eksik detay bütçe nedeniyle sonraki taramaya ertelendi.`);
    const finalCoverage = {
      status: detailCoverageNotes.length > 0 ? ('partial' as const) : coverage.status,
      note: [coverage.note, ...detailCoverageNotes].join(' '),
    };
    if (detailCoverageNotes.length > 0) notes.push(`Detay kapsamı kısmi — ${detailCoverageNotes.join(' ')}`);

    return {
      items,
      requestCount,
      notes,
      etag: listing.etag,
      lastModified: listing.lastModified,
      notModified: false,
      coverage: finalCoverage,
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
        maxBytes: 3_000_000,
      });
      const html = response.decoded?.text ?? response.body.toString('utf8');
      const $ = loadHtml(html);
      const text = readableAnnouncementText(
        $,
        [
          'article',
          'main',
          '.icerik',
          '.content',
          '#content',
          '#contentBox',
          '#DeltaPlaceHolderMain',
          'body',
        ],
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
        .slice(0, 6)
        .map((link) => ({
          url: link.url,
          label: link.text.slice(0, 160) || 'Belge',
          kind: (/\.pdf(\?|$)/i.test(link.url) ? 'pdf' : 'doc') as 'pdf' | 'doc',
        }));
      const application = links.find((link) => isOfficialApplicationUrl(link.url));

      return {
        bodyText: capturedText.length > 120 ? capturedText : null,
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

function itemIdOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/$/, '').replace(/\.(html?|aspx)$/i, '');
    const match = /([a-z0-9-]{6,}|\d{3,})$/i.exec(pathname);
    const tail = match?.[1] ?? null;
    // Bazı kurumlar kimliği sorguda taşır (DuyuruDetay.aspx?Parameter=2120):
    // yolun sonu her ilanda aynıysa sorgudaki sayısal kimliği ekle.
    const queryId = [...parsed.searchParams.values()].find((value) => /^\d{3,}$/.test(value)) ?? null;
    if (queryId && tail && !tail.endsWith(queryId)) return `${tail}-${queryId}`;
    // Yol sonu jenerikse (ör. /TR-120694/duyuru-detay) kimlik önceki sayısal
    // segmenttedir: yalnız "duyuru-detay" kullanılırsa listedeki TÜM ilanlar
    // aynı kimliği alır ve yalnız ilki işlenir, kalanları kaybolur.
    if (tail && !/\d/.test(tail)) {
      const segments = pathname.split('/').filter(Boolean);
      segments.pop();
      const prior = [...segments].reverse().find((segment) => /\d{3,}/.test(segment));
      if (prior) return `${prior}-${tail}`;
    }
    return tail ?? queryId;
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
    pathPattern:
      /(\/(duyurular|duyuru|haberler|haber|ilanlar|ilan|icerik|detay|announcements?|basin|sayfa)\b|\/TR-\d+\/|\/[a-z0-9-]{20,}$)/i,
    rowSelector: 'li, tr, article, .card, div',
    minTitleLength: 18,
    defaultInstitution: '',
    // This adapter is intentionally generic: a kurum's news/announcement page
    // is not itself proof that each linked item is a recruitment notice.
    sourceCategory: 'kurum duyurusu',
    maxItems: 25,
  });
}

/** Millî Eğitim Bakanlığı personel duyuruları. */
export function createMebAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'meb-duyuru-listesi',
    label: 'MEB — personel duyuruları',
    notes:
      'Liste sayfası JS ile yüklendiği için kurumun resmî RSS beslemesi okunur ' +
      '(meb_iys_dosyalar/xml/rss_duyurular.xml; Haberler + Duyurular kategorileri), ' +
      'detay sayfaları HTML olarak çekilir. Atama/yer değiştirme duyuruları sınıflandırmada ' +
      '"yeni ilan değil" olarak işaretlenir (sonuç/atama içerikleri reddedilir).',
    listingFormat: 'rss',
    pathPattern: /\/www\/[a-z0-9-]+\/icerik\/\d+/i,
    rowSelector: 'li, tr, article, .card, div',
    minTitleLength: 20,
    defaultInstitution: 'T.C. Millî Eğitim Bakanlığı',
    sourceCategory: 'personel duyurusu',
    maxItems: 30,
  });
}
