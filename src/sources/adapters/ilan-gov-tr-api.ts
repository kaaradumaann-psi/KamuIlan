/**
 * ilan.gov.tr JSON API adaptörü (Basın İlan Kurumu).
 *
 * İzin: CİMER üzerinden, 23.10.2026 (kullanıcı beyanı; config/source-terms.json).
 *
 * API sözleşmesi (herkese açık projelerden öğrenildi, 23.10.2026; kod kopyalanmadı):
 *   Taban:  https://www.ilan.gov.tr/api/api/services/app   (çift "api" gerçek)
 *   Liste:  POST Ad/AdsByFilter
 *           {"keys":{"txv":[<kategori>],"currentPage":[n]},"sorting":"publish_time desc",
 *            "skipCount":N,"maxResultCount":20}
 *           - Kategori süzgeci `keys.txv` (sitenin kendi isteğindeki alan). `q` metin araması 500 döndü.
 *           - Sunucu sayfa boyutunu 20'ye kırpar; skipCount dönen kayıt sayısı kadar ilerletilir.
 *           - Geçersiz `sorting` değeri hata VERMEZ, sessizce numFound=0 döner (izlenir).
 *   Cevap:  {"result":{"numFound":N,"ads":[...],"categories":[{taxId,name,slug,count}],"cityCounts":[...]}}
 *           Her ilan: id, adNo, title, advertiserName, addressCityName, publishStartDate, urlStr,
 *           isArchived, adTypeFilters[{key,value}] ("İlan Türü", "Son Başvuru" …).
 *   Detay:  GET AdDetail/GetAdDetail?id=<id> → result.content (ilanın tam HTML metni),
 *           result.adTypeFilters, result.categories.
 *
 * Kategoriler: 8 = Kamu / Akademik Personel (üst kategori), 73 = Akademik personel alımları
 * (alt kırılımları 672 öğretim üyesi, 693 arş. gör./öğr. gör./uzman — 73'ün içinde olduğu için
 * ayrıca istenmez). Memur/işçi/sözleşmeli alt kategori kimlikleri canlı doğrulanamadı (API bu
 * istemciye 403 döndü); yanıtın `categories` faseti notlara yazılır, ilk başarılı taramada
 * kimlikler oradan teyit edilir. Kategori süzgeci yok sayılırsa "İlan Türü" koruması personel
 * dışı kayıtları eler ve bunu notta bildirir.
 *
 * Yapılmayanlar: sitenin arayüzünü taklit eden başlıklar (ör. x-request-origin), tarayıcı
 * kimliği taklidi, TLS doğrulamasını kapatmak. Erişim reddi (401/403) aşılmaz.
 */
import { collapseWhitespace, makeExcerpt, normalizeTr, stripHtmlTags, stripUiChrome } from '../../domain/text';
import { toIstanbulIso } from '../../domain/dates';
import type { JobAttachment, RawAnnouncement } from '../../domain';
import { AdapterStructureError, SourceAccessError } from '../errors';
import { assertSafeUrl, describeFetchFailure, FetchError, type FetchResponse } from '../fetcher';
import { hasBudgetFor } from '../scan-budget';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

const API_BASE_PATH = '/api/api/services/app';
/** Sunucu daha büyük değerleri 20'ye kırpıyor. */
export const PAGE_SIZE = 20;
/** Kategori başına en fazla sayfa. */
export const MAX_PAGES_PER_CATEGORY = 25;
/** Çalışma başına toplam liste sayfası üst sınırı (≥2 sn aralıkla ~2 dk). */
export const MAX_LIST_PAGES = 40;
/** Çalışma başına en fazla detay isteği (ctx.maxDetailFetches ile birlikte). */
export const MAX_DETAILS = 40;
/** Sayfadaki tüm ilanlar bu kadar günden eskiyse ve başvurusu kapalıysa sayfalama durur. */
export const STALE_DAYS = 90;
const DETAIL_BUDGET_MS = 10_000;
const PAGE_BUDGET_MS = 8_000;

export interface IlanGovTrCategory {
  txv: number;
  label: string;
}

/** Kamu personeli kategorileri (bkz. dosya başı; alt kategoriler üst kategoride kapsanır). */
export const PERSONNEL_CATEGORIES: readonly IlanGovTrCategory[] = [
  { txv: 8, label: 'Kamu / Akademik Personel' },
  { txv: 73, label: 'Akademik personel alımları' },
];

