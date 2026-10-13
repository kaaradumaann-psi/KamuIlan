/**
 * Sistem depoları: kilitler, hız sınırlama, zamanlanmış görevler, kuyruk,
 * worker kalp atışı, denetim kaydı ve kaydedilen ilanlar.
 */
import { createId, sha256Hex } from '../../domain/ids';
import { addMilliseconds } from '../../lib/clock';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
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

/**
 * Dağıtık kilit: bir kaynağın AYNI ANDA iki worker tarafından taranmasını
 * engeller. Süresi dolan kilit otomatik devralınabilir (worker çökmüş olabilir).
 */
export class LockRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const doc: LockDoc = {
      id: createId('lck'),
      key,
      owner,
      acquiredAt: nowIso,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      heartbeatAt: nowIso,
    };

    const inserted = await this.store.insertIfAbsent('locks', doc);
    if (inserted.inserted) return true;

    const existing = inserted.document;
    if (Date.parse(existing.expiresAt) > now.getTime()) return false;

    // Süresi dolmuş kilidi devral: yalnızca eski sahip değişmediyse.
    const taken = await this.store.updateOne(
      'locks',
      { id: existing.id, owner: existing.owner, expiresAt: existing.expiresAt },
      { owner, acquiredAt: nowIso, expiresAt: new Date(now.getTime() + ttlMs).toISOString(), heartbeatAt: nowIso },
    );
    return taken !== null;
  }

  async extend(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const updated = await this.store.updateOne(
      'locks',
      { key, owner },
      { expiresAt: new Date(this.clock.now().getTime() + ttlMs).toISOString(), heartbeatAt: this.clock.now().toISOString() },
    );
    return updated !== null;
  }

  async release(key: string, owner: string): Promise<boolean> {
    return this.store.deleteOne('locks', { key, owner });
  }

  async list(): Promise<LockDoc[]> {
    return this.store.find('locks', {}, { limit: 200, sort: [['acquiredAt', -1]] });
  }

  async purgeExpired(): Promise<number> {
    return this.store.deleteMany('locks', { expiresAt: { $lt: this.clock.now().toISOString() } });
  }
}

/** Basit pencere tabanlı hız sınırlama (API ve giriş denemeleri için). */
export class RateLimitRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async hit(bucket: string, windowSeconds: number): Promise<{ count: number; windowStart: string; resetAt: string }> {
    const now = this.clock.now();
    const windowStartMs = Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;
    const windowStart = new Date(windowStartMs).toISOString();
    const resetAt = new Date(windowStartMs + windowSeconds * 1000).toISOString();
    // KVKK: kova anahtarı IP/e-posta içerebilir → hash'lenir.
    const hashedBucket = sha256Hex(bucket).slice(0, 32);

    const existing = await this.store.findOne('rateLimits', { bucket: hashedBucket, windowStart });
    if (existing) {
      const updated = await this.store.updateOne('rateLimits', { id: existing.id }, { count: existing.count + 1 });
      return { count: updated?.count ?? existing.count + 1, windowStart, resetAt };
    }

    const doc: RateLimitDoc = {
      id: createId('rlm'),
      bucket: hashedBucket,
      windowStart,
      count: 1,
      expiresAt: resetAt,
    };
    validateDocument('rateLimits', doc);
    const inserted = await this.store.insertIfAbsent('rateLimits', doc);
    if (inserted.inserted) return { count: 1, windowStart, resetAt };
    const updated = await this.store.updateOne(
      'rateLimits',
      { id: inserted.document.id },
      { count: inserted.document.count + 1 },
    );
    return { count: updated?.count ?? inserted.document.count + 1, windowStart, resetAt };
  }

  async purgeOlderThan(iso: string): Promise<number> {
    return this.store.deleteMany('rateLimits', { windowStart: { $lt: iso } });
  }
}

