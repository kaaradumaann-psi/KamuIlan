import { createServer, type Server } from 'node:net';
import { request as nodeHttpRequest } from 'node:http';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { toHeaderSafeAscii } from '../src/lib/headerSafe';
import { createPublicOnlyLookup, isPublicRoutableAddress } from '../src/sources/network-safety';
import {
  describeFetchFailure,
  FetchError,
  HostRateLimiter,
  HttpClient,
  loadTrustBundle,
  assertSafeUrl,
  isMalformedResponseError,
  classifyTransportFailure,
  lenientHttpDispatch,
  type DispatchResponseLike,
  type LenientDispatch,
  type LenientDispatchInit,
} from '../src/sources/fetcher';

const ORIGIN = 'https://www.resmigazete.gov.tr';
const ALLOWED = ['www.resmigazete.gov.tr'];

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

const clients: HttpClient[] = [];
const agents: MockAgent[] = [];
function makeClient(
  mockAgent: MockAgent,
  budget: { maxRequests?: number; maxTextRequests?: number } = {},
): HttpClient {
  agents.push(mockAgent);
  const client = new HttpClient({
    logger: silentLogger,
    sleep: async () => undefined,
    dispatcher: mockAgent,
    rateLimiter: new HostRateLimiter(),
    ...budget,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const agent of agents.splice(0)) await agent.close();
});

