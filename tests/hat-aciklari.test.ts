/**
 * 23.10.2026 hat açıkları (DURAKLATMA listesi):
 *  - SPK/EPDK liste seçicileri menü bağlantısı topluyordu → yalnız duyuru satırları;
 *  - anchor-list doğrudan PDF bağlantısına kimlik veremiyordu (satır sessizce düşüyordu);
 *  - doğrulanmış kapsayıcıda uzun (>180) başlıklı duyurular "menü" sanılıp atılıyordu;
 *  - TKGM detay sayfası yalnız yönlendirme metni; ilan `cms-api.tkgm.gov.tr` PDF'inde;
 *  - Kariyer Kapısı dış bağlantılı ilanlar gövdesiz kalıyordu.
 * Fixture'lar canlı sayfalardan (kimlikli UA, ≥2 sn aralık) alınıp script/style ayıklanmış
 * kopyalardır (tests/fixtures/kaynak-html).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { createLogger } from '../src/lib/logger';
import { yearSubpathListingUrls } from '../src/sources/adapters/anchor-list';
import {
  externalBodySourceFor,
  KARIYER_API_LIST_URL,
  KariyerKapisiAdapter,
} from '../src/sources/adapters/kariyerkapisi';
import { labelMatchesTitle, readAnnouncementDetail } from '../src/sources/detail-reader';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import { requireAdapter } from '../src/sources/registry';
import { loadSourceTerms } from '../src/sources/terms';
import type { AdapterContext } from '../src/sources/types';
import { buildPdf } from './support/pdf-fixtures';

const FIXTURES = fileURLToPath(new URL('./fixtures/kaynak-html/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');
const NOW = new Date('2026-10-23T09:00:00Z');
/** Liste testlerinde detay istekleri için yer tutucu yanıtlar (detay bütçesi > 0 iken kayıt üretilir). */
const DETAIL_STUB = {
  text: { body: '<html><body><main><p>Duyuru metni.</p></main></body></html>' },
  binary: { body: Buffer.from('%PDF-1.4 bozuk'), type: 'application/pdf' },
};

function response(url: string, body: Buffer, contentType: string): FetchResponse {
  const isText = !contentType.includes('pdf');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': contentType },
    body,
    contentType,
    etag: null,
    lastModified: null,
    notModified: false,
    ...(isText ? { decoded: { text: body.toString('utf8'), charset: 'utf-8', charsetGuessed: false } } : {}),
    bytes: body.byteLength,
  } as FetchResponse;
}

interface Route {
  body: string | Buffer;
  type?: string;
}

/** Yol tablosuyla sahte HTTP; tabloda olmayan istek hata (ağ yok). İzinli host listesi de kaydedilir. */
function fakeHttp(routes: Record<string, Route>, fallback?: { text: Route; binary: Route }): {
  http: HttpClient;
  calls: { url: string; kind: 'text' | 'binary'; allowedHosts: readonly string[]; minIntervalMs?: number }[];
} {
  const calls: { url: string; kind: 'text' | 'binary'; allowedHosts: readonly string[]; minIntervalMs?: number }[] = [];
  const serve = (url: string, kind: 'text' | 'binary', options: { allowedHosts?: readonly string[]; minIntervalMs?: number } = {}) => {
    calls.push({ url, kind, allowedHosts: options.allowedHosts ?? [], minIntervalMs: options.minIntervalMs });
    const route = routes[url] ?? fallback?.[kind];
    if (!route) throw new Error(`Beklenmeyen istek: ${url}`);
    const body = typeof route.body === 'string' ? Buffer.from(route.body, 'utf8') : route.body;
    return response(url, body, route.type ?? 'text/html; charset=utf-8');
  };
  const http = {
    async fetchText(url: string, options?: { allowedHosts?: readonly string[]; minIntervalMs?: number }) {
      return serve(url, 'text', options);
    },
    async fetchBinary(url: string, options?: { allowedHosts?: readonly string[]; minIntervalMs?: number }) {
      return serve(url, 'binary', options);
    },
    async close(): Promise<void> {},
  };
  return { http: http as unknown as HttpClient, calls };
}

function source(key: string): SourceDefinition {
  const found = SOURCE_DEFINITIONS.find((entry) => entry.key === key);
  if (!found) throw new Error(`${key} envanterde yok`);
  return found;
}

