/**
 * ilan.gov.tr JSON API adaptörü (Basın İlan Kurumu).
 *
 * Kaynak keşfi (14.10.2026, GitHub ekosistemi araştırması):
 * github.com/Ruchanbas/rg-ilan-botu projesi, Resmî Gazete bulut IP'lerini
 * engellediği için canlı hattını ilan.gov.tr'nin JSON API'sine taşımış ve
 * API sözleşmesini canlı doğrulamış (GitHub Actions runner'larından 200):
 *
 *   Taban:  https://www.ilan.gov.tr/api/api/services/app   (çift "api" gerçek!)
 *   Arama:  POST Ad/AdsByFilter
 *           {"keys": {"ats": [5]}, "sorting": "publish_time desc", "skipCount": N, "maxResultCount": 20}
 *           Akademik ilanlar `txv:[73]` filtresiyle ayrıca taranır.
 *   Cevap:  {"result": {"numFound": N, "ads": [...]}}
 *           Her ilan: id, adNo, title, advertiserName, slugifyTitle,
 *           addressCityName, publishStartDate, urlStr, isArchived,
 *           adTypeFilters[{key, value}] ("Son Başvuru" gibi alanlar).
 *   Detay:  GET AdDetail/GetAdDetail?id=<id>
 *           (cevap şeması belgelenmemiş; alan adlarına güvenmeden tüm metin
 *           değerleri özyinelemeli toplanır — şema değişse de metin bulunur).
 *
 * Bu adaptör HTML liste adaptörünün YERİNE değil, YANINA konur:
 *  - HTML adaptörü SPA listesi için gerçek tarayıcı fallback'ini kullanır.
 *  - API adaptörü personel (`ats:[5]`) ve akademik (`txv:[73]`) kategorilerini toplar.
 *  - offset tabanlı sayfalama (skipCount) kanıtlanabilir ve deterministiktir.
 *
 * DÜRÜSTLÜK: API sözleşmesi üçüncü taraf canlı keşfiyle belgelenmiştir; bu
 * depoda fixture testleriyle doğrulanmıştır ancak bu ortamdan CANLI denenemez
 * (ağ erişimi kapalı). Bu yüzden envanter kaydı "scraper-built" durumundadır.
 */
import { collapseWhitespace, makeExcerpt, normalizeTr, stripUiChrome } from '../../domain/text';
import { toIstanbulIso } from '../../domain/dates';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError, SourceAccessError } from '../errors';
import { assertSafeUrl, describeFetchFailure, FetchError, type FetchOptions, type FetchResponse } from '../fetcher';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

const API_BASE_PATH = '/api/api/services/app';
const PAGE_SIZE = 20;
const MAX_LIST_ITEMS = 300;
const MAX_ITEMS = 40;
/** Her kategori için en fazla 10 sayfa (her sayfa 20 ilan); kaynak nazikçe taranır. */
const MAX_PAGES_PER_FILTER = 10;
const SEARCH_FILTERS: readonly { sourceCategory: string; keys: Record<string, number[]> }[] = [
  { sourceCategory: 'personel alımı', keys: { ats: [5] } },
  { sourceCategory: 'akademik personel alımı', keys: { txv: [73] } },
];

interface ApiAd {
  id?: string | number;
  adNo?: string | number | null;
  title?: string | null;
  advertiserName?: string | null;
  slugifyTitle?: string | null;
  addressCityName?: string | null;
  publishStartDate?: string | null;
  urlStr?: string | null;
  isArchived?: boolean | null;
  adTypeFilters?: { key?: string | null; value?: string | null }[] | null;
}