/** Kalıcı zamanlanmış görevler (kaynak tarama, bakım, kapsam denetimi). */
export class ScheduledTaskRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Görev yoksa oluşturur; aralık değişirse nextRunAt son kuyruklanma zamanından yeniden hesaplanır. */
  async ensure(input: {
    kind: ScheduledTaskDoc['kind'];
    sourceKey: string;
    intervalMinutes: number;
    nextRunAt?: string;
  }): Promise<ScheduledTaskDoc> {
    const now = this.clock.now();
    const existing = await this.store.findOne('scheduledTasks', { kind: input.kind, sourceKey: input.sourceKey });
    if (existing) {
      const intervalChanged = existing.intervalMinutes !== input.intervalMinutes;
      const nextRunAt =
        intervalChanged && existing.lastRunAt
          ? addMilliseconds(existing.lastRunAt, input.intervalMinutes * 60_000)
          : existing.nextRunAt;
      const updated = await this.store.updateOne(
        'scheduledTasks',
        { id: existing.id },
        { intervalMinutes: input.intervalMinutes, nextRunAt, updatedAt: now.toISOString() },
      );
      return updated ?? existing;
    }

    const doc: ScheduledTaskDoc = {
      id: createId('tsk'),
      kind: input.kind,
      sourceKey: input.sourceKey,
      intervalMinutes: input.intervalMinutes,
      enabled: true,
      nextRunAt: input.nextRunAt ?? now.toISOString(),
      lastRunAt: null,
      lastEnqueuedRunId: null,
      lastDequeuedAt: null,
      misses: 0,
      updatedAt: now.toISOString(),
    };
    validateDocument('scheduledTasks', doc);
    const inserted = await this.store.insertIfAbsent('scheduledTasks', doc);
    return inserted.document;
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

  /** Kuyruğa alındıktan sonra bir sonraki çalışma zamanı ilerletilir. */
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
    const existing = await this.store.findOne('scheduledTasks', { id });
    if (!existing || existing.intervalMinutes === intervalMinutes) return;
    const now = this.clock.now();
    const nextRunAt = existing.lastRunAt
      ? addMilliseconds(existing.lastRunAt, intervalMinutes * 60_000)
      : existing.nextRunAt;
    await this.store.updateOne('scheduledTasks', { id }, {
      intervalMinutes,
      nextRunAt,
      updatedAt: now.toISOString(),
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.store.updateOne('scheduledTasks', { id }, { enabled, updatedAt: this.clock.now().toISOString() });
  }
}

/**
 * Yerleşik kalıcı kuyruk (Redis yoksa).
 * dedupeKey benzersizdir: aynı iş (ör. aynı kaynağın taraması) iki kez kuyruğa girmez.
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
      if (candidate.status === 'active' && candidate.lockedUntil && Date.parse(candidate.lockedUntil) > now.getTime()) {
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

  /** Başarısız iş: yeniden deneme zamanı verilir; deneme sınırı dolduysa `dead` (DLQ). */
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
    const statuses: QueueJobDoc['status'][] = ['pending', 'active', 'completed', 'failed', 'dead'];
    const counts = await Promise.all(statuses.map((status) => this.store.count('queueJobs', { status })));
    return statuses.reduce<Record<QueueJobDoc['status'], number>>(
      (acc, status, index) => {
        acc[status] = counts[index] ?? 0;
        return acc;
      },
      { pending: 0, active: 0, completed: 0, failed: 0, dead: 0 },
    );
  }

  async listDead(limit = 50): Promise<QueueJobDoc[]> {
    return this.store.find('queueJobs', { status: 'dead' }, { limit, sort: [['updatedAt', -1]] });
  }

  async requeue(id: string): Promise<QueueJobDoc | null> {
    const now = this.clock.now().toISOString();
    return this.store.updateOne('queueJobs', { id, status: 'dead' }, {
      status: 'pending',
      attempts: 0,
      runAt: now,
      lastError: null,
      updatedAt: now,
    });
  }
}

