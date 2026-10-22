import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  resolvePublicAddresses: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('playwright', () => ({ chromium: { launch: browserMocks.launch } }));
vi.mock('../src/sources/network-safety', () => ({
  createPublicOnlyLookup: vi.fn(() => vi.fn()),
  resolvePublicAddresses: browserMocks.resolvePublicAddresses,
}));

import {
  browserFallbackEnabled,
  browserRobotsRule,
  isSafeBrowserRequest,
  launchChromium,
  robotsRulesByHost,
} from '../src/sources/browser-session';

describe('headless browser egress guard', () => {
  const hosts = new Set(['www.resmigazete.gov.tr', 'resmigazete.gov.tr']);

  it('permits only web requests to exact, pinned source hosts', () => {
    expect(isSafeBrowserRequest('https://www.resmigazete.gov.tr/ilanlar', hosts)).toBe(true);
    expect(isSafeBrowserRequest('https://resmigazete.gov.tr/ilanlar', hosts)).toBe(true);
    expect(isSafeBrowserRequest('https://evil.example/ilanlar', hosts)).toBe(false);
    expect(isSafeBrowserRequest('https://www.resmigazete.gov.tr.evil.example/ilanlar', hosts)).toBe(false);
  });

  it('blocks local/numeric hosts, credentials, unsupported ports and non-web schemes', () => {
    expect(isSafeBrowserRequest('http://127.0.0.1:8000/', hosts)).toBe(false);
    expect(isSafeBrowserRequest('https://user:pass@www.resmigazete.gov.tr/', hosts)).toBe(false);
    expect(isSafeBrowserRequest('https://www.resmigazete.gov.tr:8443/', hosts)).toBe(false);
    expect(isSafeBrowserRequest('file:///etc/passwd', hosts)).toBe(false);
    expect(isSafeBrowserRequest('ws://www.resmigazete.gov.tr/socket', hosts)).toBe(false);
  });

  it('allows non-network document URLs used by the page itself', () => {
    expect(isSafeBrowserRequest('data:text/plain,hello', hosts)).toBe(true);
    expect(isSafeBrowserRequest('blob:https://www.resmigazete.gov.tr/id', hosts)).toBe(true);
  });
});

describe('tarayıcı yedeği anahtarı (SOURCE_BROWSER_FALLBACK)', () => {
  const original = process.env['SOURCE_BROWSER_FALLBACK'];
  afterEach(() => {
    if (original === undefined) delete process.env['SOURCE_BROWSER_FALLBACK'];
    else process.env['SOURCE_BROWSER_FALLBACK'] = original;
  });

  it('0/false/no/boş/tanımsız kapalı demektir; yalnızca açık 1/true açar', () => {
    expect(browserFallbackEnabled({ SOURCE_BROWSER_FALLBACK: '0' })).toBe(false);
    expect(browserFallbackEnabled({ SOURCE_BROWSER_FALLBACK: 'false' })).toBe(false);
    expect(browserFallbackEnabled({ SOURCE_BROWSER_FALLBACK: 'NO' })).toBe(false);
    expect(browserFallbackEnabled({ SOURCE_BROWSER_FALLBACK: '1' })).toBe(true);
    expect(browserFallbackEnabled({ SOURCE_BROWSER_FALLBACK: '' })).toBe(false);
    expect(browserFallbackEnabled({})).toBe(false);
    expect(browserFallbackEnabled({ SOURCE_BROWSER_FALLBACK: 'true' })).toBe(true);
  });

  it('kapalıyken Chromium hiç başlatılmaz (testler gerçek ağa çıkamaz)', async () => {
    // tests/setup.ts anahtarı 0 yapar; bu test onu DEĞİŞTİRMEDEN doğrular.
    expect(process.env['SOURCE_BROWSER_FALLBACK']).toBe('0');
    browserMocks.launch.mockReset();
    await expect(launchChromium({ allowedHosts: ['example.gov'] })).rejects.toThrow(/SOURCE_BROWSER_FALLBACK=0/);
    expect(browserMocks.launch).not.toHaveBeenCalled();
  });
});

