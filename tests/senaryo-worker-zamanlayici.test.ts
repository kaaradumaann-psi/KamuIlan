/**
 * AŞAMA 6 — Worker ve zamanlayıcı sözleşmesi.
 *
 * | # | Doğrulanan şey                                             | Beklenen                                        |
 * |---|------------------------------------------------------------|-------------------------------------------------|
 * | 1 | Zamanlanan görev türlerinin TAMAMI işlenir                 | bilinmeyen görev yok; hepsi kuyruktan geçer     |
 * | 2 | Kilit süresi (lease)                                       | süre dolmadan devralınamaz, dolunca devralınır   |
 * | 3 | Worker yokken (SCHEDULER_ENABLED=0)                        | due görev kuyruğa alınmaz, sonraki zaman kaymaz  |
 * | 4 | Güvenli sonlanma                                           | döngü durur, kalp atışı 'stopped', yarım iş yok  |
 *
 * Ağa çıkılmaz; e-posta taşıyıcısı bellek içidir (gerçek gönderim yok).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock, type Clock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { BuiltinQueueBackend } from '../src/worker/queue';
import { ensureScheduledTasks, schedulerTick } from '../src/worker/scheduler';
import { WorkerRuntime } from '../src/worker/runtime';
import { MemoryEmailTransport } from '../src/email/transport';
import { getEnv } from '../src/config/env';
import type { SourceDefinition } from '../src/config/sources';
import type { SourceAdapter } from '../src/sources/types';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const LOGGER = createLogger('senaryo-worker', { level: 'silent' });

const SOURCE_KEY = 'senaryo-kaynak';

function definition(): SourceDefinition {
  return {
    key: SOURCE_KEY,
    name: 'Senaryo Kaynağı',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Senaryo Kurumu',
    homepageUrl: 'https://ornek.test/',
    listingUrl: 'https://ornek.test/ilanlar',
    adapterKey: 'test-liste',
    method: 'html-list',
    status: 'method-defined',
    statusNote: 'test',
    lastVerifiedAt: null,
    verificationEvidence: 'test',
    coverageNote: 'test',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 0,
    maxConcurrency: 1,
    allowedHosts: ['ornek.test'],
    tags: ['test'],
  };
}

function emptyAdapter(): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Boş test listesi',
    method: 'html-list',
    notes: 'Ağa çıkmaz.',
    run: async () => ({
      items: [],
      requestCount: 1,
      notes: [],
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses: [200],
      coverage: { status: 'complete', note: 'Test: tam sayfa tarandı.' },
    }),
  };
}

interface World {
  repos: Repos;
  queue: BuiltinQueueBackend;
  clock: Clock & { advance(ms: number): void };
}

async function makeWorld(schedulerEnabled: boolean): Promise<World & { schedulerEnabled: boolean }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-senaryo-worker-')));
  await store.init();
  const clock = fixedClock(NOW);
  const repos = createRepos(store, clock);
  await repos.sources.seed([definition()]);
  return { repos, queue: new BuiltinQueueBackend(repos), clock, schedulerEnabled };
}

function makeRuntime(world: World, schedulerEnabled: boolean): WorkerRuntime {
  return new WorkerRuntime({
    repos: world.repos,
    queue: world.queue,
    env: { ...getEnv(), LOG_LEVEL: 'silent', SCHEDULER_ENABLED: schedulerEnabled, WORKER_CONCURRENCY: 2 },
    logger: LOGGER,
    workerId: 'worker-senaryo',
    transport: new MemoryEmailTransport(),
    liveFetch: false,
    now: () => world.repos.clock.now(),
    coverageWarnings: false,
    adapterOverride: emptyAdapter(),
  });
}

describe('AŞAMA 6 — worker/zamanlayıcı', () => {
  it('1) zamanlanan TÜM görev türleri kuyruğa alınır ve bilinmeyen tür yok sayılmaz', async () => {
    const world = await makeWorld(true);
    await ensureScheduledTasks(world.repos, LOGGER, 0);

    const tasks = await world.repos.scheduledTasks.listAll();
    const kinds = tasks.map((task) => task.kind).sort();
    expect(kinds).toContain('source-scrape');
    expect(kinds).toContain('deadline-refresh');
    expect(kinds).toContain('maintenance');
    expect(kinds).toContain('coverage-audit');

    const tick = await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    expect(tick.due).toBe(tasks.length);
    expect(tick.enqueued).toBe(tasks.length);

    const runtime = makeRuntime(world, true);
    const result = await runtime.tick();
    // Bakım kuyruğu tik başına SINIRLI iş çeker (2 iş): kalan görevler sonraki
    // tiklerde eritilir. Bu yüzden tüm sistem görevleri için tik tekrarlanır.
    const second = await runtime.tick();

    const ran = [...result.maintenance.ran, ...second.maintenance.ran];
    // Sistem görevleri bakım kuyruğunda GERÇEKTEN çalıştı: "bilinmeyen bakım
    // görevi" uyarısı yoksa her tür için bir işleyici var demektir.
    expect(ran).toEqual(expect.arrayContaining(['deadline-refresh', 'maintenance', 'coverage-audit']));
    expect([...result.warnings, ...second.warnings].join(' ')).not.toContain('bilinmeyen');
    expect(result.scrapes.processed).toBeGreaterThanOrEqual(1);

    const dead = await world.repos.queue.listDead(50);
    expect(dead).toHaveLength(0);
    const refreshed = await world.repos.scheduledTasks.listAll();
    expect(refreshed.every((task) => task.lastRunAt !== null)).toBe(true);
  });

  it('2) kilit süresi dolmadan devralınamaz, dolduğunda devralınır', async () => {
    const world = await makeWorld(true);
    const key = `scrape:${SOURCE_KEY}`;

    expect(await world.repos.locks.acquire(key, 'worker-1', 60_000)).toBe(true);
    // Aynı anda ikinci worker (eşzamanlı çift çalışma) kilidi alamaz.
    expect(await world.repos.locks.acquire(key, 'worker-2', 60_000)).toBe(false);
    // Kilit sahibi kilidi uzatabilir; yanlış sahip uzatamaz.
    expect(await world.repos.locks.extend(key, 'worker-2', 60_000)).toBe(false);
    expect(await world.repos.locks.extend(key, 'worker-1', 60_000)).toBe(true);
    // Süre dolduğunda devralınabilir (worker çöktüğünde kilit kalmaz).
    world.clock.advance(120_000);
    expect(await world.repos.locks.acquire(key, 'worker-2', 60_000)).toBe(true);
    const locks = await world.repos.locks.list();
    expect(locks.filter((lock) => lock.key === key)).toHaveLength(1);
    expect(locks[0]?.owner).toBe('worker-2');
  });

  it('3) SCHEDULER_ENABLED=0 iken due görev kuyruğa alınmaz ve zaman çizelgesi kaymaz', async () => {
    const world = await makeWorld(false);
    await ensureScheduledTasks(world.repos, LOGGER, 0);
    const before = await world.repos.scheduledTasks.listAll();

    const runtime = makeRuntime(world, false);
    const result = await runtime.tick();

    expect(result.scheduler.due).toBe(0);
    expect(result.scheduler.enqueued).toBe(0);
    expect(result.scrapes.processed).toBe(0);

    const after = await world.repos.scheduledTasks.listAll();
    expect(after.map((task) => task.nextRunAt)).toEqual(before.map((task) => task.nextRunAt));
    expect(after.every((task) => task.lastRunAt === null)).toBe(true);
    // Heartbeat sürer: panel worker'ı "durdu" saymasın.
    const heartbeats = await world.repos.heartbeats.list();
    expect(heartbeats.some((beat) => beat.status === 'running' || beat.status === 'starting')).toBe(true);
  });

  it('4) güvenli sonlanma: döngü durur, kalp atışı "stopped" olur, çalışan iş kalmaz', async () => {
    const world = await makeWorld(true);
    await ensureScheduledTasks(world.repos, LOGGER, 0);
    const runtime = makeRuntime(world, true);

    const loop = runtime.run(20);
    // En az bir tik işlenene kadar bekle.
    await new Promise((resolve) => setTimeout(resolve, 120));
    runtime.requestStop();
    await loop;

    const heartbeats = await world.repos.heartbeats.list();
    expect(heartbeats.at(-1)?.status).toBe('stopped');
    const running = await world.repos.locks.list();
    expect(running.filter((lock) => lock.key.startsWith('scrape:'))).toHaveLength(0);
  });
});
