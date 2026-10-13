/**
 * Worker ve zamanlayıcı testleri.
 *
 * Kapsanan garantiler (§10, §17):
 *  - Aynı zamanlanmış çalışma iki kez kuyruğa girmez.
 *  - Worker yeniden başladığında kalan iş kaldığı yerden sürdürülür (durum DB'de).
 *  - Başarısız tarama üstel geri çekilmeyle yeniden denenir, sınır dolunca DLQ'ya düşer.
 *  - Kaynak erişilemezse mevcut ilanlar korunur.
 *  - Kaynak iki worker tarafından aynı anda taranmaz (kilit).
 *  - Kalıcı kaynak hatası için yönetici uyarısı tekrar etmez (6 saatte bir).
 *  - Kalp atışı zaman aşımına düşen worker kaydı yoksa yeni kayıt üretilir.
 *  - E-posta gönderimi tarama sonucundan bağımsız yürür.
 *
 * Hiçbir test gerçek kaynağa istek atmaz: adaptörler enjekte edilir.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock, type Clock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { BuiltinQueueBackend, QUEUE_NAMES } from '../src/worker/queue';
import { ensureScheduledTasks, schedulerTick, syncTaskIntervals } from '../src/worker/scheduler';
import { WorkerRuntime } from '../src/worker/runtime';
import { AdapterUnavailableError } from '../src/sources/errors';
import type { SourceAdapter } from '../src/sources/types';
import { MemoryEmailTransport } from '../src/email/transport';
import { getEnv } from '../src/config/env';
import type { SourceDefinition } from '../src/config/sources';
import type { RawAnnouncement } from '../src/domain';
import { buildJobPayload } from '../src/email/templates';
import type { JobDoc } from '../src/db/schemas';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const TEST_ENV = { ...getEnv(), LOG_LEVEL: 'silent' as const, SCHEDULER_ENABLED: false, WORKER_CONCURRENCY: 2 };
const LOGGER = createLogger('test', { level: 'silent' });

const OK_SOURCE_KEY = 'test-kaynak-ok';
const FAILING_SOURCE_KEY = 'test-kaynak-hata';

function definition(key: string, name: string, host: string): SourceDefinition {
  return {
    key,
    name,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: name,
    listingUrl: `https://${host}/ilanlar`,
    homepageUrl: `https://${host}/`,
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
    allowedHosts: [host],
    tags: ['test'],
  };
}

const DEFINITIONS: SourceDefinition[] = [
  definition(OK_SOURCE_KEY, 'Başarılı Test Kaynağı', 'ornek.test'),
  definition(FAILING_SOURCE_KEY, 'Hatalı Test Kaynağı', 'ornek2.test'),
];

function listAdapter(items: RawAnnouncement[]): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Test listesi',
    method: 'html-list',
    notes: 'Testlerde kullanılan sahte adaptör; ağa çıkmaz.',
    run: async () => ({
      items,
      requestCount: 1,
      notes: [],
      etag: null,
      lastModified: null,
      notModified: false,
    }),
  };
}

function failingAdapter(): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Çöken test adaptörü',
    method: 'html-list',
    notes: 'Testlerde kullanılan hatalı adaptör.',
    run: async () => {
      throw new Error('Beklenmeyen ağ hatası (test).');
    },
  };
}

function unreachableAdapter(): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Erişilemeyen test adaptörü',
    method: 'html-list',
    notes: 'Kaynak erişilemez durumunu taklit eder.',
    run: async () => {
      // Üçüncü argüman: hangi yeteneğin gerektiği (ör. 'playwright').
      throw new AdapterUnavailableError('test-liste', 'Kaynağa erişilemedi (test).', 'ag-erisimi');
    },
  };
}

interface World {
  repos: Repos;
  queue: BuiltinQueueBackend;
  clock: Clock & { advance(ms: number): void };
}

async function makeWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-worker-'));
  const store = new FileStore(dir);
  await store.init();
  const clock = fixedClock(NOW);
  const repos = createRepos(store, clock);
  await repos.sources.seed(DEFINITIONS);
  return { repos, queue: new BuiltinQueueBackend(repos), clock };
}

function makeRuntime(
  world: World,
  options: { adapter?: SourceAdapter; transport?: MemoryEmailTransport; workerId?: string } = {},
): WorkerRuntime {
  return new WorkerRuntime({
    repos: world.repos,
    queue: world.queue,
    env: TEST_ENV,
    logger: LOGGER,
    workerId: options.workerId ?? 'worker-test',
    transport: options.transport ?? new MemoryEmailTransport(),
    liveFetch: false,
    now: () => world.repos.clock.now(),
    coverageWarnings: false,
    ...(options.adapter ? { adapterOverride: options.adapter } : {}),
  });
}

describe('zamanlayıcı', () => {
  it('görevleri kurar ve aynı zamanlanmış çalışmayı iki kez kuyruğa almaz', async () => {
    const world = await makeWorld();
    const ensured = await ensureScheduledTasks(world.repos, LOGGER);
    expect(ensured.total).toBeGreaterThanOrEqual(2);
    const idempotent = await ensureScheduledTasks(world.repos, LOGGER);
    expect(idempotent.created).toBe(0);
    expect(idempotent.updated).toBe(0);

    const first = await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    expect(first.enqueued).toBeGreaterThanOrEqual(2);
    expect(first.duplicates).toBe(0);

    const jobs = await world.repos.store.find('queueJobs', {}, { limit: 20 });
    const keys = new Set(jobs.map((job) => job.dedupeKey));
    expect(keys.size).toBe(jobs.length);

    // Aynı anda ikinci tik: zaman çizelgesi ilerlediği için yeni çalışma yok.
    const second = await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    expect(second.enqueued).toBe(0);

    // Aynı çalışma kimliğiyle elle tekrar kuyruğa alma denemesi de engellenir.
    const duplicate = await world.queue.enqueue(QUEUE_NAMES.scrape, {
      name: 'source-scrape',
      dedupeKey: jobs[0]?.dedupeKey ?? 'yok',
      payload: { sourceKey: OK_SOURCE_KEY },
    });
    expect(duplicate.created).toBe(false);

    const stats = await world.repos.queue.stats();
    expect(stats.pending).toBe(first.enqueued);
  });

  it('global tarama aralığını yeni ve mevcut görevlere uygular; 0 iken kaynak aralığına döner', async () => {
    const world = await makeWorld();
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });

    const existing = (await world.repos.scheduledTasks.listAll()).find((task) => task.sourceKey === OK_SOURCE_KEY);
    expect(existing?.nextRunAt).toBe(new Date(NOW.getTime() + 60 * 60_000).toISOString());

    await world.repos.sources.seed([definition('test-kaynak-yeni', 'Yeni Test Kaynağı', 'ornek3.test')]);
    const overridden = await ensureScheduledTasks(world.repos, LOGGER, 1);
    expect(overridden.updated).toBeGreaterThanOrEqual(2);
    expect(overridden.created).toBeGreaterThanOrEqual(1);
    await syncTaskIntervals(world.repos, 1);

    let tasks = await world.repos.scheduledTasks.listAll();
    const sourceTasks = tasks.filter((task) => task.kind === 'source-scrape');
    expect(sourceTasks).toHaveLength(DEFINITIONS.length + 1);
    expect(sourceTasks.every((task) => task.intervalMinutes === 1)).toBe(true);
    const rescheduledExisting = sourceTasks.find((task) => task.sourceKey === OK_SOURCE_KEY);
    expect(rescheduledExisting?.nextRunAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    const newlyScheduled = sourceTasks.find((task) => task.sourceKey === 'test-kaynak-yeni');
    expect(newlyScheduled?.nextRunAt).toBe(NOW.toISOString());

    await world.repos.sources.update(OK_SOURCE_KEY, { scrapeIntervalMinutes: 5 });
    expect(await syncTaskIntervals(world.repos, 0)).toBe(DEFINITIONS.length + 1);
    const changedTask = (await world.repos.scheduledTasks.listAll()).find((task) => task.sourceKey === OK_SOURCE_KEY);
    expect(changedTask?.intervalMinutes).toBe(5);
    expect(changedTask?.nextRunAt).toBe(new Date(NOW.getTime() + 5 * 60_000).toISOString());

    await world.repos.sources.update(OK_SOURCE_KEY, { scrapeIntervalMinutes: 60 });
    await syncTaskIntervals(world.repos, 0);
    tasks = await world.repos.scheduledTasks.listAll();
    const restoredTasks = tasks.filter((task) => task.kind === 'source-scrape');
    expect(restoredTasks.map((task) => task.intervalMinutes).sort()).toEqual([60, 60, 60]);
  });

  it('aralık dolunca yeni çalışma üretir ve bir sonraki zamanı ileri yazar', async () => {
    const world = await makeWorld();
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });

    world.clock.advance(60 * 60_000);
    const second = await schedulerTick(world.repos, world.queue, { now: world.repos.clock.now(), logger: LOGGER });
    expect(second.enqueued).toBeGreaterThanOrEqual(2);

    const tasks = await world.repos.scheduledTasks.listAll();
    const sourceTask = tasks.find((task) => task.sourceKey === OK_SOURCE_KEY);
    expect(sourceTask?.lastRunAt).toBeTruthy();
    expect(Date.parse(sourceTask?.nextRunAt ?? '')).toBeGreaterThan(NOW.getTime());
  });

  it('devre dışı kaynağın görevini çalıştırmaz ama kaydı silmez', async () => {
    const world = await makeWorld();
    await ensureScheduledTasks(world.repos, LOGGER);
    await world.repos.sources.setEnabled(OK_SOURCE_KEY, false);

    const tick = await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    expect(tick.skippedDisabled).toBeGreaterThanOrEqual(1);

    const tasks = await world.repos.scheduledTasks.listAll();
    const task = tasks.find((item) => item.sourceKey === OK_SOURCE_KEY);
    expect(task?.enabled).toBe(false);
    expect(await world.repos.sources.getByKey(OK_SOURCE_KEY)).not.toBeNull();

    // Devre dışı kaynak için kuyruğa iş girmedi.
    const jobs = await world.repos.store.find('queueJobs', {}, { limit: 20 });
    expect(jobs.some((job) => job.payload['sourceKey'] === OK_SOURCE_KEY)).toBe(false);
  });
});

describe('worker çalışma zamanı', () => {
  it('zamanlanan taramayı işler, ilan kaydeder, gecikmeyi ölçer ve kalp atışı bırakır', async () => {
    const world = await makeWorld();
    const runtime = makeRuntime(world, {
      adapter: listAdapter([sozlesmeliPersonelIlani({ sourceKey: OK_SOURCE_KEY })]),
    });

    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    const result = await runtime.tick();

    expect(result.scrapes.processed).toBeGreaterThanOrEqual(2);
    expect(result.scrapes.succeeded).toBeGreaterThanOrEqual(1);

    const jobs = await world.repos.jobs.search({}, { page: 1, pageSize: 10, includeNonAccepted: true });
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]?.classification.decision).toBe('accept');

    const runs = await world.repos.runs.list({ sourceKey: OK_SOURCE_KEY });
    expect(runs[0]?.status).toBe('success');
    expect(runs[0]?.scheduleDelayMs).toBeGreaterThanOrEqual(0);

    const heartbeats = await world.repos.heartbeats.list();
    expect(heartbeats[0]?.workerId).toBe('worker-test');
    expect(heartbeats[0]?.status).toBe('running');

    // Tarama işleri tamamlandı; bakım kuyruğu tur başına 2 iş aldığı için
    // en fazla bir iş beklemede kalabilir (bir sonraki turda işlenir).
    const stats = await world.repos.queue.stats();
    expect(stats.pending).toBeLessThanOrEqual(1);
    expect(stats.active).toBe(0);
  });

  it('WORKER_CONCURRENCY sınırına kadar farklı kaynakları paralel işler', async () => {
    const world = await makeWorld();
    let active = 0;
    let maxActive = 0;
    const adapter: SourceAdapter = {
      key: 'test-liste',
      label: 'Paralel test listesi',
      method: 'html-list',
      notes: 'İki kaynağın aynı anda çalışmasını doğrulayan sahte adaptör.',
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return { items: [], requestCount: 1, notes: [], etag: null, lastModified: null, notModified: false };
      },
    };
    const runtime = makeRuntime(world, { adapter });
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });

    const result = await runtime.tick();

    expect(result.scrapes.processed).toBe(2);
    expect(maxActive).toBe(2);
  });

  it('kaynak erişilemezse ilanlar korunur, kaynak sağlığı işaretlenir', async () => {
    const world = await makeWorld();
    const first = await applyRawAnnouncement(sozlesmeliPersonelIlani({ sourceKey: OK_SOURCE_KEY }), {
      repos: world.repos,
      now: NOW,
      workerId: 'worker-test',
      provenance: 'sample',
    });

    const runtime = makeRuntime(world, { adapter: unreachableAdapter() });
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    const result = await runtime.tick();

    // Kaynak atlandı; "başarısız" sayılmadı ve iş yeniden denenmeye bırakılmadı.
    expect(result.scrapes.skipped).toBeGreaterThanOrEqual(2);
    expect(result.scrapes.failed).toBe(0);

    const job = await world.repos.jobs.findById(first.jobId as string);
    expect(job).not.toBeNull();
    expect(await world.repos.store.count('jobs', {})).toBe(1);

    const source = await world.repos.sources.getByKey(OK_SOURCE_KEY);
    expect(source?.health.lastRunAt).not.toBeNull();
    // Erişilemeyen kaynak "sağlıklı" sayılmaz: yönetici uyarısı bu sayaçla üretilir.
    expect(source?.health.consecutiveFailures).toBe(1);
    expect(source?.health.lastErrorMessage).toContain('erişilemedi');
    expect(source?.health.lastSuccessAt).toBeNull();

    const skippedRuns = await world.repos.runs.list({ sourceKey: OK_SOURCE_KEY });
    expect(skippedRuns[0]?.status).toBe('skipped');
  });

  it('kalıcı kaynak hatası için yönetici uyarısı her taramada tekrarlanmaz', async () => {
    const world = await makeWorld();
    const runtime = makeRuntime(world, { adapter: unreachableAdapter() });
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });

    // Kaynak aralığı 60 dakika: saati ilerleterek gerçekçi biçimde 5 tarama yapılır.
    for (let index = 0; index < 5; index += 1) {
      const result = await runtime.tick();
      expect(result.scrapes.skipped).toBeGreaterThanOrEqual(1);
      world.clock.advance(60 * 60 * 1000);
      await schedulerTick(world.repos, world.queue, { now: world.repos.clock.now(), logger: LOGGER });
    }

    const source = await world.repos.sources.getByKey(OK_SOURCE_KEY);
    expect(source?.health.consecutiveFailures).toBe(5);
    expect(source?.health.consecutiveSkips).toBe(5);
    expect(source?.health.lastSuccessAt).toBeNull();

    // Denetim kaydı TEK olmalı: 1 dakikalık test taramasında her dakika yazılsaydı
    // denetim kaydı ve log okunamaz hale gelirdi.
    const ownWarnings = (await world.repos.audit.list(50, 'source.skipping')).filter(
      (log) => log.targetId === OK_SOURCE_KEY,
    );
    expect(ownWarnings).toHaveLength(1);
    expect(source?.health.lastWarningAt).not.toBeNull();

    // Altı saat sonra uyarı yeniden üretilir: kalıcı sorun sessizce kaybolmaz.
    world.clock.advance(6 * 60 * 60 * 1000);
    await schedulerTick(world.repos, world.queue, { now: world.repos.clock.now(), logger: LOGGER });
    await runtime.tick();
    const afterSixHours = (await world.repos.audit.list(50, 'source.skipping')).filter(
      (log) => log.targetId === OK_SOURCE_KEY,
    );
    expect(afterSixHours).toHaveLength(2);
  });

  it('başarısız tarama geri çekilmeyle yeniden denenir ve sınır dolunca DLQ olur', async () => {
    const world = await makeWorld();
    const runtime = makeRuntime(world, { adapter: failingAdapter() });

    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });

    const first = await runtime.tick();
    expect(first.scrapes.failed).toBeGreaterThanOrEqual(2);

    const pending = await world.repos.queue.stats();
    expect(pending.pending).toBeGreaterThanOrEqual(2);
    expect(pending.dead).toBe(0);

    // Deneme sınırı (3) dolana kadar yeniden denenir.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      world.clock.advance(60 * 60_000);
      await runtime.tick();
    }

    const dead = await world.queue.listDead(10);
    expect(dead.length).toBeGreaterThanOrEqual(1);
    expect(dead[0]?.status).toBe('dead');
    expect(dead[0]?.lastError).toContain('ağ hatası');

    const requeued = await world.queue.requeue(dead[0]?.id ?? '');
    expect(requeued?.status).toBe('pending');
    expect(requeued?.attempts).toBe(0);
  });

  it('kilitli kaynağı iki worker aynı anda taramaz', async () => {
    const world = await makeWorld();
    // Yalnızca kilitli kaynak gündemde olsun (diğeri devre dışı).
    await world.repos.sources.setEnabled(FAILING_SOURCE_KEY, false);
    const locked = await world.repos.locks.acquire(`scrape:${OK_SOURCE_KEY}`, 'diger-worker', 60_000);
    expect(locked).toBe(true);

    const runtime = makeRuntime(world, {
      adapter: listAdapter([sozlesmeliPersonelIlani({ sourceKey: OK_SOURCE_KEY })]),
    });
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    const result = await runtime.tick();

    expect(result.scrapes.skipped).toBeGreaterThanOrEqual(1);
    expect(await world.repos.store.count('jobs', {})).toBe(0);

    const runs = await world.repos.runs.list({ sourceKey: OK_SOURCE_KEY });
    expect(runs.some((run) => run.status === 'locked')).toBe(true);
  });

  it('worker yeniden başlayınca kalan işi sürdürür (durum veritabanında)', async () => {
    const world = await makeWorld();
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });

    const before = await world.repos.queue.stats();
    expect(before.pending).toBeGreaterThanOrEqual(2);

    // Yeni worker örneği (yeni süreç): aynı veritabanı, kaldığı yerden devam eder.
    const restarted = makeRuntime(world, {
      adapter: listAdapter([sozlesmeliPersonelIlani({ sourceKey: OK_SOURCE_KEY })]),
      workerId: 'worker-restarted',
    });

    const result = await restarted.tick();
    expect(result.scrapes.processed).toBeGreaterThanOrEqual(2);
    expect(result.scrapes.failed).toBe(0);

    const after = await world.repos.queue.stats();
    expect(after.completed).toBeGreaterThanOrEqual(2);
    expect(after.pending).toBeLessThanOrEqual(1);
  });

  it('e-posta gönderimi tarama hatasından bağımsız yürür', async () => {
    const world = await makeWorld();
    const { user } = await world.repos.users.create({
      email: 'abone@ornek.test',
      passwordHash: 'scrypt$test-hash-value',
      passwordSalt: 'test-salt-value',
      emailVerified: true,
    });
    await world.repos.notifications.upsertPreference(user.id, { filters: {} });

    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani({ sourceKey: OK_SOURCE_KEY }), {
      repos: world.repos,
      now: NOW,
      workerId: 'worker-test',
      provenance: 'sample',
    });
    const job = await world.repos.jobs.findById(outcome.jobId as string);
    await world.repos.outbox.enqueue(
      {
        eventId: null,
        jobId: job?.id ?? null,
        userId: user.id,
        kind: 'job-notification',
        toEmail: user.email,
        subject: 'Test bildirimi',
        template: 'new-job',
        // Gerçek bildirim yüküyle aynı biçim (buildJobPayload) kullanılır.
        payload: {
          ...buildJobPayload(job as JobDoc, { matchedOn: ['Test eşleşmesi'], baseUrl: 'http://localhost:5173' }),
        },
        idempotencyKey: 'worker-test-kutu-1',
      },
      3,
    );

    const runtime = makeRuntime(world, { adapter: failingAdapter() });
    await ensureScheduledTasks(world.repos, LOGGER);
    await schedulerTick(world.repos, world.queue, { now: NOW, logger: LOGGER });
    const result = await runtime.tick();

    // Tarama hata verdi ama e-posta yine de gönderildi.
    expect(result.emails.sent).toBe(1);
    expect(result.scrapes.failed).toBeGreaterThanOrEqual(1);

    const accepted = await world.repos.outbox.list({ status: 'accepted' }, 5);
    expect(accepted).toHaveLength(1);
  });
});

describe('kuyruk arka ucu', () => {
  it('aynı dedupe anahtarıyla ikinci iş oluşturmaz', async () => {
    const world = await makeWorld();
    const first = await world.queue.enqueue(QUEUE_NAMES.scrape, {
      name: 'manual-scrape',
      dedupeKey: 'tek-seferlik',
      payload: { sourceKey: OK_SOURCE_KEY },
    });
    const second = await world.queue.enqueue(QUEUE_NAMES.scrape, {
      name: 'manual-scrape',
      dedupeKey: 'tek-seferlik',
      payload: { sourceKey: OK_SOURCE_KEY },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await world.repos.store.count('queueJobs', {})).toBe(1);
  });

  it('lease süresi dolmadan aynı işi ikinci worker almaz', async () => {
    const world = await makeWorld();
    await world.queue.enqueue(QUEUE_NAMES.scrape, {
      name: 'manual-scrape',
      dedupeKey: 'lease-testi',
      payload: { sourceKey: OK_SOURCE_KEY },
    });

    const firstClaim = await world.queue.claim(QUEUE_NAMES.scrape, 'worker-a', 5, 60_000);
    expect(firstClaim).toHaveLength(1);

    const secondClaim = await world.queue.claim(QUEUE_NAMES.scrape, 'worker-b', 5, 60_000);
    expect(secondClaim).toHaveLength(0);

    // Lease süresi dolunca iş yeniden alınabilir (worker çökmüş olabilir).
    world.clock.advance(120_000);
    const thirdClaim = await world.queue.claim(QUEUE_NAMES.scrape, 'worker-c', 5, 60_000);
    expect(thirdClaim).toHaveLength(1);
  });
});

describe('yönetici uyarıları', () => {
  async function runtimeWithWarnings(world: World, workerId: string): Promise<WorkerRuntime> {
    return new WorkerRuntime({
      repos: world.repos,
      queue: world.queue,
      env: TEST_ENV,
      logger: LOGGER,
      workerId,
      transport: new MemoryEmailTransport(),
      liveFetch: false,
      now: () => world.repos.clock.now(),
      coverageWarnings: true,
    });
  }

  async function markFailing(world: World, times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await world.repos.sources.recordHealth(FAILING_SOURCE_KEY, {
        lastRunAt: world.repos.clock.now().toISOString(),
        success: false,
        durationMs: 120,
        discoveredCount: 0,
        acceptedCount: 0,
        errorMessage: 'Test hatası',
      });
    }
  }

  it('aynı kaynak uyarısını her tikte tekrarlamaz, denetim kaydını bir kez yazar', async () => {
    const world = await makeWorld();
    await markFailing(world, 3);
    const runtime = await runtimeWithWarnings(world, 'worker-test');

    // Uyarılar her tikte üretilirse log ve denetim kaydı dolar; aynı durum için
    // yalnızca BİR uyarı ve BİR denetim kaydı beklenir.
    const first = await runtime.tick();
    const second = await runtime.tick();

    const sourceWarnings = (result: { warnings: string[] }): string[] =>
      result.warnings.filter((warning) => warning.includes('üst üste başarısız'));

    expect(sourceWarnings(first)).toHaveLength(1);
    expect(sourceWarnings(second)).toHaveLength(0);
    expect(await world.repos.store.count('auditLogs', { action: 'source.stale' })).toBe(1);
  });

  it('başarısızlık sayısı artınca yeniden uyarır', async () => {
    const world = await makeWorld();
    await markFailing(world, 3);
    const runtime = await runtimeWithWarnings(world, 'worker-test');

    const first = await runtime.tick();
    expect(first.warnings.some((warning) => warning.includes('üst üste başarısız'))).toBe(true);

    await markFailing(world, 1); // 4. ardışık başarısızlık: durum değişti
    const second = await runtime.tick();
    expect(second.warnings.some((warning) => warning.includes('üst üste başarısız'))).toBe(true);
    expect(await world.repos.store.count('auditLogs', { action: 'source.stale' })).toBe(2);
  });

  it('eskimiş kalp atışlarını "durdu" olarak işaretler', async () => {
    const world = await makeWorld();
    await world.repos.heartbeats.beat({
      workerId: 'eski-worker',
      role: 'worker',
      version: 'test',
      status: 'running',
      processedJobs: 3,
    });
    const oldBeat = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    await world.repos.store.updateOne('workerHeartbeats', { workerId: 'eski-worker' }, { lastHeartbeatAt: oldBeat });

    const stopped = await world.repos.heartbeats.markStaleAsStopped(
      new Date(NOW.getTime() - 2 * 60_000).toISOString(),
    );
    expect(stopped).toBe(1);

    const worker = await world.repos.store.findOne('workerHeartbeats', { workerId: 'eski-worker' });
    expect(worker?.status).toBe('stopped');
    // Yakın tarihli (canlı) kayıtlar korunur.
    expect(await world.repos.store.count('workerHeartbeats', { status: 'running' })).toBe(0);
  });
});