/** Worker kalp atışı: panelde "worker çalışıyor mu?" sorusunu yanıtlar. */
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
    const existing = await this.store.findOne('workerHeartbeats', { workerId: input.workerId });
    if (existing) {
      await this.store.updateOne('workerHeartbeats', { workerId: input.workerId }, {
        lastHeartbeatAt: now,
        status: input.status,
        processedJobs: input.processedJobs,
        lastError: input.lastError ?? null,
        pid: process.pid,
      });
      return;
    }
    const doc: WorkerHeartbeatDoc = {
      id: createId('wrk'),
      workerId: input.workerId,
      role: input.role,
      version: input.version,
      pid: process.pid,
      host: process.env['HOSTNAME'] ?? 'localhost',
      startedAt: now,
      lastHeartbeatAt: now,
      status: input.status,
      processedJobs: input.processedJobs,
      lastError: input.lastError ?? null,
    };
    validateDocument('workerHeartbeats', doc);
    await this.store.insertIfAbsent('workerHeartbeats', doc);
  }

  async list(): Promise<WorkerHeartbeatDoc[]> {
    return this.store.find('workerHeartbeats', {}, { limit: 50, sort: [['lastHeartbeatAt', -1]] });
  }

  async listStale(thresholdIso: string): Promise<WorkerHeartbeatDoc[]> {
    return this.store.find('workerHeartbeats', { lastHeartbeatAt: { $lt: thresholdIso } }, { limit: 50 });
  }

  /**
   * Eskimiş kalp atışlarını "durdu" olarak işaretler.
   *
   * Neden: geliştirmede `tsx watch` worker'ı her dosya değişiminde yeniden başlatır;
   * eski süreç kaydı "running" kalır ve panelde çalışıyor gibi görünür (yanlış
   * "kalp atışı göndermedi" uyarıları da bu yüzden birikir). Süreç öldüyse
   * kaydın "running" olması yanlıştır; durdurma isteği gelmeyen çalıştırmalar da
   * (SIGKILL) bir sonraki başlatmada bu yolla düzeltilir.
   */
  async markStaleAsStopped(thresholdIso: string): Promise<number> {
    const stale = await this.store.find(
      'workerHeartbeats',
      { lastHeartbeatAt: { $lt: thresholdIso }, status: 'running' },
      { limit: 200 },
    );
    let updated = 0;
    for (const worker of stale) {
      const result = await this.store.updateOne(
        'workerHeartbeats',
        { id: worker.id },
        { status: 'stopped' },
      );
      if (result) updated += 1;
    }
    return updated;
  }

  /**
   * Çok eski kalp atışı kayıtlarını siler.
   *
   * Neden gerekli: geliştirmede `tsx watch` her dosya değişiminde worker'ı
   * yeniden başlatır ve eski süreçlerin kayıtları kalır. Bu kayıtlar
   * temizlenmezse panel sürekli "kalp atışı göndermedi" uyarısı üretir ve
   * gerçek bir kesinti ayırt edilemez. Yakın tarihli kayıtlar (varsayılan 7 gün)
   * tanı için korunur.
   */
  async purgeOlderThan(iso: string): Promise<number> {
    return this.store.deleteMany('workerHeartbeats', { lastHeartbeatAt: { $lt: iso } });
  }
}

/** Yönetici işlemleri denetim kaydı (KVKK ve güvenlik gereği). */
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

/** Kullanıcının kaydettiği ilanlar (panel). */
export class SavedJobRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async toggle(userId: string, jobId: string): Promise<{ saved: boolean }> {
    const existing = await this.store.findOne('savedJobs', { userId, jobId });
    if (existing) {
      await this.store.deleteOne('savedJobs', { id: existing.id });
      return { saved: false };
    }
    const doc: SavedJobDoc = { id: createId('sav'), userId, jobId, createdAt: this.clock.now().toISOString() };
    validateDocument('savedJobs', doc);
    await this.store.insertIfAbsent('savedJobs', doc);
    return { saved: true };
  }

  async listForUser(userId: string, limit = 100): Promise<SavedJobDoc[]> {
    return this.store.find('savedJobs', { userId }, { limit, sort: [['createdAt', -1]] });
  }

  async isSaved(userId: string, jobId: string): Promise<boolean> {
    const doc = await this.store.findOne('savedJobs', { userId, jobId });
    return doc !== null;
  }
}
