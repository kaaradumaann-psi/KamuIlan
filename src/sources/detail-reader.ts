/**
 * Ortak ilan DETAY okuyucusu (kurum liste adaptörü + Kariyer Kapısı dış bağlantıları).
 *
 * Neden ayrı modül: 23.10.2026 hat ölçümünde iki kayıp nedeni aynı köke çıktı —
 * ilan metni HTML sayfasında değil, sayfadan bağlanan PDF'teydi:
 *  - TKGM "Sözleşmeli Bilişim Personel Alım İlanı" detay sayfası yalnız
 *    "… için aşağıdaki bağlantıyı tıklayınız… İLAN" diyordu; metin
 *    `cms-api.tkgm.gov.tr/media/<n>/view` (uzantısız, `download` öznitelikli) PDF'te.
 *  - SPK "Meslek Personel Yardımcılığı Giriş Sınavı" satırı doğrudan PDF'e bağlanıyor;
 *    `fetchText` PDF içerik türünü reddettiği için detay hep "başarısız" kalıyordu.
 *
 * Kurallar:
 *  - Bağlantının kendisi PDF ise (uzantı) belge indirilip metin katmanı okunur.
 *  - HTML sayfasının metni kısa (yönlendirme cümlesi) ya da ekli belgenin etiketi ilan
 *    başlığıyla örtüşüyorsa EN FAZLA BİR belge indirilir; metni sayfa metninin arkasına eklenir.
 *  - OCR yapılmaz (detay bütçesi metin katmanı için; taranmış PDF metinsiz kalır ve
 *    kayıt "detay metni eksik" sayılarak sonraki taramada yeniden denenir).
 *  - Tüm istekler kaynağın izinli host listesi ve host başına hız sınırıyla yapılır.
 */
import { elementText, loadHtml, readableAnnouncementText } from '../lib/html';
import { isOfficialApplicationUrl, normalizeUrl } from '../domain/urls';
import { extractPdfText } from '../extraction/pdf';
import type { RawAnnouncement } from '../domain';
import { normalizeTr } from '../domain/text';
import { describeFetchFailure, FetchError, robotsDisallowMatch } from './fetcher';
import { budgetedTimeoutMs, hasBudgetFor } from './scan-budget';
import type { AdapterContext } from './types';

/** Tek detay sayfası için üst sınır (varsayılan SCRAPE_TIMEOUT_MS'ten bilinçli olarak kısa). */
export const DETAIL_TIMEOUT_MS = 20_000;
const PDF_TIMEOUT_MS = 30_000;
const PDF_MAX_BYTES = 15_728_640;
/** Bu uzunluğun altındaki sayfa metni ilan metni değil, belgeye yönlendirme sayılır. */
const STUB_TEXT_MAX_CHARS = 600;
/** Kullanılabilir gövde için asgari uzunluk (önceki davranışla aynı). */
const MIN_BODY_CHARS = 120;
const MAX_BODY_CHARS = 100_000;
/** Belge indirmesine başlamak için gereken asgari kalan tarama bütçesi. */
const MIN_PDF_BUDGET_MS = 8_000;

export interface DetailReadOptions {
  allowedHosts: readonly string[];
  minIntervalMs: number;
  /**
   * Hedef kaynağın robots.txt `Disallow` kuralları. Okuyucu başka bir kaynağın HTTP
   * istemcisiyle çağrıldığında (Kariyer Kapısı → kurum sayfası) istemcinin kendi
   * kuralları hedef host'u kapsamaz; kurallar burada her istekten önce denetlenir.
   */
  robotsDisallow?: readonly string[];
  /**
   * İlanın bilinen başlığı. Sayfa metni uzun olsa bile (kenar çubuğu/menü) etiketi bu
   * başlıkla örtüşen ekli belge ilan metnidir ve okunur (Adalet İİDB `SayfaDetay`
   * sayfası: 723 karakter menü + "… Sınav İlanı.pdf").
   */
  titleHint?: string;
}

export interface DetailReadResult {
  bodyText: string | null;
  bodyTextTruncated: boolean;
  /** Metnin geldiği yer: HTML sayfası, PDF bağlantısı ya da sayfa + ekli belge. */
  bodyFrom: 'html' | 'pdf' | 'html+pdf' | null;
  attachments: RawAnnouncement['attachments'];
  applicationUrl: string | null;
  requests: number;
  statuses: number[];
  failure: string | null;
  /** Operatör notu (belge okunamadı vb.). */
  notes: string[];
}

