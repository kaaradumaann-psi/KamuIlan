/**
 * Worker çalışma zamanı.
 *
 * Bir tik (tick) içinde yapılanlar:
 *   1. Zamanlayıcı: zamanı gelen taramaları kalıcı kuyruğa yazar.
 *   2. Tarama kuyruğu: kaynak başına kilit altında tarama çalıştırır.
 *   3. E-posta kuyruğu: outbox'tan lease'lenen iletileri gönderir (taramadan bağımsız).
 *   4. Bakım görevleri: süre dolan ilanları kapatma, kilit/hız sınırı temizliği,
 *      kaynak sağlığı ve kapsam denetimi.
 *   5. Kalp atışı ve bayat worker denetimi.
 *
 * Garantiler:
 *  - Aynı kaynak iki worker tarafından AYNI ANDA taranmaz (kilit).
 *  - Hatası alınan iş üstel geri çekilme ile yeniden denenir; sınır dolunca
 *    ölü mektuba (DLQ) düşer ve panelden yeniden kuyruğa alınabilir.
 *  - E-posta hatası taramayı, tarama hatası e-postayı durdurmaz.
 *  - Kaynağa erişilemese bile mevcut ilanlar silinmez.
 */
import { getEnv, type Env } from '../config/env';
import { APP_VERSION, SCHEDULER_DEFAULTS } from '../config/app';
import type { Repos } from '../db/repos';
import type { JobDoc, ScrapeRunDoc, SourceDoc } from '../db/schemas';
import { createLogger, type Logger } from '../lib/logger';
import { createEmailTransport, type EmailTransport } from '../email/transport';
import { sendOutboxBatch } from '../email/service';
import { TelegramBotClient } from '../telegram/client';
import { telegramConfig, type TelegramConfig } from '../telegram/config';
import type { TelegramSender } from '../telegram/deliver';
import { toIstanbulDateOnly } from '../domain/dates';
import type { SourceAdapter } from '../sources/types';
import { runSourceScrape } from '../ingest/pipeline';
import { QUEUE_NAMES, type QueueBackend, type QueueJobPayload } from './queue';
import {
  ensureScheduledTasks,
  isStale,
  schedulerTick,
  syncTaskIntervals,
  HEARTBEAT_STALE_MS,
} from './scheduler';

export interface WorkerRuntimeOptions {
  repos: Repos;
  queue: QueueBackend;
  env?: Env;
  logger?: Logger;
  workerId?: string;
  transport?: EmailTransport;
  /** Telegram gönderici; `null` = kapalı. Verilmezse ortam değişkenlerinden kurulur. */
  telegram?: TelegramSender | null;
  liveFetch?: boolean;
  /** Yalnızca testlerde: kalp atışı kaydını devre dışı bırakmaz, saati sabitler. */
  now?: () => Date;
  /** Bakım görevlerini kendi kaynak sağlığı denetimiyle değiştir (test). */
  coverageWarnings?: boolean;
  /**
   * Testlerde adaptörü değiştirmek için (ağa çıkılmaz). Üretimde `undefined`
   * bırakılır ve adaptör kayıt defterinden (registry) çözülür.
   */
  adapterOverride?: SourceAdapter;
}

export interface WorkerTickResult {
  scheduler: { due: number; enqueued: number; duplicates: number; misses: number };
  scrapes: { processed: number; succeeded: number; failed: number; skipped: number };
  emails: { claimed: number; sent: number; failed: number; dead: number };
  telegram: { claimed: number; sent: number; failed: number; dead: number; suppressed: number };
  maintenance: { ran: string[]; closedJobs: number; activatedJobs: number; purged: number };
  warnings: string[];
}

const LEASE_MS = 5 * 60_000;
const RETRY_BASE_MS = 30_000;
const MAX_SCRAPE_ATTEMPTS = 3;
const MAX_MAINTENANCE_ATTEMPTS = 2;
/** Kaynağın bu süreden uzun süredir başarılı taraması yoksa yönetici uyarısı üretilir. */
const SOURCE_STALE_AFTER_MS = 6 * 3_600_000;
/**
 * Aynı uyarının tekrar loglanma aralığı.
 *
 * Neden gerekli: `healthChecks` HER tikte çalışır (varsayılan 5 sn). Uyarıları
 * koşulsuz yazmak logu doldurur ve denetim kaydına (auditLogs) aynı olayı binlerce
 * kez yazar. Uyarı yalnızca durum DEĞİŞTİĞİNDE veya bu aralık geçtiğinde tekrarlanır.
 */
