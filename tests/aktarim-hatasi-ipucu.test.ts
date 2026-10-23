/**
 * Aktarım hatası (yanıt yok) sınıflandırması ve Kariyer Kapısı kök neden raporu.
 *
 * 23.10.2026 üretim tanısı: Frankfurt'taki sunucudan api.kariyerkapisi.gov.tr'ye
 * TCP SYN yanıtsız kalıyor (UND_ERR_CONNECT_TIMEOUT), Türkiye'den 404 dönüyor.
 * Panel bunu "tarayıcı yedeği kapalı" diye gösteriyordu; tarayıcı da aynı uca
 * bağlandığı için yanıltıcıydı.
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { createLogger } from '../src/lib/logger';
import { KARIYER_API_LIST_URL, KariyerKapisiAdapter } from '../src/sources/adapters/kariyerkapisi';
import { AdapterUnavailableError } from '../src/sources/errors';
import {
  classifyTransportFailure,
  FetchError,
  type FetchResponse,
  type HttpClient,
  withTransportHint,
} from '../src/sources/fetcher';
import type { AdapterContext } from '../src/sources/types';

const CONNECT_TIMEOUT =
  'fetch failed <- UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: api.kariyerkapisi.gov.tr:443, timeout: 10000ms)';

describe('classifyTransportFailure', () => {
  it('bağlantı kurulamadan biten hataları sınıflar', () => {
    expect(classifyTransportFailure(CONNECT_TIMEOUT)).toBe('connect-timeout');
    expect(classifyTransportFailure('ENOTFOUND: getaddrinfo ENOTFOUND bddk.org.tr')).toBe('dns');
    expect(classifyTransportFailure('ECONNREFUSED: connect ECONNREFUSED 1.2.3.4:443')).toBe('refused');
    expect(classifyTransportFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify')).toBe('tls');
  });

  it('bağlantı kurulduktan sonraki zaman aşımını engel saymaz', () => {
    expect(classifyTransportFailure('UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error')).toBeNull();
    expect(classifyTransportFailure('Sunucu hatası (HTTP 503).')).toBeNull();
  });
});

describe('withTransportHint', () => {
  it('yanıtsız bağlantıya olası IP/bölge engeli ipucu ekler, tekrar eklemez', () => {
    const error = new FetchError(KARIYER_API_LIST_URL, CONNECT_TIMEOUT, null, true);
    const hinted = withTransportHint(error);
    expect(hinted).toBeInstanceOf(FetchError);
    expect(hinted.message).toContain(CONNECT_TIMEOUT);
    expect(hinted.message).toMatch(/Olası neden: TCP bağlantısı kurulamadı/);
    expect(hinted.message).toMatch(/yurt dışı IP engeli/);
    expect(hinted.retryable).toBe(true);
    expect(hinted.status).toBeNull();
    expect(withTransportHint(hinted).message).toBe(hinted.message);
  });

  it('HTTP yanıtı olan hatalara dokunmaz', () => {
    const error = new FetchError(KARIYER_API_LIST_URL, 'Erişim reddedildi (HTTP 403).', 403, false);
    expect(withTransportHint(error)).toBe(error);
  });
});

function textResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: {},
    body: Buffer.from(body, 'utf8'),
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text: body, encoding: 'utf-8', confidence: 'header' },
    bytes: body.length,
  } as unknown as FetchResponse;
}

function ctx(http: HttpClient): AdapterContext {
  const source = SOURCE_DEFINITIONS.find((entry) => entry.key === 'kariyerkapisi-isealim');
  if (!source) throw new Error('kariyerkapisi-isealim envanterde yok');
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-23T09:00:00.000Z'),
    maxDetailFetches: 0,
  };
}

function httpWithUnreachableApi(): HttpClient {
  return {
    async fetchText(url: string) {
      if (url === KARIYER_API_LIST_URL) throw new FetchError(url, CONNECT_TIMEOUT, null, true);
      return textResponse(url, '<html><head><title>Kariyer Kapısı</title></head><body><div id="app"></div></body></html>');
    },
    async fetchBinary(url: string) {
      throw new Error(`Beklenmeyen ikili istek: ${url}`);
    },
    async close(): Promise<void> {},
  } as unknown as HttpClient;
}

describe('Kariyer Kapısı: JSON ucuna ulaşılamıyor', () => {
  it('tarayıcı kapalıyken kök nedeni (TCP zaman aşımı) fetch hatası olarak raporlar', async () => {
    const adapter = new KariyerKapisiAdapter(async () => {
      throw new Error('Tarayıcı yedeği kapalı (SOURCE_BROWSER_FALLBACK=0): Chromium başlatılmadı.');
    });
    const error = await adapter.run(ctx(httpWithUnreachableApi())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchError);
    expect(error).not.toBeInstanceOf(AdapterUnavailableError);
    const message = (error as FetchError).message;
    expect(message).toMatch(/Resmî JSON ucuna \(api\.kariyerkapisi\.gov\.tr\) bu sunucudan bağlanılamadı/);
    expect(message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(message).toMatch(/Olası neden: TCP bağlantısı kurulamadı/);
    expect(message).toMatch(/tarayıcı: .*SOURCE_BROWSER_FALLBACK=0/);
  });

  it('JSON ucu erişilebilir ama HTML boşsa eski "tarayıcı gerekli" sınıflandırması korunur', async () => {
    const http = {
      async fetchText(url: string) {
        if (url === KARIYER_API_LIST_URL) throw new FetchError(url, 'İstek başarısız (HTTP 404).', 404, false);
        return textResponse(url, '<html><body></body></html>');
      },
      async fetchBinary(url: string) {
        throw new Error(`Beklenmeyen ikili istek: ${url}`);
      },
      async close(): Promise<void> {},
    } as unknown as HttpClient;
    const adapter = new KariyerKapisiAdapter(async () => {
      throw new Error('Tarayıcı yedeği kapalı (SOURCE_BROWSER_FALLBACK=0): Chromium başlatılmadı.');
    });
    await expect(adapter.run(ctx(http))).rejects.toBeInstanceOf(AdapterUnavailableError);
  });
});
