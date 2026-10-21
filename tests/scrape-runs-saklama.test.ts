/**
 * `scrapeRuns` saklama süresi: tablo hiç temizlenmiyordu (24 kaynak × saatlik ≈ 5 haftada
 * 20.000 satır; R-03). Bitmiş eski koşumlar küçük partilerle silinir; kapsam raporu ve
 * "son başarılı tarama" için her kaynağın son koşumu ve son başarılı/kısmi koşumu korunur.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { PostgresStore } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { createRepos } from '../src/db/repos/index';
import { fixedClock } from '../src/lib/clock';
import type { StoragePort } from '../src/db/ports';
import type { ScrapeRunDoc } from '../src/db/schemas';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 90 * 24 * 3_600_000).toISOString();
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 3_600_000).toISOString();

/** Silme SQL'de çalışır ($nin, skip, $in): aynı senaryo Postgres'te (PGlite) de koşar. */
const DRIVERS: [string, () => Promise<StoragePort>][] = [
  ['dosya', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-runs-retention-')));
    await store.init();
    return store;
  }],
  ['postgres (PGlite)', async () => {
    const db = new PGlite();
    const query = async (text: string, values?: unknown[]) => {
      const result = await db.query(text, values ?? []);
      return { rows: result.rows as never[], rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null };
    };
    const store = new PostgresStore({
      connectionString: 'postgres://saklama-yerel-test',
      tablePrefix: 'kamuilan_saklama',
      pool: { query, connect: async () => ({ query, release: () => undefined }), end: async () => db.close() },
    });
    await store.init();
    await store.ensureIndexes(INDEXES);
    return store;
  }],
];

let createStore: () => Promise<StoragePort>;

async function setup() {
  const store = await createStore();
  const repos = createRepos(store, fixedClock(NOW));
  const add = async (sourceKey: string, startedAt: string, status: ScrapeRunDoc['status']): Promise<string> => {
    const run = await repos.runs.start({ sourceKey, trigger: 'schedule', workerId: 'test' });
    await store.updateOne('scrapeRuns', { id: run.id }, { startedAt, status });
    return run.id;
  };
  return { store, repos, add };
}

describe.each(DRIVERS)('scrapeRuns saklama (90 gün) — %s', (_name, factory) => {
  beforeEach(() => {
    createStore = factory;
  });
  it('eski bitmiş koşumları siler; yeni, çalışan ve korunan koşumlara dokunmaz', async () => {
    const { store, repos, add } = await setup();
    const oldFailedA = await add('kaynak-a', daysAgo(200), 'failed');
    const oldSuccessA = await add('kaynak-a', daysAgo(150), 'success');
    const oldPartialA = await add('kaynak-a', daysAgo(120), 'partial'); // A'nın son başarılı/kısmi koşumu
    const recentFailedA = await add('kaynak-a', daysAgo(1), 'failed'); // A'nın son koşumu
    const oldRunning = await add('kaynak-b', daysAgo(100), 'running');
    const oldSkippedB = await add('kaynak-b', daysAgo(95), 'skipped');
    const recentB = await add('kaynak-b', daysAgo(2), 'success');
    const onlyOldC = await add('kaynak-c', daysAgo(300), 'failed'); // C'nin tek (son) koşumu

    const result = await repos.runs.purgeFinishedOlderThan(CUTOFF);

    const left = new Set((await store.find('scrapeRuns', {})).map((run) => run.id));
    expect([...left].sort()).toEqual([oldPartialA, recentFailedA, oldRunning, recentB, onlyOldC].sort());
    expect(left.has(oldFailedA) || left.has(oldSuccessA) || left.has(oldSkippedB)).toBe(false);
    expect(result).toEqual({ matched: 3, deleted: 3, kept: 2 });
    await store.close();
  });

  it('kuru çalışma hiçbir şey silmez, aynı sayıyı verir; ikinci gerçek çalışma 0 siler', async () => {
    const { store, repos, add } = await setup();
    for (let i = 0; i < 7; i += 1) await add('kaynak-a', daysAgo(100 + i), 'success');
    await add('kaynak-a', daysAgo(1), 'success');

    const preview = await repos.runs.purgeFinishedOlderThan(CUTOFF, { dryRun: true, batchSize: 3 });
    expect(preview).toEqual({ matched: 7, deleted: 0, kept: 0 });
    expect(await store.count('scrapeRuns', {})).toBe(8);

    // Küçük partiler: 3'erli partilerle hepsi silinir.
    expect(await repos.runs.purgeFinishedOlderThan(CUTOFF, { batchSize: 3 })).toEqual({ matched: 7, deleted: 7, kept: 0 });
    expect(await store.count('scrapeRuns', {})).toBe(1);
    expect(await repos.runs.purgeFinishedOlderThan(CUTOFF, { batchSize: 3 })).toEqual({ matched: 0, deleted: 0, kept: 0 });
    await store.close();
  });

  it('parti sınırı (maxBatches) bir çalışmada silinecek satırı sınırlar', async () => {
    const { store, repos, add } = await setup();
    for (let i = 0; i < 6; i += 1) await add('kaynak-a', daysAgo(100 + i), 'failed');
    await add('kaynak-a', daysAgo(1), 'failed');

    expect(await repos.runs.purgeFinishedOlderThan(CUTOFF, { batchSize: 2, maxBatches: 2 })).toEqual({
      matched: 4,
      deleted: 4,
      kept: 0,
    });
    expect(await store.count('scrapeRuns', {})).toBe(3);
    await store.close();
  });
});
