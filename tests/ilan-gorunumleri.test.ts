/**
 * İlan görünümleri — arşiv sözleşmesi (API).
 *
 * Süresi dolan ve iptal edilen ilanlar silinmez; "Arşiv" görünümü
 * `status=closed,cancelled` ile yalnızca bunları getirir, açık ilanı getirmez.
 * Arayüzdeki "İptal edildi" seçeneği eklenene kadar iptal edilen ilanlar
 * durum filtresiyle bulunamıyordu.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-21T09:00:00+03:00');
const LOGGER = createLogger('gorunum-test', { level: 'silent' });
let cleanupTasks: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const task of cleanupTasks) await task();
  cleanupTasks = [];
});

async function seededApp(): Promise<{
  app: FastifyInstance;
  ids: Record<'active' | 'closed' | 'cancelled', string>;
}> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-gorunum-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const ids = {} as Record<'active' | 'closed' | 'cancelled', string>;
  const seeds = [
    ['active', 'Ankara Su ve Kanalizasyon İdaresi', 'Sözleşmeli Bilişim Personeli Alım İlanı'],
    ['closed', 'İzmir Liman İşletmesi Müdürlüğü', 'Sürekli İşçi Alım İlanı'],
    ['cancelled', 'Konya Orman Bölge Müdürlüğü', 'Orman Muhafaza Memuru Alım İlanı'],
  ] as const;
  for (const [index, [status, institution, title]] of seeds.entries()) {
    const raw = sozlesmeliPersonelIlani({
      sourceItemId: `GORUNUM-${index}`,
      title: `${institution}: ${title}`,
      institution,
      url: `https://ornek.test/ilanlar/GORUNUM-${index}`,
    });
    const result = await applyRawAnnouncement(raw, {
      repos,
      now: NOW,
      workerId: 'w-gorunum',
      provenance: 'scraped',
    });
    const jobId = (result as { jobId?: string | null }).jobId;
    if (!jobId) throw new Error(`ilan oluşturulamadı: ${JSON.stringify(result)}`);
    await store.updateOne('jobs', { id: jobId }, { status });
    ids[status] = jobId;
  }
  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
  cleanupTasks.push(async () => {
    await app.close();
    await store.close();
  });
  return { app, ids };
}

describe('GET /api/jobs — arşiv görünümü', () => {
  it('status=closed,cancelled yalnızca kapanan ve iptal edilen ilanları getirir', async () => {
    const { app, ids } = await seededApp();
    const response = await app.inject({ method: 'GET', url: '/api/jobs?status=closed,cancelled' });
    expect(response.statusCode).toBe(200);
    const returned = (response.json() as { items: { id: string }[] }).items.map((item) => item.id).sort();
    expect(returned).toEqual([ids.closed, ids.cancelled].sort());
  });

  it('status=cancelled iptal edilen ilanı bulur; status=all üçünü de gösterir (silinmez); varsayılan liste yalnız güncel ilanı gösterir', async () => {
    const { app, ids } = await seededApp();
    const cancelled = (await app.inject({ method: 'GET', url: '/api/jobs?status=cancelled' })).json() as {
      items: { id: string }[];
    };
    expect(cancelled.items.map((item) => item.id)).toEqual([ids.cancelled]);
    const all = (await app.inject({ method: 'GET', url: '/api/jobs?status=all' })).json() as { total: number };
    expect(all.total).toBe(3);
    const current = (await app.inject({ method: 'GET', url: '/api/jobs' })).json() as { total: number };
    expect(current.total).toBe(1);
  });
});