describe('browser session cancellation', () => {
  beforeEach(() => {
    // Bu blok Playwright'ı MOCK'lar (gerçek ağ yok); anahtar bilinçli olarak açılır.
    process.env['SOURCE_BROWSER_FALLBACK'] = '1';
    browserMocks.launch.mockReset();
    browserMocks.resolvePublicAddresses.mockClear();
  });

  it('closes page and browser on abort and shares an idempotent close', async () => {
    const page = {
      route: vi.fn(async () => undefined),
      routeWebSocket: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    };
    browserMocks.launch.mockResolvedValue(browser);
    const controller = new AbortController();
    const session = await launchChromium({ allowedHosts: ['example.gov'], signal: controller.signal });

    controller.abort(new Error('scrape timeout'));
    await Promise.all([session.close(), session.close()]);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe('tarayıcı yedeği robots.txt kapısı', () => {
  const ISKUR_RULES = robotsRulesByHost([
    { allowedHosts: ['iskur.gov.tr', 'www.iskur.gov.tr'], robotsDisallow: ['/api/', '/*?*'] },
    { allowedHosts: ['www.resmigazete.gov.tr'] },
  ]);

  beforeEach(() => {
    process.env['SOURCE_BROWSER_FALLBACK'] = '1';
    browserMocks.launch.mockReset();
  });

  it('kaynak tanımlarındaki İŞKUR kuralları host bazında okunur', () => {
    expect(robotsRulesByHost().get('www.iskur.gov.tr')).toEqual(['/api/', '/*?*']);
    expect(robotsRulesByHost().has('www.resmigazete.gov.tr')).toBe(false);
  });

  it('yasak yol ve sorgu dizeli adres eşleşir; diğer host ve izinli yol eşleşmez', () => {
    expect(browserRobotsRule('https://www.iskur.gov.tr/api/ilanlar', ISKUR_RULES)).toBe('/api/');
    expect(browserRobotsRule('https://www.iskur.gov.tr/ilanlar/?sayfa=2', ISKUR_RULES)).toBe('/*?*');
    expect(browserRobotsRule('https://www.iskur.gov.tr/ilanlar/kamu-personel/', ISKUR_RULES)).toBeNull();
    expect(browserRobotsRule('https://www.resmigazete.gov.tr/api/x?y=1', ISKUR_RULES)).toBeNull();
    expect(browserRobotsRule('data:text/plain,a?b', ISKUR_RULES)).toBeNull();
  });

  async function sessionWithRoute() {
    let handler: ((route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => Promise<void>) | undefined;
    const goto = vi.fn(async () => undefined);
    const page = {
      goto,
      route: vi.fn(async (_pattern: string, h: typeof handler) => {
        handler = h;
      }),
      routeWebSocket: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    browserMocks.launch.mockResolvedValue({ newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) });
    const session = await launchChromium({ allowedHosts: ['www.iskur.gov.tr'], robotsRules: ISKUR_RULES });
    const decide = async (url: string): Promise<'continue' | 'abort'> => {
      let decision: 'continue' | 'abort' = 'continue';
      await handler?.({
        request: () => ({ url: () => url }),
        continue: async () => {
          decision = 'continue';
        },
        abort: async () => {
          decision = 'abort';
        },
      });
      return decision;
    };
    return { session, goto, decide };
  }

  it('yasak adrese goto hiç istek göndermeden açık hata verir; izinli adres gider', async () => {
    const { session, goto } = await sessionWithRoute();
    await expect(
      session.page.goto('https://www.iskur.gov.tr/api/ilan-listesi', { waitUntil: 'load', timeout: 1000 }),
    ).rejects.toThrow(/robots\.txt kuralı bu adresi yasaklıyor \(Disallow: \/api\/\)/);
    expect(goto).not.toHaveBeenCalled();
    await session.page.goto('https://www.iskur.gov.tr/ilanlar/', { waitUntil: 'load', timeout: 1000 });
    expect(goto).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it('sayfanın kendi XHR/alt kaynak istekleri de route katmanında robots ile kesilir', async () => {
    const { session, decide } = await sessionWithRoute();
    expect(await decide('https://www.iskur.gov.tr/api/ilanlar?tur=kamu')).toBe('abort');
    expect(await decide('https://www.iskur.gov.tr/ilanlar/?sayfa=2')).toBe('abort');
    expect(await decide('https://www.iskur.gov.tr/ilanlar/')).toBe('continue');
    await session.close();
  });
});
