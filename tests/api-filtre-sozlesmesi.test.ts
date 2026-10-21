/**
 * GET /api/jobs filtre sözleşmesi — `hasApplicationUrl`.
 *
 * Bulgu (21.10.2026): parametre `z.coerce.boolean()` ile çözülüyordu ve
 * `Boolean('false') === true` olduğu için `?hasApplicationUrl=false` filtresi
 * TERSİNİ uyguluyordu: paylaşılan bağlantı "başvuru bağlantısı OLMAYAN ilanlar"
 * demek isterken yalnızca bağlantısı olanları döndürüyordu. Arayüz yalnızca
 * `hasApplicationUrl=1` gönderdiği için hata tarayıcıda görünmüyordu; API
 * sözleşmesi ve paylaşılabilir bağlantılar bozuktu.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { resetEnvCache } from '../src/config/env';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-21T09:00:00+03:00');
const LOGGER = createLogger('api-filtre-test', { level: 'silent' });
const WITH_URL = 'https://basvuru.ornek.test/ilan/1';

let openStores: FileStore[] = [];
let openApps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps) await app.close();
  for (const store of openStores) await store.close();
  openApps = [];
  openStores = [];
  resetEnvCache();
});

async function makeWorld(): Promise<{ repos: Repos; app: FastifyInstance }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-filtre-')));
  await store.init();
  openStores.push(store);
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
  openApps.push(app);
  return { repos, app };
}

/** Başvuru bağlantısı OLAN ve OLMAYAN iki ilan. */
async function seedJobs(repos: Repos): Promise<void> {
  const withUrl = sozlesmeliPersonelIlani({ sourceItemId: 'FILTRE-1' });
  await applyRawAnnouncement(
    { ...withUrl, applicationUrl: WITH_URL } as typeof withUrl,
    { repos, now: NOW, workerId: 'w-filtre', provenance: 'scraped' },
  );

  // Farklı kurum + farklı dönem: tekilleştirme bunları birleştirmemeli.
  const withoutUrl = sozlesmeliPersonelIlani({
    sourceItemId: 'FILTRE-2',
    title: 'Örnek Belediyesi Başkanlığından: Zabıta Memuru Alım İlanı',
    institution: 'Örnek Belediyesi Başkanlığı',
    url: 'https://ornek.test/ilanlar/FILTRE-2',
    bodyText:
      'Örnek Belediyesi Başkanlığından: Belediyemizde istihdam edilmek üzere 3 (üç) zabıta memuru alınacaktır. ' +
      'Başvurular 05.11.2026 tarihinde başlayıp 15.11.2026 tarihinde sona erecektir. ' +
      'Adayların 2026 yılı KPSS P3 puanına sahip olması ve lisans mezunu olması gerekmektedir.',
    applicationEndAt: '2026-11-15T17:00:00+03:00',
  });
  await applyRawAnnouncement(withoutUrl, {
    repos,
    now: NOW,
    workerId: 'w-filtre',
    provenance: 'scraped',
  });
}

async function titles(app: FastifyInstance, query: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/api/jobs?${query}` });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { items: { title: string; hasApplicationUrl: boolean }[] };
  return body.items.map((item) => item.title);
}

describe('GET /api/jobs?hasApplicationUrl', () => {
  it('false ve 0 yalnızca başvuru bağlantısı OLMAYAN ilanları döndürür', async () => {
    const { repos, app } = await makeWorld();
    await seedJobs(repos);

    for (const value of ['false', '0']) {
      const list = await titles(app, `hasApplicationUrl=${value}&pageSize=50`);
      expect(list, `hasApplicationUrl=${value}`).toHaveLength(1);
      expect(list[0]).toContain('Zabıta Memuru Alım İlanı');
    }
  });

  it('true ve 1 yalnızca başvuru bağlantısı olan ilanları döndürür', async () => {
    const { repos, app } = await makeWorld();
    await seedJobs(repos);

    for (const value of ['true', '1']) {
      const list = await titles(app, `hasApplicationUrl=${value}&pageSize=50`);
      expect(list, `hasApplicationUrl=${value}`).toHaveLength(1);
      expect(list[0]).toContain('Sözleşmeli Personel Alım İlanı');
    }
  });

  it('parametre verilmezse iki ilan da döner', async () => {
    const { repos, app } = await makeWorld();
    await seedJobs(repos);
    expect(await titles(app, 'pageSize=50')).toHaveLength(2);
  });
});
