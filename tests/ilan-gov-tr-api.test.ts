/**
 * ilan.gov.tr JSON API adaptörü testleri (ağ yok; sahte HTTP istemcisi).
 *
 * Sözleşme (herkese açık projelerden öğrenildi, bkz. adaptör dosya başı):
 *   POST /api/api/services/app/Ad/AdsByFilter
 *        {"keys":{"txv":[kategori],"currentPage":[n]},"sorting":"publish_time desc","skipCount":N,"maxResultCount":20}
 *   GET  /api/api/services/app/AdDetail/GetAdDetail?id=<id>  → result.content (HTML)
 * Fixture'lar sentetiktir (canlı API 23.10.2026'da bu istemciye 403 döndü).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { createLogger } from '../src/lib/logger';
import {
  collectApiText,
  deadlineFromAdFilters,
  extractDetailLinks,
  IlanGovTrApiAdapter,
  isNonPersonnelAdType,
  MAX_LIST_PAGES,
  PAGE_SIZE,
  PERSONNEL_CATEGORIES,
} from '../src/sources/adapters/ilan-gov-tr-api';
import { FetchError, type FetchResponse, type HttpClient } from '../src/sources/fetcher';
import { AdapterStructureError, SourceAccessError } from '../src/sources/errors';
import type { SourceDefinition } from '../src/config/sources';
import type { AdapterContext } from '../src/sources/types';

const API_BASE = 'https://www.ilan.gov.tr/api/api/services/app';
const LIST_URL = `${API_BASE}/Ad/AdsByFilter`;
const FIXTURES = join(__dirname, 'fixtures', 'ilan-gov-tr-api');
const listFixture = JSON.parse(readFileSync(join(FIXTURES, 'ads-by-filter-txv8.json'), 'utf8')) as unknown;
const detailFixture = JSON.parse(readFileSync(join(FIXTURES, 'ad-detail.json'), 'utf8')) as unknown;

function jsonResponse(url: string, payload: unknown): FetchResponse {
  const text = JSON.stringify(payload);
  const body = Buffer.from(text, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
    contentType: 'application/json; charset=utf-8',
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

interface ListBody {
  keys: { txv: number[]; currentPage: number[] };
  sorting: string;
  skipCount: number;
  maxResultCount: number;
}

interface RecordedCall {
  url: string;
  method: string;
  jsonBody: unknown;
  headers: Record<string, string> | undefined;
}

/** Sahte HTTP istemcisi: JSON cevabı döner, istek kaydı tutar (ağ yok). */
function fakeJsonHttp(
  resolve: (url: string, call: RecordedCall) => unknown | undefined,
  failure?: (url: string) => FetchError | null,
): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handler = {
    async fetchText(
      url: string,
      options?: { method?: string; jsonBody?: unknown; headers?: Record<string, string> },
    ): Promise<FetchResponse> {
      const call: RecordedCall = {
        url,
        method: options?.method ?? 'GET',
        jsonBody: options?.jsonBody,
        headers: options?.headers,
      };
      calls.push(call);
      const error = failure?.(url);
      if (error) throw error;
      const payload = resolve(url, call);
      if (payload === undefined) throw new Error(`Beklenmeyen istek: ${url}`);
      return jsonResponse(url, payload);
    },
    async fetchBinary(url: string): Promise<FetchResponse> {
      throw new Error(`İkili istek beklenmiyordu: ${url}`);
    },
    async close(): Promise<void> {
      /* ağ yok */
    },
  };
  return { http: handler as unknown as HttpClient, calls };
}

const NOW = new Date('2026-10-23T09:00:00.000Z');

function contextFor(source: SourceDefinition, http: HttpClient, maxDetailFetches = 10): AdapterContext {
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: NOW,
    maxDetailFetches,
  };
}

const apiSource = SOURCE_DEFINITIONS.find((source) => source.adapterKey === 'ilan-gov-tr-api');
const ilanApiSource = apiSource as SourceDefinition;