interface ApiFilter {
  key?: string | null;
  value?: string | null;
}

interface ApiAd {
  id?: string | number;
  adNo?: string | number | null;
  title?: string | null;
  advertiserName?: string | null;
  addressCityName?: string | null;
  addressCountyName?: string | null;
  publishStartDate?: string | null;
  urlStr?: string | null;
  isArchived?: boolean | null;
  adTypeFilters?: ApiFilter[] | null;
}

interface ParsedRow {
  /** Kayıt kimliği (resmî ilan no varsa adNo, yoksa id). Kalıcı tekil anahtar. */
  itemId: string;
  /** GetAdDetail'in beklediği kimlik (`id` alanı). */
  detailId: string;
  url: string;
  title: string;
  institution: string | null;
  city: string | null;
  district: string | null;
  publishedAt: string | null;
  applicationEndAt: string | null;
  referenceNo: string | null;
  category: string;
}

const HTML_TAG = /<[^>]+>/g;
const DOC_EXTENSIONS: Record<string, JobAttachment['kind']> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'excel',
  xlsx: 'excel',
  odt: 'doc',
  rtf: 'doc',
};

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

/** JSON'daki TÜM metin değerlerini topla (detayda `content` yoksa şemadan bağımsız yedek). */
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
export function deadlineFromAdFilters(filters: ApiFilter[] | null | undefined): string | null {
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

/**
 * "İlan Türü" filtresi personel alımı DIŞINDA bir tür bildiriyor mu? Alan yoksa karar verilmez
 * (false): kategori süzgecine güvenilir.
 */
export function isNonPersonnelAdType(filters: ApiFilter[] | null | undefined): boolean {
  for (const pair of filters ?? []) {
    const key = normalizeTr(String(pair.key ?? ''));
    if (!key.includes('ilan turu')) continue;
    const value = normalizeTr(String(pair.value ?? ''));
    if (value.length === 0) return false;
    return !value.includes('personel');
  }
  return false;
}

/** Detay HTML'inden bağlantıları ve belge eklerini çıkarır (yalnız izinli alan adları). */
export function extractDetailLinks(
  html: string,
  baseUrl: string,
  allowedHosts: readonly string[],
): { links: { text: string; url: string }[]; attachments: JobAttachment[] } {
  const links: { text: string; url: string }[] = [];
  const attachments: JobAttachment[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = (match[1] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue;
    const url = absolute.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const text = collapseWhitespace(stripHtmlTags(match[2] ?? '')).slice(0, 200);
    links.push({ text, url });
    const extension = /\.([a-z0-9]{2,5})$/i.exec(absolute.pathname)?.[1]?.toLowerCase() ?? '';
    const kind = DOC_EXTENSIONS[extension];
    if (!kind) continue;
    try {
      assertSafeUrl(url, allowedHosts);
    } catch {
      continue; // Dış alan adındaki belge yalnız bağlantı olarak kalır; indirilmez.
    }
    attachments.push({ url, label: text || `Ek (${extension.toUpperCase()})`, kind });
  }
  return { links, attachments };
}

function dayDiff(fromIsoDate: string, to: Date): number {
  const from = Date.parse(`${fromIsoDate}T00:00:00+03:00`);
  return Number.isFinite(from) ? (to.getTime() - from) / 86_400_000 : 0;
}

function rowFromAd(
  ad: ApiAd,
  listingUrl: string,
  allowedHosts: readonly string[],
  category: string,
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
    district: collapseWhitespace(String(ad.addressCountyName ?? '')) || null,
    publishedAt,
    applicationEndAt: deadlineFromAdFilters(ad.adTypeFilters),
    referenceNo: adNo || null,
    category,
  };
}

interface DetailResult {
  bodyText: string | null;
  truncated: boolean;
  applicationEndAt: string | null;
  links: { text: string; url: string }[];
  attachments: JobAttachment[];
}

export class IlanGovTrApiAdapter implements SourceAdapter {
  readonly key = 'ilan-gov-tr-api';
  readonly label = 'ilan.gov.tr — JSON API (kamu personeli kategorileri)';
  readonly method = 'json-api';
  readonly notes =
    'Basın İlan Kurumu portalının JSON API’si: AdsByFilter ile kategori (txv) listesi, skipCount ile ' +
    '20’lik offset sayfalama (çalışma başına üst sınır), GetAdDetail ile ilanın tam metni (content). ' +
    'Yapılandırılmış alanlar (kurum, il/ilçe, resmî ilan no, "Son Başvuru") doğrudan okunur.';

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
    const apiBase = `${new URL(listingUrl).origin}${API_BASE_PATH}`;
    const now = ctx.fetchedAt;
    let requestCount = 0;
    let listPages = 0;
    const rowsByItem = new Map<string, ParsedRow>();
    const perCategory = new Map<string, number>();
    let archived = 0;
    let expired = 0;
    let nonPersonnel = 0;
    let seenAds = 0;
    const incomplete: string[] = [];
    let zeroCategories = 0;
    const facets = new Map<string, string>();

    for (const category of PERSONNEL_CATEGORIES) {
      let skipCount = 0;
      let exhausted = false;
      let reason = '';
      for (let page = 1; page <= MAX_PAGES_PER_CATEGORY; page += 1) {
        if (listPages >= MAX_LIST_PAGES) {
          reason = `çalışma başına ${MAX_LIST_PAGES} sayfa sınırı`;
          break;
        }
        if (!hasBudgetFor(ctx, PAGE_BUDGET_MS)) {
          reason = 'tarama zaman bütçesi';
          break;
        }
        const payload = await this.fetchPage(ctx, apiBase, category, page, skipCount, httpStatuses);
        requestCount += 1;
        listPages += 1;

        const result = this.expectResult(payload, source.key);
        const ads = Array.isArray(result.ads) ? (result.ads as ApiAd[]) : [];
        const numFound = Number(result.numFound ?? 0);
        if (page === 1) {
          if (numFound === 0) zeroCategories += 1;
          for (const facet of Array.isArray(result.categories) ? result.categories : []) {
            const entry = facet as { taxId?: unknown; name?: unknown; count?: unknown };
            if (entry.taxId === undefined || entry.taxId === null) continue;
            facets.set(String(entry.taxId), `${String(entry.name ?? '?')} (${String(entry.count ?? '?')})`);
          }
        }

        let staleOnPage = 0;
        for (const ad of ads) {
          seenAds += 1;
          if (ad.isArchived === true) {
            archived += 1;
            continue;
          }
          if (isNonPersonnelAdType(ad.adTypeFilters)) {
            nonPersonnel += 1;
            continue;
          }
          const row = rowFromAd(ad, listingUrl, source.allowedHosts, category.label);
          if (!row) continue;
          const closed = row.applicationEndAt !== null && Date.parse(row.applicationEndAt) < now.getTime();
          if (closed) {
            expired += 1;
            if (row.publishedAt && dayDiff(row.publishedAt, now) > STALE_DAYS) staleOnPage += 1;
            continue;
          }
          if (!rowsByItem.has(row.itemId)) {
            rowsByItem.set(row.itemId, row);
            perCategory.set(category.label, (perCategory.get(category.label) ?? 0) + 1);
          }
        }
        notes.push(`txv=${category.txv} sayfa ${page}: ${ads.length} kayıt (numFound=${numFound}).`);

        skipCount += ads.length;
        if (ads.length === 0 || skipCount >= numFound) {
          exhausted = true;
          break;
        }
        // publish_time desc: sayfanın tamamı eski ve kapanmışsa daha derini de öyledir.
        if (staleOnPage === ads.length) {
          exhausted = true;
          notes.push(`txv=${category.txv}: ${STALE_DAYS} günden eski, başvurusu kapanmış sayfaya ulaşıldı; durdu.`);
          break;
        }
        if (page === MAX_PAGES_PER_CATEGORY) reason = `kategori başına ${MAX_PAGES_PER_CATEGORY} sayfa sınırı`;
      }
      if (!exhausted) incomplete.push(`txv=${category.txv} (${reason || 'sınır'})`);
    }

    if (facets.size > 0) {
      notes.push(
        `Kategori faseti: ${[...facets.entries()].map(([id, label]) => `${id}=${label}`).join('; ')}.`,
      );
    }
    if (nonPersonnel > 0) {
      const share = seenAds > 0 ? Math.round((nonPersonnel / seenAds) * 100) : 0;
      notes.push(
        `${nonPersonnel} kayıt "İlan Türü" personel alımı olmadığı için elendi (%${share})` +
          (share >= 50 ? ' — kategori süzgeci (txv) yok sayılıyor olabilir; kimlikleri doğrulayın.' : '.'),
      );
    }

    // Detay bütçesi önce yeni ilanlara, sonra ayrıntısı daha önce alınamamış ilanlara harcanır.
    const known = ctx.knownItemIds ?? new Set<string>();
    const withDetail = ctx.knownItemIdsWithDetail ?? new Set<string>();
    const allRows = [...rowsByItem.values()];
    const fresh = allRows.filter((row) => !known.has(row.itemId));
    const retry = allRows.filter((row) => known.has(row.itemId) && !withDetail.has(row.itemId));
    const detailLimit = Math.min(ctx.maxDetailFetches, MAX_DETAILS);
    const details = new Map<string, DetailResult>();
    let detailFetches = 0;
    let detailDeferred = 0;
    let failedDetails = 0;
    let detailsWithoutText = 0;
    for (const row of [...fresh, ...retry]) {
      if (detailFetches >= detailLimit || !hasBudgetFor(ctx, DETAIL_BUDGET_MS)) {
        detailDeferred += 1;
        continue;
      }
      detailFetches += 1;
      try {
        const detail = await this.fetchDetail(ctx, apiBase, row, httpStatuses);
        requestCount += 1;
        if (detail.bodyText) details.set(row.itemId, detail);
        else detailsWithoutText += 1;
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        requestCount += 1;
        failedDetails += 1;
        notes.push(`Detay okunamadı (${row.itemId}): ${describeFetchFailure(error)}`);
      }
    }

    const emitted = [...fresh, ...retry.filter((row) => details.has(row.itemId))];
    const items: RawAnnouncement[] = emitted.map((row) => this.toAnnouncement(row, details.get(row.itemId) ?? null, source));

    // Aynı taramada tekrarlanan kurum kabuğunu gövdelerden çıkar.
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
        delete item.bodyText;
        delete item.rawExcerpt;
        delete item.bodyTextSource;
        delete item.bodyTextTruncated;
        item.extractionConfidence = 0.5;
      }
    });

    notes.push(
      `${requestCount} istek; ${allRows.length} açık personel ilanı (` +
        PERSONNEL_CATEGORIES.map((category) => `${category.label}: ${perCategory.get(category.label) ?? 0}`).join(', ') +
        `), ${expired} başvurusu kapanmış ve ${archived} arşiv kaydı atlandı; ${details.size} detay okundu, ` +
        `${items.length} kayıt hazırlandı.`,
    );
    if (detailDeferred > 0)
      notes.push(
        `Detay bütçesi (${detailLimit}) doldu; ${detailDeferred} ilanın ayrıntısı sonraki taramalarda alınacak ` +
          '(yeni ilanlar liste bilgisiyle kaydedildi).',
      );
    if (failedDetails > 0) notes.push(`${failedDetails} detay isteği başarısız oldu.`);
    if (detailsWithoutText > 0) notes.push(`${detailsWithoutText} detay yanıtından kullanılabilir metin çıkmadı.`);

    let coverage: NonNullable<AdapterRunResult['coverage']>;
    if (zeroCategories === PERSONNEL_CATEGORIES.length) {
      coverage = {
        status: 'unknown',
        note: 'Tüm kategoriler numFound=0 döndü; sıralama/kategori sözleşmesi değişmiş olabilir (API hata vermeden boş döner).',
      };
    } else if (incomplete.length > 0) {
      coverage = {
        status: 'partial',
        note: `Sayfalama tamamlanmadı: ${incomplete.join(', ')}; kalan sayfalar sonraki taramaya kaldı.`,
      };
    } else {
      coverage = {
        status: 'complete',
        note:
          'Kamu personeli kategorilerinde (txv ' +
          PERSONNEL_CATEGORIES.map((category) => category.txv).join(', ') +
          ') offset sayfaları sonuna ya da başvurusu kapanmış eski kayıtlara kadar gezildi.',
      };
    }
    notes.push(`Liste kapsamı: ${coverage.status} — ${coverage.note}`);

    return {
      items,
      requestCount,
      notes,
      etag: null,
      lastModified: null,
      notModified: false,
      coverage,
      httpStatuses,
    };
  }

  private async fetchPage(
    ctx: AdapterContext,
    apiBase: string,
    category: IlanGovTrCategory,
    page: number,
    skipCount: number,
    httpStatuses: number[],
  ): Promise<unknown> {
    const { source } = ctx;
    try {
      const response = await ctx.http.fetchText(`${apiBase}/Ad/AdsByFilter`, {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
        method: 'POST',
        jsonBody: {
          keys: { txv: [category.txv], currentPage: [page] },
          sorting: 'publish_time desc',
          skipCount,
          maxResultCount: PAGE_SIZE,
        },
        accept: 'application/json',
        expectedContentTypes: ['application/json', 'text/json', 'text/plain'],
      });
      httpStatuses.push(response.status);
      return this.parseJson(response);
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      if (error instanceof AdapterStructureError || error instanceof SourceAccessError) throw error;
      if (error instanceof FetchError && (error.status === 403 || error.status === 401)) {
        throw new SourceAccessError(
          source.key,
          `ilan.gov.tr API’si bu istemciye erişim vermiyor (HTTP ${error.status}). Erişim kısıtı aşılmaz; ` +
            'sitenin arayüz başlıkları taklit edilmez. Basın İlan Kurumu’ndan izinli erişim yöntemi istenmeli.',
          error.status,
        );
      }
      throw error;
    }
  }

  private async fetchDetail(
    ctx: AdapterContext,
    apiBase: string,
    row: ParsedRow,
    httpStatuses: number[],
  ): Promise<DetailResult> {
    const { source } = ctx;
    const response = await ctx.http.fetchText(
      `${apiBase}/AdDetail/GetAdDetail?id=${encodeURIComponent(row.detailId)}`,
      {
        allowedHosts: source.allowedHosts,
        minIntervalMs: source.minRequestIntervalMs,
        accept: 'application/json',
        expectedContentTypes: ['application/json', 'text/json', 'text/plain'],
      },
    );
    httpStatuses.push(response.status);
    const payload = this.parseJson(response) as { result?: unknown } | null;
    const result =
      payload && typeof payload === 'object' && payload.result && typeof payload.result === 'object'
        ? (payload.result as { content?: unknown; adTypeFilters?: ApiFilter[] | null })
        : null;
    const html = typeof result?.content === 'string' ? result.content : '';
    const text = stripUiChrome(collapseWhitespace(html ? stripHtmlTags(html) : collectApiText(result ?? payload)));
    const { links, attachments } = html
      ? extractDetailLinks(html, row.url, source.allowedHosts)
      : { links: [], attachments: [] };
    return {
      bodyText: text.length > MIN_USABLE_BODY ? text.slice(0, 100_000) : null,
      truncated: text.length > 100_000,
      applicationEndAt: deadlineFromAdFilters(result?.adTypeFilters ?? null),
      links,
      attachments,
    };
  }

  private toAnnouncement(
    row: ParsedRow,
    detail: DetailResult | null,
    source: AdapterContext['source'],
  ): RawAnnouncement {
    const bodyText = detail?.bodyText ?? null;
    const applicationEndAt = row.applicationEndAt ?? detail?.applicationEndAt ?? null;
    return {
      sourceKey: source.key,
      sourceItemId: row.itemId,
      url: row.url,
      title: row.title,
      institution: row.institution ?? source.institution,
      ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
      ...(applicationEndAt ? { applicationEndAt } : {}),
      sourceCategory: row.category,
      ...(bodyText ? { bodyText, bodyTextSource: 'detail' as const, rawExcerpt: bodyText.slice(0, 400) } : {}),
      ...(detail?.truncated ? { bodyTextTruncated: true } : {}),
      attachments: detail?.attachments ?? [],
      ...(detail && detail.links.length > 0 ? { links: detail.links } : {}),
      ...(row.referenceNo ? { referenceNo: row.referenceNo } : {}),
      ...(row.city ? { city: row.city } : {}),
      ...(row.district ? { district: row.district } : {}),
      extractionConfidence: bodyText ? 0.8 : 0.5,
    };
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
  ): { numFound?: unknown; ads?: unknown; categories?: unknown } {
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
    return root as { numFound?: unknown; ads?: unknown; categories?: unknown };
  }
}