/** Bağlantı adresi bir belge mi (uzantıdan)? */
export function isDocumentUrl(url: string): boolean {
  try {
    return /\.(pdf|docx?)$/i.test(new URL(url).pathname);
  } catch {
    return /\.(pdf|docx?)(\?|$)/i.test(url);
  }
}

function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return /\.pdf(\?|$)/i.test(url);
  }
}

function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.some((allowed) => allowed.toLowerCase() === host);
  } catch {
    return false;
  }
}

function robotsBlocked(url: string, options: DetailReadOptions): string | null {
  if (!options.robotsDisallow?.length) return null;
  try {
    const rule = robotsDisallowMatch(new URL(url), options.robotsDisallow);
    return rule ? `robots.txt kuralı bu adresi yasaklıyor (Disallow: ${rule}); istek gönderilmedi.` : null;
  } catch {
    return 'Geçersiz adres.';
  }
}

function significantTokens(value: string): string[] {
  return normalizeTr(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/** Belge etiketi ilan başlığıyla örtüşüyor mu (başlık sözcüklerinin ≥ %70'i etikette)? */
export function labelMatchesTitle(label: string, title: string): boolean {
  const titleTokens = [...new Set(significantTokens(title))];
  if (titleTokens.length < 3) return false;
  const labelTokens = new Set(significantTokens(label));
  const hits = titleTokens.filter((token) => labelTokens.has(token)).length;
  return hits / titleTokens.length >= 0.7;
}

function emptyResult(): DetailReadResult {
  return {
    bodyText: null,
    bodyTextTruncated: false,
    bodyFrom: null,
    attachments: [],
    applicationUrl: null,
    requests: 0,
    statuses: [],
    failure: null,
    notes: [],
  };
}

async function readPdf(
  ctx: AdapterContext,
  url: string,
  options: DetailReadOptions,
): Promise<{ text: string; status: number | null; failure: string | null }> {
  const blocked = robotsBlocked(url, options);
  if (blocked) return { text: '', status: null, failure: blocked };
  try {
    const response = await ctx.http.fetchBinary(url, {
      allowedHosts: [...options.allowedHosts],
      minIntervalMs: options.minIntervalMs,
      maxBytes: PDF_MAX_BYTES,
      timeoutMs: budgetedTimeoutMs(ctx, PDF_TIMEOUT_MS),
      retries: 1,
    });
    const pdf = await extractPdfText(new Uint8Array(response.body), { maxPages: 16, maxChars: 60_000 });
    if (pdf.error) return { text: '', status: response.status, failure: `PDF okunamadı: ${pdf.error}` };
    if (pdf.noTextLayer) {
      return { text: '', status: response.status, failure: 'PDF metin katmanı yok (taranmış görüntü olabilir).' };
    }
    return { text: pdf.text, status: response.status, failure: null };
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
    return {
      text: '',
      status: error instanceof FetchError && error.status !== null ? error.status : null,
      failure: describeFetchFailure(error),
    };
  }
}

/**
 * İlan detayını okur. Hata fırlatmaz (iptal hariç): başarısızlık `failure` ile döner.
 */
export async function readAnnouncementDetail(
  ctx: AdapterContext,
  url: string,
  options: DetailReadOptions,
): Promise<DetailReadResult> {
  const result = emptyResult();

  // 1) Bağlantının kendisi PDF: ilan metni belgenin metin katmanıdır.
  if (isPdfUrl(url)) {
    const pdf = await readPdf(ctx, url, options);
    result.requests = 1;
    if (pdf.status !== null) result.statuses.push(pdf.status);
    result.attachments = [{ url, label: 'İlan belgesi (PDF)', kind: 'pdf' }];
    if (pdf.failure) {
      result.failure = pdf.failure;
      return result;
    }
    const text = pdf.text.trim();
    if (text.length > MIN_BODY_CHARS) {
      result.bodyText = text.slice(0, MAX_BODY_CHARS);
      result.bodyTextTruncated = text.length > MAX_BODY_CHARS;
      result.bodyFrom = 'pdf';
    }
    return result;
  }

  // 2) HTML detay sayfası.
  const blocked = robotsBlocked(url, options);
  if (blocked) {
    result.failure = blocked;
    return result;
  }
  let html: string;
  try {
    const response = await ctx.http.fetchText(url, {
      allowedHosts: [...options.allowedHosts],
      minIntervalMs: options.minIntervalMs,
      maxBytes: 3_000_000,
      // Kalan bütçeye sığan bir zaman aşımı: tek yavaş detay sayfası tüm
      // taramayı düşürmesin (SCRAPE_TIMEOUT_MS varsayılanı tek istek için çok uzun).
      timeoutMs: budgetedTimeoutMs(ctx, DETAIL_TIMEOUT_MS),
    });
    result.requests = 1;
    result.statuses.push(response.status);
    html = response.decoded?.text ?? response.body.toString('utf8');
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
    result.requests = 1;
    if (error instanceof FetchError && error.status !== null) result.statuses.push(error.status);
    result.failure = describeFetchFailure(error);
    return result;
  }

  const $ = loadHtml(html);
  const text = readableAnnouncementText(
    $,
    ['article', 'main', '.icerik', '.content', '#content', '#contentBox', '#DeltaPlaceHolderMain', 'body'],
    MAX_BODY_CHARS + 1,
  );
  const links = $('a[href]')
    .toArray()
    .map((element) => ({
      text: elementText($(element), 200),
      url: normalizeUrl($(element).attr('href') ?? '', url),
      // `download` öznitelikli bağlantı uzantısız da olsa belgedir (TKGM `/media/<n>/view`).
      download: $(element).attr('download') !== undefined,
    }))
    .filter((link): link is { text: string; url: string; download: boolean } => link.url !== null);

  const documentLinks = links.filter((link) => isDocumentUrl(link.url) || link.download);
  const seenDocs = new Set<string>();
  result.attachments = documentLinks
    .filter((link) => (seenDocs.has(link.url) ? false : (seenDocs.add(link.url), true)))
    .slice(0, 6)
    .map((link) => ({
      url: link.url,
      label: link.text.slice(0, 160) || 'Belge',
      kind: (/\.docx?$/i.test(link.url.split('?')[0] ?? '') ? 'doc' : 'pdf') as 'pdf' | 'doc',
    }));
  result.applicationUrl = links.find((link) => isOfficialApplicationUrl(link.url))?.url ?? null;

  const pageText = text.slice(0, MAX_BODY_CHARS);
  result.bodyTextTruncated = text.length > MAX_BODY_CHARS;
  if (pageText.length > MIN_BODY_CHARS) {
    result.bodyText = pageText;
    result.bodyFrom = 'html';
  }

  // 3) Sayfa yalnız belgeye yönlendiriyorsa ya da ekli belgenin etiketi ilan başlığının
  // kendisiyse ilan metni ekli belgededir: tek belge okunur.
  const pdfCandidates = result.attachments.filter(
    (attachment) => attachment.kind === 'pdf' && hostAllowed(attachment.url, options.allowedHosts),
  );
  const titled = options.titleHint
    ? pdfCandidates.find((attachment) => labelMatchesTitle(attachment.label, options.titleHint ?? ''))
    : undefined;
  if (pageText.length < STUB_TEXT_MAX_CHARS || titled) {
    const preferred =
      titled ??
      pdfCandidates.find((attachment) => /ilan|duyuru|alim|alım|sinav|sınav/i.test(attachment.label)) ??
      pdfCandidates[0];
    const offHost = result.attachments.find(
      (attachment) => attachment.kind === 'pdf' && !hostAllowed(attachment.url, options.allowedHosts),
    );
    if (!preferred && offHost) {
      // Belge izinli host listesinin dışında: indirilmez (kaynak şartları/izin listesi),
      // ama operatör "metin neden yok" sorusunun cevabını görsün.
      result.notes.push(`Ekli ilan belgesi izinli host listesi dışında; okunmadı (${offHost.url}).`);
    }
    if (preferred) {
      if (!hasBudgetFor(ctx, MIN_PDF_BUDGET_MS)) {
        result.notes.push(`Ekli ilan belgesi tarama bütçesi dolduğu için okunmadı (${preferred.url}).`);
      } else {
        const pdf = await readPdf(ctx, preferred.url, options);
        result.requests += 1;
        if (pdf.status !== null) result.statuses.push(pdf.status);
        const pdfText = pdf.text.trim();
        if (pdf.failure) {
          result.notes.push(`Ekli ilan belgesi okunamadı (${preferred.url}): ${pdf.failure}`);
        } else if (pdfText.length > MIN_BODY_CHARS) {
          // Başlıkla eşleşen belge ilanın kendisidir; uzun sayfa metni (menü/kenar
          // çubuğundaki başka duyuru başlıkları) sınıflandırmayı bulandırmasın diye eklenmez.
          const withPage = pageText.length > 0 && !(titled && pageText.length >= STUB_TEXT_MAX_CHARS);
          const combined = withPage ? `${pageText}\n\n${pdfText}` : pdfText;
          result.bodyText = combined.slice(0, MAX_BODY_CHARS);
          result.bodyTextTruncated = combined.length > MAX_BODY_CHARS;
          result.bodyFrom = withPage ? 'html+pdf' : 'pdf';
        }
      }
    }
  }
  return result;
}
