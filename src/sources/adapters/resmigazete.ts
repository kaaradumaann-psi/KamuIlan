/**
 * Resmî Gazete — Çeşitli İlânlar adaptörü (PDF tabanlı).
 *
 * Doğrulanmış akış (12.10.2026, canlı):
 *   /fihrist?tarih=YYYY-MM-DD  → günün bölüm bağlantıları
 *   /ilanlar/eskiilanlar/YYYY/MM/YYYYMMDD-4.htm → "ÇEŞİTLİ İLÂNLAR" tablosu
 *   Her satır bir kurum ilanı ve ilgili PDF'e (…-4-N.pdf) bağlantı verir.
 *
 * İlan metninin TAMAMI PDF içindedir; bu yüzden PDF indirilip metin katmanı
 * okunur. Taranmış PDF'lerde metin katmanı bulunmaz: bu durumda kayıt yine
 * oluşturulur (ek saklanır, durum "metin katmanı yok" olarak bildirilir) ve
 * metin gerektiren alanlar boş bırakılır — tahmin yürütülmez.
 */
import { collapseWhitespace, normalizeTr } from '../../domain/text';
import { firstDateOnlyIn } from '../../domain/dates';
import { addDaysDateOnly, toIstanbulDateOnly, toIstanbulIso } from '../../domain/dates';
import { normalizeUrl } from '../../domain/urls';
import type { JobAttachment, RawAnnouncement } from '../../domain';
import { AdapterStructureError } from '../errors';
import { cleanInstitution, ownCardText } from '../listing-utils';
import { loadHtml, readableText, absoluteUrl } from '../../lib/html';
import { extractPdfText } from '../../extraction/pdf';
import { sharedOcrEngine } from '../../extraction/ocr';
import { getEnv } from '../../config/env';
import { join } from 'node:path';
import { budgetedTimeoutMs, hasBudgetFor } from '../scan-budget';
import { assertSafeUrl, FetchError, isTransientTransportFailure, type FetchResponse } from '../fetcher';
import { launchChromium } from '../browser-session';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import { detectNextPage } from '../pagination';

const RESMI_GAZETE_HOST = 'https://www.resmigazete.gov.tr';
const SECTION_PATTERN = /-\d+\.htm$/i;
const PDF_PATTERN = /\.pdf$/i;
const MAX_SECTION_PAGES = 10;
/**
 * Tek PDF için üst sınır. Eski değer 60 sn idi: erişilemeyen beş PDF, tarama
 * bütçesinin (SCRAPE_TIMEOUT_MS) tamamını yutup nüshayı düşürüyordu
 * (2026-10-16 canlı koşum: tek kaynak 560 sn, `UND_ERR_HEADERS_TIMEOUT`).
 */
const PDF_TIMEOUT_MS = 25_000;
/** Bir PDF indirmesine başlamak için gereken asgari kalan bütçe. */
const MIN_PDF_BUDGET_MS = 8_000;
/**
 * Tek bölüm (liste) sayfası isteği için üst sınır. Verilmediğinde HttpClient varsayılanı tüm tarama
 * bütçesidir (SCRAPE_TIMEOUT_MS): sunucu yanıt başlığını göndermeyip bağlantıyı askıda tuttuğunda
 * (22.10.2026 üretim provası, `UND_ERR_HEADERS_TIMEOUT`) tek istek + yeniden deneme 120 sn'nin tamamını
 * yiyip taramayı kısmi sonuç yerine "başarısız" bitiriyordu.
 */
const SECTION_TIMEOUT_MS = 20_000;

type CoverageStatus = 'complete' | 'partial' | 'unknown';

interface SectionRow {
  index: number;
  pdfUrl: string;
  rowText: string;
}

/**
 * A pager can only advance within the current dated "Çeşitli İlânlar"
 * section. Do not let an HTML link turn pagination into an arbitrary fetch.
 */
