/**
 * İŞKUR e-Şube — Açık İş İlanları (yalnız "Kamu" işyeri türü).
 *
 * Arama ekranı (Istihdam/AcikIsIlanAra.aspx) standart ASP.NET WebForms'tur: ilk GET formu ve
 * __VIEWSTATE/__EVENTVALIDATION alanlarını verir; "Kamu" seçeneği (`ctl04$IsyeriTuruRadios=kamuRadio`)
 * ile "Ara" komutu postback olarak gönderilir, sonraki sayfalar `ctlDataPagerDetay$btnNext` postback'idir.
 * Oturum çerezleri (ASP.NET_SessionId vb.) yalnız bu koşum boyunca bellekte tutulur.
 *
 * Satır verisi paylaş menüsünün `data-*` öznitelikleridir (ilan no, meslek, il, açık iş sayısı, son
 * başvuru); kurum adı satırdaki `ctlIsverenDL` öğesidir. Ayrıntı (genel hususlar, özel şartlar,
 * meslek, öğrenim) girişsiz açılan `AcikIsIlanDetay.aspx?uiID=…` sayfasından okunur.
 *
 * Çok satırlı kamu talepleri (ör. TCDD'nin il il açtığı talepler) İŞKUR'da her il için AYRI ilan
 * numarasıyla yayımlanır; her satır kendi il/kontenjan/son başvurusuyla ayrı ilan olarak üretilir.
 *
 * Erişim: robots.txt (23.10.2026) yalnız `/Meslek/ViewMeslekDetayPopUp.aspx/` yasaklar. CAPTCHA,
 * zorunlu oturum ya da arama formunun kaybolması durumunda adaptör DURUR (atlatma yapılmaz).
 */
import type { CheerioAPI } from 'cheerio';
import type { RawAnnouncement } from '../../domain';
import { collapseWhitespace } from '../../domain/text';
import { findProvince } from '../../domain/provinces';
import { toIstanbulIso } from '../../domain/dates';
import { blockElementText, loadHtml } from '../../lib/html';
import { AdapterStructureError, SourceAccessError } from '../errors';
import { assertSafeUrl, type FetchResponse } from '../fetcher';
import { cleanInstitution, parseListingDate } from '../listing-utils';
import { hasBudgetFor } from '../scan-budget';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

export const ISKUR_ESUBE_SEARCH_URL = 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx';
export const ISKUR_ESUBE_DETAIL_URL = 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx';
const SEARCH_TARGET = 'ctl04$ctlAcikIsPageCommand$CommandItem_Search';
const NEXT_PAGE_TARGET = 'ctl04$ctlDataPagerDetay$btnNext';
const EMPLOYER_TYPE_FIELD = 'ctl04$IsyeriTuruRadios';
const PUBLIC_EMPLOYER_VALUE = 'kamuRadio';
/** Koşu başına en fazla gezilecek sonuç sayfası (sayfa başı 15 satır). */
export const MAX_RESULT_PAGES = 30;
/** Sayfa başına tahmini süre (≥5 sn aralık + büyük HTML); bütçe kalmadıysa sayfalama durur. */
const PAGE_BUDGET_MS = 12_000;
const DETAIL_BUDGET_MS = 9_000;

export interface IskurListingRow {
  ilanNo: string;
  occupation: string;
  institution: string | null;
  employerType: string | null;
  workPeriod: string | null;
  workPattern: string | null;
  quota: number | null;
  city: string | null;
  district: string | null;
  locationText: string;
  applicationEndDate: string | null;
  detailUrl: string;
}

export interface IskurPagerState {
  currentPage: number | null;
  totalPages: number | null;
  totalRecords: number | null;
}

/** Çerez kavanozu: yalnız koşum süresince bellekte. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: FetchResponse): void {
    const raw = response.headers['set-cookie'];
    if (!raw) return;
    for (const line of raw.split('\n')) {
      const pair = line.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  }
}

/**
 * Formun tarayıcının göndereceği alanları: gizli/metin girdileri, işaretli radyo/onay kutuları ve
 * etkin `<select>`lerin seçili değeri. Gönder düğmeleri (Kaydet vb.) eklenmez.
 */