const WARNING_REPEAT_MS = 6 * 3_600_000;

export class WorkerRuntime {
  private readonly repos: Repos;
  private readonly queue: QueueBackend;
  private readonly env: Env;
  private readonly logger: Logger;
  readonly workerId: string;
  private readonly transport: EmailTransport | null;
  private readonly telegram: TelegramSender | null;
  private readonly now: () => Date;
  private readonly coverageWarnings: boolean;
  private readonly liveFetch: boolean | undefined;
  private readonly adapterOverride: SourceAdapter | undefined;
  private stopRequested = false;
  private processed = 0;
  private lastError: string | null = null;
  /** Uyarı tekrarını önlemek için son uyarı durumları (bellekte; süreç ile birlikte sıfırlanır). */
  private readonly warnedSources = new Map<string, { failures: number; at: number }>();
  private readonly warnedWorkers = new Set<string>();
  private warnedDeadJobs: { count: number; at: number } | null = null;

  constructor(options: WorkerRuntimeOptions) {
    this.repos = options.repos;
    this.queue = options.queue;
    this.env = options.env ?? getEnv();
    this.workerId = options.workerId ?? `${this.env.WORKER_NAMESPACE}-${process.pid}`;
    this.logger = options.logger ?? createLogger('worker', { level: this.env.LOG_LEVEL });
    this.now = options.now ?? (() => this.repos.clock.now());
    this.coverageWarnings = options.coverageWarnings ?? true;
    this.liveFetch = options.liveFetch;
    this.adapterOverride = options.adapterOverride;
    // Scheduling controls task creation only; it must not silently disable an
    // already-queued notification delivery. EMAIL_PROVIDER owns mail transport.
    this.transport = options.transport ?? createEmailTransport(this.env).transport;
    this.telegram =
      options.telegram !== undefined ? options.telegram : telegramSenderFromEnv(this.env);
  }

  /** Tek tik. Testlerde doğrudan çağrılır; üretimde `run()` döngü kurar. */
  async tick(): Promise<WorkerTickResult> {
    const now = this.now();
    // Kalp atışı tik BAŞINDA da atılır: yavaş/büyük taramalar tek tiki
    // dakikalara uzatabilir; yalnızca sonda atılırsa panel o süre boyunca
    // yanlışlıkla "worker çalışmıyor" gösterir.
    await this.safeHeartbeat([]);
    const result: WorkerTickResult = {
      scheduler: { due: 0, enqueued: 0, duplicates: 0, misses: 0 },
      scrapes: { processed: 0, succeeded: 0, failed: 0, skipped: 0 },
      emails: { claimed: 0, sent: 0, failed: 0, dead: 0 },
      telegram: { claimed: 0, sent: 0, failed: 0, dead: 0, suppressed: 0 },
      maintenance: { ran: [], closedJobs: 0, activatedJobs: 0, purged: 0 },
      warnings: [],
    };

    const schedule = this.env.SCHEDULER_ENABLED
      ? await schedulerTick(this.repos, this.queue, { now, logger: this.logger })
      : { due: 0, enqueued: 0, duplicates: 0, misses: 0 };
    result.scheduler = {
      due: schedule.due,
      enqueued: schedule.enqueued,
      duplicates: schedule.duplicates,
      misses: schedule.misses,
    };

    const scrape = await this.processScrapeQueue();
    result.scrapes = scrape;

    const email = await this.processEmailQueue(now);
    result.emails = email;
    result.telegram = await this.processTelegramQueue(now);

    const maintenance = await this.processMaintenanceQueue(now);
    result.maintenance = maintenance;

    result.warnings = await this.healthChecks(now);

    await this.heartbeat(result);
    return result;
  }

