/**
 * Kamu İlan (Strateji ve Bütçe Başkanlığı) adaptörü.
 *
 * Merkezî kamu ilan ekranı: memur, sözleşmeli, işçi ve akademik ilanları
 * kurum ayrımı olmadan listeler. Bu nedenle erişilebildiği ortamlarda kapsam
 * açısından en değerli kaynaktır.
 *
 * ERİŞİM KISITI: Bu ortamdan 403 "Geographic Restriction" (WAF) döndü
 * (12.10.2026). Kısıt AŞILMAYA ÇALIŞILMAZ; adaptör kısıtı açıkça bildirir ve
 * Türkiye'den çalışan bir kurulumda otomatik devreye girer.
 */
import { createHash } from 'node:crypto';
import { collapseWhitespace } from '../../domain/text';
import { TURKISH_MONTHS, isValidDateParts, toDateOnly, toIstanbulDateOnly } from '../../domain/dates';
import type { RawAnnouncement } from '../../domain';
import { AdapterStructureError, SourceAccessError } from '../errors';
import { loadHtml, readableText, absoluteUrl, elementText } from '../../lib/html';
import { cleanInstitution, cleanTitle, ownCardText, parseListingDate } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';
import { detectNextPage } from '../pagination';
import { assertSafeUrl } from '../fetcher';

const MAX_LIST_PAGES = 10;
const MAX_LIST_ITEMS = 300;

interface SbbListingRow {
  /** Kararlı kimlik: `kod` parametresi her istekte yeniden şifrelendiği için URL kimlik olamaz. */
  id?: string;
  title: string;
  url: string;
  institution: string | null;
  city: string | null;
  publishedAt: string | null;
  summary: string;
}

export class SbbKamuIlanAdapter implements SourceAdapter {
  readonly key = 'sbb-kamuilan';
  readonly label = 'Kamu İlan (SBB)';
  readonly method = 'http-html';
  readonly notes =
    'Merkezî kamu ilan ekranı. Erişim kısıtlıysa (WAF/geo) kısıt aşılmaz; durum panelde ' +
    '"erişim kısıtlı" olarak görünür ve diğer kaynaklar çalışmaya devam eder.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const notes: string[] = [];
    let requestCount = 0;

    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: liste okunmadı.');
      return { items: [], requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    let response;
    const httpStatuses: number[] = [];
    try {
      response = await ctx.http.fetchText(ctx.source.listingUrl, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
      });
      requestCount += 1;
      httpStatuses.push(response.status);
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      const message = error instanceof Error ? error.message : String(error);
      if (/403|erişim reddedildi|Geographic/i.test(message)) {
        throw new SourceAccessError(
          ctx.source.key,
          'Kamu İlan (SBB) bu ortamdan erişilemiyor: HTTP 403 / Geographic Restriction. Kısıt aşılmaz.',
          403,
        );
      }
      throw error;
    }

    if (response.notModified) {
      return {
        items: [],
        requestCount,
        notes: ['İlan listesi değişmemiş (304).'],
        etag: response.etag,
        lastModified: response.lastModified,
        notModified: true,
        httpStatuses,
        coverage: {
          status: 'unknown',
          note: '304 yanıtı içeriğin değişmediğini gösterir; bu çalışmada sayfalar yeniden gezilmedi.',
        },
      };
    }

