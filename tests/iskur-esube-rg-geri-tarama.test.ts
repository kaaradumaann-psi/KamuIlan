/**
 * 23.10.2026: İŞKUR e-Şube kamu ilanları adaptörü (gerçek sayfadan kısaltılmış fikstürler) ve
 * Resmî Gazete geriye dönük (RG_BACKFILL_DAYS) taramanın kalıcı ilerleme kaydı. Ağ yok.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { resetEnvCache } from '../src/config/env';
import { classify } from '../src/classification/engine';
import { loadHtml } from '../src/lib/html';
import { createLogger } from '../src/lib/logger';
import { loadSourceTerms } from '../src/sources/terms';
import {
  IskurEsubeAdapter,
  collectFormFields,
  iskurRowToAnnouncement,
  parseIskurDetail,
  parseIskurRows,
  parsePager,
  postbackBody,
} from '../src/sources/adapters/iskur-esube';
import { ResmiGazeteAdapter, resmiGazeteSectionUrl } from '../src/sources/adapters/resmigazete';
import {
  RG_BACKFILL_MAX_ATTEMPTS,
  planRgBackfill,
  readRgBackfillState,
  recordRgBackfill,
} from '../src/sources/adapters/resmigazete-backfill';
import { requireAdapter } from '../src/sources/registry';
import { SourceAccessError } from '../src/sources/errors';
import type { FetchOptions, FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { AdapterContext } from '../src/sources/types';

const FIXTURES = fileURLToPath(new URL('./fixtures/kaynak-html/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');
const iskurSource = SOURCE_DEFINITIONS.find((source) => source.key === 'iskur-esube-acik-is')!;
const rgSource = SOURCE_DEFINITIONS.find((source) => source.adapterKey === 'resmigazete-cestili')!;

function response(url: string, text: string, headers: Record<string, string> = {}): FetchResponse {
  const body = Buffer.from(text, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body,
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

function ctxFor(
  source: AdapterContext['source'],
  http: HttpClient,
  extra: Partial<AdapterContext> = {},
): AdapterContext {
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-23T09:00:00Z'),
    maxDetailFetches: 1,
    ...extra,
  };
}

describe('İŞKUR e-Şube kamu ilanları', () => {
  it('envanter, kayıt defteri, robots ve şartlar kaydı otomatik taramaya uygun', () => {
    expect(iskurSource.enabled).toBe(true);
    expect(iskurSource.adapterKey).toBe('iskur-esube-kamu');
    expect(iskurSource.intervalMinutes).toBeGreaterThanOrEqual(120);
    expect(iskurSource.intervalMinutes).toBeLessThanOrEqual(180);
    expect(iskurSource.minRequestIntervalMs).toBeGreaterThanOrEqual(5_000);
    expect(iskurSource.robotsDisallow).toEqual(['/Meslek/ViewMeslekDetayPopUp.aspx/']);
    expect(requireAdapter(iskurSource.adapterKey)).toBeInstanceOf(IskurEsubeAdapter);
    const terms = loadSourceTerms();
    expect(terms.status).toBe('available');
    expect(terms.entries.get('iskur-esube-acik-is')?.decision).toBe('allowed');
    for (const key of ['iskur-kamu-memur-alim', 'iskur-kurumdisi-kamu-isci']) {
      expect(terms.entries.get(key)?.decision).toBe('blocked');
    }
  });

  it('form alanlarını tarayıcı gibi toplar ve "Kamu" postback gövdesini kurar', () => {
    const fields = collectFormFields(loadHtml(fixture('iskur-esube-arama.html')));
    expect(fields.get('__VIEWSTATE')).toBe('VS-ILK');
    expect(fields.get('ctl04$IsyeriTuruRadios')).toBe('ozelSektorRadio');
    expect(fields.get('ctl04$ctlCalismaYeri')).toBe('1');
    expect(fields.has('ctl04$ctlUlke')).toBe(false); // disabled
    expect(fields.has('ctl04$ctlAramaKaydet')).toBe(false); // submit
    expect(fields.has('ctl04$ulkeGeneliChk')).toBe(false); // işaretsiz
    fields.set('ctl04$IsyeriTuruRadios', 'kamuRadio');
    const body = new URLSearchParams(postbackBody(fields, 'ctl04$ctlAcikIsPageCommand$CommandItem_Search'));
    expect(body.get('ctl04$IsyeriTuruRadios')).toBe('kamuRadio');
    expect(body.get('__EVENTTARGET')).toBe('ctl04$ctlAcikIsPageCommand$CommandItem_Search');
  });

  it('satırları (il il ayrı İŞKUR ilan numaraları) ve sayfalayıcıyı okur', () => {
    const $ = loadHtml(fixture('iskur-esube-sonuc-1.html'));
    const rows = parseIskurRows($, iskurSource.allowedHosts);
    expect(rows.map((row) => [row.ilanNo, row.city, row.district, row.quota, row.applicationEndDate])).toEqual([
      ['00009862271', 'Ankara', null, 2, '2026-10-26'],
      ['00009862396', 'Edirne', null, 3, '2026-10-26'],
      ['00009870677', 'Ardahan', 'Çıldır', 1, '2026-10-27'],
    ]);
    expect(rows[0]?.institution).toBe('TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ');
    expect(rows[0]?.detailUrl).toBe('https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx?uiID=00009862271');
    expect(parsePager($)).toEqual({ currentPage: 1, totalPages: 2, totalRecords: 4 });
    expect(parsePager(loadHtml(fixture('iskur-esube-sonuc-2.html')))).toEqual({
      currentPage: 2,
      totalPages: 2,
      totalRecords: 4,
    });
  });

  it('detay metnini (genel hususlar, özel şartlar, meslek, öğrenim) çıkarır ve ilan kabul edilir', () => {
    const detail = parseIskurDetail(fixture('iskur-esube-detay.html'));
    expect(detail).toContain('TALEBE BAŞVURACAK ADAYLARIN DİKKATİNE');
    expect(detail).toContain('21/10/2026-26/10/2026');
    expect(detail).toContain('Raylı Sistem Araçları');
    expect(detail).not.toContain('giriş yapınız');
    expect(detail).not.toMatch(/^\s*\|\s*$/m);
    const [row] = parseIskurRows(loadHtml(fixture('iskur-esube-sonuc-1.html')), iskurSource.allowedHosts);
    const item = iskurRowToAnnouncement(row!, iskurSource.key, detail);
    expect(item).toMatchObject({
      sourceItemId: 'iskur-esube:00009862271',
      referenceNo: '00009862271',
      city: 'Ankara',
      quota: 2,
      applicationEndAt: '2026-10-26T23:59:00+03:00',
      bodyTextSource: 'detail',
    });
    const result = classify({
      title: item.title,
      body: item.bodyText ?? null,
      sourceCategory: item.sourceCategory ?? null,
      sourceKey: item.sourceKey,
    });
    expect(result.decision).toBe('accept');
  });

  it('formu gönderir, sayfalamayı izler, çerezi taşır ve detay bütçesini yeni ilanlara harcar', async () => {
    const calls: { url: string; options: FetchOptions }[] = [];
    const http = {
      async fetchText(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
        calls.push({ url, options });
        if (url.includes('AcikIsIlanDetay.aspx')) return response(url, fixture('iskur-esube-detay.html'));
        if (options.method !== 'POST') {
          return response(url, fixture('iskur-esube-arama.html'), {
            'set-cookie': 'ASP.NET_SessionId=abc; path=/; HttpOnly\nTS01=xyz; Path=/',
          });
        }
        const body = new URLSearchParams(options.formBody ?? '');
        if (body.get('__EVENTTARGET') === 'ctl04$ctlAcikIsPageCommand$CommandItem_Search') {
          expect(body.get('ctl04$IsyeriTuruRadios')).toBe('kamuRadio');
          expect(body.get('__VIEWSTATE')).toBe('VS-ILK');
          return response(url, fixture('iskur-esube-sonuc-1.html'));
        }
        if (body.get('__EVENTTARGET') === 'ctl04$ctlDataPagerDetay$btnNext') {
          expect(body.get('__VIEWSTATE')).toBe('VS-SAYFA1');
          return response(url, fixture('iskur-esube-sonuc-2.html'));
        }
        throw new Error(`Beklenmeyen istek: ${url}`);
      },
    } as unknown as HttpClient;

    const result = await new IskurEsubeAdapter().run(
      ctxFor(iskurSource, http, {
        // 00009862396 ayrıntısıyla biliniyor: yeniden üretilmez.
        knownItemIds: new Set(['iskur-esube:00009862396']),
        knownItemIdsWithDetail: new Set(['iskur-esube:00009862396']),
      }),
    );
    expect(calls.map((call) => call.options.method ?? 'GET')).toEqual(['GET', 'POST', 'POST', 'GET']);
    expect(calls[1]?.options.headers?.['cookie']).toBe('ASP.NET_SessionId=abc; TS01=xyz');
    expect(calls.every((call) => call.options.minIntervalMs === 5_000)).toBe(true);
    expect(result.coverage?.status).toBe('complete');
    expect(result.items.map((item) => item.sourceItemId)).toEqual([
      'iskur-esube:00009862271',
      'iskur-esube:00009870677',
      'iskur-esube:00009864072',
    ]);
    expect(result.items.map((item) => item.bodyTextSource)).toEqual(['detail', 'listing', 'listing']);
    expect(result.items[2]).toMatchObject({ city: 'Kayseri', district: 'Melikgazi', quota: 5 });
  });

  it('CAPTCHA çıkarsa durur (atlatma yok)', async () => {
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        return response(url, '<html><body><form><div class="g-recaptcha"></div></form></body></html>');
      },
    } as unknown as HttpClient;
    await expect(new IskurEsubeAdapter().run(ctxFor(iskurSource, http))).rejects.toBeInstanceOf(SourceAccessError);
  });
});

describe('Resmî Gazete geriye dönük tarama planı', () => {
  it('kapalıyken plan yok; açılınca pencere başlangıç gününe sabitlenir ve koşum başına sınırlıdır', () => {
    expect(planRgBackfill(null, { today: '2026-10-23', windowDays: 0, maxDaysPerRun: 3 })).toBeNull();
    const plan = planRgBackfill(null, { today: '2026-10-23', windowDays: 60, maxDaysPerRun: 3 })!;
    expect(plan.state.anchorDate).toBe('2026-10-23');
    expect(plan.dates).toEqual(['2026-10-21', '2026-10-20', '2026-10-19']);
    // Ertesi gün aynı pencere (kaymaz): kalan günler başlangıca göre hesaplanır.
    const next = recordRgBackfill(
      plan,
      [
        { dateOnly: '2026-10-21', outcome: 'done' },
        { dateOnly: '2026-10-20', outcome: 'deferred' },
        { dateOnly: '2026-10-19', outcome: 'failed' },
      ],
      new Date('2026-10-23T10:00:00Z'),
    );
    expect(next.doneDates).toEqual(['2026-10-21']);
    expect(next.attempts).toEqual({ '2026-10-19': 1 });
    const later = planRgBackfill(next, { today: '2026-10-24', windowDays: 60, maxDaysPerRun: 2 })!;
    expect(later.dates).toEqual(['2026-10-20', '2026-10-19']);
  });

  it(`${RG_BACKFILL_MAX_ATTEMPTS} başarısız denemeden sonra günü atlar; pencere bitince bir daha planlamaz`, () => {
    let plan = planRgBackfill(null, { today: '2026-10-23', windowDays: 3, maxDaysPerRun: 5 })!;
    expect(plan.dates).toEqual(['2026-10-21', '2026-10-20']);
    let state = recordRgBackfill(plan, [{ dateOnly: '2026-10-21', outcome: 'done' }], new Date());
    for (let attempt = 0; attempt < RG_BACKFILL_MAX_ATTEMPTS; attempt += 1) {
      plan = planRgBackfill(state, { today: '2026-10-23', windowDays: 3, maxDaysPerRun: 5 })!;
      state = recordRgBackfill(plan, [{ dateOnly: '2026-10-20', outcome: 'failed' }], new Date('2026-10-23T12:00:00Z'));
    }
    expect(state.skippedDates).toEqual(['2026-10-20']);
    expect(state.completedAt).toBe('2026-10-23T12:00:00.000Z');
    expect(planRgBackfill(state, { today: '2026-11-01', windowDays: 3, maxDaysPerRun: 5 })).toBeNull();
    // Pencere büyütülürse yalnız eklenen gün işlenir.
    expect(planRgBackfill(state, { today: '2026-11-01', windowDays: 4, maxDaysPerRun: 5 })?.dates).toEqual(['2026-10-19']);
    expect(readRgBackfillState({ rgBackfill: state })).toEqual(state);
  });
});

describe('Resmî Gazete adaptörü geri taraması', () => {
  afterEach(() => {
    delete process.env.RG_BACKFILL_DAYS;
    resetEnvCache();
  });

  const sectionHtml = (pdfUrls: string[]): string => `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1>
    <div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div>
    <table>${pdfUrls.map((url) => `<tr><td>ÖRNEK BELEDİYESİ <a href="${url}">(PDF)</a></td></tr>`).join('')}</table>
  </body></html>`;

  it('olağan günlerden sonra geçmiş günleri işler, ilerlemeyi döndürür ve bitince istek yapmaz', async () => {
    process.env.RG_BACKFILL_DAYS = '3';
    resetEnvCache();
    const fetchedAt = new Date('2026-10-12T09:00:00Z');
    const oldPdf = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261010-4-1.pdf';
    const textCalls: string[] = [];
    const intervals: (number | undefined)[] = [];
    const http = {
      async fetchText(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
        textCalls.push(url);
        intervals.push(options.minIntervalMs);
        return response(url, sectionHtml(url === resmiGazeteSectionUrl('2026-10-10') ? [oldPdf] : []));
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return { ...response(url, ''), body, bytes: body.byteLength, contentType: 'application/pdf', decoded: undefined };
      },
    } as unknown as HttpClient;

    const first = await new ResmiGazeteAdapter().run(ctxFor(rgSource, http, { fetchedAt, maxDetailFetches: 5 }));
    expect(textCalls).toEqual(
      ['2026-10-12', '2026-10-11', '2026-10-10', '2026-10-09'].map((date) => resmiGazeteSectionUrl(date)),
    );
    expect(intervals.every((value) => (value ?? 0) >= 2_000)).toBe(true);
    expect(first.items.map((item) => item.sourceItemId)).toEqual(['resmigazete:20261010-4-1.pdf']);
    expect(first.coverage?.status).toBe('complete'); // olağan günlerin kapsamı geri taramadan etkilenmez
    const state = readRgBackfillState(first.adapterState);
    expect(state).toMatchObject({ anchorDate: '2026-10-12', doneDates: ['2026-10-09', '2026-10-10'] });
    expect(state?.completedAt).not.toBeNull();

    textCalls.length = 0;
    const second = await new ResmiGazeteAdapter().run(
      ctxFor(rgSource, http, { fetchedAt, maxDetailFetches: 5, adapterState: first.adapterState ?? null }),
    );
    expect(textCalls).toEqual(['2026-10-12', '2026-10-11'].map((date) => resmiGazeteSectionUrl(date)));
    expect(second.adapterState).toBeUndefined();
  });

  it('PDF bütçesi olağan günlere harcandıysa geçmiş gün istek yapılmadan sonraya kalır', async () => {
    process.env.RG_BACKFILL_DAYS = '2';
    resetEnvCache();
    const textCalls: string[] = [];
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        textCalls.push(url);
        const date = url === resmiGazeteSectionUrl('2026-10-12') ? '20261012' : null;
        return response(url, sectionHtml(date ? [`https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/${date}-4-1.pdf`] : []));
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return { ...response(url, ''), body, bytes: body.byteLength, contentType: 'application/pdf', decoded: undefined };
      },
    } as unknown as HttpClient;
    const result = await new ResmiGazeteAdapter().run(
      ctxFor(rgSource, http, { fetchedAt: new Date('2026-10-12T09:00:00Z'), maxDetailFetches: 1 }),
    );
    expect(textCalls).not.toContain(resmiGazeteSectionUrl('2026-10-10'));
    const state = readRgBackfillState(result.adapterState);
    expect(state?.doneDates).toEqual([]);
    expect(state?.attempts).toEqual({});
    expect(state?.completedAt).toBeNull();
  });
});

describe('kaynak tohumlama: elle takipten otomatik adaptöre geçiş', () => {
  it('manual-entry kaydı otomatik adaptöre geçince enabled/aralık bir kez uygulanır; yönetici kapatırsa korunur', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-iskur-')));
    await store.init();
    const repos = createRepos(store, fixedClock(new Date('2026-10-23T09:00:00Z')));
    const manual = {
      ...iskurSource,
      adapterKey: 'manual-entry',
      method: 'manual-entry' as const,
      status: 'needs-manual-method' as const,
      enabled: false,
      intervalMinutes: 360,
    };
    await repos.sources.seed([manual]);
    expect((await repos.sources.getByKey(iskurSource.key))?.enabled).toBe(false);
    await repos.sources.seed([iskurSource]);
    expect(await repos.sources.getByKey(iskurSource.key)).toMatchObject({
      enabled: true,
      scrapeIntervalMinutes: iskurSource.intervalMinutes,
      adapterKey: 'iskur-esube-kamu',
    });
    // Sonradan yöneticinin kapatması sonraki tohumlamada ezilmez.
    await repos.sources.setEnabled(iskurSource.key, false);
    await repos.sources.seed([{ ...iskurSource, statusNote: `${iskurSource.statusNote} (güncellendi)` }]);
    expect((await repos.sources.getByKey(iskurSource.key))?.enabled).toBe(false);
    // Adaptör durumu kaynakta saklanır (RG geri tarama ilerlemesi).
    await repos.sources.update(iskurSource.key, { adapterState: { rgBackfill: { anchorDate: '2026-10-23' } } });
    expect((await repos.sources.getByKey(iskurSource.key))?.adapterState).toEqual({
      rgBackfill: { anchorDate: '2026-10-23' },
    });
  });
});