describe('HttpClient ağ davranışı', () => {
  it('başarılı yanıtı çözülmüş metin ile döndürür', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/ilanlar/test.htm', method: 'GET' })
      .reply(200, '<html><body>İLAN</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    const client = makeClient(mock);
    const response = await client.fetchText(`${ORIGIN}/ilanlar/test.htm`, {
      allowedHosts: ALLOWED,
      retries: 0,
    });
    expect(response.status).toBe(200);
    expect(response.decoded?.text).toContain('İLAN');
  });

  it('global HTTP budget redirect ve retry denemelerini sayar; bütçe aşımında yeni istek göndermez', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/redirect-budget', method: 'GET' })
      .reply(302, '', { headers: { location: '/redirect-target' } });
    mock
      .get(ORIGIN)
      .intercept({ path: '/redirect-target', method: 'GET' })
      .reply(200, '<html>ok</html>', { headers: { 'content-type': 'text/html' } });
    const client = makeClient(mock, { maxRequests: 2, maxTextRequests: 1 });

    const response = await client.fetchText(`${ORIGIN}/redirect-budget`, {
      allowedHosts: ALLOWED,
      retries: 1,
      minIntervalMs: 0,
    });
    expect(response.status).toBe(200);
    expect(client.requestsMade).toBe(2);
    expect(client.remainingRequestBudget).toBe(0);
    expect(client.textFetchesMade).toBe(1);
    expect(client.remainingTextRequestBudget).toBe(0);

    await expect(
      client.fetchText(`${ORIGIN}/never-sent`, { allowedHosts: ALLOWED, retries: 0, minIntervalMs: 0 }),
    ).rejects.toThrow(/text\/page request bütçesi doldu/);
    await expect(
      client.fetchBinary(`${ORIGIN}/binary-never-sent`, { allowedHosts: ALLOWED, retries: 0, minIntervalMs: 0 }),
    ).rejects.toThrow(/toplam HTTP istek bütçesi doldu/);
    expect(client.requestsMade).toBe(2);
    expect(client.textFetchesMade).toBe(1);
  });

  it('eşzamanlı istekler ortak sert HTTP sınırını atomik olarak rezerve eder', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/parallel-a', method: 'GET' })
      .reply(200, '<html>a</html>', { headers: { 'content-type': 'text/html' } });
    mock
      .get(ORIGIN)
      .intercept({ path: '/parallel-b', method: 'GET' })
      .reply(200, '<html>b</html>', { headers: { 'content-type': 'text/html' } });
    const client = makeClient(mock, { maxRequests: 1 });

    const results = await Promise.allSettled([
      client.fetchText(`${ORIGIN}/parallel-a`, { allowedHosts: ALLOWED, retries: 0, minIntervalMs: 0 }),
      client.fetchText(`${ORIGIN}/parallel-b`, { allowedHosts: ALLOWED, retries: 0, minIntervalMs: 0 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(client.requestsMade).toBe(1);
    expect(client.remainingRequestBudget).toBe(0);
  });

  it('POST jsonBody isteğini JSON gövdesi ve content-type ile gönderir', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const payload = { keys: { q: ['personel alımı'] }, skipCount: 0, maxResultCount: 100 };
    mock
      .get(ORIGIN)
      .intercept({
        path: '/api/api/services/app/Ad/AdsByFilter',
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
      .reply(200, '{"result":{"numFound":0,"ads":[]}}', {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    const client = makeClient(mock);
    const response = await client.fetchText(`${ORIGIN}/api/api/services/app/Ad/AdsByFilter`, {
      allowedHosts: ALLOWED,
      retries: 0,
      method: 'POST',
      jsonBody: payload,
      expectedContentTypes: ['application/json'],
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.decoded?.text ?? '')).toEqual({ result: { numFound: 0, ads: [] } });
  });

  it('303 yönlendirmesi POST isteğini gövdesiz GET’e çevirir', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/api/basla', method: 'POST' })
      .reply(303, '', { headers: { location: '/api/hedef' } });
    mock
      .get(ORIGIN)
      .intercept({ path: '/api/hedef', method: 'GET' })
      .reply(200, '{"ok":true}', { headers: { 'content-type': 'application/json' } });
    const client = makeClient(mock);
    const response = await client.fetchText(`${ORIGIN}/api/basla`, {
      allowedHosts: ALLOWED,
      retries: 0,
      method: 'POST',
      jsonBody: { a: 1 },
      expectedContentTypes: ['application/json'],
    });
    expect(response.status).toBe(200);
    expect(response.decoded?.text).toBe('{"ok":true}');
  });

  it('307 yönlendirmesi POST yöntemini ve gövdeyi korur', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const payload = { q: ['memur alımı'] };
    mock
      .get(ORIGIN)
      .intercept({ path: '/api/basla', method: 'POST' })
      .reply(307, '', { headers: { location: '/api/yeni-hedef' } });
    mock
      .get(ORIGIN)
      .intercept({ path: '/api/yeni-hedef', method: 'POST', body: JSON.stringify(payload) })
      .reply(200, '{"ok":1}', { headers: { 'content-type': 'application/json' } });
    const client = makeClient(mock);
    const response = await client.fetchText(`${ORIGIN}/api/basla`, {
      allowedHosts: ALLOWED,
      retries: 0,
      method: 'POST',
      jsonBody: payload,
      expectedContentTypes: ['application/json'],
    });
    expect(response.status).toBe(200);
    expect(response.decoded?.text).toBe('{"ok":1}');
  });

  it('iptal edilmiş tarama sinyali HTTP isteğini ve yeniden denemeleri durdurur', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    agents.push(mock);
    const controller = new AbortController();
    controller.abort();
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      signal: controller.signal,
      rateLimiter: new HostRateLimiter(),
    });
    clients.push(client);

    await expect(
      client.fetchText(`${ORIGIN}/ilanlar/iptal.htm`, { allowedHosts: ALLOWED, retries: 3 }),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('iptal') });
  });

  it('yeniden deneme beklemesi sırasında iptal edilince sonraki HTTP denemesini başlatmaz', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get(ORIGIN).intercept({ path: '/backoff.htm', method: 'GET' }).reply(503, 'geçici hata');
    agents.push(mock);
    const controller = new AbortController();
    let enteredBackoff!: () => void;
    const backoffStarted = new Promise<void>((resolve) => {
      enteredBackoff = resolve;
    });
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async (_ms, signal) => {
        enteredBackoff();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
            once: true,
          });
        });
      },
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
    });
    clients.push(client);

    const pending = client.fetchText(`${ORIGIN}/backoff.htm`, {
      allowedHosts: ALLOWED,
      retries: 1,
      signal: controller.signal,
    });
    await backoffStarted;
    controller.abort(new Error('scan cancelled during retry backoff'));

    await expect(pending).rejects.toMatchObject({
      status: null,
      retryable: false,
      message: expect.stringContaining('iptal edildi'),
    });
  });

  it('ağ düzeyi hatada undici neden kodunu hata mesajına katar (status null)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    mock
      .get(ORIGIN)
      .intercept({ path: '/ilanlar/test.htm', method: 'GET' })
      .replyWithError(Object.assign(new Error('fetch failed'), { cause }));
    const client = makeClient(mock);
    let caught: unknown;
    try {
      await client.fetchText(`${ORIGIN}/ilanlar/test.htm`, { allowedHosts: ALLOWED, retries: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FetchError);
    expect((caught as FetchError).status).toBeNull();
    expect((caught as Error).message).toContain('UND_ERR_CONNECT_TIMEOUT');
  });

  it('429/503 Retry-After değerinden önce yeniden denemez', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const requestMatcher = { path: '/retry-after.htm', method: 'GET' } as const;
    mock
      .get(ORIGIN)
      .intercept(requestMatcher)
      .reply(429, 'rate limited', { headers: { 'retry-after': '2' } });
    mock
      .get(ORIGIN)
      .intercept(requestMatcher)
      .reply(200, 'ok', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    agents.push(mock);
    const sleeps: number[] = [];
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
    });
    clients.push(client);

    const response = await client.fetchText(`${ORIGIN}/retry-after.htm`, {
      allowedHosts: ALLOWED,
      retries: 1,
      minIntervalMs: 0,
    });

    expect(response.status).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);
  });

  it('404 retryable olmayan FetchError üretir', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get(ORIGIN).intercept({ path: '/yok.htm', method: 'GET' }).reply(404, 'yok');
    const client = makeClient(mock);
    await expect(
      client.fetchText(`${ORIGIN}/yok.htm`, { allowedHosts: ALLOWED, retries: 0 }),
    ).rejects.toMatchObject({ status: 404, retryable: false });
  });

  it('izin listesindeki olmayan host engellenir (istek çıkmaz)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const client = makeClient(mock);
    await expect(
      client.fetchText('https://evil.example.com/x', { allowedHosts: ALLOWED, retries: 0 }),
    ).rejects.toMatchObject({ status: null, retryable: false });
  });
});