  private async processScrapeQueue(): Promise<WorkerTickResult['scrapes']> {
    const stats = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    if (this.queue.kind !== 'builtin') return stats; // Redis yolunda işler push edilir.

    const scrapeLeaseMs = Math.max(LEASE_MS, this.env.SCRAPE_TIMEOUT_MS + 90_000);
    const jobs = await this.queue.claim(
      QUEUE_NAMES.scrape,
      this.workerId,
      this.env.WORKER_CONCURRENCY,
      scrapeLeaseMs,
    );
    // Claim limiti WORKER_CONCURRENCY ise işler gerçekten de bu sınır içinde
    // paralel yürütülür. Her tarama için kullanılan HttpClient'lar aynı
    // process-host limiter'ını paylaşarak minRequestIntervalMs'i korur.
    const outcomes = await Promise.all(
      jobs.map(async (job) => {
        try {
          return await this.handleScrapeJob({
            id: job.id,
            payload: job.payload,
            attempts: job.attempts,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.lastError = message;
          this.logger.error({ err: message, jobId: job.id }, 'tarama işi tamamlanamadı');
          return 'failed' as const;
        }
      }),
    );
    for (const outcome of outcomes) {
      stats.processed += 1;
      if (outcome === 'failed') stats.failed += 1;
      else if (outcome === 'skipped') stats.skipped += 1;
      else stats.succeeded += 1;
    }

    return stats;
  }

  /**
   * Tek bir tarama işini işler. Hem yerleşik kuyruk (çekmeli) hem Redis (itmeli)
   * yolu bu fonksiyonu kullanır; böylece davranış iki arka uçta aynıdır.
   */
  private async handleScrapeJob(job: QueueJobPayload): Promise<'succeeded' | 'failed' | 'skipped'> {
    const sourceKey = String(job.payload['sourceKey'] ?? '');
    if (!sourceKey) {
      await this.failJob(job.id, job.attempts, 'İş yükünde sourceKey yok.', MAX_SCRAPE_ATTEMPTS);
      return 'failed';
    }

    const source = await this.repos.sources.getByKey(sourceKey);
    if (!source) {
      await this.completeJob(job.id);
      this.logger.warn({ sourceKey, jobId: job.id }, 'kaynak kaydı bulunamadı; iş kapatıldı');
      return 'skipped';
    }
    if (!source.enabled) {
      await this.completeJob(job.id);
      return 'skipped';
    }

    try {
      const run = await runSourceScrape({
        repos: this.repos,
        source,
        trigger: 'schedule',
        workerId: this.workerId,
        scheduledFor: (job.payload['scheduledFor'] as string | undefined) ?? null,
        ...(this.liveFetch !== undefined ? { liveFetch: this.liveFetch } : {}),
        ...(this.adapterOverride ? { adapter: this.adapterOverride } : {}),
        logger: this.logger.child({ sourceKey }),
      });
      this.processed += 1;

      if (run.status === 'failed') {
        await this.failJob(job.id, job.attempts, run.errors[0] ?? 'Tarama başarısız.', MAX_SCRAPE_ATTEMPTS);
        return 'failed';
      }
      await this.completeJob(job.id);
      // 'skipped' (erişilemedi/değişmedi) ve 'locked' (başka worker tarıyor)
      // durumları başarısızlık değildir; iş kapatılır.
      return run.status === 'skipped' || run.status === 'locked' ? 'skipped' : 'succeeded';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.logger.error({ err: message, sourceKey, jobId: job.id }, 'tarama işi çöküşle sonuçlandı');
      await this.failJob(job.id, job.attempts, message, MAX_SCRAPE_ATTEMPTS);
      return 'failed';
    }
  }

  private async processTelegramQueue(now: Date): Promise<WorkerTickResult['telegram']> {
    const empty = { claimed: 0, sent: 0, failed: 0, dead: 0, suppressed: 0 };
    if (!this.telegram) return empty;
    try {
      const batch = await sendOutboxBatch({
        repos: this.repos,
        channel: 'telegram',
        telegram: this.telegram,
        workerId: this.workerId,
        limit: 20,
        now,
      });
      return {
        claimed: batch.claimed,
        sent: batch.sent,
        failed: batch.failed,
        dead: batch.dead,
        suppressed: batch.suppressed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.logger.error({ err: message }, 'telegram turu başarısız');
      return { ...empty, failed: 1 };
    }
  }

  private async processEmailQueue(now: Date): Promise<WorkerTickResult['emails']> {
    if (!this.transport) return { claimed: 0, sent: 0, failed: 0, dead: 0 };
    try {
      const batch = await sendOutboxBatch({
        repos: this.repos,
        transport: this.transport,
        workerId: this.workerId,
        limit: 20,
        now,
      });
      return { claimed: batch.claimed, sent: batch.sent, failed: batch.failed, dead: batch.dead };
    } catch (error) {
      // E-posta hatası taramayı durdurmaz; kayıt altına alınır.
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.logger.error({ err: message }, 'e-posta turu başarısız');
      return { claimed: 0, sent: 0, failed: 1, dead: 0 };
    }
  }

  private async processMaintenanceQueue(now: Date): Promise<WorkerTickResult['maintenance']> {
    const stats: WorkerTickResult['maintenance'] = { ran: [], closedJobs: 0, activatedJobs: 0, purged: 0 };
    if (this.queue.kind !== 'builtin') return stats;

    const jobs = await this.queue.claim(QUEUE_NAMES.maintenance, this.workerId, 2, LEASE_MS);
    for (const job of jobs) {
      const outcome = await this.handleMaintenanceJob(
        { id: job.id, payload: job.payload, attempts: job.attempts },
        now,
      );
      if (outcome) {
        stats.ran.push(outcome.ran);
        stats.closedJobs += outcome.closedJobs;
        stats.activatedJobs += outcome.activatedJobs;
        stats.purged += outcome.purged;
      }
    }

    return stats;
  }

  /** Tek bir bakım işini işler (çekmeli ve itmeli yolda ortak). */
  private async handleMaintenanceJob(
    job: QueueJobPayload,
    now: Date = this.now(),
  ): Promise<{ ran: string; closedJobs: number; activatedJobs: number; purged: number } | null> {
    try {
      const handled = await this.runMaintenanceJob(
        String(job.payload['kind'] ?? job.payload['name'] ?? ''),
        job.payload,
        now,
      );
      await this.completeJob(job.id);
      return handled;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: message, jobId: job.id }, 'bakım görevi başarısız');
      await this.failJob(job.id, job.attempts, message, MAX_MAINTENANCE_ATTEMPTS);
      return null;
    }
  }

  private async runMaintenanceJob(
    kind: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<{ ran: string; closedJobs: number; activatedJobs: number; purged: number } | null> {
    switch (kind) {
      case 'deadline-refresh': {
        // Tarihler Türkiye saatine göre karşılaştırılır (gün sınırı Europe/Istanbul).
        const today = toIstanbulDateOnly(now);
        const closedExpired = await this.repos.jobs.closeExpiredJobs(today);
        const closedStale = await this.repos.jobs.closeStalePublications(today);
        const activated = await this.repos.jobs.activateStartedJobs(today);
        return { ran: kind, closedJobs: closedExpired + closedStale, activatedJobs: activated, purged: 0 };
      }
      case 'maintenance': {
        const purgedLocks = await this.repos.locks.purgeExpired();
        const purgedLimits = await this.repos.rateLimits.purgeOlderThan(
          new Date(now.getTime() - 24 * 3_600_000).toISOString(),
        );
        const purgedSessions = await this.repos.users.purgeExpiredSessions();
        const purgedHeartbeats = await this.repos.heartbeats.purgeOlderThan(
          new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString(),
        );
        return {
          ran: kind,
          closedJobs: 0,
          activatedJobs: 0,
          purged: purgedLocks + purgedLimits + purgedSessions + purgedHeartbeats,
        };
      }
      case 'coverage-audit': {
        const coverage = await this.repos.sources.coverage();
        await this.repos.audit.append({
          actorUserId: null,
          actorRole: 'worker',
          action: 'coverage.audit',
          targetType: 'system',
          targetId: 'coverage',
          meta: {
            total: coverage.summary.total,
            enabled: coverage.summary.enabled,
            verified: coverage.summary.verified,
            failing: coverage.summary.failing,
            stale: coverage.summary.stale,
            planned: coverage.planned.length,
            job: payload['taskId'] ?? null,
          },
        });
        return { ran: kind, closedJobs: 0, activatedJobs: 0, purged: 0 };
      }
      default:
        this.logger.warn({ kind }, 'bilinmeyen bakım görevi; yok sayıldı');
        return null;
    }
  }

  /** Uzun süredir başarısız/eskimiş kaynaklar ve bayat worker'lar için uyarı üretir. */
  private async healthChecks(now: Date): Promise<string[]> {
    const warnings: string[] = [];

    if (this.coverageWarnings) {
      const sources = await this.repos.sources.list();
      for (const source of sources) {
        if (!source.enabled) continue;
        const neverSucceeded = isStale(source.health.lastSuccessAt, now, SOURCE_STALE_AFTER_MS);
        if (!neverSucceeded || source.health.consecutiveFailures < 3) {
          this.warnedSources.delete(source.key);
          continue;
        }
        const previous = this.warnedSources.get(source.key);
        const changed = previous === undefined || previous.failures !== source.health.consecutiveFailures;
        const repeat = previous !== undefined && now.getTime() - previous.at >= WARNING_REPEAT_MS;
        if (!changed && !repeat) continue;

        this.warnedSources.set(source.key, {
          failures: source.health.consecutiveFailures,
          at: now.getTime(),
        });
        warnings.push(
          `${source.name}: ${source.health.consecutiveFailures} kez üst üste başarısız, son başarı ${source.health.lastSuccessAt ?? 'hiç'}`,
        );
        // Denetim kaydı yalnızca durum değiştiğinde yazılır (aksi hâlde her tikte birikirdi).
        if (changed) {
          await this.repos.audit.append({
            actorUserId: null,
            actorRole: 'worker',
            action: 'source.stale',
            targetType: 'source',
            targetId: source.key,
            meta: {
              consecutiveFailures: source.health.consecutiveFailures,
              lastSuccessAt: source.health.lastSuccessAt,
              lastErrorMessage: source.health.lastErrorMessage,
            },
          });
        }
      }
    }

    const staleThreshold = new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString();
    const staleWorkers = await this.repos.heartbeats.listStale(staleThreshold);
    if (staleWorkers.length > 0) {
      // Kalp atışı kesilen süreçler "durdu" sayılır; aksi hâlde panelde sahte
      // "çalışıyor" görünürler (geliştirmede tsx watch sık yeniden başlatır).
      await this.repos.heartbeats.markStaleAsStopped(staleThreshold);
    }
    for (const worker of staleWorkers) {
      if (worker.workerId === this.workerId) continue;
      // Aynı ölü worker için her tikte tekrar uyarmak yerine bir kez uyarılır;
      // kayıt `markStaleAsStopped` ile zaten "durdu" olarak işaretlenir.
      if (this.warnedWorkers.has(worker.workerId)) continue;
      this.warnedWorkers.add(worker.workerId);
      warnings.push(
        `Worker ${worker.workerId} ${worker.lastHeartbeatAt} tarihinden beri kalp atışı göndermedi.`,
      );
    }

    const queueStats = await this.queue.stats();
    const deadCount = queueStats.counts['dead'] ?? 0;
    if (deadCount > 0) {
      const previous = this.warnedDeadJobs;
      const changed = previous === null || previous.count !== deadCount;
      const repeat = previous !== null && now.getTime() - previous.at >= WARNING_REPEAT_MS;
      if (changed || repeat) {
        this.warnedDeadJobs = { count: deadCount, at: now.getTime() };
        warnings.push(`Kuyrukta ${deadCount} ölü iş var; panelden incelenmeli.`);
      }
    } else {
      this.warnedDeadJobs = null;
    }

    for (const warning of warnings) this.logger.warn({}, warning);
    return warnings;
  }

  /** İşi tamamlandı olarak işaretler (Redis yolunda BullMQ durumu kendisi yönetir). */
  private async completeJob(id: string): Promise<void> {
    if (this.queue.kind !== 'builtin') return;
    await this.queue.complete(id);
  }

  /**
   * Başarısız işi üstel geri çekilme ile yeniden planlar; sınır dolduysa DLQ.
   * Redis yolunda deneme/geri çekilme BullMQ'ya aittir; hata fırlatmak yeterlidir.
   */
  private async failJob(id: string, attempts: number, error: string, maxAttempts: number): Promise<void> {
    if (this.queue.kind !== 'builtin') throw new Error(error);
    const tooMany = attempts >= maxAttempts;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
    const jitter = Math.round(backoff * (0.8 + Math.random() * 0.4));
    const retryAt = tooMany ? null : new Date(this.now().getTime() + jitter).toISOString();
    await this.queue.fail(id, error, retryAt);
    if (tooMany) {
      this.logger.error({ jobId: id, attempts, error }, 'iş ölü mektuba düştü (DLQ)');
    }
  }

  private async heartbeat(result: WorkerTickResult): Promise<void> {
    await this.safeHeartbeat(result.warnings);
  }

  /** Kalp atışı hatası iş akışını düşürmemeli; yalnızca günlüğe yazılır. */
  private async safeHeartbeat(warnings: string[], status?: 'starting' | 'running' | 'stopping' | 'stopped'): Promise<void> {
    try {
      await this.repos.heartbeats.beat({
        workerId: this.workerId,
        role: 'worker',
        version: APP_VERSION,
        status: status ?? (this.stopRequested ? 'stopping' : 'running'),
        processedJobs: this.processed,
        lastError: this.lastError ?? warnings[0] ?? null,
      });
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'kalp atışı yazılamadı',
      );
    }
  }

  /** Kalıcı döngü: tikler arasında beklenir, durdurma isteği ile temiz kapanır. */
  async run(intervalMs = this.env.SCHEDULER_TICK_MS): Promise<void> {
    let heartbeatState: 'starting' | 'running' = 'starting';
    let heartbeatInFlight: Promise<void> | null = null;
    await this.safeHeartbeat([], 'starting');
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = this.safeHeartbeat([], this.stopRequested ? 'stopping' : heartbeatState).finally(() => {
        heartbeatInFlight = null;
      });
    }, SCHEDULER_DEFAULTS.heartbeatIntervalMs);

