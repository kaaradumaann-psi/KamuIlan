/**
 * Kuyruk arka ucu.
 *
 * Varsayılan ("yerleşik") kuyruk veritabanındadır: ek servis gerekmez, worker
 * çökse bile iş kaybolmaz, aynı iş iki kez kuyruğa girmez (benzersiz dedupe
 * anahtarı). REDIS_URL tanımlıysa BullMQ/Redis kullanılır; bu yol yalnızca
 * yapılandırma ile etkinleşir ve canlı Redis ile doğrulanmalıdır.
 *
 * Kural: hiçbir zaman `setInterval` ile iş üretilmez ve iş durumu bellekte
 * tutulmaz; tüm durum veritabanındadır (yeniden başlatmaya dayanıklı).
 */
import type { QueueJobDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import type { Logger } from '../lib/logger';
import type { Env } from '../config/env';
import { getEnv } from '../config/env';

export const QUEUE_NAMES = {
  scrape: 'scrape',
  email: 'email',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface EnqueueOptions {
  name: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  runAt?: string;
  maxAttempts?: number;
}

export interface QueueStats {
  backend: 'builtin' | 'redis';
  counts: Record<string, number>;
  dead: number;
}

/** Yerleşik (veritabanı) kuyruk. */
export class BuiltinQueueBackend implements PullQueueBackend {
  readonly kind = 'builtin' as const;

  constructor(private readonly repos: Repos) {}

  async enqueue(queue: QueueName, options: EnqueueOptions): Promise<{ id: string; created: boolean }> {
    const result = await this.repos.queue.enqueue({
      queue,
      name: options.name,
      dedupeKey: options.dedupeKey,
      payload: options.payload,
      ...(options.runAt ? { runAt: options.runAt } : {}),
      ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    });
    return { id: result.job.id, created: result.created };
  }

  async claim(queue: QueueName, workerId: string, limit: number, leaseMs: number): Promise<QueueJobDoc[]> {
    return this.repos.queue.claim(queue, workerId, limit, leaseMs);
  }

  async complete(id: string): Promise<void> {
    await this.repos.queue.complete(id);
  }

  async fail(id: string, error: string, retryAt: string | null): Promise<void> {
    await this.repos.queue.fail(id, error, retryAt);
  }

  async stats(): Promise<QueueStats> {
    const counts = await this.repos.queue.stats();
    const dead = await this.repos.queue.listDead(1);
    return { backend: 'builtin', counts, dead: counts.dead ?? dead.length };
  }

  async listDead(limit = 50): Promise<QueueJobDoc[]> {
    return this.repos.queue.listDead(limit);
  }

  async requeue(id: string): Promise<QueueJobDoc | null> {
    return this.repos.queue.requeue(id);
  }

  async close(): Promise<void> {
    // Yerleşik kuyrukta kapatılacak bağlantı yok.
  }
}

/**
 * BullMQ/Redis kuyruğu (isteğe bağlı).
 *
 * BullMQ işleri kendisi çeker (push modeli); bu yüzden `startWorker` ile bir
 * işleyici bağlanır. Yerleşik kuyrukla aynı garantiler Redis tarafında `jobId`
 * (dedupe) ve `attempts`/`backoff` ayarlarıyla sağlanır.
 *
 * NOT: Bu yol yalnızca `REDIS_URL` tanımlıysa ve Redis erişilebilirse çalışır.
 * Sandbox/geliştirme ortamında Redis yoksa yerleşik kuyruk kullanılır.
 */
import type * as BullMqModuleNs from 'bullmq';
type BullMqModule = typeof BullMqModuleNs;
type BullQueue = InstanceType<BullMqModule['Queue']>;
/** Kapatılabilir olması yeterli: BullMQ Worker jenerikleri sürümle değişebiliyor. */
type ClosableWorker = { close(): Promise<void> };

export class RedisQueueBackend implements PushQueueBackend {
  readonly kind = 'redis' as const;
  private readonly queue: BullQueue;
  private readonly workers: ClosableWorker[] = [];

  constructor(
    private readonly bullmq: BullMqModule,
    private readonly redisUrl: string,
    private readonly namespace: string,
    private readonly logger: Logger,
  ) {
    this.queue = new bullmq.Queue(`${namespace}:jobs`, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        removeOnComplete: { age: 3_600, count: 5_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    });
  }

  async enqueue(queue: QueueName, options: EnqueueOptions): Promise<{ id: string; created: boolean }> {
    const job = await this.queue.add(queue, { ...options.payload }, {
      jobId: options.dedupeKey,
      ...(options.runAt ? { delay: Math.max(0, Date.parse(options.runAt) - Date.now()) } : {}),
      ...(options.maxAttempts ? { attempts: options.maxAttempts } : {}),
    });
    return { id: String(job.id), created: true };
  }

  /** Push modeli: işleyici bir Redis worker'ına bağlanır. */
  startWorker(
    queueName: QueueName,
    handler: (job: QueueJobPayload) => Promise<void>,
    concurrency = 2,
  ): void {
    const { Worker } = this.bullmq;
    const worker = new Worker(
      `${this.namespace}:jobs`,
      async (job) => {
        if (job.name !== queueName) return;
        await handler({
          id: String(job.id),
          payload: (job.data ?? {}) as Record<string, unknown>,
          attempts: job.attemptsMade + 1,
        });
      },
      { connection: { url: this.redisUrl }, concurrency },
    );
    worker.on('failed', (job, error) => {
      this.logger.error({ err: error.message, jobId: job?.id }, 'redis kuyruğunda iş başarısız');
    });
    this.workers.push(worker);
  }

  async stats(): Promise<QueueStats> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return { backend: 'redis', counts, dead: counts['failed'] ?? 0 };
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.queue.close();
  }
}

/**
 * Çekmeli (pull) arka uç: worker işi kendisi talep eder (yerleşik kuyruk).
 * İtmeli (push) arka uç: işleyici doğrudan kuyruğa bağlanır (Redis/BullMQ).
 */
export interface PullQueueBackend {
  readonly kind: 'builtin';
  enqueue(queue: QueueName, options: EnqueueOptions): Promise<{ id: string; created: boolean }>;
  claim(queue: QueueName, workerId: string, limit: number, leaseMs: number): Promise<QueueJobDoc[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string, retryAt: string | null): Promise<void>;
  stats(): Promise<QueueStats>;
  listDead(limit?: number): Promise<QueueJobDoc[]>;
  requeue(id: string): Promise<QueueJobDoc | null>;
  close(): Promise<void>;
}

export interface PushQueueBackend {
  readonly kind: 'redis';
  enqueue(queue: QueueName, options: EnqueueOptions): Promise<{ id: string; created: boolean }>;
  startWorker(
    queueName: QueueName,
    handler: (job: QueueJobPayload) => Promise<void>,
    concurrency?: number,
  ): void;
  stats(): Promise<QueueStats>;
  close(): Promise<void>;
}

export interface QueueJobPayload {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type QueueBackend = PullQueueBackend | PushQueueBackend;

/**
 * Kuyruk arka ucunu seçer. Redis yapılandırılmışsa ve bağlantı kurulabiliyorsa
 * Redis; aksi halde yerleşik kuyruk kullanılır ve bu durum LOG'a yazılır
 * (sessizce yanlış arka uca düşülmez).
 */
export async function createQueueBackend(
  repos: Repos,
  logger: Logger,
  env: Env = getEnv(),
): Promise<QueueBackend> {
  if (env.REDIS_URL) {
    try {
      const bullmq = await import('bullmq');
      logger.info({ namespace: env.WORKER_NAMESPACE }, 'Redis kuyruğu kullanılıyor (BullMQ)');
      return new RedisQueueBackend(bullmq, env.REDIS_URL, env.WORKER_NAMESPACE, logger);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Redis kuyruğu kurulamadı; yerleşik veritabanı kuyruğuna dönülüyor',
      );
    }
  }
  logger.info({}, 'yerleşik veritabanı kuyruğu kullanılıyor (Redis tanımlı değil)');
  return new BuiltinQueueBackend(repos);
}