describe('HostRateLimiter', () => {
  it('eşzamanlı istemciler aynı host için ayrı zaman aralığı rezerve eder', async () => {
    const limiter = new HostRateLimiter();
    const startedAt: number[] = [];
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        await limiter.wait('ortak-ornek.test', 35);
        startedAt.push(Date.now());
      }),
    );
    startedAt.sort((left, right) => left - right);
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(25);
  });
});

describe('SSRF ve DNS çözümleme güvenliği', () => {
  it.each([
    ['8.8.8.8', true],
    ['93.184.216.34', true],
    ['10.1.2.3', false],
    ['100.64.0.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['192.0.2.8', false],
    ['224.0.0.1', false],
    ['2001:4860:4860::8888', true],
    ['fd00::1', false],
    ['fe80::1', false],
    ['2001:db8::1', false],
    ['::ffff:127.0.0.1', false],
  ])('%s public-address kararı doğru', (address, expected) => {
    expect(isPublicRoutableAddress(address)).toBe(expected);
  });

  it('DNS yanıtında tek bir özel IP varsa genel IP ile birlikte dahi tüm hostu reddeder', async () => {
    const lookup = createPublicOnlyLookup((_hostname, _options, callback) =>
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    );
    const result = await new Promise<{ code: string | undefined; addresses: string[] }>((resolve) => {
      lookup('mixed.example.test', { all: true }, (error, address) => {
        resolve({
          code: (error as NodeJS.ErrnoException | null)?.code,
          addresses: Array.isArray(address) ? address.map((entry) => entry.address) : [address],
        });
      });
    });
    expect(result).toEqual({ code: 'EACCES', addresses: [] });
  });

  it('DNS yanıtındaki public adresi doğrulayıp döndürür', async () => {
    const lookup = createPublicOnlyLookup((_hostname, _options, callback) =>
      callback(null, [{ address: '93.184.216.34', family: 4 }]),
    );
    const result = await new Promise<{ address: string | string[]; family?: number }>((resolve, reject) => {
      lookup('public.example.test', { all: false }, (error, address, family) => {
        if (error) reject(error);
        else
          resolve({
            address: Array.isArray(address) ? address.map((entry) => entry.address) : address,
            family,
          });
      });
    });
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('IP literal, kullanıcı bilgisi ve yalnızca alt alan adıyla eşleşen allowlist reddedilir', () => {
    expect(() => assertSafeUrl('https://8.8.8.8/path')).toThrow(FetchError);
    expect(() => assertSafeUrl('https://user:secret@www.ilan.gov.tr/path', ['www.ilan.gov.tr'])).toThrow(
      FetchError,
    );
    expect(() => assertSafeUrl('https://www.ilan.gov.tr/path', ['ilan.gov.tr'])).toThrow(FetchError);
    expect(assertSafeUrl('https://www.ilan.gov.tr/path', ['www.ilan.gov.tr']).hostname).toBe(
      'www.ilan.gov.tr',
    );
  });
});

describe('loadTrustBundle (sistem CA birleşimi)', () => {
  it('desteklenen platformda PEM biçiminde birleşik paket döndürür', () => {
    const bundle = loadTrustBundle();
    // Eski Node'da undefined kabul edilebilir; döndürüyorsa biçimi doğru olmalı.
    if (bundle !== undefined) {
      expect(bundle.length).toBeGreaterThan(50);
      expect(bundle.every((cert) => cert.includes('BEGIN CERTIFICATE'))).toBe(true);
    }
  });
});

describe('User-Agent başlık güvenliği (UND_ERR_INVALID_ARG regresyonu)', () => {
  it('toHeaderSafeAscii Türkçe karakterleri çevirir, kontrol karakterlerini atar', () => {
    expect(toHeaderSafeAscii('KamuİlanBot şğüöçı')).toBe('KamuIlanBot sguoci');
    expect(toHeaderSafeAscii('Bot\r\nX-Injected: 1')).toBe('BotX-Injected: 1');
    expect(toHeaderSafeAscii('  çok   boşluk  ')).toBe('cok bosluk');
  });

  it('env varsayılanı ve kullanıcı değeri saf ASCII olur', () => {
    expect(getEnv({}).SCRAPE_USER_AGENT).toMatch(/^[\x20-\x7E]+$/);
    expect(getEnv({ SCRAPE_USER_AGENT: 'Bot (ilan toplayıcı)' }).SCRAPE_USER_AGENT).toBe(
      'Bot (ilan toplayici)',
    );
  });

  it('Türkçe User-Agent verilse bile istek temizlenmiş başlıkla çıkar', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    // Mock yalnızca temizlenmiş UA ile eşleşir; ham hâli gitseydi eşleşmezdi.
    mock
      .get(ORIGIN)
      .intercept({
        path: '/ua.htm',
        method: 'GET',
        headers: { 'user-agent': 'KamuIlan Test s' },
      })
      .reply(200, 'tamam', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      userAgent: 'Kamuİlan Test ş',
    });
    clients.push(client);
    const response = await client.fetchText(`${ORIGIN}/ua.htm`, { allowedHosts: ALLOWED, retries: 0 });
    expect(response.status).toBe(200);
  });
});

describe('describeFetchFailure', () => {
  it('cause zincirini okunabilir tek satıra indirir', () => {
    const inner = Object.assign(new Error('socket kapandı'), { code: 'ECONNRESET' });
    const outer = Object.assign(new Error('fetch failed'), { cause: inner });
    expect(describeFetchFailure(outer)).toBe('fetch failed <- ECONNRESET: socket kapandı');
  });

  it('FetchError mesajını aynen döndürür', () => {
    expect(describeFetchFailure(new FetchError('https://x', 'zaten açık', 500, true))).toBe('zaten açık');
  });
});

// --- RFC dışı yanıt başlığı (BDDK regresyonu): undici'nin katı HTTP/1.1 ayrıştırıcısı
// geçersiz başlık belirtecini reddeder; hoşgörülü yedek aktarım aynı isteği TLS ve
// kimlik korunarak tek sefer yeniden dener. (Bkz. 23.10.2026 bddk-duyurular arızası.)

/** undici llhttp'nin ürettiği HTTPParserError'ın test eşleniği. */
function malformedHeaderError(): Error {
  return Object.assign(
    new Error('Response does not match the HTTP/1.1 protocol (Invalid header token)'),
    { name: 'HTTPParserError', code: 'HPE_INVALID_HEADER_TOKEN' },
  );
}

function lenientResponseStub(
  bodyText: string,
  headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' },
): DispatchResponseLike {
  const iterator = (async function* () {
    yield Buffer.from(bodyText);
  })();
  const body = Object.assign(iterator, {
    dump: async () => undefined,
    destroy: () => undefined,
  });
  return { statusCode: 200, headers, body };
}

describe('isMalformedResponseError / classifyTransportFailure', () => {
  it('HTTPParserError sınıfını, HPE_ kodunu ve protokol mesajını (cause zinciri dahil) tanır', () => {
    expect(isMalformedResponseError(malformedHeaderError())).toBe(true);
    expect(isMalformedResponseError(Object.assign(new Error('x'), { code: 'HPE_INVALID_HEADER_TOKEN' }))).toBe(true);
    expect(
      isMalformedResponseError(new Error('Response does not match the HTTP/1.1 protocol (Invalid header token)')),
    ).toBe(true);
    const wrapped = Object.assign(new Error('fetch failed'), { cause: malformedHeaderError() });
    expect(isMalformedResponseError(wrapped)).toBe(true);
  });

  it('zaman aşımı / TLS / bağlantı hatalarını RFC dışı yanıt saymaz', () => {
    expect(isMalformedResponseError(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(false);
    expect(isMalformedResponseError(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }))).toBe(false);
    expect(isMalformedResponseError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
  });

  it('classifyTransportFailure RFC dışı yanıtı ayrı sınıf olarak döndürür', () => {
    expect(classifyTransportFailure('HPE_INVALID_HEADER_TOKEN: Response does not match the HTTP/1.1 protocol')).toBe(
      'malformed-response',
    );
    expect(classifyTransportFailure('UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error')).toBe('connect-timeout');
    expect(classifyTransportFailure('CERT_HAS_EXPIRED')).toBe('tls');
  });
});

describe('HttpClient RFC dışı yanıt yedek aktarımı', () => {
  it('lenient yedek YOKKEN RFC dışı başlık yanıtı başarısız olur (mevcut davranış / regresyon)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/bddk.htm', method: 'GET' })
      .replyWithError(malformedHeaderError());
    // lenientDispatch enjekte EDİLMEZ; MockAgent'ta yedek ağa çıkmayacağı için atlanır.
    const client = makeClient(mock);
    let caught: unknown;
    try {
      await client.fetchText(`${ORIGIN}/bddk.htm`, { allowedHosts: ALLOWED, retries: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FetchError);
    expect((caught as FetchError).status).toBeNull();
    expect((caught as Error).message).toMatch(/HTTP\/1\.1 protocol|HPE_INVALID_HEADER_TOKEN/);
    expect(client.malformedHeaderFallbacks).toBe(0);
  });

  it('RFC dışı başlık yanıtı hoşgörülü yedek aktarımla başarır; kimlik (UA) korunur', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/bddk.htm', method: 'GET' })
      .replyWithError(malformedHeaderError());
    let captured: { url: string; init: LenientDispatchInit } | null = null;
    const lenient: LenientDispatch = async (url, init) => {
      captured = { url, init };
      return lenientResponseStub('<html><body>BDDK Duyuru</body></html>');
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      userAgent: 'KamuIlanBot/9 (+kimlik)',
      lenientDispatch: lenient,
    });
    clients.push(client);

    const response = await client.fetchText(`${ORIGIN}/bddk.htm`, { allowedHosts: ALLOWED, retries: 0 });
    expect(response.status).toBe(200);
    expect(response.decoded?.text).toContain('BDDK Duyuru');
    expect(client.malformedHeaderFallbacks).toBe(1);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(`${ORIGIN}/bddk.htm`);
    // Kimlik korunur: aynı tanımlı User-Agent yedek aktarıma geçer.
    expect(captured!.init.headers['user-agent']).toBe('KamuIlanBot/9 (+kimlik)');
    // TLS güveni zayıflatılmaz: yedek init'te doğrulamayı kapatan bir alan yoktur.
    expect(Object.keys(captured!.init)).not.toContain('rejectUnauthorized');
  });

  it('gerçek zaman aşımı hoşgörülü yedeğe YÖNLENDİRİLMEZ (gerçek arıza maskelenmez)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    mock
      .get(ORIGIN)
      .intercept({ path: '/timeout.htm', method: 'GET' })
      .replyWithError(Object.assign(new Error('fetch failed'), { cause }));
    let lenientCalled = false;
    const lenient: LenientDispatch = async () => {
      lenientCalled = true;
      return lenientResponseStub('<html>should-not-happen</html>');
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      lenientDispatch: lenient,
    });
    clients.push(client);

    let caught: unknown;
    try {
      await client.fetchText(`${ORIGIN}/timeout.htm`, { allowedHosts: ALLOWED, retries: 0 });
    } catch (error) {
      caught = error;
    }
    expect(lenientCalled).toBe(false);
    expect(caught).toBeInstanceOf(FetchError);
    expect((caught as Error).message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(client.malformedHeaderFallbacks).toBe(0);
  });

  it('gerçek HTTP 500 hoşgörülü yedeğe YÖNLENDİRİLMEZ (yanıt alınan hata normal akışta kalır)', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get(ORIGIN).intercept({ path: '/500.htm', method: 'GET' }).reply(500, 'patladi');
    let lenientCalled = false;
    const lenient: LenientDispatch = async () => {
      lenientCalled = true;
      return lenientResponseStub('<html>no</html>');
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      lenientDispatch: lenient,
    });
    clients.push(client);

    await expect(
      client.fetchText(`${ORIGIN}/500.htm`, { allowedHosts: ALLOWED, retries: 0 }),
    ).rejects.toMatchObject({ status: 500, retryable: true });
    expect(lenientCalled).toBe(false);
  });

  it('yedek de RFC dışı kalırsa son hataya anlamlı neden ipucu eklenir', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/bddk.htm', method: 'GET' })
      .replyWithError(malformedHeaderError());
    const lenient: LenientDispatch = async () => {
      throw malformedHeaderError();
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      lenientDispatch: lenient,
    });
    clients.push(client);

    let caught: unknown;
    try {
      await client.fetchText(`${ORIGIN}/bddk.htm`, { allowedHosts: ALLOWED, retries: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FetchError);
    expect((caught as Error).message).toContain('Olası neden:');
    expect((caught as Error).message).toContain('geçersiz başlık belirteci');
  });

  it('undici VE hoşgörülü ayrıştırıcı bozuksa son çare curl ile başarır; kimlik (UA) korunur', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/bddk.htm', method: 'GET' })
      .replyWithError(malformedHeaderError());
    const lenient: LenientDispatch = async () => {
      // Geçersiz başlık ADI gibi: insecureHTTPParser bile çözemez.
      throw malformedHeaderError();
    };
    let curlCaptured: { url: string; init: LenientDispatchInit } | null = null;
    const curl: LenientDispatch = async (url, init) => {
      curlCaptured = { url, init };
      return lenientResponseStub('<html><body>BDDK curl ile</body></html>');
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      userAgent: 'KamuIlanBot/9 (+kimlik)',
      lenientDispatch: lenient,
      curlDispatch: curl,
    });
    clients.push(client);

    const response = await client.fetchText(`${ORIGIN}/bddk.htm`, { allowedHosts: ALLOWED, retries: 0 });
    expect(response.status).toBe(200);
    expect(response.decoded?.text).toContain('BDDK curl ile');
    expect(client.curlFallbacks).toBe(1);
    expect(curlCaptured).not.toBeNull();
    expect(curlCaptured!.init.headers['user-agent']).toBe('KamuIlanBot/9 (+kimlik)');
    // TLS güveni zayıflatan bir alan curl init'ine de sızmaz.
    expect(Object.keys(curlCaptured!.init)).not.toContain('rejectUnauthorized');
  });

  it('hoşgörülü yedek gerçek zaman aşımı atarsa curl SON ÇAREsine düşülmez', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/bddk.htm', method: 'GET' })
      .replyWithError(malformedHeaderError());
    const lenient: LenientDispatch = async () => {
      throw Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    };
    let curlCalled = false;
    const curl: LenientDispatch = async () => {
      curlCalled = true;
      return lenientResponseStub('<html>olmamalı</html>');
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      lenientDispatch: lenient,
      curlDispatch: curl,
    });
    clients.push(client);

    await expect(client.fetchText(`${ORIGIN}/bddk.htm`, { allowedHosts: ALLOWED, retries: 0 })).rejects.toBeInstanceOf(
      FetchError,
    );
    expect(curlCalled).toBe(false);
    expect(client.curlFallbacks).toBe(0);
  });

  it('hoşgörülü yedek başarılıysa curl SON ÇAREsi çağrılmaz', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(ORIGIN)
      .intercept({ path: '/bddk.htm', method: 'GET' })
      .replyWithError(malformedHeaderError());
    const lenient: LenientDispatch = async () => lenientResponseStub('<html>lenient ok</html>');
    let curlCalled = false;
    const curl: LenientDispatch = async () => {
      curlCalled = true;
      return lenientResponseStub('<html>olmamalı</html>');
    };
    agents.push(mock);
    const client = new HttpClient({
      logger: silentLogger,
      sleep: async () => undefined,
      dispatcher: mock,
      rateLimiter: new HostRateLimiter(),
      lenientDispatch: lenient,
      curlDispatch: curl,
    });
    clients.push(client);

    const response = await client.fetchText(`${ORIGIN}/bddk.htm`, { allowedHosts: ALLOWED, retries: 0 });
    expect(response.decoded?.text).toContain('lenient ok');
    expect(curlCalled).toBe(false);
    expect(client.malformedHeaderFallbacks).toBe(1);
    expect(client.curlFallbacks).toBe(0);
  });
});