function ad(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${index}`,
    adNo: `ILN-${index}`,
    title: `Örnek Kurum Sözleşmeli Personel Alım İlanı ${index}`,
    advertiserName: 'Örnek Kurum',
    addressCityName: 'ANKARA',
    publishStartDate: '2026-10-20T10:00:00',
    urlStr: `/ilan/${index}/ornek`,
    isArchived: false,
    adTypeFilters: [
      { key: 'İlan Türü', value: 'PERSONEL ALIMI' },
      { key: 'Son Başvuru Tarihi', value: '10.11.2026' },
    ],
    ...overrides,
  };
}

const page = (ads: Record<string, unknown>[], numFound: number): unknown => ({ result: { numFound, ads } });
const detailText = { result: { content: `<p>${'Başvuru koşulları ve aranan nitelikler. '.repeat(8)}</p>` } };
const listCalls = (calls: RecordedCall[]): RecordedCall[] => calls.filter((call) => call.url === LIST_URL);
const bodyOf = (call: RecordedCall): ListBody => call.jsonBody as ListBody;

describe('ilan.gov.tr JSON API adaptörü', () => {
  it('envanterde tanımlıdır; canlı 403 engelini ve sözleşme kaynaklarını dürüstçe bildirir', () => {
    expect(apiSource).toBeDefined();
    expect(apiSource?.method).toBe('json-api');
    expect(apiSource?.status).toBe('scraper-built');
    expect(apiSource?.lastVerifiedAt).toBeNull();
    expect(apiSource?.verificationEvidence).toContain('403');
    expect(apiSource?.verificationEvidence).toContain('n8n-ilan-gov-tr-akademik-is-ilani-takip');
    expect(apiSource?.statusNote).toContain('CİMER');
    expect(apiSource?.robotsDisallow).toContain('/*tebligat');
  });

  it('her kamu personeli kategorisini txv gövdesiyle, 20’lik sayfayla ve taklit başlığı olmadan ister', async () => {
    const { http, calls } = fakeJsonHttp((url) => {
      if (url === LIST_URL) return page([ad(1)], 1);
      if (url.includes('/AdDetail/GetAdDetail')) return detailText;
      return undefined;
    });

    await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));

    const lists = listCalls(calls);
    expect(lists.map((call) => bodyOf(call).keys.txv[0])).toEqual(PERSONNEL_CATEGORIES.map((c) => c.txv));
    expect(PERSONNEL_CATEGORIES.map((c) => c.txv)).toEqual([8, 73]);
    expect(lists[0]?.method).toBe('POST');
    expect(lists[0]?.jsonBody).toEqual({
      keys: { txv: [8], currentPage: [1] },
      sorting: 'publish_time desc',
      skipCount: 0,
      maxResultCount: PAGE_SIZE,
    });
    expect(PAGE_SIZE).toBe(20);
    for (const call of calls) {
      const names = Object.keys(call.headers ?? {}).map((name) => name.toLowerCase());
      expect(names).not.toContain('x-request-origin');
      expect(names).not.toContain('user-agent');
    }
    // Detay yalnız `id` ile istenir (adNo değil).
    const detail = calls.find((call) => call.url.includes('/AdDetail/GetAdDetail'));
    expect(detail?.url).toBe(`${API_BASE}/AdDetail/GetAdDetail?id=id-1`);
  });

  it('fixture: alanları okur, ihale ve başvurusu kapanmış kaydı eler, detay HTML’inden tam metin ve ek çıkarır', async () => {
    const { http } = fakeJsonHttp((url, call) => {
      if (url === LIST_URL) return bodyOf(call).keys.txv[0] === 8 ? listFixture : page([], 0);
      if (url.endsWith('id=f1a0c3d2-0001')) return detailFixture;
      if (url.includes('/AdDetail/GetAdDetail')) return detailText;
      return undefined;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));

    expect(result.items.map((item) => item.sourceItemId)).toEqual(['ILN02400001', 'YOK02400002']);
    const item = result.items[0];
    expect(item?.url).toBe(
      'https://www.ilan.gov.tr/ilan/1900001/ornek-belediye-baskanligi-sozlesmeli-personel-alim-ilani',
    );
    expect(item?.institution).toBe('ÖRNEK BELEDİYE BAŞKANLIĞI');
    expect(item?.city).toBe('ANKARA');
    expect(item?.district).toBe('ÇANKAYA');
    expect(item?.referenceNo).toBe('ILN02400001');
    expect(item?.publishedAt).toBe('2026-10-20');
    expect(item?.applicationEndAt).toBe('2026-11-05T23:59:00+03:00');
    expect(item?.sourceCategory).toBe('Kamu / Akademik Personel');
    expect(item?.bodyTextSource).toBe('detail');
    expect(item?.bodyText).toContain('İnşaat Mühendisi');
    expect(item?.bodyText).toContain('KPSSP3');
    expect(item?.bodyText).not.toContain('<td>');
    expect(item?.attachments).toEqual([
      {
        url: 'https://medya.ilan.gov.tr/ilan/ekler/1900001/basvuru-formu.pdf',
        label: 'Başvuru Formu',
        kind: 'pdf',
      },
    ]);
    expect(item?.links?.map((link) => link.url)).toContain('https://www.ornek.bel.tr/duyuru');
    expect(item?.links?.some((link) => link.url.startsWith('mailto:'))).toBe(false);

    const notes = result.notes.join(' ');
    expect(notes).toContain('1 kayıt "İlan Türü" personel alımı olmadığı için elendi');
    expect(notes).toContain('1 başvurusu kapanmış');
    expect(notes).toContain('Kategori faseti: 8=Kamu / Akademik Personel (4)');
    expect(result.coverage?.status).toBe('complete');
    expect(result.httpStatuses?.every((status) => status === 200)).toBe(true);
  });

  it('skipCount’u dönen kayıt sayısı kadar ilerletir ve numFound dolunca durur', async () => {
    const total = 45;
    const { http, calls } = fakeJsonHttp((url, call) => {
      if (url === LIST_URL) {
        const body = bodyOf(call);
        if (body.keys.txv[0] !== 8) return page([], 0);
        const start = body.skipCount;
        const count = Math.max(0, Math.min(PAGE_SIZE, total - start));
        return page(Array.from({ length: count }, (_, i) => ad(start + i)), total);
      }
      return detailText;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http, 0));
    const txv8 = listCalls(calls).filter((call) => bodyOf(call).keys.txv[0] === 8);
    expect(txv8.map((call) => bodyOf(call).skipCount)).toEqual([0, 20, 40]);
    expect(txv8.map((call) => bodyOf(call).keys.currentPage[0])).toEqual([1, 2, 3]);
    expect(result.items).toHaveLength(total);
    expect(result.coverage?.status).toBe('complete');
  });

  it('çalışma başına sayfa sınırına uyar ve kapsamı kısmi bildirir', async () => {
    const { http, calls } = fakeJsonHttp((url, call) => {
      if (url === LIST_URL) {
        const body = bodyOf(call);
        const base = (body.keys.txv[0] ?? 0) * 100_000 + body.skipCount;
        return page(Array.from({ length: PAGE_SIZE }, (_, i) => ad(base + i)), 10_000);
      }
      return detailText;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http, 0));
    expect(listCalls(calls).length).toBeLessThanOrEqual(MAX_LIST_PAGES);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toMatch(/sayfa sınırı/);
  });

  it('sayfanın tamamı eski ve başvurusu kapanmışsa derine inmez', async () => {
    const old = { publishStartDate: '2026-03-01T10:00:00', adTypeFilters: [{ key: 'Son Başvuru', value: '20.03.2026' }] };
    const { http, calls } = fakeJsonHttp((url, call) => {
      if (url === LIST_URL) {
        const start = bodyOf(call).skipCount;
        return page(Array.from({ length: PAGE_SIZE }, (_, i) => ad(start + i, old)), 5_000);
      }
      return detailText;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    expect(listCalls(calls)).toHaveLength(PERSONNEL_CATEGORIES.length);
    expect(result.items).toHaveLength(0);
    expect(result.coverage?.status).toBe('complete');
  });

  it('kategoriler arası yinelenenleri tekilleştirir; bilinenleri yinelemez, detaysız bilinenleri yeniden dener', async () => {
    let detailFails = true;
    const { http, calls } = fakeJsonHttp(
      (url) => {
        if (url === LIST_URL) return page([ad(1), ad(2), ad(3)], 3);
        return detailText;
      },
      (url) =>
        detailFails && url.endsWith('id=id-3') ? new FetchError(url, 'Zaman aşımı', null, true) : null,
    );

    const ctx = {
      ...contextFor(ilanApiSource, http),
      knownItemIds: new Set(['ILN-1', 'ILN-2', 'ILN-3']),
      knownItemIdsWithDetail: new Set(['ILN-1']),
    };
    const result = await new IlanGovTrApiAdapter().run(ctx);
    // İki kategori aynı üç ilanı döndürdü: üç benzersiz kayıt. ILN-1 ayrıntılı bilinir → atlanır.
    // ILN-2 detay aldı → üretilir; ILN-3 detayı başarısız → üretilmez (sonraki taramada yeniden).
    expect(result.items.map((item) => item.sourceItemId)).toEqual(['ILN-2']);
    expect(calls.filter((call) => call.url.includes('GetAdDetail')).length).toBe(2);
    expect(result.notes.join(' ')).toContain('Detay okunamadı (ILN-3)');

    detailFails = false;
    const result2 = await new IlanGovTrApiAdapter().run({ ...ctx, knownItemIds: new Set<string>() });
    expect(result2.items.map((item) => item.sourceItemId)).toEqual(['ILN-1', 'ILN-2', 'ILN-3']);
  });

  it('detay bütçesi dolunca yeni ilanları liste bilgisiyle üretir ve ertelemeyi bildirir', async () => {
    const { http, calls } = fakeJsonHttp((url) => {
      if (url === LIST_URL) return page([ad(1), ad(2), ad(3), ad(4), ad(5)], 5);
      return detailText;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http, 2));
    expect(result.items).toHaveLength(5);
    expect(result.items.filter((item) => item.bodyText).length).toBe(2);
    expect(result.items[4]?.extractionConfidence).toBe(0.5);
    expect(calls.filter((call) => call.url.includes('GetAdDetail')).length).toBe(2);
    expect(result.notes.join(' ')).toContain('3 ilanın ayrıntısı sonraki taramalarda alınacak');
  });

  it('kategori süzgeci yok sayılırsa personel dışı kayıtları eler ve uyarır', async () => {
    const tender = { adTypeFilters: [{ key: 'İlan Türü', value: 'İHALE' }] };
    const { http } = fakeJsonHttp((url) => {
      if (url === LIST_URL) return page([ad(1), ad(2, tender), ad(3, tender), ad(4, tender)], 4);
      return detailText;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    expect(result.items.map((item) => item.sourceItemId)).toEqual(['ILN-1']);
    expect(result.notes.join(' ')).toMatch(/kategori süzgeci \(txv\) yok sayılıyor olabilir/);
  });

  it('tüm kategoriler numFound=0 dönerse kapsamı bilinmiyor sayar (geçersiz sıralama sessiz boş döner)', async () => {
    const { http } = fakeJsonHttp((url) => (url === LIST_URL ? page([], 0) : undefined));
    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    expect(result.items).toHaveLength(0);
    expect(result.coverage?.status).toBe('unknown');
  });

  it('API sözleşmesi değişirse yapı hatası fırlatır (sessiz yanlış veri üretmez)', async () => {
    const { http } = fakeJsonHttp((url) => (url === LIST_URL ? { unexpected: true } : undefined));
    await expect(new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http))).rejects.toBeInstanceOf(
      AdapterStructureError,
    );
  });

  it('JSON olmayan yanıtta yapı hatası fırlatır', async () => {
    const handler = {
      async fetchText(): Promise<FetchResponse> {
        const text = '<html>Bakım</html>';
        return {
          url: API_BASE,
          finalUrl: API_BASE,
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from(text, 'utf8'),
          contentType: 'text/html',
          etag: null,
          lastModified: null,
          notModified: false,
          decoded: { text, charset: 'utf-8', charsetGuessed: false },
          bytes: text.length,
        };
      },
      async close(): Promise<void> {},
    } as unknown as HttpClient;

    await expect(new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, handler))).rejects.toBeInstanceOf(
      AdapterStructureError,
    );
  });

  it('401/403 erişim kısıtını aşmadan kaynak erişim hatasına çevirir', async () => {
    const { http, calls } = fakeJsonHttp(
      () => undefined,
      (url) => new FetchError(url, 'Forbidden', 403, false),
    );
    const run = new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    await expect(run).rejects.toBeInstanceOf(SourceAccessError);
    await expect(run).rejects.toThrow(/taklit edilmez/);
    expect(calls).toHaveLength(1);
  });

  it('canlı erişim kapalıyken ağ isteği yapmaz', async () => {
    const { http, calls } = fakeJsonHttp(() => undefined);
    const result = await new IlanGovTrApiAdapter().run({ ...contextFor(ilanApiSource, http), liveFetch: false });
    expect(calls).toHaveLength(0);
    expect(result.items).toHaveLength(0);
    expect(result.notModified).toBe(false);
  });
});

describe('API yardımcıları', () => {
  it('collectApiText tüm metin değerlerini HTML etiketlerinden arındırıp toplar', () => {
    const text = collectApiText({ a: '<p>Merhaba <strong>dünya</strong></p>', b: ['bir', { c: 'iki' }], d: 42 });
    expect(text).toContain('Merhaba dünya');
    expect(text).toContain('iki');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('42');
  });

  it('collectApiText aşırı iç içe geçmiş yapıda kontrollü durur', () => {
    let deep: unknown = 'uç';
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(collectApiText(deep)).toBe('');
  });

  it('deadlineFromAdFilters "Son Başvuru" değerini ISO tarihe çevirir', () => {
    expect(deadlineFromAdFilters([{ key: 'Son Başvuru Tarihi', value: '02.11.2026' }])).toBe(
      '2026-11-02T23:59:00+03:00',
    );
    expect(deadlineFromAdFilters([{ key: 'Başvuru Bitiş', value: '5/1/2027' }])).toBe('2027-01-05T23:59:00+03:00');
    expect(deadlineFromAdFilters([{ key: 'İl', value: 'Ankara' }])).toBeNull();
    expect(deadlineFromAdFilters([{ key: 'Son Başvuru', value: 'yakında' }])).toBeNull();
  });

  it('isNonPersonnelAdType yalnız açıkça başka türü eler', () => {
    expect(isNonPersonnelAdType([{ key: 'İlan Türü', value: 'İHALE' }])).toBe(true);
    expect(isNonPersonnelAdType([{ key: 'İlan Türü', value: 'PERSONEL ALIMI' }])).toBe(false);
    expect(isNonPersonnelAdType([{ key: 'Son Başvuru', value: '01.01.2027' }])).toBe(false);
    expect(isNonPersonnelAdType(null)).toBe(false);
  });

  it('extractDetailLinks dış alan adındaki belgeyi ek yapmaz', () => {
    const { links, attachments } = extractDetailLinks(
      '<a href="/ekler/a.pdf">A</a><a href="https://dis.example.com/b.pdf">B</a><a href="#x">C</a>',
      'https://www.ilan.gov.tr/ilan/1/x',
      ['www.ilan.gov.tr', 'medya.ilan.gov.tr'],
    );
    expect(links.map((link) => link.url)).toEqual([
      'https://www.ilan.gov.tr/ekler/a.pdf',
      'https://dis.example.com/b.pdf',
    ]);
    expect(attachments).toEqual([{ url: 'https://www.ilan.gov.tr/ekler/a.pdf', label: 'A', kind: 'pdf' }]);
  });
});