function ctx(src: SourceDefinition, http: HttpClient, maxDetailFetches = 0): AdapterContext {
  return {
    source: src,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: NOW,
    maxDetailFetches,
  };
}

describe('SPK: yıl sayfası, yalnız duyuru satırları', () => {
  it('menü bağlantısı toplamaz; uzun başlıklı ve PDF bağlantılı duyurular dahil 20 satırın hepsi kayıt olur', async () => {
    const src = source('spk-duyurular');
    expect(src.listingUrl).toBe('https://www.spk.gov.tr/duyurular/basin-duyurulari');
    const listing = 'https://www.spk.gov.tr/duyurular/basin-duyurulari/2026';
    const { http, calls } = fakeHttp({
      [listing]: { body: fixture('spk-basin-duyurulari-2026.html') },
      // Sayfa 2 aynı fixture: tekrar eden kimlikler sayfalamayı durdurur.
      [`${listing}?s=2`]: { body: fixture('spk-basin-duyurulari-2026.html') },
    }, DETAIL_STUB);
    const result = await requireAdapter(src.adapterKey).run(ctx(src, http, 50));
    expect(calls[0]?.url).toBe(listing);
    expect(result.items).toHaveLength(20);
    for (const item of result.items) {
      expect(item.url).toMatch(/spk\.gov\.tr\/(?:duyurular\/basin-duyurulari\/2026\/[^/]+|data\/[0-9a-f]{24}\/[^/]+\.pdf)$/);
    }
    // Eskiden kimlik alamayıp düşen ilan PDF'i: kararlı "belge-" kimliği.
    const pdf = result.items.find((item) => item.url.endsWith('.pdf'));
    expect(pdf?.title).toMatch(/Meslek Personel Yardımcılığı Giriş Sınavı/);
    expect(pdf?.sourceItemId).toMatch(/^belge-[0-9a-f]{20}$/);
    // >180 karakterlik başlık artık atılmıyor (CPMI-IOSCO duyurusu).
    expect(result.items.some((item) => /CPMI-IOSCO$/.test(item.url))).toBe(true);
  });

  it('yıl alt sayfası İstanbul saatine göre; Ocak başında önceki yıl da okunur', () => {
    const base = 'https://www.spk.gov.tr/duyurular/basin-duyurulari/';
    expect(yearSubpathListingUrls(base, new Date('2026-10-23T09:00:00Z'))).toEqual([`${base.slice(0, -1)}/2026`]);
    // 31 Aralık 21:30 UTC = 1 Ocak 00:30 İstanbul
    expect(yearSubpathListingUrls(base, new Date('2026-12-31T21:30:00Z'))).toEqual([
      `${base.slice(0, -1)}/2027`,
      `${base.slice(0, -1)}/2026`,
    ]);
    expect(yearSubpathListingUrls(base, new Date('2027-01-16T12:00:00Z'))).toEqual([`${base.slice(0, -1)}/2027`]);
  });
});