describe('lenientHttpDispatch (gerçek yerel sunucu)', () => {
  it('katı Node ayrıştırıcısının reddettiği geçersiz başlık belirtecini hoşgörülü yolda ayrıştırır', async () => {
    // RFC dışı başlık DEĞERİ (içinde ham kontrol karakteri). Katı llhttp (undici ve
    // insecureHTTPParser'sız Node) bunu HPE_INVALID_HEADER_TOKEN ile reddeder;
    // insecureHTTPParser bu sınıfı tolere eder — BDDK'nın aralıklı ürettiği tür.
    const rawResponse =
      'HTTP/1.1 200 OK\r\n' +
      'Content-Type: text/html\r\n' +
      `X-Weird: ba${String.fromCharCode(1)}r\r\n` +
      'Content-Length: 5\r\n' +
      '\r\n' +
      'HELLO';
    const server: Server = createServer((socket) => {
      socket.on('data', () => {
        socket.write(rawResponse);
        socket.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/`;
    try {
      // Kontrast: katı Node ayrıştırıcısı (insecureHTTPParser yok) aynı yanıtı reddeder.
      const strictError = await new Promise<Error | null>((resolve) => {
        const req = nodeHttpRequest(url, { method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => resolve(null));
        });
        req.on('error', resolve);
        req.end();
      });
      expect(strictError).not.toBeNull();
      expect(String((strictError as Error & { code?: string }).code ?? strictError?.message)).toMatch(/HPE_/);

      // Hoşgörülü yol aynı yanıtı başarıyla ayrıştırır.
      const response = await lenientHttpDispatch(url, {
        method: 'GET',
        headers: { 'user-agent': 'KamuIlanBot/9' },
        timeoutMs: 5_000,
      });
      expect(response.statusCode).toBe(200);
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('HELLO');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('TLS doğrulamasını AÇIK tutar: güvenilmeyen/uyumsuz sertifikayı reddeder (doğrulama kapatılmaz)', async () => {
    const https = await import('node:https');
    const { readFileSync } = await import('node:fs');
    const fx = (name: string) => readFileSync(new URL(`./fixtures/tls-aia/${name}`, import.meta.url));
    const leafKey = fx('leaf.key');
    const leafCrt = fx('leaf.crt').toString();
    const intermediateCrt = fx('intermediate.crt').toString();

    // Sertifika SAN'ı site.example.gov.tr içindir ve güvenilen bir köke bağlanmaz;
    // 127.0.0.1'e yapılan doğrulamalı bağlantı bu yüzden reddedilmelidir. Red,
    // hoşgörülü ayrıştırıcıya rağmen TLS doğrulamasının AÇIK kaldığını kanıtlar.
    const server = https.createServer(
      { key: leafKey, cert: `${leafCrt}\n${intermediateCrt}` },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>tls-ok</html>');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        lenientHttpDispatch(`https://127.0.0.1:${port}/`, {
          method: 'GET',
          headers: { 'user-agent': 'KamuIlanBot/9' },
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/UNABLE_TO_VERIFY|SELF_SIGNED|CERT|ALTNAME/) });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
