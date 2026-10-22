/**
 * Cloudflare Workers giriş noktası: /api/* API vekiline, diğer yollar statik varlıklara.
 * Eski durum: wrangler.jsonc'de `main` yoktu; functions/api (Pages kuralı) Workers'ta çalışmadığı için
 * /api istekleri index.html dönüyordu.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../functions/worker';

afterEach(() => vi.unstubAllGlobals());

const assets = { fetch: vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) };
const env = { API_ORIGIN: 'https://api.ornek.test', ASSETS: assets };

describe('functions/worker.ts', () => {
  it('/api/* isteğini API kaynağına iletir (statik varlığa düşmez)', async () => {
    const upstream = vi.fn(async () => new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(new Request('https://kamuilan.ornek.tr/api/health?x=1'), env);
    expect(response.headers.get('content-type')).toContain('application/json');
    const target = String((upstream.mock.calls[0] as unknown[])[0] instanceof Request ? ((upstream.mock.calls[0] as unknown[])[0] as Request).url : (upstream.mock.calls[0] as unknown[])[0]);
    expect(target).toBe('https://api.ornek.test/api/health?x=1');
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('birden çok Set-Cookie ayrı ayrı korunur (üretimde giriş oturumu kayboluyordu)', async () => {
    const upstreamHeaders = new Headers({ 'content-type': 'application/json' });
    upstreamHeaders.append('set-cookie', 'kamuilan_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 29 Oct 2026 18:00:00 GMT');
    upstreamHeaders.append('set-cookie', 'kamuilan_csrf=xyz; Path=/; Secure; SameSite=Lax; Expires=Thu, 29 Oct 2026 18:00:00 GMT');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { headers: upstreamHeaders })));
    const response = await worker.fetch(new Request('https://kamuilan.ornek.tr/api/auth/login', { method: 'POST', body: '{}' }), env);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^kamuilan_session=abc;/);
    expect(cookies[1]).toMatch(/^kamuilan_csrf=xyz;/);
  });

  it('sayfa yolları statik varlıklardan (SPA) sunulur', async () => {
    const response = await worker.fetch(new Request('https://kamuilan.ornek.tr/ilanlar/abc'), env);
    expect(await response.text()).toContain('<!doctype html>');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it('wrangler.jsonc giriş betiğini ve yalnız /api için önce-Worker kuralını tanımlar', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');
    expect(config).toMatch(/"main":\s*"functions\/worker\.ts"/);
    expect(config).toMatch(/"run_worker_first":\s*\["\/api\/\*"\]/);
    expect(config).toMatch(/"binding":\s*"ASSETS"/);
  });
});
