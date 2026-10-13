import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { toHeaderSafeAscii } from '../src/lib/headerSafe';
import { describeFetchFailure, FetchError, HttpClient, loadTrustBundle } from '../src/sources/fetcher';

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
function makeClient(mockAgent: MockAgent): HttpClient {
  agents.push(mockAgent);
  const client = new HttpClient({
    logger: silentLogger,
    sleep: async () => undefined,
    dispatcher: mockAgent,
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
      .reply(200, '<html><body>İLAN</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const client = makeClient(mock);
    const response = await client.fetchText(`${ORIGIN}/ilanlar/test.htm`, {
      allowedHosts: ALLOWED,
      retries: 0,
    });
    expect(response.status).toBe(200);
    expect(response.decoded?.text).toContain('İLAN');
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
