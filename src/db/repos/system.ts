/**
 * Sistem altyapısı depoları: dağıtık kilit, hız sınırlama, zamanlanmış görevler,
 * yerleşik kuyruk (Redis yoksa), worker heartbeat, denetim kaydı, kaydedilen ilanlar.
 */
import { createId, sha256Hex } from '../../domain/ids';
import { addMilliseconds, type Clock, systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type {
  AuditLogDoc,
  LockDoc,
  QueueJobDoc,
  RateLimitDoc,
  SavedJobDoc,
  ScheduledTaskDoc,
  WorkerHeartbeatDoc,
} from '../schemas';
import { validateDocument } from '../validate';

/** Dağıtık kilit: aynı kaynağın iki kez taranmasını engeller. */
export class LockRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const doc: LockDoc = {
      id: createId('lck'),
      key,
      owner,
      acquiredAt: now.toISOString(),
      expiresAt,
    };
    const result = await this.store.insertIfAbsent('locks', doc);
    if (result.inserted) return true;
    // Süresi geçmiş kilidi devral (koşullu güncelleme: yalnızca süresi dolmuşsa).
    const takenOver = await this.store.updateOne(
      'locks',
      { key, expiresAt: { $lt: now.toISOString() } },
      { owner, acquiredAt: now.toISOString(), expiresAt },
    );
    return Boolean(takenOver);
  }

  async release(key: string, owner: string): Promise<boolean> {
    return this.store.deleteOne('locks', { key, owner });
  }

  async list(): Promise<LockDoc[]> {
    return this.store.find('locks', {}, { limit: 500 });
  }
}

/** Basit sabit pencere hız sınırlayıcı (API ve scraping istekleri için). */
export class RateLimitRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async hit(bucket: string, windowSeconds: number): Promise<{ count: number; windowStart: string; resetAt: string }> {
    const now = this.clock.now();
    const windowMs = windowSeconds * 1_000;
    const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
    const windowStart = new Date(windowStartMs).toISOString();
    const doc: RateLimitDoc = {
      id: createId('rlm'),
      bucket,
      windowStart,
      count: 0,
    };
    const existing = await this.store.insertIfAbsent('rateLimits', doc);
    const updated = await this.store.updateOne('rateLimits', { id: existing.document.id }, {
      count: existing.document.count + 1,
    });
    return {
      count: updated?.count ?? existing.document.count + 1,
      windowStart,
      resetAt: new Date(windowStartMs + windowMs).toISOString(),
    };
  }

  async purgeOlderThan(iso: string): Promise<number> {
    return this.store.deleteMany('rateLimits', { windowStart: { $lt: iso } });
  }
}

/** Zamanlanmış görevler: her kaynak için bir sonraki tarama zamanı kalıcıdır. */
export class ScheduledTaskRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async ensure(input: {
    kind: ScheduledTaskDoc['kind'];
    sourceKey: string;
    intervalMinutes: number;
    nextRunAt?: string;
  }): Promise<ScheduledTaskDoc> {
    const now = this.clock.now().toISOString();
    const doc: ScheduledTaskDoc = {
      id: createId('tsk'),
      kind: input.kind,
      sourceKey: input.sourceKey,
      intervalMinutes: input.intervalMinutes,
      enabled: true,
      nextRunAt: input.nextRunAt ?? now,
      lastRunAt: null,
      lastEnqueuedRunId: null,
      lastDequeuedAt: null,
      misses: 0,
      updatedAt: now,
    };
    validateDocument('scheduledTasks', doc);
    const result = await this.store.upsertOne(
      'scheduledTasks',
      { kind: input.kind, sourceKey: input.sourceKey },
      doc,
      { intervalMinutes: input.intervalMinutes, updatedAt: now },
    );
    return result.document;
  }

  async listDue(nowIso: string, limit = 50): Promise<ScheduledTaskDoc[]> {
    return this.store.find(
      'scheduledTasks',
      { enabled: true, nextRunAt: { $lte: nowIso } },
      { limit, sort: [['nextRunAt', 1]] },
    );
  }

  async listAll(): Promise<ScheduledTaskDoc[]> {
    return this.store.find('scheduledTasks', {}, { limit: 500, sort: [['sourceKey', 1]] });
  }

  /** Görev enqueue edildikten sonra bir sonraki çalışma zamanını ilerletir. */
  async markEnqueued(
    id: string,
    run: { runId: string; intervalMinutes: number; dequeuedAt?: string | null; misses?: number },
  ): Promise<void> {
    const now = this.clock.now();
    await this.store.updateOne('scheduledTasks', { id }, {
      lastRunAt: now.toISOString(),
      lastEnqueuedRunId: run.runId,
      lastDequeuedAt: run.dequeuedAt ?? null,
      misses: run.misses ?? 0,
      nextRunAt: addMilliseconds(now.toISOString(), run.intervalMinutes * 60_000),
      updatedAt: now.toISOString(),
    });
  }

  async setInterval(id: string, intervalMinutes: number): Promise<void> {
    await this.store.updateOne('scheduledTasks', { id }, {
      intervalMinutes,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.store.updateOne('scheduledTasks', { id }, {
      enabled,
      updatedAt: this.clock.now().toISOString(),
    });
  }
}

/**
 * Yerleşik kalıcı kuyruk (Redis yoksa).
 * Redis + BullMQ varsa aynı sözleşme BullMQ adaptörüyle karşılanır.
 */
export class BuiltinQueueRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async enqueue(input: {
    queue: string;
    name: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    runAt?: string;
    maxAttempts?: number;
  }): Promise<{ job: QueueJobDoc; created: boolean }> {
    const now = this.clock.now().toISOString();
    const doc: QueueJobDoc = {
      id: createId('qjb'),
      queue: input.queue,
      name: input.name,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      runAt: input.runAt ?? now,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    validateDocument('queueJobs', doc);
    const result = await this.store.insertIfAbsent('queueJobs', doc);
    return { job: result.document, created: result.inserted };
  }

  async claim(queue: string, workerId: string, limit = 5, leaseMs = 300_000): Promise<QueueJobDoc[]> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const candidates = await this.store.find(
      'queueJobs',
      { queue, status: { $in: ['pending', 'active'] }, runAt: { $lte: nowIso } },
      { limit: limit * 4, sort: [['runAt', 1]] },
    );
    const claimed: QueueJobDoc[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      if (candidate.status === 'active' && candidate.lockedUntil && new Date(candidate.lockedUntil).getTime() > now.getTime()) {
        continue;
      }
      const updated = await this.store.updateOne('queueJobs', { id: candidate.id, status: candidate.status }, {
        status: 'active',
        lockedBy: workerId,
        lockedUntil: new Date(now.getTime() + leaseMs).toISOString(),
        attempts: candidate.attempts + 1,
        updatedAt: nowIso,
      });
      if (updated) claimed.push(updated);
    }
    return claimed;
  }

  async complete(id: string): Promise<void> {
    const now = this.clock.now().toISOString();
    await this.store.updateOne('queueJobs', { id }, {
      status: 'completed',
      completedAt: now,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    });
  }

  async fail(id: string, error: string, retryAt: string | null): Promise<QueueJobDoc | null> {
    const current = await this.store.findOne('queueJobs', { id });
    if (!current) return null;
    const exhausted = current.attempts >= current.maxAttempts;
    const now = this.clock.now().toISOString();
    return this.store.updateOne('queueJobs', { id }, {
      status: retryAt && !exhausted ? 'pending' : 'dead',
      lastError: error.slice(0, 500),
      runAt: retryAt ?? now,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    });
  }

  async stats(): Promise<Record<QueueJobDoc['status'], number>> {
    const [pending, active, completed, failed, dead] = await Promise.all([
      this.store.count('queueJobs', { status: 'pending' }),
      this.store.count('queueJobs', { status: 'active' }),
      this.store.count('queueJobs', { status: 'completed' }),
      this.store.count('queueJobs', { status: 'failed' }),
      this.store.count('queueJobs', { status: 'dead' }),
    ]);
    return { pending, active, completed, failed, dead };
  }

  async listDead(limit = 50): Promise<QueueJobDoc[]> {
    return this.store.find('queueJobs', { status: 'dead' }, { limit, sort: [['updatedAt', -1]] });
  }
}

