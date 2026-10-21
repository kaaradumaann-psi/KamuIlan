/**
 * GERÇEK KAYNAK REGRESYONU — resmî "duyurular" sayfası (İçişleri Bakanlığı).
 *
 * Veri: `tests/fixtures/gercek-ilanlar/2026-10-21-icisleri-duyurular.json`
 * — 21.10.2026'da https://www.icisleri.gov.tr/duyurular adresinden tek herkese
 * açık istekle gözlemlenen 10 gerçek başlık (gövde metni indirilmedi).
 *
 * Neden: bu kaynak `enabled: true` ve uygulamanın gerçek kaynak listesinde var.
 * Sayfadaki kayıtlar sınav/sonuç/kararname duyurularıdır; iş ilanı DEĞİLDİR.
 * Ölçülen durum (düzeltme öncesi): 10 kayıttan 4'ü `accept` + `kind: process`
 * alıyordu ve `GET /api/jobs` varsayılan listesinde (kind filtresi boşken) iş
 * ilanlarıyla birlikte dönüyordu. Kullanıcı "Sözleşmeli Bilişim Personeli Sözlü
 * Sınav Sonuç Listesi"ni açık kadro sanabilirdi.
 *
 * KANIT DÜZEYİ: [1] gerçek sayfa gözlemi + [2] tekrarlanabilir test.
 * SINIRLILIK [4]: başlıklar gerçek; gövde metni yok, bu yüzden yalnızca başlık
 * düzeyinde karar ölçülür. Etiketler ajan tarafından konuldu (humanVerified:false).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
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
import { classify } from '../src/classification/engine';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';

interface FixtureItem {
  id: string;
  path: string;
  title: string;
  expected: 'process' | 'not-job';
}
interface Fixture {
  observedAt: string;
  source: { key: string; url: string; name: string };
  items: FixtureItem[];
}

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/gercek-ilanlar/2026-10-21-icisleri-duyurular.json'),
    'utf8',
  ),
) as Fixture;

const NOW = new Date('2026-10-21T09:00:00+03:00');
const LOGGER = createLogger('icisleri-regresyon', { level: 'silent' });

let openStores: FileStore[] = [];
let openApps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps) await app.close();
  for (const store of openStores) await store.close();
  openApps = [];
  openStores = [];
  resetEnvCache();
});

describe('İçişleri Bakanlığı duyuruları (gerçek başlıklar)', () => {
  it('fixture gerçek ve yeterli', () => {
    expect(fixture.items.length).toBeGreaterThanOrEqual(10);
    for (const item of fixture.items) {
      expect(item.title.length).toBeGreaterThan(20);
      expect(item.path.startsWith('/')).toBe(true);
    }
  });

  it('hiçbir duyuru iş ilanı (accept + kind=job) olarak sınıflandırılmaz', () => {
    for (const item of fixture.items) {
      const result = classify({ title: item.title, body: '', sourceCategory: 'duyuru' });
      const isJobAd = result.decision === 'accept' && result.kind !== 'process';
      expect(isJobAd, `${item.title} → ${result.decision}/${result.kind}`).toBe(false);
    }
  });

  it('kabul edilen kayıtlar yalnızca "process" kategorisindedir', () => {
    const accepted = fixture.items
      .map((item) => ({ item, result: classify({ title: item.title, body: '', sourceCategory: 'duyuru' }) }))
      .filter(({ result }) => result.decision === 'accept');
    for (const { item, result } of accepted) {
      expect(result.kind, item.title).toBe('process');
    }
  });

  it('akışa giren duyurular "process" etiketiyle görünür ve açık ilan sayılmaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-icisleri-')));
    await store.init();
    openStores.push(store);
    const repos: Repos = createRepos(store, fixedClock(NOW));
    await repos.sources.seed();

    for (const item of fixture.items) {
      await applyRawAnnouncement(
        {
          sourceKey: fixture.source.key,
          sourceItemId: item.id,
          url: `${fixture.source.url.replace('/duyurular', '')}${item.path}`,
          title: item.title,
          bodyText: '',
          bodyTextSource: 'listing' as const,
          attachments: [],
          sourceCategory: 'duyuru',
          extractionConfidence: 0.4,
        },
        { repos, now: NOW, workerId: 'w-icisleri', provenance: 'scraped' },
      );
    }

    const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
    openApps.push(app);

    const list = await app.inject({ method: 'GET', url: '/api/jobs?pageSize=50' });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { title: string; kind: string }[] }).items;
    const fixtureTitles = new Set(fixture.items.map((item) => item.title));
    for (const item of items) {
      if (!fixtureTitles.has(item.title)) continue;
      // Akışta görünse bile iş ilanı olarak etiketlenemez.
      expect(item.kind, item.title).toBe('process');
    }

    // Ana sayfa "açık ilan" sayacı yalnızca gerçek iş ilanlarını sayar.
    const stats = await app.inject({ method: 'GET', url: '/api/jobs/stats' });
    expect(stats.statusCode).toBe(200);
    const statsBody = stats.json() as { active: number; total: number };
    expect(statsBody.active).toBe(0);
    expect(statsBody.total).toBe(0);
  });
});