    let currentHtml = response.decoded?.text ?? response.body.toString('utf8');
    let currentUrl = response.finalUrl;
    const rowsByUrl = new Map<string, SbbListingRow>();
    const visitedPages = new Set<string>();
    let sawPagination = false;
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = 'Kamu İlan sayfası kapsamı bu çalışmada doğrulanamadı.';

    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const normalizedPageUrl = currentUrl;
      if (visitedPages.has(normalizedPageUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Sayfalama daha önce gezilen URL’ye döndü; tekrar döngüsü engellendi.';
        break;
      }
      visitedPages.add(normalizedPageUrl);

      const $ = loadHtml(currentHtml);
      const pageRows = this.parseListing($, currentUrl, ctx.source.allowedHosts, ctx.fetchedAt);
      const declared = declaredListingCount($);
      notes.push(`Sayfa ${page}: ${pageRows.length} ilan satırı.`);
      const repeated = pageRows.some((row) => rowsByUrl.has(row.id ?? row.url));
      let capExceeded = false;
      for (const row of pageRows) {
        if (rowsByUrl.has(row.id ?? row.url)) continue;
        if (rowsByUrl.size >= MAX_LIST_ITEMS) {
          capExceeded = true;
          break;
        }
        rowsByUrl.set(row.id ?? row.url, row);
      }
      if (repeated) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page} önceki kayıtları tekrarladı; sayfa parametresinin etkisi doğrulanamadı.`;
        break;
      }
      if (capExceeded) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_LIST_ITEMS} kayıtlık üst sınıra ulaşıldı; kalan liste kayıtları bu çalışmada alınmadı.`;
        break;
      }

      // Kamu İlan tüm güncel ilanları tek sayfada verir ve toplamı "N ilan" diye yazar;
      // okunan kart sayısı bu toplamla birebir eşleşirse kapsam kanıtlanmış sayılır.
      if (page === 1 && declared !== null && declared === pageRows.length && pageRows.length > 0) {
        coverageStatus = 'complete';
        coverageNote = `Sayfanın bildirdiği toplam (${declared} ilan) ile okunan kart sayısı eşleşti.`;
        break;
      }
      if (page === 1 && declared !== null && declared !== pageRows.length) {
        notes.push(`Sayfa ${declared} ilan bildiriyor, ${pageRows.length} kart okundu.`);
      }

      const navigation = detectNextPage(currentHtml, currentUrl);
      sawPagination ||= navigation.detected;
      if (!navigation.nextUrl) {
        coverageStatus = navigation.endConfirmed ? 'complete' : 'unknown';
        coverageNote = navigation.endConfirmed
          ? `${visitedPages.size} sayfa gezildi ve kaynak sayfalama denetimi son sayfayı doğruladı.`
          : sawPagination
            ? `${visitedPages.size} sayfa gezildi ancak son sayfa işareti doğrulanamadı; kapsam bilinmiyor.`
            : 'Sayfada doğrulanabilir sonraki/son sayfa işareti bulunmadı; tek sayfanın tüm duyurular olduğu varsayılmıyor.';
        break;
      }
      if (page >= MAX_LIST_PAGES) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_LIST_PAGES} sayfalık üst sınıra ulaşıldı; sonraki sayfa taranmadı.`;
        break;
      }
      const nextUrl = navigation.nextUrl;
      if (visitedPages.has(nextUrl)) {
        coverageStatus = 'unknown';
        coverageNote = 'Kaynağın sonraki sayfa bağlantısı önceki sayfaya döndü.';
        break;
      }
      try {
        const nextPage = await ctx.http.fetchText(nextUrl, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
        });
        requestCount += 1;
        httpStatuses.push(nextPage.status);
        if (nextPage.notModified) {
          coverageStatus = 'unknown';
          coverageNote = 'Sonraki sayfa için 304 alındı; o sayfanın ilanları bu çalışmada doğrulanamadı.';
          break;
        }
        currentUrl = nextPage.finalUrl;
        currentHtml = nextPage.decoded?.text ?? nextPage.body.toString('utf8');
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        coverageStatus = 'partial';
        coverageNote = `Sonraki sayfa alınamadı (${error instanceof Error ? error.message : String(error)}); önceki sayfalar işlendi.`;
        notes.push(coverageNote);
        break;
      }
    }

    const rows = [...rowsByUrl.values()];
    if (rows.length === 0) {
      const $ = loadHtml(currentHtml);
      const pageText = readableText($, 'body', 2_000).toLocaleLowerCase('tr');
      if (!pageText.includes('ilan')) {
        throw new AdapterStructureError(
          this.key,
          'Kamu İlan (SBB) sayfası beklenen biçimde değil.',
          'Sayfa yüklendi ancak ilan listesi bulunamadı; arayüz değişmiş olabilir.',
        );
      }
      notes.push('Liste yapısı doğrulandı, o an ilan bulunamadı.');
    }

    const items: RawAnnouncement[] = rows.map((row) => ({
      sourceKey: ctx.source.key,
      sourceItemId: row.id ?? `sbb:${slugFor(row.url)}`,
      url: row.url,
      title: row.title,
      institution: row.institution ?? 'Belirtilmemiş kurum',
      ...(row.publishedAt ? { publishedAt: `${row.publishedAt}T00:00:00+03:00` } : {}),
      ...(row.city ? { city: row.city } : {}),
      attachments: [],
      sourceCategory: 'kamuilan-sbb',
      rawExcerpt: collapseWhitespace(row.summary).slice(0, 1_200),
      bodyText: row.summary,
      bodyTextSource: 'listing',
      extractionConfidence: 0.5,
    }));

    notes.push(
      `${requestCount} istek, ${items.length} ilan hazırlandı (${visitedPages.size} sayfa tarandı).`,
    );
    notes.push(
      `Liste kapsamı: ${coverageStatus === 'complete' ? 'tam' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`,
    );
    return {
      items,
      requestCount,
      notes,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: false,
      httpStatuses,
      coverage: { status: coverageStatus, note: coverageNote },
    };
  }

  parseListing(
    $: ReturnType<typeof loadHtml>,
    pageUrl: string,
    allowedHosts: readonly string[] = [new URL(pageUrl).hostname],
    fetchedAt: Date = new Date(),
  ): SbbListingRow[] {
    const timeline = this.parseTimeline($, pageUrl, allowedHosts, fetchedAt);
    if (timeline !== null) return timeline;
    const rows: SbbListingRow[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href) return;
      let safeUrl: string;
      try {
        safeUrl = assertSafeUrl(href, allowedHosts).toString();
      } catch {
        return;
      }
      const title = cleanTitle(elementText(node, 300));
      if (title.length < 12) return;
      // Sorgu parametresi ilanı ayırt eder (ör. ilanDetay.aspx?kod=…); yalnızca #parça atılır.
      const key = safeUrl.split('#')[0] ?? safeUrl;
      if (seen.has(key)) return;
      seen.add(key);

      // Paylaşılmış kapsayıcıda kurum/il komşu ilandan alınmaz.
      const containerText =
        ownCardText(node, 'li, tr, div, article', (value) => value.split('#')[0] || null, 700) ?? title;
      const institutionMatch = containerText.match(
        /([A-ZÇĞİÖŞÜ][^|•·]{5,90}?(?:Bakanlığı|Başkanlığı|Rektörlüğü|Müdürlüğü|Belediyesi|Üniversitesi|Kurumu|Genel Müdürlüğü))/u,
      );
      const cityMatch = /İl\s*[:.]?\s*([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)/u.exec(containerText);

      rows.push({
        title,
        url: key,
        institution: cleanInstitution(institutionMatch?.[1] ?? null),
        city: cityMatch?.[1] ?? null,
        publishedAt: parseListingDate(containerText),
        summary: collapseWhitespace(containerText),
      });
    });

    return rows;
  }

  /**
   * Gerçek Kamu İlan düzeni (22.10.2026): güncel ilanlar `ul#nav2.cbp_tmtimeline` içinde
   * gün başlıklı `<li>` öğeleridir; her ilan `a[href^="ilanDetay.aspx?kod="]` kartıdır
   * (`p.alt_p1` kurum, `p.alt_p2` başlık + `<em>` başvuru aralığı). Üstteki manşet
   * kaydırıcısı aynı ilanları farklı `kod` ile tekrarladığından okunmaz. Düzen yoksa null.
   */
  private parseTimeline(
    $: ReturnType<typeof loadHtml>,
    pageUrl: string,
    allowedHosts: readonly string[],
    fetchedAt: Date,
  ): SbbListingRow[] | null {
    const days = $('ul.cbp_tmtimeline > li');
    if (days.length === 0) return null;
    const rows: SbbListingRow[] = [];
    const seen = new Set<string>();
    const today = toIstanbulDateOnly(fetchedAt);
    days.each((_dayIndex, dayElement) => {
      const day = $(dayElement);
      const publishedAt = timelineDate(
        collapseWhitespace(day.find('time h4').first().text()),
        collapseWhitespace(day.find('time h3').first().text()),
        today,
      );
      day.find('a[href]').each((_index, element) => {
        const node = $(element);
        const href = absoluteUrl(node.attr('href'), pageUrl, $);
        if (!href || !/ilanDetay\.aspx/i.test(href)) return;
        let safeUrl: string;
        try {
          safeUrl = assertSafeUrl(href, allowedHosts).toString();
        } catch {
          return;
        }
        const institution = cleanInstitution(collapseWhitespace(node.find('.alt_p1').first().text())) ?? null;
        const titleNode = node.find('.alt_p2').first().clone();
        const range = collapseWhitespace(titleNode.find('em').text()).replace(/^\(\s*|\s*\)$/g, '');
        titleNode.find('em').remove();
        const heading = collapseWhitespace(titleNode.text());
        if (!heading) return;
        const title = cleanTitle([institution, heading].filter(Boolean).join(' '));
        if (title.length < 6) return;
        const id = `sbb:${createHash('sha256')
          .update([institution ?? '', heading, publishedAt ?? '', range].join('|'))
          .digest('hex')
          .slice(0, 24)}`;
        if (seen.has(id)) return;
        seen.add(id);
        rows.push({
          id,
          title,
          url: safeUrl,
          institution,
          city: null,
          publishedAt,
          summary: collapseWhitespace(
            [institution, heading, range ? `Başvuru aralığı: ${range}` : null].filter(Boolean).join(' — '),
          ),
        });
      });
    });
    return rows;
  }
}

/** "101 ilan" sayacı (`#lb_ilansayi`); bulunamazsa null. */
function declaredListingCount($: ReturnType<typeof loadHtml>): number | null {
  const match = /(\d{1,5})\s*ilan/i.exec(collapseWhitespace($('#lb_ilansayi').first().text()));
  return match ? Number(match[1]) : null;
}

/**
 * Zaman çizelgesi gün başlığı ("22" + "Ekim") yıl içermez. Liste yayımlanmış ilanları
 * gösterdiğinden gün bugünden ileri olamaz: bu yıl içinde bugünü aşıyorsa önceki yıldır.
 */
function timelineDate(dayText: string, monthText: string, today: string): string | null {
  const day = Number(dayText);
  const month = TURKISH_MONTHS[monthText.toLocaleLowerCase('tr').trim()];
  if (!Number.isInteger(day) || !month) return null;
  const year = Number(today.slice(0, 4));
  const candidate = isValidDateParts(year, month, day) ? toDateOnly(year, month, day) : null;
  if (candidate && candidate <= today) return candidate;
  return isValidDateParts(year - 1, month, day) ? toDateOnly(year - 1, month, day) : null;
}

function slugFor(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

export { SourceAccessError };
