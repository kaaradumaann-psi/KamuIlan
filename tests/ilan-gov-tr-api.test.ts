/**
 * ilan.gov.tr JSON API adaptörü testleri.
 *
 * Sözleşme kaynağı: github.com/Ruchanbas/rg-ilan-botu (canlı doğrulanmış API):
 *   POST /api/api/services/app/Ad/AdsByFilter  {"keys":{"q":["terim"]},"skipCount":N,"maxResultCount":M}
 *   GET  /api/api/services/app/AdDetail/GetAdDetail?id=<id>&isKiwiAd=false
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { createLogger } from '../src/lib/logger';
import {
  collectApiText,
  deadlineFromAdFilters,
  IlanGovTrApiAdapter,
} from '../src/sources/adapters/ilan-gov-tr-api';
import { FetchError, type FetchResponse, type HttpClient } from '../src/sources/fetcher';
import { AdapterStructureError, SourceAccessError } from '../src/sources/errors';
import type { SourceDefinition } from '../src/config/sources';
import type { AdapterContext } from '../src/sources/types';

const API_BASE = 'https://www.ilan.gov.tr/api/api/services/app';

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

interface RecordedCall {
  url: string;
  method: string;
  jsonBody: unknown;
  headers: Record<string, string>;
}

/** Sahte HTTP istemcisi: JSON cevabı döner, istek kaydı tutar (ağ yok). */
function fakeJsonHttp(
  resolve: (url: string, call: RecordedCall) => unknown | undefined,
  failure?: (url: string, call: RecordedCall, attempt: number) => FetchError | null,
): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const attempts = new Map<string, number>();
  const handler = {
    async fetchText(url: string, options?: { method?: string; jsonBody?: unknown; headers?: Record<string, string> }): Promise<FetchResponse> {
      const call: RecordedCall = { url, method: options?.method ?? 'GET', jsonBody: options?.jsonBody, headers: options?.headers ?? {} };
      calls.push(call);
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      const error = failure?.(url, call, attempt);
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

function contextFor(source: SourceDefinition, http: HttpClient, maxDetailFetches = 10): AdapterContext {
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-14T09:00:00.000Z'),
    maxDetailFetches,
  };
}

const apiSource = SOURCE_DEFINITIONS.find((source) => source.adapterKey === 'ilan-gov-tr-api');
const ilanApiSource: SourceDefinition =
  apiSource ??
  ({
    key: 'ilan-gov-tr-api-personel',
    allowedHosts: ['www.ilan.gov.tr', 'ilan.gov.tr'],
    listingUrl: 'https://www.ilan.gov.tr/ilan/tum-ilanlar/personel-alimi?ats=5',
    minRequestIntervalMs: 1,
  } as SourceDefinition);

function ad(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'abc-1',
    adNo: 'ILN-2026-1001',
    title: 'Örnek Kurum Sözleşmeli Personel Alım İlanı',
    advertiserName: 'Örnek Sağlık Bakanlığı',
    addressCityName: 'Ankara',
    publishStartDate: '2026-10-13T00:00:00',
    urlStr: 'https://www.ilan.gov.tr/ilan/1001',
    isArchived: false,
    adTypeFilters: [{ key: 'Son Başvuru', value: '02/11/2026' }],
    ...overrides,
  };
}

/** AdsByFilter cevabı üretir; numFound'a göre sayfa boyunca yinelenen kayıtlar. */
function adsPayload(ads: Record<string, unknown>[], numFound: number): unknown {
  return { result: { numFound, ads } };
}