export function collectFormFields($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  const form = $('form#form1').first().length > 0 ? $('form#form1').first() : $('form').first();
  form.find('input[name]').each((_index, element) => {
    const node = $(element);
    const name = node.attr('name');
    if (!name) return;
    const type = (node.attr('type') ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'file') return;
    if ((type === 'radio' || type === 'checkbox') && node.attr('checked') === undefined) return;
    if (node.attr('disabled') !== undefined) return;
    const value = node.attr('value') ?? (type === 'checkbox' ? 'on' : '');
    fields.set(name, value);
  });
  form.find('select[name]').each((_index, element) => {
    const node = $(element);
    const name = node.attr('name');
    if (!name || node.attr('disabled') !== undefined) return;
    const selected = node.find('option[selected]').first();
    const option = selected.length > 0 ? selected : node.find('option').first();
    fields.set(name, option.attr('value') ?? option.text() ?? '');
  });
  form.find('textarea[name]').each((_index, element) => {
    const node = $(element);
    const name = node.attr('name');
    if (name) fields.set(name, node.text());
  });
  return fields;
}

export function postbackBody(fields: Map<string, string>, eventTarget: string): string {
  const next = new Map(fields);
  next.set('__EVENTTARGET', eventTarget);
  next.set('__EVENTARGUMENT', '');
  return new URLSearchParams([...next]).toString();
}

/** CAPTCHA ya da arama formu yerine giriş zorunluluğu: atlatılmaz, koşum durur. */
export function accessBarrier($: CheerioAPI): string | null {
  const html = $.html();
  if (/captcha|g-recaptcha|hcaptcha/i.test(html)) return 'Sayfada CAPTCHA doğrulaması var.';
  if ($('input[name="__VIEWSTATE"]').length === 0) {
    return 'Arama formu (__VIEWSTATE) bulunamadı; sayfa oturum/giriş isteyebilir.';
  }
  return null;
}

export function parsePager($: CheerioAPI): IskurPagerState {
  const pageText = collapseWhitespace($('body').text());
  const totalRecords = /Toplam\s+Kay[ıi]t\s*:\s*([\d.]+)/i.exec(pageText)?.[1];
  const current = $('input[name="ctl04$ctlDataPagerDetay$txtCurrentPage"]').attr('value');
  // span.DataPagerInformation: "[txtCurrentPage] / 6 … Toplam Kayıt: 90"
  const pagerText = collapseWhitespace($('.DataPagerInformation').text());
  const totalPages = /\/\s*(\d{1,4})/.exec(pagerText)?.[1];
  return {
    currentPage: current && /^\d+$/.test(current) ? Number(current) : null,
    totalPages: totalPages ? Number(totalPages) : null,
    totalRecords: totalRecords ? Number(totalRecords.replace(/\./g, '')) : null,
  };
}

function cityParts(locationText: string): { city: string | null; district: string | null } {
  // "İl Geneli Başvuru  (ANKARA / ANKARA/MERKEZ)" | "(İSTANBUL / İSTANBUL/KADIKÖY)"
  const match = /\(\s*([^()/]+?)\s*\/\s*([^()]+?)\s*\)/.exec(locationText);
  if (!match) return { city: null, district: null };
  const province = findProvince(match[1] ?? '');
  const districtRaw = (match[2] ?? '').split('/').pop()?.trim() ?? '';
  const district =
    districtRaw && !/(^|\s)merkez$/i.test(districtRaw)
      ? districtRaw.toLocaleLowerCase('tr').replace(/(^|\s)(\p{L})/gu, (_m, space: string, letter: string) => space + letter.toLocaleUpperCase('tr'))
      : null;
  return { city: province?.name ?? null, district };
}

