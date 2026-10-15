import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { buildApp } from '../src/server/app';
import { ihaleIlani, sonucDuyurusu, sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const LOGGER = createLogger('kind-api-test', { level: 'silent' });

let app: FastifyInstance | undefined;
let dir: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function world(): Promise<Repos> {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-kind-api-'));
  const store = new FileStore(dir);
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const ctx = { repos, now: NOW, workerId: 'worker-kind-api', provenance: 'scraped' as const };
  await applyRawAnnouncement(sozlesmeliPersonelIlani(), ctx);
  await applyRawAnnouncement(sonucDuyurusu(), ctx);
  await applyRawAnnouncement(ihaleIlani(), ctx);
  app = await buildApp({ repos, logger: LOGGER });
  await app.ready();
  return repos;
}

describe('/api/jobs tür alanı ve filtresi', () => {
  it('her ilan özetinde kind alanı bulunur; ihale kaydı akışa girmez', async () => {
    await world();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs?pageSize=50' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ title: string; kind: string }> };
    expect(body.items.length).toBe(2);
    for (const item of body.items) expect(['job', 'process']).toContain(item.kind);
    expect(body.items.map((item) => item.kind).sort()).toEqual(['job', 'process']);
  });

  it('kind=process yalnızca süreç duyurularını döndürür', async () => {
    await world();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs?kind=process&pageSize=50' });
    const body = response.json() as { items: Array<{ title: string; kind: string }>; total: number };
    expect(response.statusCode).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items[0]?.kind).toBe('process');
  });

  it('kind=job yalnızca iş ilanlarını döndürür', async () => {
    await world();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs?kind=job&pageSize=50' });
    const body = response.json() as { items: Array<{ kind: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.kind).toBe('job');
  });

  it('geçersiz tür değeri reddedilir', async () => {
    await world();
    const response = await app!.inject({ method: 'GET', url: '/api/jobs?kind=diger' });
    expect(response.statusCode).toBe(400);
  });
});