describe('ilan.gov.tr JSON API adaptörü', () => {
  it('envanterde tanımlıdır ve API sözleşmesini dürüstçe bildirir', () => {
    expect(apiSource).toBeDefined();
    expect(apiSource?.method).toBe('json-api');
    expect(apiSource?.status).toBe('scraper-built');
    expect(apiSource?.lastVerifiedAt).toBeNull();
    expect(apiSource?.verificationEvidence).toContain('txv:[73]');
    expect(apiSource?.verificationEvidence).toContain('temiz AdsByFilter isteği 403; tek IGT-UI retry 200');
    expect(apiSource?.allowedHosts.length ?? 0).toBeGreaterThan(0);
  });

  it('AdsByFilter isteğini ilan kategorisi filtresi, kimlikli AJAX başlığı ve sayfalama ile gönderir', async () => {
    const { http, calls } = fakeJsonHttp((url, call) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`) {
        expect(call.method).toBe('POST');
        return adsPayload([ad({})], 1);
      }
      if (url.includes('/AdDetail/GetAdDetail')) {
        return { result: { detail: 'Başvuru koşulları '.repeat(30) } };
      }
      return undefined;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));

    const search = calls.find((call) => call.url.endsWith('/Ad/AdsByFilter'));
    expect(search?.jsonBody).toEqual({
      keys: { ats: [5] },
      sorting: 'publish_time desc',
      skipCount: 0,
      maxResultCount: 20,
    });
    expect(search?.headers).toMatchObject({
      'content-type': 'application/json-patch+json',
      'x-requested-with': 'XMLHttpRequest',
    });
    // Kimlik (User-Agent) fetcher'ın sistem geneli değeridir; adaptör ezmez.
    expect(search?.headers).not.toHaveProperty('user-agent');
    expect(search?.headers).not.toHaveProperty('x-request-origin');
    expect(result.items).toHaveLength(1);
    expect(result.requestCount).toBeGreaterThan(0);
  });

  it('akademik ilanları ayrı txv filtresiyle arar ve kategori bilgisini kayda taşır', async () => {
    const { http, calls } = fakeJsonHttp((url, call) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`) {
        const body = call.jsonBody as { keys: Record<string, number[]> };
        if (body.keys.txv) return adsPayload([ad({ adNo: 'ILN-ACADEMIC-1', id: 'academic-1' })], 1);
        return adsPayload([], 0);
      }
      if (url.includes('/AdDetail/GetAdDetail')) return { result: { content: 'Akademik ilan gövdesi '.repeat(20) } };
      return undefined;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    const academicSearch = calls.find((call) => (call.jsonBody as { keys?: { txv?: number[] } }).keys?.txv);
    expect(academicSearch?.jsonBody).toMatchObject({ keys: { txv: [73] }, sorting: 'publish_time desc' });
    expect(result.items[0]?.sourceItemId).toBe('ILN-ACADEMIC-1');
    expect(result.items[0]?.sourceCategory).toBe('akademik personel alımı');
  });

  it('temiz istek 403 verirse yalnız bir kez IGT-UI başlığıyla yeniden dener', async () => {
    const { http, calls } = fakeJsonHttp(
      (url, call) => {
        if (url.endsWith('/Ad/AdsByFilter')) {
          const body = call.jsonBody as { keys: Record<string, number[]> };
          return body.keys.ats ? adsPayload([ad({})], 1) : adsPayload([], 0);
        }
        if (url.includes('/AdDetail/GetAdDetail')) return { result: { content: 'Başvuru metni '.repeat(30) } };
        return undefined;
      },
      (url, call) => call.headers['x-request-origin'] === 'IGT-UI'
        ? null
        : new FetchError(url, 'Forbidden', 403, false),
    );

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    const listCalls = calls.filter((call) => call.url.endsWith('/Ad/AdsByFilter'));
    const detailCalls = calls.filter((call) => call.url.includes('/AdDetail/GetAdDetail'));
    expect(listCalls).toHaveLength(3);
    expect(listCalls[0]?.headers).not.toHaveProperty('x-request-origin');
    expect(listCalls[1]?.headers['x-request-origin']).toBe('IGT-UI');
    expect(listCalls[2]?.headers['x-request-origin']).toBe('IGT-UI');
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]?.headers['x-request-origin']).toBe('IGT-UI');
    expect(result.items).toHaveLength(1);
    expect(result.requestCount).toBe(4);
  });

  it('offset tabanlı sayfalamada skipCount ile ilerler ve numFound dolunca durur', async () => {
    const pageSize = 20;
    const { http, calls } = fakeJsonHttp((url, call) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`) {
        const body = call.jsonBody as { skipCount: number };
        const start = body.skipCount;
        if (start >= 150) return adsPayload([], 150);
        const ads = Array.from({ length: Math.min(pageSize, 150 - start) }, (_, index) =>
          ad({
            id: `id-${start + index}`,
            adNo: `ILN-${start + index}`,
            title: `Örnek Kurum Sözleşmeli Memur Alım İlanı ${start + index}`,
            urlStr: `https://www.ilan.gov.tr/ilan/${start + index}`,
          }),
        );
        return adsPayload(ads, 150);
      }
      if (url.includes('/AdDetail/GetAdDetail')) return { result: { metin: 'Başvuru şartları '.repeat(20) } };
      return undefined;
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http, 300));

    const skips = calls
      .filter((call) => call.url.endsWith('/Ad/AdsByFilter'))
      .map((call) => (call.jsonBody as { skipCount: number }).skipCount);
    // İlk terimde en az iki sayfa: 0 ve 100; numFound=150 dolunca durulur.
    expect(skips).toContain(0);
    expect(skips).toContain(100);
    // Çalışma başına en fazla MAX_ITEMS (40) kayıt işlenir; kalanı ertelenir.
    expect(result.items.length).toBe(40);
    expect(result.notes.join(' ')).toContain('sonraki taramaya bırakıldı');
  });

  it('yapılandırılmış alanları okur: kurum, il, resmî ilan no, Son Başvuru', async () => {
    const { http } = fakeJsonHttp((url) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`)
        return adsPayload(
          [
            ad({
              adNo: 'ILN-2026-9001',
              id: '9001',
              title: 'Örnek Üniversitesi Sözleşmeli Bilişim Personeli Alım İlanı',
              advertiserName: 'Örnek Teknik Üniversitesi',
              addressCityName: 'İzmir',
              publishStartDate: '2026-10-13T14:22:00',
              urlStr: 'https://www.ilan.gov.tr/ilan/9001',
              adTypeFilters: [
                { key: 'İl / İlçe', value: 'İzmir' },
                { key: 'Son Başvuru', value: '02/11/2026' },
              ],
            }),
          ],
          1,
        );
      return {
        result: {
          detailText: 'Adayların 4001 nitelik kodunu taşıması gerekir. '.repeat(4),
          nested: { more: 'Başvurular e-Devlet üzerinden yapılır. '.repeat(3) },
        },
      };
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    const item = result.items[0];
    expect(item?.sourceItemId).toBe('ILN-2026-9001');
    expect(item?.referenceNo).toBe('ILN-2026-9001');
    expect(item?.institution).toBe('Örnek Teknik Üniversitesi');
    expect(item?.city).toBe('İzmir');
    expect(item?.publishedAt).toBe('2026-10-13');
    expect(item?.applicationEndAt).toBe('2026-11-02T23:59:00+03:00');
    expect(item?.url).toBe('https://www.ilan.gov.tr/ilan/9001');
    // Detay metni şemadan bağımsız toplanır (nested alanlar da dâhil).
    expect(item?.bodyText).toContain('4001');
    expect(item?.bodyText).toContain('e-Devlet');
    expect(item?.bodyTextSource).toBe('detail');
  });

  it('GetAdDetail isteğini id ile yapar (adNo değil) ve yalnız yeni kayıtları detaylandırır', async () => {
    const { http, calls } = fakeJsonHttp((url) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`)
        return adsPayload(
          [ad({ adNo: 'ILN-2026-7001', isArchived: true }), ad({ adNo: 'ILN-2026-7002', id: 'x7002' })],
          2,
        );
      return { result: { text: 'Detay metni '.repeat(30) } };
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sourceItemId).toBe('ILN-2026-7002');
    const detailCall = calls.find((call) => call.url.includes('/AdDetail/GetAdDetail'));
    // rg-ilan-botu sözleşmesi: detay kimliği `id` alanıdır; resmî ilan no (adNo) kayıt anahtarıdır.
    expect(detailCall?.url).toContain('id=x7002');
    expect(detailCall?.url).not.toContain('ILN-2026-7002');
    expect(result.items[0]?.referenceNo).toBe('ILN-2026-7002');
  });

  it('sayfa sınırına takılıp numFound\'a ulaşılamayan terim kapsamı complete yapmaz', async () => {
    // Her sayfa 100 kayıt döner (aynı adNo'lar: havuz sınırı devreye girmez),
    // numFound 600 → 5 sayfa sonra sayfa sınırı dolar ama arşiv tükenmemiştir.
    const { http } = fakeJsonHttp((url) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`)
        return adsPayload(
          Array.from({ length: 100 }, (_, index) => ad({ adNo: `ILN-2026-3${index}`, id: `id-3${index}` })),
          600,
        );
      return { result: { text: 'Detay metni '.repeat(30) } };
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http, 100));
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toMatch(/numFound'a ulaşılamadı/);
    expect(result.coverage?.note).not.toMatch(/sonuna kadar gezildi/);
  });

  it('bilinen kayıtları yinelenmez, detaysız bilinenleri yeniden dener', async () => {
    const { http, calls } = fakeJsonHttp((url) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`)
        return adsPayload([ad({}), ad({ adNo: 'ILN-2026-1002', id: 'abc-2' })], 2);
      return { result: { text: 'Detay metni '.repeat(30) } };
    });

    const result = await new IlanGovTrApiAdapter().run({
      ...contextFor(ilanApiSource, http),
      knownItemIds: new Set(['ILN-2026-1001']),
      knownItemIdsWithDetail: new Set<string>(),
    });
    expect(result.items.map((item) => item.sourceItemId)).toEqual(['ILN-2026-1001', 'ILN-2026-1002']);
    expect(calls.filter((call) => call.url.includes('/AdDetail/GetAdDetail')).length).toBe(2);

    const result2 = await new IlanGovTrApiAdapter().run({
      ...contextFor(ilanApiSource, http),
      knownItemIds: new Set(['ILN-2026-1001']),
      knownItemIdsWithDetail: new Set(['ILN-2026-1001']),
    });
    expect(result2.items.map((item) => item.sourceItemId)).toEqual(['ILN-2026-1002']);
  });

  it('detay bütçesini aşan kayıtları sonraki taramaya bırakır ve kapsamı kısmi bildirir', async () => {
    const { http } = fakeJsonHttp((url, call) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`) {
        const body = call.jsonBody as { skipCount: number };
        if (body.skipCount > 0) return adsPayload([], 5);
        return adsPayload(
          Array.from({ length: 5 }, (_, index) =>
            ad({
              adNo: `ILN-2026-200${index}`,
              id: `id-200${index}`,
              title: `Örnek Kurum Memur Alım İlanı ${index}`,
            }),
          ),
          5,
        );
      }
      return { result: { text: 'Detay metni '.repeat(30) } };
    });

    const result = await new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http, 2));
    expect(result.items).toHaveLength(2);
    expect(result.coverage?.status).toBe('partial');
    expect(result.notes.join(' ')).toContain('sonraki taramaya bırakıldı');
  });

  it('API sözleşmesi değişirse yapı hatası fırlatır (sessiz yanlış veri üretmez)', async () => {
    const { http } = fakeJsonHttp((url) => {
      if (url === `${API_BASE}/Ad/AdsByFilter`) return { unexpected: true };
      return undefined;
    });

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

  it('401/403 erişim kısıtını kaynak erişim hatasına çevirir', async () => {
    const { http } = fakeJsonHttp(
      () => undefined,
      () => new FetchError(`${API_BASE}/Ad/AdsByFilter`, 'Forbidden', 403, false),
    );
    await expect(new IlanGovTrApiAdapter().run(contextFor(ilanApiSource, http))).rejects.toBeInstanceOf(
      SourceAccessError,
    );
  });

  it('canlı erişim kapalıyken ağ isteği yapmaz', async () => {
    const { http, calls } = fakeJsonHttp(() => undefined);
    const result = await new IlanGovTrApiAdapter().run({
      ...contextFor(ilanApiSource, http),
      liveFetch: false,
    });
    expect(calls).toHaveLength(0);
    expect(result.items).toHaveLength(0);
    expect(result.notModified).toBe(false);
  });
});

describe('API yardımcıları', () => {
  it('collectApiText tüm metin değerlerini HTML etiketlerinden arındırıp toplar', () => {
    const text = collectApiText({
      a: '<p>Merhaba <strong>dünya</strong></p>',
      b: ['bir', { c: 'iki' }],
      d: 42,
      e: null,
    });
    expect(text).toContain('Merhaba dünya');
    expect(text).toContain('bir');
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
    expect(deadlineFromAdFilters([{ key: 'Son Başvuru', value: '02/11/2026' }])).toBe(
      '2026-11-02T23:59:00+03:00',
    );
    expect(deadlineFromAdFilters([{ key: 'Başvuru Bitiş', value: '5.1.2027' }])).toBe(
      '2027-01-05T23:59:00+03:00',
    );
    expect(deadlineFromAdFilters([{ key: 'İl', value: 'Ankara' }])).toBeNull();
    expect(deadlineFromAdFilters([{ key: 'Son Başvuru', value: 'yakında' }])).toBeNull();
  });
});