interface ParsedRow {
  /** Kayıt kimliği (resmî ilan no varsa adNo, yoksa id). Kalıcı tekil anahtar. */
  itemId: string;
  /**
   * GetAdDetail'in beklediği kimlik: upstream `rg-ilan-botu` ile aynı şekilde
   * `id` alanı. adNo ile detay istemek doğrulanmış sözleşmeden sapmadır.
   */
  detailId: string;
  url: string;
  title: string;
  institution: string | null;
  city: string | null;
  publishedAt: string | null;
  applicationEndAt: string | null;
  referenceNo: string | null;
  sourceCategory: string;
}

const HTML_TAG = /<[^>]+>/g;

/** Gövde metni kullanılabilir uzunlukta mı? (İlan gövdesi için alt sınır.) */
const MIN_USABLE_BODY = 120;
/** Aynı taramada bu kadar ilanda geçen uzun ifade şablon (kurum kabuğu) sayılır. */
const BOILERPLATE_MIN_DOCS = 5;
/** Şablon tespitinde kayan pencere uzunluğu (kelime). */
const BOILERPLATE_WINDOW = 10;

/**
 * Aynı taramadaki ilanlarda sık tekrarlanan kelime pencerelerini (ör. her YÖK ilanındaki
 * "BİRİMLER Genel Sekreterlik … Bilgi İşlem Daire Başkanlığı" kurum kabuğu) gövdelerden çıkarır.
 * Tekrar eden bir ifade bir ilanın özgün içeriği değil, sitenin ortak kabuğudur. En az
 * BOILERPLATE_MIN_DOCS ilanda geçmeyen ifadelere dokunulmaz (özgün koşullar korunur).
 */
export function stripRepeatedBoilerplate(bodies: readonly string[]): string[] {
  if (bodies.length < BOILERPLATE_MIN_DOCS) return [...bodies];
  const tokenized = bodies.map((body) => body.split(' ').filter((token) => token.length > 0));
  const keyOf = (tokens: string[], start: number): string =>
    normalizeTr(tokens.slice(start, start + BOILERPLATE_WINDOW).join(' '));

  const docsPerWindow = new Map<string, number>();
  for (const tokens of tokenized) {
    const seen = new Set<string>();
    for (let start = 0; start + BOILERPLATE_WINDOW <= tokens.length; start += 1) {
      seen.add(keyOf(tokens, start));
    }
    for (const key of seen) docsPerWindow.set(key, (docsPerWindow.get(key) ?? 0) + 1);
  }

  return tokenized.map((tokens) => {
    const covered = new Array<boolean>(tokens.length).fill(false);
    for (let start = 0; start + BOILERPLATE_WINDOW <= tokens.length; start += 1) {
      if ((docsPerWindow.get(keyOf(tokens, start)) ?? 0) < BOILERPLATE_MIN_DOCS) continue;
      for (let index = start; index < start + BOILERPLATE_WINDOW; index += 1) covered[index] = true;
    }
    return tokens.filter((_, index) => !covered[index]).join(' ');
  });
}

/** JSON'daki TÜM metin değerlerini topla (şemadan bağımsız detay okuma). */
export function collectApiText(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') return collapseWhitespace(value.replace(HTML_TAG, ' '));
  if (Array.isArray(value)) return value.map((item) => collectApiText(item, depth + 1)).join(' ');
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => collectApiText(item, depth + 1))
      .join(' ');
  }
  return '';
}

/** "Son Başvuru" benzeri yapılandırılmış filtreden son başvuru gününü al. */
export function deadlineFromAdFilters(
  filters: { key?: string | null; value?: string | null }[] | null | undefined,
): string | null {
  const NEEDLES = ['son basvuru', 'basvuru bitis', 'son muracaat'];
  for (const pair of filters ?? []) {
    const key = normalizeTr(String(pair.key ?? ''));
    if (!NEEDLES.some((needle) => key.includes(needle))) continue;
    const match = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(String(pair.value ?? ''));
    if (!match?.[3]) continue;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return toIstanbulIso(`${year}-${mm}-${dd}`, '23:59');
  }
  return null;
}