describe('EPDK: tam duyuru listesi tablosu', () => {
  it('#AnnouncementList yalnız 4-<kimlik> duyurularını verir; menü (1-…, 3-…) yok', async () => {
    const src = source('epdk-duyurular');
    const { http } = fakeHttp({ [src.listingUrl]: { body: fixture('epdk-duyuru-listesi.html') } }, DETAIL_STUB);
    const result = await requireAdapter(src.adapterKey).run(ctx(src, http, 50));
    // Tabloda 14 tekil duyuru; "Sıkça Sorulan Sorular" başlıklı 1 satır site iskeleti kuralıyla elenir.
    expect(result.items).toHaveLength(13);
    for (const item of result.items) expect(item.url).toMatch(/^https:\/\/www\.epdk\.gov\.tr\/Detay\/Icerik\/4-[1-9]\d*\//);
    const long = result.items.find((item) => item.url.includes('4-16455'));
    expect(long?.title).toMatch(/^Spot boru gazı ithalatı 2026\/10 Talep Çağrısı/);
    expect(long?.title.length).toBeLessThanOrEqual(281);
  });
});

const TKGM_DETAIL_URL = 'https://www.tkgm.gov.tr/duyurular/tapu-ve-kadastro-genel-mudurlugu-sozlesmeli-bilisim-personel-alim-ilani';
const TKGM_PDF_URL = 'https://cms-api.tkgm.gov.tr/media/101807/view';
// Canlı sayfanın (730 KB Next.js akışı) ilan bölümünün kısaltılmış biçimi: tek cümle + uzantısız
// `download` öznitelikli belge bağlantısı.
const TKGM_DETAIL_HTML = `<!doctype html><html><body><main><article>
<p>Tapu ve Kadastro Genel Müdürlüğü Sözleşmeli Bilişim Personel Alım İlanı için aşağıdaki bağlantıyı tıklayınız...</p>
<a download="" target="_blank" href="${TKGM_PDF_URL}">İLAN</a>
</article></main></body></html>`;
const TKGM_PDF = buildPdf({
  title: 'Ilan',
  lines: [
    'TAPU VE KADASTRO GENEL MUDURLUGU',
    'SOZLESMELI BILISIM PERSONELI ALIM ILANI',
    'Bilgi Teknolojileri Dairesi Baskanliginda istihdam edilmek uzere 375 sayili KHK Ek-6 maddesi',
    'uyarinca sozlesmeli bilisim personeli alinacaktir. Basvurular 10.11.2026 tarihine kadar yapilir.',
  ],
});

describe('TKGM: detay metni ekli PDF\'te', () => {
  it('cms-api host\'u izinli: yönlendirme sayfasının PDF eki okunur', async () => {
    const src = source('tkgm-duyurular');
    expect(src.allowedHosts).toContain('cms-api.tkgm.gov.tr');
    const { http, calls } = fakeHttp({
      [TKGM_DETAIL_URL]: { body: TKGM_DETAIL_HTML },
      [TKGM_PDF_URL]: { body: TKGM_PDF, type: 'application/pdf' },
    });
    const read = await readAnnouncementDetail(ctx(src, http), TKGM_DETAIL_URL, {
      allowedHosts: src.allowedHosts,
      minIntervalMs: src.minRequestIntervalMs,
    });
    expect(read.failure).toBeNull();
    expect(read.bodyFrom).toBe('html+pdf');
    expect(read.bodyText).toMatch(/SOZLESMELI BILISIM PERSONELI ALIM ILANI/);
    expect(read.requests).toBe(2);
    expect(calls.map((call) => call.kind)).toEqual(['text', 'binary']);
  });

  it('eski izin listesiyle (cms-api yok) metin alınamaz ve nedeni nota yazılır', async () => {
    const src = source('tkgm-duyurular');
    const { http, calls } = fakeHttp({ [TKGM_DETAIL_URL]: { body: TKGM_DETAIL_HTML } });
    const read = await readAnnouncementDetail(ctx(src, http), TKGM_DETAIL_URL, {
      allowedHosts: ['www.tkgm.gov.tr', 'tkgm.gov.tr'],
      minIntervalMs: 0,
    });
    expect(read.bodyText).toBeNull();
    expect(calls).toHaveLength(1);
    expect(read.notes.join(' ')).toMatch(/izinli host listesi dışında/);
  });

  it('robots Disallow kuralına takılan adres istenmez', async () => {
    const src = source('tkgm-duyurular');
    const { http, calls } = fakeHttp({});
    const read = await readAnnouncementDetail(ctx(src, http), 'https://www.tkgm.gov.tr/api/x', {
      allowedHosts: src.allowedHosts,
      minIntervalMs: 0,
      robotsDisallow: ['/api/'],
    });
    expect(read.failure).toMatch(/robots\.txt/);
    expect(calls).toHaveLength(0);
  });
});

const ADALET_TITLE = '2026 Yılı Açıktan İcra Müdür ve İcra Müdür Yardımcılığı Sınav İlanı';
const ADALET_URL =
  'https://iidb.adalet.gov.tr/Home/SayfaDetay/2026-yili-aciktan-icra-mudur-ve-icra-mudur-yardimciligi-sinav-ilani02102026113030';
const ADALET_PDF_URL =
  'https://iidb.adalet.gov.tr/Resimler/SayfaDokuman/202610021655235582026%20Y%C4%B1l%C4%B1%20A%C3%A7%C4%B1ktan%20%C4%B0cra%20M%C3%BCd%C3%BCr%20ve%20%C4%B0cra%20M%C3%BCd%C3%BCr%20Yard%C4%B1mc%C4%B1l%C4%B1%C4%9F%C4%B1%20S%C4%B1nav%20%C4%B0lan%C4%B1.pdf';
const ADALET_PDF = buildPdf({
  title: 'Icra Mudur Sinav Ilani',
  lines: [
    'T.C. ADALET BAKANLIGI',
    'ACIKTAN ALIM SURETIYLE ICRA MUDUR VE ICRA MUDUR YARDIMCILARINI SECME SINAVI DUYURUSU',
    '1- Bakanligimizca, yazili ve sozlu sinavlar ile 150 Icra Mudur ve Icra Mudur Yardimcisi aciktan alinacaktir.',
    '2- Basvurular 05.11.2026 tarihine kadar e-Devlet uzerinden yapilacaktir.',
  ],
});

function kariyerList(rows: Record<string, unknown>[]): string {
  return JSON.stringify({ searchIlan: rows });
}

describe('Kariyer Kapısı: dış bağlantılı ilan gövdesi', () => {
  const terms = loadSourceTerms(process.cwd());

  it('yalnız şartları incelenmiş kayıtlı kaynağın host\'una gidilir; liste/kök adresler ve bilinmeyen hostlar okunmaz', () => {
    expect(externalBodySourceFor(ADALET_URL, 'kariyerkapisi-isealim', terms, SOURCE_DEFINITIONS, NOW)?.key).toBe(
      'adalet-bakanligi-duyurular',
    );
    // İŞKUR e-Şube arama sayfası = kaynağın liste sayfası; kök adres de ilan değil.
    expect(
      externalBodySourceFor('https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx', 'kariyerkapisi-isealim', terms, SOURCE_DEFINITIONS, NOW),
    ).toBeNull();
    expect(externalBodySourceFor('https://esube.iskur.gov.tr/', 'kariyerkapisi-isealim', terms, SOURCE_DEFINITIONS, NOW)).toBeNull();
    // Envanterde olmayan kurum sitesi (şartları incelenmemiş): gidilmez.
    expect(
      externalBodySourceFor('https://personeltemin.jandarma.gov.tr/ilan', 'kariyerkapisi-isealim', terms, SOURCE_DEFINITIONS, NOW),
    ).toBeNull();
    // Şartları "blocked" olan kaynak (ilan.gov.tr) host'u: gidilmez.
    expect(
      externalBodySourceFor('https://www.ilan.gov.tr/ilan/123/x', 'kariyerkapisi-isealim', terms, SOURCE_DEFINITIONS, NOW),
    ).toBeNull();
  });

  it('başlıkla örtüşen ekli belge, uzun menü metnine rağmen okunur', () => {
    expect(labelMatchesTitle(ADALET_TITLE, ADALET_TITLE)).toBe(true);
    expect(labelMatchesTitle('Kamuoyuna Açıklama', ADALET_TITLE)).toBe(false);
  });

  it('Adalet İİDB dış ilanı: gövde kurum sayfasının PDF ekinden, adalet kaynağının kurallarıyla okunur', async () => {
    const src = source('kariyerkapisi-isealim');
    const adalet = source('adalet-bakanligi-duyurular');
    const { http, calls } = fakeHttp({
      [KARIYER_API_LIST_URL]: {
        type: 'application/json',
        body: kariyerList([
          {
            guid: '',
            kurumAdi: 'ADALET BAKANLIĞI',
            ilanBaslik: ADALET_TITLE,
            ilanTipi: 2,
            bitTarih: '2026-11-05T00:00:00',
            basvuruLinki: ADALET_URL,
          },
          {
            guid: '',
            kurumAdi: 'JANDARMA VE SAHİL GÜVENLİK AKADEMİSİ BAŞKANLIĞI',
            ilanBaslik: 'Subay ve Astsubay Temini Başvuru Duyurusu 2026',
            ilanTipi: 2,
            bitTarih: '2026-11-10T00:00:00',
            basvuruLinki: 'https://personeltemin.jandarma.gov.tr/duyuru',
          },
        ]),
      },
      [ADALET_URL]: { body: fixture('adalet-iidb-sayfadetay.html') },
      [ADALET_PDF_URL]: { body: ADALET_PDF, type: 'application/pdf' },
    });
    const result = await new KariyerKapisiAdapter(async () => {
      throw new Error('tarayıcı çağrılmamalı');
    }, terms).run(ctx(src, http, 5));

    const item = result.items.find((entry) => entry.title === ADALET_TITLE);
    expect(item?.bodyTextSource).toBe('detail');
    expect(item?.bodyText).toMatch(/150 Icra Mudur ve Icra Mudur Yardimcisi aciktan alinacaktir/);
    // Başlıkla eşleşen belge okunduğunda kenar çubuğu metni (başka duyurular) gövdeye girmez.
    expect(item?.bodyText).not.toMatch(/Son Haberler/);
    expect(item?.attachments.some((attachment) => attachment.url === ADALET_PDF_URL)).toBe(true);
    // İstekler hedef kaynağın izin listesi ve hız sınırıyla yapıldı.
    const external = calls.filter((call) => call.url.startsWith('https://iidb.adalet.gov.tr/'));
    expect(external).toHaveLength(2);
    for (const call of external) {
      expect(call.allowedHosts).toEqual(adalet.allowedHosts);
      expect(call.minIntervalMs).toBe(adalet.minRequestIntervalMs);
    }
    // Jandarma: kayıtlı kaynak yok → istek yok, kayıt gövdesiz (inceleme).
    expect(calls.some((call) => call.url.includes('jandarma'))).toBe(false);
    const jandarma = result.items.find((entry) => /Astsubay/.test(entry.title));
    expect(jandarma?.bodyText).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/1 dış bağlantılı ilanın adresi şartları incelenmiş kayıtlı bir kaynağa ait değil/);
  });

  it('detay bütçesi 0 iken dış gövde okunmaz, sonraki taramaya bırakılır', async () => {
    const src = source('kariyerkapisi-isealim');
    const { http, calls } = fakeHttp({
      [KARIYER_API_LIST_URL]: {
        type: 'application/json',
        body: kariyerList([
          { guid: '', kurumAdi: 'ADALET BAKANLIĞI', ilanBaslik: ADALET_TITLE, ilanTipi: 2, bitTarih: '2026-11-05T00:00:00', basvuruLinki: ADALET_URL },
        ]),
      },
    });
    const result = await new KariyerKapisiAdapter(async () => {
      throw new Error('tarayıcı çağrılmamalı');
    }, terms).run(ctx(src, http, 0));
    expect(calls).toHaveLength(1);
    expect(result.items[0]?.bodyText).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/1 dış ilan gövdesi detay\/zaman bütçesi nedeniyle/);
  });

  it('önceden gövdesiz kaydedilen dış ilan, gövdesi okunabiliyorsa yeniden denenir', async () => {
    const src = source('kariyerkapisi-isealim');
    const { http } = fakeHttp({
      [KARIYER_API_LIST_URL]: {
        type: 'application/json',
        body: kariyerList([
          { guid: '', kurumAdi: 'ADALET BAKANLIĞI', ilanBaslik: ADALET_TITLE, ilanTipi: 2, bitTarih: '2026-11-05T00:00:00', basvuruLinki: ADALET_URL },
        ]),
      },
      [ADALET_URL]: { body: fixture('adalet-iidb-sayfadetay.html') },
      [ADALET_PDF_URL]: { body: ADALET_PDF, type: 'application/pdf' },
    });
    const adapter = new KariyerKapisiAdapter(async () => {
      throw new Error('tarayıcı çağrılmamalı');
    }, terms);
    const first = await adapter.run(ctx(src, fakeHttp({
      [KARIYER_API_LIST_URL]: {
        type: 'application/json',
        body: kariyerList([
          { guid: '', kurumAdi: 'ADALET BAKANLIĞI', ilanBaslik: ADALET_TITLE, ilanTipi: 2, bitTarih: '2026-11-05T00:00:00', basvuruLinki: ADALET_URL },
        ]),
      },
    }).http, 0));
    const itemId = first.items[0]!.sourceItemId;
    const retried = await adapter.run({ ...ctx(src, http, 5), knownItemIds: new Set([itemId]), knownItemIdsWithDetail: new Set<string>() });
    expect(retried.items).toHaveLength(1);
    expect(retried.items[0]?.bodyText).toMatch(/Icra Mudur/);
  });
});
