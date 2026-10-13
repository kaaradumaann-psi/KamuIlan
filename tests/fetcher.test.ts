import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { describeFetchFailure, FetchError, HttpClient } from '../src/sources/fetcher';

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