    try {
      this.logger.info(
        {
          workerId: this.workerId,
          intervalMs,
          backend: this.queue.kind,
          sources: 'kaynak envanteri hazır',
          scanIntervalMinutes: this.env.SCAN_INTERVAL_MINUTES || 'kaynak başına',
        },
        'worker başlangıç işleri hazırlanıyor',
      );
      // Tek bir global aralık verilmişse hem yeni görevler hem var olan görevler
      // aynı aralığa çekilir; 0 ise her kaynağın kendi aralığı korunur.
      await ensureScheduledTasks(this.repos, this.logger, this.env.SCAN_INTERVAL_MINUTES);
      await syncTaskIntervals(this.repos, this.env.SCAN_INTERVAL_MINUTES);

      // Önceki çalıştırmalardan kalan "running" kayıtlar: süreç öldüyse panelde
      // sahte "çalışıyor" görünmemeleri için stale eşiğini geçenler durduruldu sayılır.
      const staleBefore = new Date(this.now().getTime() - HEARTBEAT_STALE_MS).toISOString();
      const stopped = await this.repos.heartbeats.markStaleAsStopped(staleBefore);
      if (stopped > 0) {
        this.logger.info({ stopped }, 'kalp atışı eskimiş worker kayıtları "durdu" olarak işaretlendi');
      }
      // Önceki süreç ölürken yarım kalmış taramalar da kapatılır; yoksa panelde
      // sonsuza dek "çalışıyor" görünürler.
      const closedRuns = await this.repos.runs.closeStaleRunning(
        staleBefore,
        'Worker süreci sonlandığı için yarım kalan tarama kapatıldı.',
      );
      if (closedRuns > 0) {
        this.logger.info({ closedRuns }, 'yarım kalmış tarama kayıtları kapatıldı');
      }

      if (this.queue.kind === 'redis') {
        // İtmeli arka uç: tarama ve bakım işleri doğrudan işleyiciye bağlanır.
        const queue = this.queue;
        queue.startWorker(
          QUEUE_NAMES.scrape,
          async (job) => {
            await this.handleScrapeJob(job);
          },
          this.env.WORKER_CONCURRENCY,
        );
        queue.startWorker(
          QUEUE_NAMES.maintenance,
          async (job) => {
            await this.handleMaintenanceJob(job);
          },
          1,
        );
        this.logger.info({}, 'Redis işleyicileri bağlandı (tarama ve bakım)');
      }

      heartbeatState = 'running';
      await this.safeHeartbeat([], 'running');
      this.logger.info({ workerId: this.workerId }, 'worker zamanlanmış işler için hazır');

      while (!this.stopRequested) {
        const started = Date.now();
        try {
          const result = await this.tick();
          if (result.scrapes.processed > 0 || result.emails.claimed > 0) {
            this.logger.info(
              {
                scrapes: result.scrapes,
                emails: result.emails,
                scheduler: result.scheduler,
                durationMs: Date.now() - started,
              },
              'tik tamamlandı',
            );
          }
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.logger.error({ err: this.lastError }, 'tik hata ile sonuçlandı');
        }
        await this.sleep(intervalMs);
      }
    } finally {
      try {
        await this.queue.close();
      } catch (error) {
        this.logger.warn({ err: error }, 'worker kuyruğu kapatılırken hata oluştu');
      }
      clearInterval(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
      await this.safeHeartbeat([], 'stopped');
      this.logger.info({ workerId: this.workerId }, 'worker durdu');
    }
  }