export function parseIskurRows($: CheerioAPI, allowedHosts: readonly string[]): IskurListingRow[] {
  const rows: IskurListingRow[] = [];
  const seen = new Set<string>();
  $('a.share-toggle[data-ilanno]').each((_index, element) => {
    const share = $(element);
    const ilanNo = (share.attr('data-ilanno') ?? '').trim();
    if (!/^\d{6,14}$/.test(ilanNo) || seen.has(ilanNo)) return;
    const row = share.closest('tr');
    const occupation = collapseWhitespace(
      share.attr('data-meslekler') ?? row.find('a[id*="_flag_"]').first().text(),
    );
    if (!occupation) return;
    let detailUrl: string;
    try {
      detailUrl = assertSafeUrl(`${ISKUR_ESUBE_DETAIL_URL}?uiID=${ilanNo}`, allowedHosts).toString();
    } catch {
      return;
    }
    seen.add(ilanNo);
    const text = (suffix: string): string | null =>
      collapseWhitespace(row.find(`[id$="${suffix}"]`).first().text()) || null;
    const locationText = collapseWhitespace(share.attr('data-il') ?? text('_ctlCalismaYeriDL') ?? '');
    const quotaRaw = share.attr('data-acikissayi') ?? text('_Label9') ?? '';
    const quota = /^\d{1,5}$/.test(quotaRaw.trim()) ? Number(quotaRaw.trim()) : null;
    const end = parseListingDate(share.attr('data-sontarih') ?? text('_ctlSonBasvuruTarihi'));
    rows.push({
      ilanNo,
      occupation,
      institution: text('_ctlIsverenDL'),
      employerType: collapseWhitespace(share.attr('data-isverentur') ?? text('_ctlIsverenTurDL') ?? '') || null,
      workPeriod: text('_ctlCalismaPeriyotDL'),
      workPattern: collapseWhitespace(share.attr('data-calismasekli') ?? text('_ctlCalismaSekliDL') ?? '') || null,
      quota,
      ...cityParts(locationText),
      locationText,
      applicationEndDate: end,
      detailUrl,
    });
  });
  return rows;
}

const DETAIL_PANELS = [
  '#ctl01_ctlIsIlanBilgileri_ctlGenelSartlarCenter',
  '#ctl01_ctlIsIlanBilgileri_ctlGenelSartlarCenter2',
  '#ctl01_ctlIsIlanBilgileri_ctlPanelMeslek',
  '#ctl01_ctlIsIlanBilgileri_ctlPanelKisiselBilgiler',
] as const;

