import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  resolvePublicAddresses: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('playwright', () => ({ chromium: { launch: browserMocks.launch } }));
vi.mock('../src/sources/network-safety', () => ({
  createPublicOnlyLookup: vi.fn(() => vi.fn()),
  resolvePublicAddresses: browserMocks.resolvePublicAddresses,
}));

import { isSafeBrowserRequest, launchChromium } from '../src/sources/browser-session';

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

describe('browser session cancellation', () => {
  beforeEach(() => {
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