  /** Durdurma isteği: mevcut tik biter, sonra döngü kapanır. */
  requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.logger.info({ workerId: this.workerId }, 'durdurma isteği alındı; mevcut tur tamamlanıyor');
  }

  private async sleep(ms: number): Promise<void> {
    // Durdurma isteği beklemeyi keser (kapanış uzun süre asılı kalmasın).
    const step = 500;
    let waited = 0;
    while (waited < ms && !this.stopRequested) {
      const chunk = Math.min(step, ms - waited);
      await new Promise((resolve) => setTimeout(resolve, chunk));
      waited += chunk;
    }
  }
}

/** Panel/CLI için worker durumu özeti. */
export async function workerStatus(repos: Repos): Promise<{
  heartbeats: Awaited<ReturnType<Repos['heartbeats']['list']>>;
  queue: Record<string, number>;
  deadJobs: number;
}> {
  const heartbeats = await repos.heartbeats.list();
  const queue = await repos.queue.stats();
  const dead = await repos.queue.listDead(50);
  return { heartbeats, queue, deadJobs: dead.length };
}

/** Elle tetikleme: yönetici panelinden tek seferlik tarama. */
export async function triggerSourceScrape(
  repos: Repos,
  queue: QueueBackend,
  sourceKey: string,
  requestedBy: string,
): Promise<{ enqueued: boolean; jobId: string | null; reason?: string }> {
  const source: SourceDoc | null = await repos.sources.getByKey(sourceKey);
  if (!source) return { enqueued: false, jobId: null, reason: 'Kaynak bulunamadı.' };
  const now = repos.clock.now();
  const dedupeKey = `manual:${sourceKey}:${now.toISOString()}`;
  const result = await queue.enqueue(QUEUE_NAMES.scrape, {
    name: 'manual-scrape',
    dedupeKey,
    payload: { kind: 'manual-scrape', sourceKey, scheduledFor: now.toISOString(), requestedBy },
    maxAttempts: 2,
  });
  await repos.audit.append({
    actorUserId: requestedBy,
    actorRole: 'admin',
    action: 'source.manual-scrape',
    targetType: 'source',
    targetId: sourceKey,
    meta: { queueJobId: result.id, created: result.created },
  });
  return { enqueued: result.created, jobId: result.id };
}

/** Sağlık denetimi için son tarama özeti (panel göstergesi). */
export function summarizeRun(run: ScrapeRunDoc): { label: string; value: string }[] {
  return [
    { label: 'Kaynak', value: run.sourceKey },
    { label: 'Durum', value: run.status },
    { label: 'Bulunan', value: String(run.itemsFound) },
    { label: 'Kabul', value: String(run.itemsAccepted) },
    { label: 'Sonuç', value: run.result },
  ];
}

/** Bildirim gönderilecek ilanı kısaca tanımlar (log/panel). */
export function describeJob(job: JobDoc): string {
  return `${job.title} — ${job.institution}`;
}

/** Ortam değişkenlerinden Telegram göndericisi. Kanal kapalıysa null (e-posta etkilenmez). */
export function telegramSenderFromEnv(env: Env): TelegramSender | null {
  const config: TelegramConfig | null = telegramConfig(env);
  if (!config) return null;
  return {
    client: new TelegramBotClient({ token: config.token, apiBaseUrl: config.apiBaseUrl }),
    config,
    senderName: env.APP_DISPLAY_NAME,
    baseUrl: env.APP_BASE_URL,
  };
}