/** Detay sayfasının ilan bölümleri (genel hususlar, özel şartlar, meslek, öğrenim) düz metin olarak. */
export function parseIskurDetail(html: string): string {
  const $ = loadHtml(html);
  $('script, style, noscript').remove();
  const parts: string[] = [];
  for (const selector of DETAIL_PANELS) {
    const panel = $(selector).first();
    if (panel.length === 0) continue;
    const text = blockElementText(panel, 30_000)
      .replace(/&nbsp;?/g, ' ')
      // Tablo hücre ayırıcı artıkları ("Başlık |", tek başına "|") atılır.
      .replace(/[ \t]*\|[ \t]*$/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n').slice(0, 60_000);
}

function rowSummary(row: IskurListingRow): string {
  return [
    `Kurum: ${row.institution ?? 'belirtilmemiş'}`,
    `Meslek: ${row.occupation}`,
    row.quota !== null ? `Açık iş (pozisyon) sayısı: ${row.quota}` : null,
    row.locationText ? `Çalışma yeri: ${row.locationText}` : null,
    [row.employerType, row.workPeriod, row.workPattern].filter(Boolean).join(' / ') || null,
    row.applicationEndDate ? `Son başvuru tarihi: ${row.applicationEndDate.split('-').reverse().join('.')}` : null,
    `İŞKUR işgücü istemi no: ${row.ilanNo}`,
    'Başvuru: İŞKUR e-Şube (esube.iskur.gov.tr) "İş Arayan" girişi, İŞKUR hizmet noktaları veya Alo 170.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function iskurRowToAnnouncement(
  row: IskurListingRow,
  sourceKey: string,
  detailText: string | null,
): RawAnnouncement {
  const institution = cleanInstitution(row.institution) ?? row.institution ?? undefined;
  const summary = rowSummary(row);
  const body = detailText ? `${summary}\n\n${detailText}` : summary;
  const lotteryNote = detailText && /kura/i.test(detailText) ? ['Başvuru yolu: İŞKUR üzerinden; seçim kurayla (ilan metni).'] : [];
  const where = [row.city, row.district].filter(Boolean).join('/');
  return {
    sourceKey,
    sourceItemId: `iskur-esube:${row.ilanNo}`,
    url: row.detailUrl,
    // Kamu kurumlarının İŞKUR'a verdiği talepler (Kamu İşçi Alımı Yönetmeliği) işçi alımıdır;
    // başlık bunu açıkça söyler ki sınıflandırma "başlıkta alım ifadesi yok" diye incelemeye düşürmesin.
    title: `${institution ?? 'Kamu kurumu'} — ${row.occupation} işçi alımı (İŞKUR${where ? `, ${where}` : ''})`,
    bodyText: body,
    bodyTextSource: detailText ? 'detail' : 'listing',
    ...(institution ? { institution } : {}),
    ...(row.applicationEndDate ? { applicationEndAt: toIstanbulIso(row.applicationEndDate, '23:59') } : {}),
    applicationUrl: row.detailUrl,
    ...(row.city ? { city: row.city } : {}),
    ...(row.district ? { district: row.district } : {}),
    ...(row.quota !== null ? { quota: row.quota } : {}),
    referenceNo: row.ilanNo,
    attachments: [],
    sourceCategory: 'iskur-esube-kamu',
    rawExcerpt: collapseWhitespace(body).slice(0, 1_200),
    extractionConfidence: detailText ? 0.7 : 0.55,
    notes: [
      'İŞKUR e-Şube kamu açık iş ilanı; il/kontenjan/son başvuru liste satırından.',
      ...lotteryNote,
    ],
  };
}

export class IskurEsubeAdapter implements SourceAdapter {
  readonly key = 'iskur-esube-kamu';
  readonly label = 'İŞKUR e-Şube — Kamu Açık İş İlanları';
  readonly method = 'http-postback';
  readonly notes =
    'ASP.NET arama formu "Kamu" filtresiyle postback olarak gönderilir; sonuç sayfaları "Sonraki Sayfa" ' +
    `postback'iyle en fazla ${MAX_RESULT_PAGES} sayfa izlenir. Detaylar girişsiz açılan ilan sayfasından okunur. ` +
    'CAPTCHA/oturum zorunluluğu çıkarsa tarama durur; atlatma yapılmaz.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const notes: string[] = [];
    const httpStatuses: number[] = [];
    let requestCount = 0;
    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı: arama formu gönderilmedi.');
      return { items: [], requestCount, notes, etag: null, lastModified: null, notModified: false };
    }

    const jar = new CookieJar();
    const searchUrl = assertSafeUrl(ctx.source.listingUrl || ISKUR_ESUBE_SEARCH_URL, ctx.source.allowedHosts).toString();
    const request = async (url: string, formBody?: string): Promise<CheerioAPI> => {
      const response = await ctx.http.fetchText(url, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
        retries: 1,
        ...(formBody !== undefined
          ? { method: 'POST' as const, formBody, headers: { ...jar.header(), referer: searchUrl } }
          : { headers: jar.header() }),
      });
      requestCount += 1;
      httpStatuses.push(response.status);
      jar.absorb(response);
      return loadHtml(response.decoded?.text ?? response.body.toString('utf8'));
    };

    const barrierCheck = ($: CheerioAPI, stage: string): void => {
      const barrier = accessBarrier($);
      if (barrier) {
        throw new SourceAccessError(ctx.source.key, `İŞKUR e-Şube ${stage}: ${barrier} Atlatma yapılmaz.`, null);
      }
    };

    const form = await request(searchUrl);
    barrierCheck(form, 'arama sayfası');
    const fields = collectFormFields(form);
    if (!fields.has(EMPLOYER_TYPE_FIELD)) {
      throw new AdapterStructureError(
        ctx.source.key,
        'İŞKUR e-Şube arama formunda işyeri türü seçimi bulunamadı.',
        `${EMPLOYER_TYPE_FIELD} alanı yok; form değişmiş olabilir.`,
      );
    }
    fields.set(EMPLOYER_TYPE_FIELD, PUBLIC_EMPLOYER_VALUE);

    let $ = await request(searchUrl, postbackBody(fields, SEARCH_TARGET));
    barrierCheck($, 'arama sonucu');
    const rowsById = new Map<string, IskurListingRow>();
    let pager = parsePager($);
    let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
    let coverageNote = 'Sonuç sayfalarının sonu doğrulanamadı.';

    for (let page = 1; page <= MAX_RESULT_PAGES; page += 1) {
      const rows = parseIskurRows($, ctx.source.allowedHosts);
      const before = rowsById.size;
      for (const row of rows) rowsById.set(row.ilanNo, row);
      notes.push(`Sayfa ${pager.currentPage ?? page}/${pager.totalPages ?? '?'}: ${rows.length} satır.`);
      if (rows.length > 0 && rowsById.size === before) {
        coverageStatus = 'unknown';
        coverageNote = `Sayfa ${page} önceki satırları tekrarladı; sayfalama ilerlemedi.`;
        break;
      }
      if (pager.totalRecords !== null && rowsById.size >= pager.totalRecords) {
        coverageStatus = 'complete';
        coverageNote = `Sitenin bildirdiği toplam (${pager.totalRecords} kamu ilanı) ile okunan satır sayısı eşleşti.`;
        break;
      }
      const lastPage =
        rows.length === 0 ||
        (pager.totalPages !== null && pager.currentPage !== null && pager.currentPage >= pager.totalPages) ||
        $('#ctl04_ctlDataPagerDetay_btnNext').length === 0;
      if (lastPage) {
        const declared = pager.totalRecords;
        coverageStatus = declared !== null && declared !== rowsById.size ? 'partial' : 'complete';
        coverageNote =
          declared !== null && declared !== rowsById.size
            ? `Son sayfaya ulaşıldı ancak ${declared} kayıttan ${rowsById.size} satır okundu.`
            : `${page} sayfa gezildi; son sayfa sayfalama denetimiyle doğrulandı.`;
        break;
      }
      if (page >= MAX_RESULT_PAGES) {
        coverageStatus = 'partial';
        coverageNote = `${MAX_RESULT_PAGES} sayfalık üst sınıra ulaşıldı; kalan sayfalar sonraki taramaya kaldı.`;
        break;
      }
      if (!hasBudgetFor(ctx, PAGE_BUDGET_MS)) {
        coverageStatus = 'partial';
        coverageNote = `Tarama zaman bütçesi ${page}. sayfada doldu; kalan sayfalar sonraki taramaya kaldı.`;
        break;
      }
      try {
        $ = await request(searchUrl, postbackBody(collectFormFields($), NEXT_PAGE_TARGET));
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        coverageStatus = 'partial';
        coverageNote = `Sonraki sayfa alınamadı (${error instanceof Error ? error.message : String(error)}); önceki sayfalar işlendi.`;
        break;
      }
      barrierCheck($, `${page + 1}. sonuç sayfası`);
      pager = parsePager($);
    }

    const rows = [...rowsById.values()];
    if (rows.length === 0 && pager.totalRecords === null) {
      throw new AdapterStructureError(
        ctx.source.key,
        'İŞKUR e-Şube arama sonucu beklenen biçimde değil.',
        'Ne ilan satırı ne de "Toplam Kayıt" sayacı bulundu; arayüz değişmiş olabilir.',
      );
    }

    // Detay bütçesi önce yeni ilanlara, sonra ayrıntısı daha önce alınamamış ilanlara harcanır.
    // Ayrıntısı alınmış bilinen ilanlar yeniden üretilmez (gereksiz DB yazımı yok).
    const idOf = (row: IskurListingRow): string => `iskur-esube:${row.ilanNo}`;
    const known = ctx.knownItemIds ?? new Set<string>();
    const withDetail = ctx.knownItemIdsWithDetail ?? new Set<string>();
    const fresh = rows.filter((row) => !known.has(idOf(row)));
    const retry = rows.filter((row) => known.has(idOf(row)) && !withDetail.has(idOf(row)));
    const details = new Map<string, string>();
    let detailFetches = 0;
    let detailDeferred = 0;
    for (const row of [...fresh, ...retry]) {
      if (detailFetches >= ctx.maxDetailFetches || !hasBudgetFor(ctx, DETAIL_BUDGET_MS)) {
        detailDeferred += 1;
        continue;
      }
      detailFetches += 1;
      try {
        const detail = await request(row.detailUrl);
        const text = parseIskurDetail(detail.html());
        if (text) details.set(row.ilanNo, text);
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        notes.push(`Detay alınamadı (${row.ilanNo}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (detailDeferred > 0) {
      notes.push(
        `Detay bütçesi (${ctx.maxDetailFetches}) doldu; ${detailDeferred} ilanın ayrıntısı sonraki taramalarda alınacak ` +
          '(yeni ilanlar liste bilgisiyle kaydedildi).',
      );
    }

    const items = [...fresh, ...retry.filter((row) => details.has(row.ilanNo))].map((row) =>
      iskurRowToAnnouncement(row, ctx.source.key, details.get(row.ilanNo) ?? null),
    );

    notes.push(
      `${requestCount} istek; ${rows.length} kamu ilanı satırı, ${details.size} detay okundu, ${items.length} kayıt hazırlandı.`,
    );
    notes.push(`Liste kapsamı: ${coverageStatus === 'complete' ? 'tam' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`);
    return {
      items,
      requestCount,
      notes,
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses,
      coverage: { status: coverageStatus, note: coverageNote },
    };
  }
}