function allowlistedSectionPageUrl(
  candidate: string,
  sectionUrl: string,
  allowedHosts: readonly string[],
): string | null {
  if (candidate.length > 2_048) return null;
  try {
    const next = new URL(candidate);
    const section = new URL(sectionUrl);
    if (
      next.username.length > 0 ||
      next.password.length > 0 ||
      next.protocol !== 'https:' ||
      (next.port.length > 0 && next.port !== '443')
    ) {
      return null;
    }

    const sectionHost = section.hostname.toLowerCase();
    const nextHost = next.hostname.toLowerCase();
    const withoutWww = (host: string): string => host.replace(/^www\./, '');
    const sectionHostAllowed = allowedHosts.some((host) => host.toLowerCase() === sectionHost);
    if (nextHost !== sectionHost && withoutWww(nextHost) === withoutWww(sectionHost) && sectionHostAllowed) {
      // detectNextPage normalizes away "www". Restore the listing origin so
      // the browser fallback can still fetch same-origin PDFs on later pages.
      next.hostname = sectionHost;
    }
    const hostAllowed = allowedHosts.some((host) => host.toLowerCase() === next.hostname.toLowerCase());
    if (!hostAllowed) return null;

    const directory = (pathname: string): string =>
      pathname.slice(0, pathname.lastIndexOf('/')).toLowerCase();
    if (directory(next.pathname) !== directory(section.pathname)) return null;

    const sectionFilename = section.pathname.slice(section.pathname.lastIndexOf('/') + 1).toLowerCase();
    const sectionStem = sectionFilename.replace(/\.html?$/i, '');
    const pageFilename = next.pathname.slice(next.pathname.lastIndexOf('/') + 1).toLowerCase();
    if (pageFilename !== `${sectionStem}.htm` && pageFilename !== `${sectionStem}.html`) {
      const suffix = pageFilename.slice(sectionStem.length);
      if (!/^-\d+\.html?$/i.test(suffix)) return null;
    }

    return next.toString();
  } catch {
    return null;
  }
}

export interface SectionBrowserSession {
  fetchHtml(url: string): Promise<string>;
  fetchBytes(url: string): Promise<Buffer>;
  close(): Promise<void>;
}

export interface SectionBrowser {
  open(allowedHosts: readonly string[], signal?: AbortSignal): Promise<SectionBrowserSession>;
}

/**
 * Gerçek tarayıcı oturumu: bölüm sayfası gezilerek, PDF'ler sayfa içinden
 * (aynı köken) çekilir. Sunucu, tarayıcı-dışı istemcileri yavaşlattığında
 * devreye girer; herkesin tarayıcıyla okuyabildiği resmî gazete okunur,
 * kimlik gizleme/kimlik sahteciliği yapılmaz.
 */
class PlaywrightSectionBrowser implements SectionBrowser {
  async open(allowedHosts: readonly string[], signal?: AbortSignal): Promise<SectionBrowserSession> {
    const session = await launchChromium({ allowedHosts, signal });
    const page = session.page;
    let navigated = false;
    return {
      async fetchHtml(url: string): Promise<string> {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        navigated = true;
        return page.content();
      },
      async fetchBytes(url: string): Promise<Buffer> {
        if (!navigated) {
          await page.goto(new URL(url).origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          navigated = true;
        }
        const base64 = await page.evaluate(async (target: string) => {
          const MAX_BYTES = 15_728_640;
          const response = await fetch(target);
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`HTTP ${response.status}`);
          }
          const contentLength = Number(response.headers.get('content-length') ?? 0);
          if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('PDF boyut sınırı aşıldı (tarayıcı yolu).');
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error('PDF yanıt gövdesi okunamadı (tarayıcı yolu).');
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_BYTES) {
              await reader.cancel().catch(() => undefined);
              throw new Error('PDF boyut sınırı aşıldı (tarayıcı yolu).');
            }
            chunks.push(value);
          }
          const bytes = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          return btoa(binary);
        }, url);
        const body = Buffer.from(base64, 'base64');
        if (body.byteLength > 15_728_640) throw new Error('PDF boyut sınırı aşıldı (tarayıcı yolu).');
        return body;
      },
      close: () => session.close(),
    };
  }
}

/** Günün "Çeşitli İlânlar" bölüm sayfasının adresi (adaptörün ve probe'un ortak kaynağı). */
export function resmiGazeteSectionUrl(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  return `${RESMI_GAZETE_HOST}/ilanlar/eskiilanlar/${year}/${month}/${year}${month}${day}-4.htm`;
}

