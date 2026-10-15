/** Kaynak özetleri: doğrulanmış adaptörler "hazırlanan" sayısına karışmaz. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceDefinition } from '../src/config/sources';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';

const NOW = new Date('2026-10-14T09:00:00+03:00');

function sourceDefinition(
  key: string,
  status: 'verified' | 'scraper-built',
  intervalMinutes: number,
): SourceDefinition {
  return {
    key,
    name: key,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: key,
    listingUrl: `https://${key}.example.test/ilanlar`,
    homepageUrl: `https://${key}.example.test/`,
    adapterKey: 'test-adapter',
    method: 'html-list',
    status,
    statusNote: 'coverage testi',
    lastVerifiedAt: status === 'verified' ? '2026-10-14' : null,
    verificationEvidence: status === 'verified' ? 'Fixture ile doğrulandı.' : 'Henüz doğrulanmadı.',
    coverageNote: 'Test kaynağı.',
    enabled: true,
    intervalMinutes,
    minRequestIntervalMs: 1_000,
    maxConcurrency: 1,
    allowedHosts: [`${key}.example.test`],
    tags: ['test'],
  };
}

describe('kaynak kapsam özeti', () => {
  it('envanter aynıysa seed tekrarında gereksiz kayıt güncellemesi yapmaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-source-seed-')));
    await store.init();
    try {
      const repos = createRepos(store, fixedClock(NOW));
      const definition = sourceDefinition('degismeyen-kaynak', 'verified', 60);
      expect(await repos.sources.seed([definition])).toEqual({ created: 1, updated: 0 });
      expect(await repos.sources.seed([definition])).toEqual({ created: 0, updated: 0 });
    } finally {
      await store.close();
    }
  });

  it('hazır ama doğrulanmamış adaptörleri sayar; canlı doğrulananları tekrardan saymaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-source-coverage-')));
    await store.init();
    try {
      const repos = createRepos(store, fixedClock(NOW));
      await repos.sources.seed([
        sourceDefinition('verified-kaynak', 'verified', 60),
        sourceDefinition('hazir-kaynak', 'scraper-built', 180),
      ]);
      await repos.scheduledTasks.ensure({
        kind: 'source-scrape',
        sourceKey: 'verified-kaynak',
        intervalMinutes: 1,
      });

      const coverage = await repos.sources.coverage();
      const verified = coverage.sources.find((source) => source.key === 'verified-kaynak');
      const prepared = coverage.sources.find((source) => source.key === 'hazir-kaynak');

      expect(coverage.summary.verified).toBe(1);
      expect(coverage.summary.built).toBe(1);
      expect(verified?.built).toBe(true); // Doğrulanmış kaynakta da adaptör vardır.
      expect(verified?.intervalMinutes).toBe(1); // Zamanlayıcıdaki etkin aralık gösterilir.
      expect(prepared?.built).toBe(true);
      expect(prepared?.intervalMinutes).toBe(180); // Henüz görev yoksa kaynak aralığına düşer.
    } finally {
      await store.close();
    }
  });

  it('son başarısız deneme, son başarılı tarama varmış gibi tazeliği gizlemez', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-source-coverage-')));
    await store.init();
    try {
      const repos = createRepos(store, fixedClock(NOW));
      await repos.sources.seed([sourceDefinition('basarisiz-kaynak', 'verified', 60)]);
      await repos.sources.recordHealth('basarisiz-kaynak', {
        lastRunAt: NOW.toISOString(),
        success: false,
        durationMs: 250,
        discoveredCount: 0,
        acceptedCount: 0,
        errorMessage: 'Kaynak yanıt vermedi.',
      });

      const coverage = await repos.sources.coverage();
      expect(coverage.summary.failing).toBe(1);
      expect(coverage.summary.stale).toBe(1);
    } finally {
      await store.close();
    }
  });
  it('kapsam özeti kaynak başına son tarama sorgularını aynı anda çalıştırır (uzak veritabanında sıralı gecikme birikmez)', async () => {
    const base = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-source-latency-')));
    await base.init();
    let inFlight = 0;
    let maxInFlight = 0;
    const delayedStore = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'find' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 40));
            inFlight -= 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    try {
      const repos = createRepos(delayedStore as typeof base, fixedClock(NOW));
      await repos.sources.seed(
        Array.from({ length: 8 }, (_, index) => sourceDefinition(`paralel-${index}`, 'verified', 60)),
      );
      inFlight = 0;
      maxInFlight = 0;
      const coverage = await repos.sources.coverage();
      expect(coverage.sources).toHaveLength(8);
      expect(maxInFlight).toBeGreaterThan(1);
    } finally {
      await base.close();
    }
  });
});
