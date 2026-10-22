/**
 * Üretim API'sinin aynı süreçten arayüz sunması (`serveStatic`).
 *
 * Eski davranış (22.10.2026 üretim provasında bulundu): `serveStatic` açıkken
 * `setNotFoundHandler` iki kez çağrılıyordu ve Fastify ikincisini reddettiği için
 * `NODE_ENV=production npm run start` HER SEFERİNDE "Not found handler already set"
 * ile çöküyordu. Bu yolu hiçbir test kapsamıyordu.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';

const LOGGER = createLogger('statik-test', { level: 'silent' });

let dataDir: string;
let distDir: string;
let store: FileStore;
let app: FastifyInstance | null = null;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kamuilan-statik-veri-'));
  distDir = mkdtempSync(join(tmpdir(), 'kamuilan-statik-dist-'));
  store = new FileStore(dataDir);
  await store.init();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
});

async function build(withIndex: boolean): Promise<FastifyInstance> {
  if (withIndex) {
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Kamuİlan</title><div id="root"></div>');
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  }
  app = await buildApp({ repos: createRepos(store), logger: LOGGER, serveStatic: true, staticRoot: distDir });
  await app.ready();
  return app;
}

describe('serveStatic (üretimde aynı süreçten arayüz)', () => {
  it('uygulama açılır; bilinmeyen sayfa yolu SPA index.html döner', async () => {
    const server = await build(true);
    const page = await server.inject({ method: 'GET', url: '/ilanlar/abc?q=zabita' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<div id="root">');
  });

  it('derlenmiş varlık dosyası sunulur', async () => {
    const server = await build(true);
    const asset = await server.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
  });

  it('bilinmeyen /api yolu ve GET olmayan istek JSON 404 döner (HTML değil)', async () => {
    const server = await build(true);
    const api = await server.inject({ method: 'GET', url: '/api/yok-boyle-bir-uc' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
    const post = await server.inject({ method: 'POST', url: '/bilinmeyen', payload: {} });
    expect(post.headers['content-type']).toContain('application/json');
  });

  it('dist/index.html yoksa API yine açılır; sayfa yolları JSON 404', async () => {
    const server = await build(false);
    const health = await server.inject({ method: 'GET', url: '/api/health' });
    expect(health.headers['content-type']).toContain('application/json');
    expect((health.json() as { status?: string }).status).toBeTruthy();
    const page = await server.inject({ method: 'GET', url: '/ilanlar' });
    expect(page.statusCode).toBe(404);
    expect(page.headers['content-type']).toContain('application/json');
  });
});