function rowFromAd(
  ad: ApiAd,
  listingUrl: string,
  allowedHosts: readonly string[],
  sourceCategory: string,
): ParsedRow | null {
  const id = String(ad.id ?? '').trim();
  const adNo = ad.adNo !== null && ad.adNo !== undefined ? String(ad.adNo).trim() : '';
  const itemId = adNo.length > 0 ? adNo : id.length > 0 ? id : null;
  const detailId = id.length > 0 ? id : adNo;
  const title = stripUiChrome(String(ad.title ?? ''));
  if (!itemId || !detailId || title.length < 8) return null;

  const rawHref = String(ad.urlStr ?? '').trim();
  const candidate = rawHref.startsWith('http')
    ? rawHref
    : rawHref
      ? new URL(rawHref, listingUrl).toString()
      : null;
  let url: string | null = null;
  if (candidate) {
    try {
      url = assertSafeUrl(candidate, allowedHosts).toString();
    } catch {
      return null;
    }
  }

  const publish = String(ad.publishStartDate ?? '').slice(0, 10);
  const publishedAt = /^\d{4}-\d{2}-\d{2}$/.test(publish) ? publish : null;

  return {
    itemId,
    detailId,
    url: url ?? listingUrl,
    title: title.slice(0, 300),
    institution: stripUiChrome(String(ad.advertiserName ?? '')) || null,
    city: collapseWhitespace(String(ad.addressCityName ?? '')) || null,
    publishedAt,
    applicationEndAt: deadlineFromAdFilters(ad.adTypeFilters),
    referenceNo: adNo || null,
    sourceCategory,
  };
}

/**
 * Operatör izin beyanıyla: dürüst isteğe yalnız HTTP 403 gelirse, aynı güvenlik
 * ayarlarıyla bir kez sitenin XHR origin başlığı denenir. TLS, kimlikli UA ve
 * host allowlist değişmez; 401/başka hata durumlarında başlık eklenmez.
 */
async function fetchApiWithUiOriginRetry(
  ctx: AdapterContext,
  url: string,
  options: FetchOptions,
  onAttempt: () => void,
  uiOriginConfirmed: boolean,
): Promise<{ response: FetchResponse; uiOriginUsed: boolean; retriedWithUiOrigin: boolean }> {
  if (uiOriginConfirmed) {
    onAttempt();
    return {
      response: await ctx.http.fetchText(url, {
        ...options,
        headers: { ...(options.headers ?? {}), 'x-request-origin': 'IGT-UI' },
      }),
      uiOriginUsed: true,
      retriedWithUiOrigin: false,
    };
  }
  onAttempt();
  try {
    return { response: await ctx.http.fetchText(url, options), uiOriginUsed: false, retriedWithUiOrigin: false };
  } catch (error) {
    if (!(error instanceof FetchError) || error.status !== 403) throw error;
    onAttempt();
    return {
      response: await ctx.http.fetchText(url, {
        ...options,
        headers: { ...(options.headers ?? {}), 'x-request-origin': 'IGT-UI' },
      }),
      uiOriginUsed: true,
      retriedWithUiOrigin: true,
    };
  }
}

export class IlanGovTrApiAdapter implements SourceAdapter {
  readonly key = 'ilan-gov-tr-api';
  readonly label = 'ilan.gov.tr — JSON API (personel alımı havuzu)';
  readonly method = 'json-api';
  readonly notes =
    'Basın İlan Kurumu portalının JSON API’si: AdsByFilter ile personel ve akademik kategori filtreleri, ' +
    'skipCount ile offset tabanlı sayfalama, GetAdDetail ile şemadan bağımsız detay metni. ' +
    'Yapılandırılmış alanlar (kurum, il, resmî ilan no, "Son Başvuru" filtresi) doğrudan okunur. ' +
    'HTML liste adaptörünün yerine geçmez, onu tamamlar; 403 durumunda bir kez izinli IGT-UI fallback dener.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const { source, liveFetch } = ctx;
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

