/**
 * Bölge engelli kaynak kapısı (23.10.2026): api.kariyerkapisi.gov.tr sunucumuzun
 * yurt dışı IP'sini ağ düzeyinde engelliyor. Bu kaynaklar her koşumda zaman aşımıyla
 * başarısız olup ölü mektup kuyruğunu şişiriyor ve sağlığı "degraded" gösteriyordu.
 * Kapı: gerçek taramada denemeye girmeden temiz "atlandı"; hata sayılmaz.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { runSourceScrape } from '../src/ingest/pipeline';
import { SOURCE_DEFINITIONS, findSourceDefinition } from '../src/config/sources';

const NOW = new Date('2026-10-23T12:00:00Z');
const BLOCKED_KEY = 'kariyerkapisi-isealim';

let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-bolge-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bölge engeli kapısı', () => {
  it('Kariyer Kapısı tanımı region-blocked işaretli', () => {
    expect(findSourceDefinition(BLOCKED_KEY)?.accessState).toBe('region-blocked');
  });

  it('yalnızca bilinçli işaretlenen kaynaklar region-blocked', () => {
    const blocked = SOURCE_DEFINITIONS.filter((s) => s.accessState === 'region-blocked').map((s) => s.key);
    expect(blocked).toEqual([BLOCKED_KEY]);
  });

  it('gerçek taramada denemeye girmeden atlanır ve eski hata sayacı temizlenir', async () => {
    const source = await repos.sources.getByKey(BLOCKED_KEY);
    if (!source) throw new Error('kaynak yok');
    // Önceki başarısızlıkları taklit et (ölü kuyruk/degraded sebebi).
    await repos.sources.recordHealth(BLOCKED_KEY, {
      lastRunAt: NOW.toISOString(),
      success: false,
      durationMs: 15000,
      discoveredCount: 0,
      acceptedCount: 0,
      errorMessage: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const before = await repos.sources.getByKey(BLOCKED_KEY);
    expect((before?.health.consecutiveFailures ?? 0)).toBeGreaterThan(0);

    // Adaptör/HTTP verilmez: kapı bunlardan ÖNCE devreye girmeli (ağa çıkılmaz).
    const run = await runSourceScrape({
      repos,
      source: before!,
      trigger: 'schedule',
      workerId: 'worker-bolge',
      logger: createLogger('bolge', { level: 'silent' }),
      liveFetch: true,
    });

    expect(run.status).toBe('skipped');
    expect(run.notes.join(' ')).toContain('bölge');
    const after = await repos.sources.getByKey(BLOCKED_KEY);
    expect(after?.health.consecutiveFailures).toBe(0);
  });

  it('sağlık raporu bölge engelli kaynağı "başarısız" saymaz', async () => {
    await repos.sources.recordHealth(BLOCKED_KEY, {
      lastRunAt: NOW.toISOString(),
      success: false,
      durationMs: 15000,
      discoveredCount: 0,
      acceptedCount: 0,
      errorMessage: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const coverage = await repos.sources.coverage({ termsPolicy: 'enforce' });
    const entry = coverage.sources.find((s) => s.key === BLOCKED_KEY);
    expect(entry?.accessBlocked).toBe(true);
    expect(coverage.summary.failing).toBe(0);
  });
});