export class HeartbeatRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async beat(input: {
    workerId: string;
    role: WorkerHeartbeatDoc['role'];
    version: string;
    status: WorkerHeartbeatDoc['status'];
    processedJobs: number;
    lastError?: string | null;
  }): Promise<void> {
    const now = this.clock.now().toISOString();
    const doc: WorkerHeartbeatDoc = {
      id: createId('wrk'),
      workerId: input.workerId,
      role: input.role,
      version: input.version,
      pid: process.pid,
      host: process.env.HOSTNAME ?? 'localhost',
      startedAt: now,
      lastHeartbeatAt: now,
      status: input.status,
      processedJobs: input.processedJobs,
      lastError: input.lastError ?? null,
    };
    validateDocument('workerHeartbeats', doc);
    await this.store.upsertOne('workerHeartbeats', { workerId: input.workerId }, doc, {
      lastHeartbeatAt: now,
      status: input.status,
      processedJobs: input.processedJobs,
      lastError: input.lastError ?? null,
      pid: process.pid,
    });
  }

  async list(): Promise<WorkerHeartbeatDoc[]> {
    return this.store.find('workerHeartbeats', {}, { limit: 50, sort: [['lastHeartbeatAt', -1]] });
  }

  async listStale(thresholdIso: string): Promise<WorkerHeartbeatDoc[]> {
    return this.store.find('workerHeartbeats', { lastHeartbeatAt: { $lt: thresholdIso } }, { limit: 50 });
  }
}

export class AuditRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(input: {
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    meta?: Record<string, unknown>;
    ip?: string | null;
  }): Promise<AuditLogDoc> {
    const doc: AuditLogDoc = {
      id: createId('aud'),
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      meta: input.meta ?? {},
      ipHash: input.ip ? sha256Hex(input.ip).slice(0, 32) : null,
      createdAt: this.clock.now().toISOString(),
    };
    validateDocument('auditLogs', doc);
    await this.store.insertOne('auditLogs', doc);
    return doc;
  }

  async list(limit = 100, action?: string): Promise<AuditLogDoc[]> {
    const query: Record<string, unknown> = {};
    if (action) query.action = action;
    return this.store.find('auditLogs', query, { limit, sort: [['createdAt', -1]] });
  }
}

export class SavedJobRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async toggle(userId: string, jobId: string): Promise<{ saved: boolean }> {
    const existing = await this.store.findOne('savedJobs', { userId, jobId });
    if (existing) {
      await this.store.deleteOne('savedJobs', { userId, jobId });
      return { saved: false };
    }
    const doc: SavedJobDoc = {
      id: createId('sav'),
      userId,
      jobId,
      createdAt: this.clock.now().toISOString(),
    };
    validateDocument('savedJobs', doc);
    await this.store.insertIfAbsent('savedJobs', doc);
    return { saved: true };
  }

  async listForUser(userId: string, limit = 100): Promise<SavedJobDoc[]> {
    return this.store.find('savedJobs', { userId }, { limit, sort: [['createdAt', -1]] });
  }

  async isSaved(userId: string, jobId: string): Promise<boolean> {
    return (await this.store.findOne('savedJobs', { userId, jobId })) !== null;
  }
}