    const listingUrl = source.listingUrl;
    const apiBase = this.apiBaseOf(listingUrl);
    let requestCount = 0;
    const rowsByItem = new Map<string, ParsedRow>();
    let totalNumFound = 0;
    let uiOriginConfirmed = false;
    /** Sayfa sınırına takılıp numFound'a ulaşılamayan terimler (kapsam eksik). */
    const truncatedTerms: string[] = [];

    for (const filter of SEARCH_FILTERS) {
      let skipCount = 0;
      let filterExhausted = false;
      for (let page = 1; page <= MAX_PAGES_PER_FILTER; page += 1) {
        if (rowsByItem.size >= MAX_LIST_ITEMS) break;
        let payload: unknown;
        try {
          const request = await fetchApiWithUiOriginRetry(ctx, `${apiBase}/Ad/AdsByFilter`, {
            allowedHosts: source.allowedHosts,
            minIntervalMs: source.minRequestIntervalMs,
            method: 'POST',
            headers: {
              'content-type': 'application/json-patch+json',
              'x-requested-with': 'XMLHttpRequest',
              accept: 'application/json, text/plain, */*',
            },
            jsonBody: {
              keys: filter.keys,
              sorting: 'publish_time desc',
              skipCount,
              maxResultCount: PAGE_SIZE,
            },
            expectedContentTypes: ['application/json', 'text/json', 'text/plain'],
          }, () => { requestCount += 1; }, uiOriginConfirmed);
          const response = request.response;
          if (request.uiOriginUsed) uiOriginConfirmed = true;
          if (request.retriedWithUiOrigin) {
            notes.push('AdsByFilter temiz isteği 403 döndürdü; operatör izniyle IGT-UI başlığı ikinci kez denendi.');
          }
          httpStatuses.push(response.status);
          payload = this.parseJson(response);
        } catch (error) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
          if (error instanceof AdapterStructureError || error instanceof SourceAccessError) throw error;
          if (error instanceof FetchError && (error.status === 403 || error.status === 401)) {
            throw new SourceAccessError(
              source.key,
              'ilan.gov.tr API’si temiz ve izinli XHR-origin denemelerinde HTTP ' +
                `${error.status} döndürdü; HTML liste adaptörü çalışmaya devam eder.`,
              error.status,
            );
          }
          throw error;
        }

        const result = this.expectResult(payload, source.key);
        const ads = Array.isArray(result.ads) ? (result.ads as ApiAd[]) : [];
        const numFound = Number(result.numFound ?? 0);
        totalNumFound = Math.max(totalNumFound, numFound);
        const fresh = ads.filter((ad) => ad.isArchived !== true);
        for (const ad of fresh) {
          const row = rowFromAd(ad, listingUrl, source.allowedHosts, filter.sourceCategory);
          if (row && !rowsByItem.has(row.itemId)) rowsByItem.set(row.itemId, row);
        }
        notes.push(`"${filter.sourceCategory}" kategori sayfa ${page}: ${ads.length} kayıt (numFound=${numFound}).`);

        // Offset sayfalama: boş sayfa ya da numFound'a ulaşma sonu kanıtlar.
        skipCount += PAGE_SIZE;
        if (ads.length < PAGE_SIZE || skipCount >= numFound) {
          filterExhausted = true;
          break;
        }
      }
      if (!filterExhausted && rowsByItem.size < MAX_LIST_ITEMS) truncatedTerms.push(filter.sourceCategory);
      if (rowsByItem.size >= MAX_LIST_ITEMS) break;
    }

    const known = new Set<string>(ctx.knownItemIds ?? []);
    const knownWithDetail = new Set<string>(ctx.knownItemIdsWithDetail ?? []);
    const allRows = [...rowsByItem.values()];
    // Sıra korunur: henüz işlenmemiş (yeni ya da detaysız bilinen) kayıtlar.
    const needsWork = (row: ParsedRow): boolean => !known.has(row.itemId) || !knownWithDetail.has(row.itemId);
    const workRows = allRows.filter(needsWork);
    const selectedRows = workRows.slice(0, Math.min(ctx.maxDetailFetches, MAX_ITEMS));

    const items: RawAnnouncement[] = [];
    let failedDetailFetches = 0;
    let detailsWithoutUsableText = 0;

    for (const row of selectedRows) {
      let bodyText: string | null = null;
      let bodyTextTruncated = false;
      try {
        const detailRequest = await fetchApiWithUiOriginRetry(ctx,
          `${apiBase}/AdDetail/GetAdDetail?id=${encodeURIComponent(row.detailId)}`,
          {
            allowedHosts: source.allowedHosts,
            minIntervalMs: source.minRequestIntervalMs,
            headers: {
              'x-requested-with': 'XMLHttpRequest',
              accept: 'application/json, text/plain, */*',
            },
            expectedContentTypes: ['application/json', 'text/json', 'text/plain'],
          },
          () => { requestCount += 1; },
          uiOriginConfirmed,
        );
        const detailResponse = detailRequest.response;
        if (detailRequest.uiOriginUsed) uiOriginConfirmed = true;
        if (detailRequest.retriedWithUiOrigin) {
          notes.push(`GetAdDetail ${row.itemId}: temiz istek 403 döndürdü; IGT-UI başlığı ikinci kez denendi.`);
        }
        httpStatuses.push(detailResponse.status);
        const detailPayload = this.parseJson(detailResponse);
        const fullText = stripUiChrome(collectApiText(detailPayload));
        if (fullText.length > MIN_USABLE_BODY) {
          bodyTextTruncated = fullText.length > 100_000;
          bodyText = fullText.slice(0, 100_000);
        } else {
          detailsWithoutUsableText += 1;
        }
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        failedDetailFetches += 1;
        notes.push(`Detay okunamadı (${row.itemId}): ${describeFetchFailure(error)}`);
      }

      items.push({
        sourceKey: source.key,
        sourceItemId: row.itemId,
        url: row.url,
        title: row.title,
        institution: row.institution ?? source.institution,
        ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
        ...(row.applicationEndAt ? { applicationEndAt: row.applicationEndAt } : {}),
        sourceCategory: row.sourceCategory,
        ...(bodyText
          ? { bodyText, bodyTextSource: 'detail' as const, rawExcerpt: bodyText.slice(0, 400) }
          : {}),
        ...(bodyTextTruncated ? { bodyTextTruncated: true } : {}),
        attachments: [],
        ...(row.referenceNo ? { referenceNo: row.referenceNo } : {}),
        ...(row.city ? { city: row.city } : {}),
        extractionConfidence: bodyText ? 0.8 : 0.5,
      });
    }

    // Aynı taramada tekrarlanan kurum kabuğunu gövdelerden çıkar (ör. birim/kurum bloğu).
    const bodyIndexes = items.map((item, index) => (item.bodyText ? index : -1)).filter((index) => index >= 0);
    const cleanedBodies = stripRepeatedBoilerplate(bodyIndexes.map((index) => items[index]?.bodyText ?? ''));
    bodyIndexes.forEach((itemIndex, position) => {
      const item = items[itemIndex];
      if (!item) return;
      const cleaned = cleanedBodies[position] ?? '';
      if (cleaned.length > MIN_USABLE_BODY) {
        item.bodyText = cleaned;
        item.rawExcerpt = cleaned.slice(0, 400);
      } else {
        // Kabuk çıkarıldıktan sonra kalan metin yetersiz: gövde yok sayılır, ilan başlıkla kalır.
        delete item.bodyText;
        delete item.rawExcerpt;
        delete item.bodyTextSource;
        delete item.bodyTextTruncated;
        item.extractionConfidence = 0.5;
      }
    });

    const deferred = Math.max(0, workRows.length - selectedRows.length);
    notes.push(
      `Arama havuzunda ${allRows.length} benzersiz ilan (toplam numFound=${totalNumFound}); ` +
        `bu çalışmada ${items.length} kayıt işlendi.`,
    );
    if (deferred > 0)
      notes.push(
        `${deferred} ilan detay bütçesi nedeniyle sonraki taramaya bırakıldı (bütçe ${ctx.maxDetailFetches}).`,
      );

    // Kapsam: tüm terimlerde offset sayfaları tükendiğinde havuz tamamlanmıştır;
    // ancak metin araması sitenin TÜM arşivini kanıtlamaz — bu yüzden kapsam
    // "complete" yalnız tam sayfa turu + yapı doğrulamasıyla verilir.
    const coverageNotes: string[] = [];
    if (failedDetailFetches > 0) coverageNotes.push(`${failedDetailFetches} detay isteği başarısız oldu.`);
    if (detailsWithoutUsableText > 0)
      coverageNotes.push(`${detailsWithoutUsableText} detay yanıtından kullanılabilir metin çıkarılamadı.`);
    if (deferred > 0) coverageNotes.push(`${deferred} kayıt detay bütçesi nedeniyle ertelendi.`);
    const capped = rowsByItem.size >= MAX_LIST_ITEMS;
    if (truncatedTerms.length > 0)
      coverageNotes.push(
        `${truncatedTerms.length} kategoride numFound'a ulaşılamadı (sayfa sınırı ${MAX_PAGES_PER_FILTER}): ` +
          truncatedTerms.join(', ') + '.',
      );
    if (capped) coverageNotes.unshift(`${MAX_LIST_ITEMS} kayıtlık havuz sınırına ulaşıldı; aramanın tamamı bu çalışmada alınmadı.`);
    const complete = !capped && truncatedTerms.length === 0 && coverageNotes.length === 0;
    const coverageNote = complete
      ? 'Tüm arama terimlerinde offset sayfaları sonuna kadar gezildi (AdsByFilter numFound doğrulaması). ' +
        'Metin araması tabanlı kapsam: arama terimleriyle eşleşen ilanların tamamı; terim dışı ilanlar kapsam dışıdır.'
      : coverageNotes.join(' ');

    return {
      items,
      requestCount,
      notes,
      etag: null,
      lastModified: null,
      notModified: false,
      coverage: { status: complete ? 'complete' : 'partial', note: coverageNote },
      httpStatuses,
    };
  }

  /** Liste adresinden API tabanını türetir (çift /api/api gerçektir). */
  private apiBaseOf(listingUrl: string): string {
    const url = new URL(listingUrl);
    return `${url.origin}${API_BASE_PATH}`;
  }

  private parseJson(response: FetchResponse): unknown {
    const text = response.decoded?.text ?? response.body.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new AdapterStructureError(
        this.key,
        'ilan.gov.tr API’si JSON olmayan yanıt döndürdü.',
        `Yanıt başlığı: "${makeExcerpt(normalizeTr(text), 120)}" — API sözleşmesi değişmiş olabilir.`,
      );
    }
  }

  private expectResult(
    payload: unknown,
    sourceKey: string,
  ): {
    numFound?: unknown;
    ads?: unknown;
  } {
    const root =
      payload && typeof payload === 'object' && 'result' in (payload as Record<string, unknown>)
        ? ((payload as Record<string, unknown>)['result'] as Record<string, unknown> | null)
        : null;
    if (!root || typeof root !== 'object' || !('ads' in root)) {
      throw new AdapterStructureError(
        this.key,
        `ilan.gov.tr API sözleşmesi beklenenden farklı (${sourceKey}).`,
        'AdsByFilter cevabında "result.ads" alanı yok; API değişmiş olabilir.',
      );
    }
    return root as { numFound?: unknown; ads?: unknown };
  }
}