export interface SectionPageDiagnostics {
  title: string | null;
  anchorCount: number;
  pdfLinkCount: number;
  /** Adaptörün gerçekte çıkardığı satır sayısı (parseSectionRows ile aynı kod). */
  parsedRows: number;
  tableCount: number;
  htmlContentPresent: boolean;
  /** Engel/doğrulama sayfası izi (erişim engellendi, captcha, challenge vb.). */
  challengeHint: boolean;
  /** Menü dışındaki ilk metin; yalnızca kısa bir teşhis için, sayfa içeriği değildir. */
  textHead: string;
}

/**
 * Bölüm sayfasının yapısını bir kez özetler. Sayfa içeriği saklanmaz; yalnızca sayımlar,
 * başlık ve kısa bir metin başı döner. Canlı teşhiste "PDF bağlantısı yok" ile "engel sayfası"
 * ayrımını yapmak için kullanılır.
 */
export function describeSectionPage(html: string, pageUrl: string): SectionPageDiagnostics {
  const $ = loadHtml(html);
  const text = readableText($, 'body');
  const normalized = normalizeTr(text.slice(0, 4_000));
  return {
    title: collapseWhitespace($('title').first().text()) || null,
    anchorCount: $('a[href]').length,
    pdfLinkCount: $('a[href]').filter((_index, element) =>
      /\.pdf(?:$|[?#])/i.test($(element).attr('href') ?? ''),
    ).length,
    parsedRows: new ResmiGazeteAdapter().parseSectionRows($, pageUrl).length,
    tableCount: $('table').length,
    htmlContentPresent: $('#html-content').length > 0,
    challengeHint: /\b(?:erisim engellen\w*|access denied|captcha|cloudflare|just a moment|challenge)\b/.test(
      normalized,
    ),
    textHead: text.slice(0, 160),
  };
}

export class ResmiGazeteAdapter implements SourceAdapter {
  constructor(private readonly browser: SectionBrowser | null = null) {}

  private async openBrowser(
    allowedHosts: readonly string[],
    signal?: AbortSignal,
  ): Promise<SectionBrowserSession> {
    return (this.browser ?? new PlaywrightSectionBrowser()).open(allowedHosts, signal);
  }

  readonly key = 'resmigazete-cestili';
  readonly label = 'Resmî Gazete — Çeşitli İlânlar';
  readonly method = 'pdf-index';
  readonly notes =
    'Günlük nüshadaki Çeşitli İlânlar bölümü HTML olarak okunur, ilan metni PDF metin katmanından çıkarılır. ' +
    'Günlük bölüm sayfalaması izinli alan adı içinde en fazla 10 sayfa izlenir; açık son-sayfa işareti yoksa tamlık bilinmiyor olarak bildirilir. ' +
    'HTTP istemcisi cevap alamazsa (sunucu tarayıcı-dışı istemciyi yavaşlatıyorsa) aynı sayfalar gerçek tarayıcıyla okunur. ' +
    'Yargı/ihale bölümleri kapsam dışıdır.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const items: RawAnnouncement[] = [];
    const notes: string[] = [];
    let requestCount = 0;
    let etag: string | null = null;
    let lastModified: string | null = null;
    let notModified = false;
    let detailFetches = 0;
    let failedPdfFetches = 0;
    // OCR (taranmış belge): ayar açıksa, koşu başı sınır dolmadıysa ve tarama bütçesi
    // yetiyorsa. Belge başı ~5–15 sn CPU; sınır, taramanın zaman aşımına düşmesini önler.
    const env = getEnv();
    let ocrDocs = 0;
    const ocrEngine = sharedOcrEngine({
      enabled: env.OCR_ENABLED,
      langPath: env.OCR_LANG_PATH,
      cachePath: join(env.DATA_DIR, 'ocr-cache'),
    });
    let limitNoted = false;
    // Zaman bütçesi dolduğunda kalan belgeler atlanır ve koşum KISMİ kapsamla
    // döner (eski davranış: sert zaman aşımı → hiçbir kayıt oluşmaz).
    let budgetNoted = false;
    let budgetExhausted = false;
    let deferredByBudget = 0;
    const sectionDatesRead: string[] = [];
    const sectionCoverages: { dateOnly: string; status: CoverageStatus; note: string }[] = [];
    const seenItemIds = new Set<string>(ctx.knownItemIds ?? []);

    if (!ctx.liveFetch) {
      notes.push(
        'Canlı erişim kapalı (SOURCE_LIVE_FETCH=0): adaptör yalnızca yapılandırma doğrulaması yaptı.',
      );
      return {
        items,
        requestCount,
        notes,
        etag,
        lastModified,
        notModified,
        coverage: {
          status: 'unknown',
          note: 'Canlı erişim kapalı olduğu için günlük nüsha ve liste kapsamı doğrulanmadı.',
        },
      };
    }

    const today = toIstanbulDateOnly(ctx.fetchedAt);
    const days = [0, 1]; // Bugün yayımlanmadıysa dünkü nüsha okunur.
    const browserSessionRef: { current: SectionBrowserSession | null } = { current: null };

    const fetchSectionPage = async (
      url: string,
      dateOnly: string,
    ): Promise<{ response: FetchResponse | null; html: string }> => {
      try {
        const response = await ctx.http.fetchText(url, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
          retries: 1,
          timeoutMs: budgetedTimeoutMs(ctx, SECTION_TIMEOUT_MS),
        });
        requestCount += 1;
        return { response, html: response.decoded?.text ?? response.body.toString('utf8') };
      } catch (error) {
        requestCount += 1;
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        if (!isTransientTransportFailure(error)) throw error;
        try {
          const safeUrl = assertSafeUrl(url, ctx.source.allowedHosts).toString();
          const browserSession = (browserSessionRef.current ??= await this.openBrowser(
            ctx.source.allowedHosts,
            ctx.signal,
          ));
          const html = await browserSession.fetchHtml(safeUrl);
          notes.push(`${dateOnly} nüshası HTTP ile alınamadı; sayfa tarayıcı ile okundu.`);
          return { response: null, html };
        } catch (browserError) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? browserError;
          // Preserve the HTTP failure as the primary cause, matching the
          // existing browser-fallback behavior for the first section page.
          throw error;
        }
      }
    };

    try {
      for (const offset of days) {
        if (budgetExhausted) break;
        const dateOnly = addDaysDateOnly(today, -offset);
        const sectionUrl = this.sectionUrl(dateOnly);
        let firstPage: { response: FetchResponse | null; html: string };
        try {
          firstPage = await fetchSectionPage(sectionUrl, dateOnly);
        } catch (error) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
          const currentIssueNotPublished =
            offset < days.length - 1 && error instanceof FetchError && error.status === 404;
          if (error instanceof FetchError && error.status !== null && !currentIssueNotPublished) throw error;
          if (offset < days.length - 1) {
            const note =
              `Nüsha/bölüm sayfası alınamadı (${error instanceof Error ? error.message : String(error)}); ` +
              'bir önceki gün denenecek; bu tarih için kapsam kısmi.';
            sectionCoverages.push({ dateOnly, status: 'partial', note });
            notes.push(`${dateOnly} ${note}`);
            continue;
          }
          throw error;
        }

        if (offset === 0 && firstPage.response) {
          etag = firstPage.response.etag;
          lastModified = firstPage.response.lastModified;
        }
        if (firstPage.response?.notModified) {
          sectionCoverages.push({
            dateOnly,
            status: 'unknown',
            note: 'Bölüm 304 döndürdü; bu çalışmada içeriği ve sayfalama sonu yeniden doğrulanmadı.',
          });
          notes.push(`${dateOnly} nüshası değişmemiş (304).`);
          if (offset === 0) {
            notModified = true;
            break;
          }
          continue;
        }

        sectionDatesRead.push(dateOnly);
        let currentUrl = sectionUrl;
        let currentHtml = firstPage.html;
        const visitedPages = new Set<string>();
        let sectionStatus: CoverageStatus = 'unknown';
        let sectionNote = `${dateOnly} sayfa kapsamı son sayfa işaretiyle doğrulanmadı.`;

        for (let pageNumber = 1; pageNumber <= MAX_SECTION_PAGES; pageNumber += 1) {
          if (budgetExhausted) {
            sectionStatus = 'partial';
            sectionNote = `${dateOnly} bölümü tarama zaman bütçesi dolduğu için ${pageNumber - 1}. sayfada durdu.`;
            notes.push(sectionNote);
            break;
          }
          const normalizedPageUrl = normalizeUrl(currentUrl) || currentUrl;
          if (visitedPages.has(normalizedPageUrl)) {
            sectionStatus = 'partial';
            sectionNote = `${dateOnly} sayfalaması daha önce gezilen URL’ye döndü; tekrar isteği engellendi.`;
            notes.push(sectionNote);
            break;
          }
          visitedPages.add(normalizedPageUrl);

          const $ = loadHtml(currentHtml);
          const rows = this.parseSectionRows($, currentUrl, ctx.source.allowedHosts);
          const pageText = readableText($, 'body', 5_000).toLocaleLowerCase('tr');
          const isAnnouncementPage =
            pageText.includes('ilân') || pageText.includes('ilan') || rows.length > 0;
          if (!isAnnouncementPage) {
            const message = `Resmî Gazete Çeşitli İlânlar sayfası beklenen biçimde değil (${currentUrl}).`;
            if (pageNumber === 1) {
              throw new AdapterStructureError(
                this.key,
                message,
                'Sayfa yüklendi ancak ne ilan bağlantısı ne de ilan metni bulundu; HTML yapısı değişmiş olabilir.',
              );
            }
            sectionStatus = 'partial';
            sectionNote = `${dateOnly} ${pageNumber}. sayfa yapısı tanınmadı; önceki sayfalar korundu.`;
            notes.push(sectionNote);
            break;
          }

          const uniqueRows: SectionRow[] = [];
          let duplicateCount = 0;
          for (const row of rows) {
            const sourceItemId = this.sourceItemId(row.pdfUrl);
            if (seenItemIds.has(sourceItemId)) {
              duplicateCount += 1;
              continue;
            }
            seenItemIds.add(sourceItemId);
            uniqueRows.push(row);
          }
          notes.push(
            `${dateOnly} sayfa ${pageNumber}: ${rows.length} PDF ilanı bulundu, ${uniqueRows.length} yeni kayıt; ` +
              `${duplicateCount} yinelenen kayıt atlandı.`,
          );

          for (const row of uniqueRows) {
            if (detailFetches >= ctx.maxDetailFetches) {
              if (!limitNoted) {
                limitNoted = true;
                notes.push(
                  `Belge indirme sınırı (${ctx.maxDetailFetches}) doldu; kalan ilanlar sonraki taramada alınacak.`,
                );
              }
              continue;
            }

            if (!hasBudgetFor(ctx, MIN_PDF_BUDGET_MS)) {
              budgetExhausted = true;
              deferredByBudget += 1;
              if (!budgetNoted) {
                budgetNoted = true;
                notes.push(
                  'Tarama zaman bütçesi doldu; indirilmemiş belgeler sonraki taramaya bırakıldı ' +
                    '(kaynak başarısız sayılmaz, bu koşum kısmi kapsamla kaydedilir).',
                );
              }
              break;
            }

            detailFetches += 1;
            requestCount += 1;
            // Tek yavaş/erişilemez PDF tüm nüshayı düşürmemeli: hata yalıtılır,
            // ilan atlanır ve not düşülür (kayıt oluşmadığı için sonraki
            // taramada kendiliğinden yeniden denenir).
            let pdfBody: Buffer;
            try {
              if (browserSessionRef.current) {
                pdfBody = await browserSessionRef.current.fetchBytes(row.pdfUrl);
              } else {
                const pdfResponse = await ctx.http.fetchBinary(row.pdfUrl, {
                  allowedHosts: ctx.source.allowedHosts,
                  minIntervalMs: ctx.source.minRequestIntervalMs,
                  maxBytes: 15_728_640,
                  timeoutMs: budgetedTimeoutMs(ctx, PDF_TIMEOUT_MS),
                  retries: 1,
                });
                pdfBody = pdfResponse.body;
              }
            } catch (error) {
              if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
              failedPdfFetches += 1;
              notes.push(
                `PDF indirilemedi, ilan atlandı (sonraki taramada yeniden denenecek): ` +
                  `${row.pdfUrl.split('/').pop() ?? row.pdfUrl} — ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }

            const ocrAllowed = ocrEngine !== null && ocrDocs < env.OCR_MAX_DOCS_PER_RUN && hasBudgetFor(ctx, 60_000);
            const pdf = await extractPdfText(new Uint8Array(pdfBody), {
              maxPages: 16,
              maxChars: 60_000,
              ...(ocrAllowed && ocrEngine
                ? { ocr: { engine: await ocrEngine, minConfidence: env.OCR_MIN_CONFIDENCE, maxPages: env.OCR_MAX_PAGES } }
                : {}),
            });
            if (pdf.ocr) ocrDocs += 1;
            const itemNotes: string[] = [];
            if (pdf.error) itemNotes.push(`PDF okunamadı: ${pdf.error}`);
            if (pdf.ocr) itemNotes.push(pdf.ocr.note);
            if (pdf.noTextLayer && !pdf.error) {
              itemNotes.push(
                'PDF metin katmanı yok (taranmış görüntü olabilir); metin alanları boş bırakıldı, belge saklandı.',
              );
            }
            if (pdf.truncated) {
              itemNotes.push(
                `PDF metin çıkarımı sınırı nedeniyle kısaltıldı (${pdf.pagesRead}/${pdf.pages} sayfa, ${pdf.text.length} karakter).`,
              );
            }

            const rowInstitution = cleanInstitution(row.rowText);
            const title = deriveTitle(pdf.text, row.rowText, rowInstitution, dateOnly);
            const bodyText = pdf.text;
            const publishedAt = toIstanbulIso(dateOnly, '00:00');

            const attachment: JobAttachment = {
              url: row.pdfUrl,
              label: 'Resmî Gazete ilan belgesi (PDF)',
              kind: 'pdf',
              sizeBytes: pdfBody.byteLength,
            };

            items.push({
              sourceKey: ctx.source.key,
              sourceItemId: this.sourceItemId(row.pdfUrl),
              url: row.pdfUrl,
              title,
              bodyText,
              bodyTextSource: 'document',
              ...(pdf.ocr?.used && pdf.ocr.confidence !== null ? { ocrConfidence: pdf.ocr.confidence } : {}),
              ...(pdf.truncated ? { bodyTextTruncated: true } : {}),
              ...(rowInstitution ? { institution: rowInstitution } : {}),
              publishedAt,
              attachments: [attachment],
              sourceCategory: 'resmi-gazete-cesitli-ilanlar',
              rawExcerpt: collapseWhitespace(bodyText.slice(0, 1_200)),
              extractionConfidence: pdf.noTextLayer ? 0.2 : pdf.error ? 0.1 : 0.6,
              ...(itemNotes.length > 0 ? { notes: itemNotes } : {}),
            });
          }

          const navigation = detectNextPage(currentHtml, currentUrl);
          if (!navigation.nextUrl) {
            if (navigation.endConfirmed) {
              sectionStatus = 'complete';
              sectionNote = `${dateOnly} bölümünde ${visitedPages.size} sayfa gezildi ve sayfalama denetimi son sayfayı açıkça doğruladı.`;
            } else {
              sectionStatus = 'unknown';
              sectionNote = `${dateOnly} bölümünün ${pageNumber}. sayfasında sonraki bağlantı yok ancak açık son-sayfa işareti de bulunmadı; tamlık bilinmiyor.`;
            }
            break;
          }

          if (pageNumber >= MAX_SECTION_PAGES) {
            sectionStatus = 'partial';
            sectionNote = `${dateOnly} bölümü ${MAX_SECTION_PAGES} sayfalık üst sınıra ulaştı; algılanan sonraki sayfa taranmadı.`;
            notes.push(sectionNote);
            break;
          }

          const nextPageUrl = allowlistedSectionPageUrl(
            navigation.nextUrl,
            sectionUrl,
            ctx.source.allowedHosts,
          );
          if (!nextPageUrl) {
            sectionStatus = 'partial';
            sectionNote = `${dateOnly} sonraki sayfa bağlantısı izin verilen Resmî Gazete bölümüyle eşleşmediği için izlenmedi.`;
            notes.push(`${sectionNote} Bağlantı: ${navigation.nextUrl}`);
            break;
          }
          const normalizedNextUrl = normalizeUrl(nextPageUrl) || nextPageUrl;
          if (visitedPages.has(normalizedNextUrl)) {
            sectionStatus = 'partial';
            sectionNote = `${dateOnly} sonraki sayfa daha önce gezilen URL’ye döndü; döngü engellendi.`;
            notes.push(sectionNote);
            break;
          }

          try {
            const nextPage = await fetchSectionPage(nextPageUrl, dateOnly);
            if (nextPage.response?.notModified) {
              sectionStatus = 'partial';
              sectionNote = `${dateOnly} sonraki sayfa 304 döndürdü; sayfa içeriği doğrulanamadı.`;
              notes.push(sectionNote);
              break;
            }
            currentUrl = nextPageUrl;
            currentHtml = nextPage.html;
          } catch (error) {
            if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
            sectionStatus = 'partial';
            sectionNote =
              `${dateOnly} sonraki sayfa alınamadı (${error instanceof Error ? error.message : String(error)}); ` +
              'daha önce işlenen sayfalar korundu.';
            notes.push(sectionNote);
            break;
          }
        }

        sectionCoverages.push({ dateOnly, status: sectionStatus, note: sectionNote });
      }
    } finally {
      await browserSessionRef.current?.close().catch(() => undefined);
    }

    notes.push(
      `${requestCount} istek yapıldı, ${items.length} ilan hazırlandı. ` +
        'Çeşitli İlânlar bölümünde yayımlanan her ilan ayrı bir PDF’tir; metin katmanı olmayan belgeler insan incelemesine düşer.',
    );

    const incompleteSections = sectionCoverages.filter((section) => section.status !== 'complete');
    const hasKnownOmissions =
      limitNoted ||
      budgetNoted ||
      failedPdfFetches > 0 ||
      sectionCoverages.some((section) => section.status === 'partial') ||
      sectionCoverages.length < days.length;
    const allSectionsComplete =
      sectionCoverages.length === days.length &&
      sectionCoverages.every((section) => section.status === 'complete');
    const coverageStatus: CoverageStatus = notModified
      ? 'unknown'
      : hasKnownOmissions
        ? 'partial'
        : allSectionsComplete
          ? 'complete'
          : 'unknown';
    const coverageNote = notModified
      ? 'Günlük nüsha 304 döndürdü; bu çalışmada ilan listesi ve sayfalama yeniden doğrulanmadı.'
      : coverageStatus === 'complete'
        ? `${sectionDatesRead.join(', ')} günlük bölümlerinin tüm sayfaları açık son-sayfa göstergesiyle gezildi; daha eski arşiv nüshaları bu çalışmanın tarih aralığına dahil değildir.`
        : [
            ...incompleteSections.map((section) => section.note),
            ...(limitNoted
              ? [
                  `PDF indirme bütçesi (${ctx.maxDetailFetches}) nedeniyle listedeki tüm yeni belgeler işlenemedi.`,
                ]
              : []),
            ...(budgetNoted
              ? [
                  `Tarama zaman bütçesi doldu; en az ${deferredByBudget} belge sonraki taramaya bırakıldı.`,
                ]
              : []),
            ...(failedPdfFetches > 0
              ? [`${failedPdfFetches} PDF alınamadı; ilgili ilanlar oluşturulamadı.`]
              : []),
          ].join(' ') || 'Tüm günlük bölüm sayfaları ve PDF kayıtları bu çalışmada doğrulanamadı.';
    notes.push(
      `Liste kapsamı: ${coverageStatus === 'complete' ? 'tam' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`,
    );

    return {
      items,
      requestCount,
      notes,
      etag,
      lastModified,
      notModified,
      coverage: { status: coverageStatus, note: coverageNote },
    };
  }

  private sectionUrl(dateOnly: string): string {
    return resmiGazeteSectionUrl(dateOnly);
  }

  private sourceItemId(pdfUrl: string): string {
    const file = pdfUrl.split('/').pop() ?? pdfUrl;
    return `resmigazete:${file}`;
  }

  /** Bölüm sayfasındaki ilan satırlarını (kurum → PDF) çıkarır. */
  parseSectionRows(
    $: ReturnType<typeof loadHtml>,
    pageUrl: string,
    allowedHosts: readonly string[] = [new URL(pageUrl).hostname],
  ): SectionRow[] {
    const rows: SectionRow[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href || !PDF_PATTERN.test(href)) return;
      let parsed: URL;
      try {
        parsed = assertSafeUrl(href, allowedHosts);
      } catch {
        return;
      }
      if (parsed.protocol !== 'https:' || (parsed.port.length > 0 && parsed.port !== '443')) return;
      if (!SECTION_PATTERN.test(parsed.pathname.replace(PDF_PATTERN, '.htm'))) {
        // Belge adı "-4-N.pdf" biçiminde olmalı.
        if (!/-\d+-\d+\.pdf$/i.test(parsed.pathname)) return;
      }
      if (seen.has(href)) return;
      seen.add(href);

      // Paylaşılmış hücrede (birden çok PDF) satır metni komşu belgeye ait olabilir: yalnız bağlantı metni.
      const rowText = collapseWhitespace(
        ownCardText(node, 'td, li, tr, div', (value) => (PDF_PATTERN.test(value) ? value : null), 4_000) ??
          node.text(),
      )
        .replace(/\s*\(?PDF\)?\s*$/i, '')
        .trim();

      rows.push({
        index: rows.length,
        pdfUrl: parsed.toString(),
        rowText: rowText.length >= 4 ? rowText : (node.text() ?? '').trim(),
      });
    });

    return rows;
  }

  /** İnsan tarafından okunabilir ilk başlığı bulur; bulunamazsa satır metni kullanılır. */
  static deriveTitleFromRow(rowText: string): string {
    return collapseWhitespace(rowText.replace(/[:;]\s*$/, ''));
  }
}

/**
 * Resmî Gazete ilan PDF'lerinin künye biçimi: "<Kurum>dan:" satırı + büyük harfli
 * başlık ("İPTAL İLANI", "SÖZLEŞMELİ PERSONEL ALIM İLANI"). Gerçek koşumda
 * (21.10.2026, 20261021-4-1.pdf) 11 karakterlik "İPTAL İLANI" kısa satır eşiğine
 * takılıyor ve gövdedeki "ilan iptal edilmiştir." başlık oluyordu.
 *
 * Büyük harfli başlık yoksa (üniversite ilanlarında sık: "… Rektörlüğünden:" +
 * "… öğretim üyesi alınacaktır."), alım fiili taşıyan ilk cümle kurumla birlikte
 * başlık olur. Metin kaynaktan birebir alınır; tür/unvan uydurulmaz.
 */
function issuerHeading(lines: readonly string[]): string | null {
  for (let index = 0; index < Math.min(lines.length - 1, 6); index += 1) {
    const issuer = lines[index] ?? '';
    const heading = lines[index + 1] ?? '';
    if (!/\p{L}(?:dan|den|tan|ten|ndan|nden):$/u.test(issuer) || issuer.length < 6) continue;
    const letters = heading.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 4 && letters === letters.toLocaleUpperCase('tr-TR')) {
      return `${issuer} ${heading}`.slice(0, 300);
    }
    const paragraph = lines.slice(index + 1, index + 6).join(' ');
    const sentence = paragraph
      .split(/(?<=\.)\s+/)
      .find((part) => /\b(?:al[ıi]nacakt[ıi]r|al[ıi]m[ıi]\s+yap[ıi]lacakt[ıi]r|istihdam\s+edilecektir)/iu.test(part));
    if (sentence) {
      const trimmed = sentence.length > 200 ? `${sentence.slice(0, 199).trimEnd()}…` : sentence;
      return `${issuer} ${trimmed}`.slice(0, 300);
    }
    return null;
  }
  return null;
}

function deriveTitle(pdfText: string, rowText: string, institution: string | null, dateOnly: string): string {
  const normalizedRow = collapseWhitespace(rowText.replace(/[:;]\s*$/, ''));
  if (pdfText) {
    const issued = issuerHeading(
      pdfText
        .split('\n')
        .map((line) => collapseWhitespace(line))
        .filter((line) => line.length > 0),
    );
    if (issued) return issued;
    const lines = pdfText
      .split('\n')
      .map((line) => collapseWhitespace(line))
      .filter((line) => line.length >= 12);
    const heading = lines.find(
      (line) =>
        /\b(?:ilan[ıi]?|al[ıi]m[ıi]?|alım|duyuru|sınav|kadro|personel|ba[şs]vuru)\b/iu.test(line) &&
        !/^\d/.test(line),
    );
    if (heading) {
      const cleaned = heading
        .replace(/\s{2,}/g, ' ')
        .replace(/[:;]$/, '')
        .trim();
      if (cleaned.length >= 12) return cleaned.slice(0, 300);
    }
  }
  if (normalizedRow.length >= 8) return `${normalizedRow} — ${dateOnly}`.slice(0, 300);
  if (institution) return `${institution} ilanı — ${dateOnly}`.slice(0, 300);
  return `Resmî Gazete ilanı — ${dateOnly}`;
}

export { deriveTitle, firstDateOnlyIn };
