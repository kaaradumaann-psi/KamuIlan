/**
 * Kalıcı zamanlayıcı.
 *
 * Tasarım kuralları (§10):
 *  - Zamanlama durumu VERİTABANINDA tutulur (`scheduledTasks`): süreç yeniden
 *    başlasa da kaldığı yerden devam eder, uygulama kapalıyken tarama kaçmaz.
 *  - `setInterval` ile iş üretilmez; her tik veritabanındaki `nextRunAt` alanına
 *    bakar. Böylece birden çok worker aynı anda çalışsa bile aynı zamanlanmış
 *    çalışma iki kez kuyruğa girmez (benzersiz dedupe anahtarı).
 *  - Çok uzun süre çalışmamış (ör. uygulama uykudaydı) görevler için geçmiş
 *    çalışmalar yığılmaz: gecikme "miss" olarak sayılır ve zaman çizelgesi
 *    şimdiye kaydırılır.
 *  - Kaynağa erişilemese bile ilanlar silinmez; bu modül yalnızca zamanlar.
 */
import { SCHEDULER_DEFAULTS } from '../config/app';
import { SOURCE_DEFINITIONS } from '../config/sources';
import type { ScheduledTaskDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import type { Logger } from '../lib/logger';
import { createLogger } from '../lib/logger';
import { addMinutes } from '../lib/clock';
import { QUEUE_NAMES, type QueueBackend } from './queue';

/** Bakım görevlerinin kaynak anahtarı (tek bir kuruma bağlı değildir). */
export const SYSTEM_TASK_KEY = '*';

export interface EnsureTasksResult {
  created: number;
  updated: number;
  disabled: number;
  total: number;
}

/**
 * Zamanlanmış görevleri kaynak envanterine göre kurar/günceller.
 * Devre dışı kaynakların görevleri SİLİNMEZ, yalnızca devre dışı bırakılır.
 */
export async function ensureScheduledTasks(repos: Repos, logger: Logger = createLogger('scheduler')): Promise<EnsureTasksResult> {
  const result: EnsureTasksResult = { created: 0, updated: 0, disabled: 0, total: 0 };
  const sources = await repos.sources.list();
  const before = await repos.scheduledTasks.listAll();
  const existingKeys = new Set(before.map((task) => `${task.kind}:${task.sourceKey}`));

  for (const source of sources) {
    const task = await repos.scheduledTasks.ensure({
      kind: 'source-scrape',
      sourceKey: source.key,
      intervalMinutes: source.scrapeIntervalMinutes,
    });
    if (!source.enabled && task.enabled) {
      await repos.scheduledTasks.setEnabled(task.id, false);
      result.disabled += 1;
    } else if (source.enabled && !task.enabled) {
      await repos.scheduledTasks.setEnabled(task.id, true);
    }
    if (existingKeys.has(`source-scrape:${source.key}`)) result.updated += 1;
    else result.created += 1;
  }

  const systemTasks: { kind: ScheduledTaskDoc['kind']; intervalMinutes: number; note: string }[] = [
    {
      kind: 'deadline-refresh',
      intervalMinutes: 30,
      note: 'Süresi geçen ilanları kapatır, başvurusu başlayanları etkinleştirir.',
    },
    {
      kind: 'maintenance',
      intervalMinutes: 60,
      note: 'Kilit/hız sınırı/hareket kayıtlarını temizler, kaynak sağlığını denetler.',
    },
    {
      kind: 'coverage-audit',
      intervalMinutes: SCHEDULER_DEFAULTS.auditIntervalMinutes,
      note: 'Kapsam raporunu üretir, uzun süredir başarısız kaynakları uyarır.',
    },
  ];

  for (const task of systemTasks) {
    const created = await repos.scheduledTasks.ensure({
      kind: task.kind,
      sourceKey: SYSTEM_TASK_KEY,
      intervalMinutes: task.intervalMinutes,
    });
    if (existingKeys.has(`${task.kind}:${SYSTEM_TASK_KEY}`)) result.updated += 1;
    else result.created += 1;
    void created;
  }

  const all = await repos.scheduledTasks.listAll();
  result.total = all.length;
  logger.info(
    { created: result.created, updated: result.updated, disabled: result.disabled, total: result.total },
    'zamanlanmış görevler hazır',
  );
  return result;
}

export interface SchedulerTickResult {
  due: number;
  enqueued: number;
  duplicates: number;
  misses: number;
  skippedDisabled: number;
}

/**
 * Zamanı gelen görevleri kuyruğa alır ve sonraki çalışma zamanını ilerletir.
 *
 * `maxCatchUpMinutes`: bu süreden daha eski çalışmalar telafi edilmez, gecikme
 * olarak sayılır (uygulama saatlerce kapalı kaldıysa ardışık tarama fırtınası olmaz).
 */
export async function schedulerTick(
  repos: Repos,
  queue: QueueBackend,
  options: { now?: Date; limit?: number; maxCatchUpMinutes?: number; logger?: Logger } = {},
): Promise<SchedulerTickResult> {
  const logger = options.logger ?? createLogger('scheduler');
  const now = options.now ?? repos.clock.now();
  const nowIso = now.toISOString();
  const maxCatchUpMinutes = options.maxCatchUpMinutes ?? 10;
  const result: SchedulerTickResult = { due: 0, enqueued: 0, duplicates: 0, misses: 0, skippedDisabled: 0 };

  const dueTasks = await repos.scheduledTasks.listDue(nowIso, options.limit ?? 50);
  result.due = dueTasks.length;

  for (const task of dueTasks) {
    if (!task.enabled) {
      result.skippedDisabled += 1;
      continue;
    }

    if (task.kind === 'source-scrape' && task.sourceKey !== SYSTEM_TASK_KEY) {
      const source = await repos.sources.getByKey(task.sourceKey);
      if (!source || !source.enabled) {
        // Kaynak kaldırılmış/devre dışı: görev durdurulur ama silinmez.
        await repos.scheduledTasks.setEnabled(task.id, false);
        result.skippedDisabled += 1;
        continue;
      }
    }

    const delayMinutes = Math.floor((now.getTime() - Date.parse(task.nextRunAt)) / 60_000);
    const tooLate = delayMinutes > Math.max(maxCatchUpMinutes, task.intervalMinutes);
    const scheduledFor = tooLate ? nowIso : task.nextRunAt;
    if (tooLate) {
      result.misses += 1;
      logger.warn(
        { task: task.kind, sourceKey: task.sourceKey, scheduledFor: task.nextRunAt, delayMinutes },
        'zamanlanmış çalışma kaçırıldı; zaman çizelgesi şimdiye kaydırıldı',
      );
    }

    // Dedupe anahtarı zamanlanmış çalışmanın kimliğidir: aynı çalışma iki kez
    // kuyruğa girmez, sonraki çalışma ise ayrı bir iş olur.
    const dedupeKey = `${task.kind}:${task.sourceKey}:${task.nextRunAt}`;
    const payload: Record<string, unknown> = {
      kind: task.kind,
      sourceKey: task.sourceKey,
      scheduledFor,
      scheduleDelayMs: Math.max(0, now.getTime() - Date.parse(task.nextRunAt)),
      taskId: task.id,
    };

    const enqueued = await queue.enqueue(
      task.kind === 'source-scrape' ? QUEUE_NAMES.scrape : QUEUE_NAMES.maintenance,
      {
        name: task.kind,
        dedupeKey,
        payload,
        maxAttempts: task.kind === 'source-scrape' ? 3 : 2,
      },
    );

    if (enqueued.created) result.enqueued += 1;
    else result.duplicates += 1;

    await repos.scheduledTasks.markEnqueued(task.id, {
      runId: enqueued.id,
      intervalMinutes: task.intervalMinutes,
      dequeuedAt: nowIso,
      misses: task.misses + (tooLate ? 1 : 0),
    });
  }

  return result;
}

/** Görevlerin bir sonraki çalışma zamanını şimdiye çeker (bakım/elle tetikleme). */
export async function rescheduleTask(repos: Repos, id: string, delayMinutes = 0): Promise<void> {
  const tasks = await repos.scheduledTasks.listAll();
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  const now = repos.clock.now();
  const next = delayMinutes > 0 ? addMinutes(now.toISOString(), delayMinutes) : now.toISOString();
  await repos.store.updateOne('scheduledTasks', { id }, { nextRunAt: next, updatedAt: now.toISOString() });
}

/** Kaynak tanımındaki aralık ile görevi hizalar (panelden aralık değişince). */
export async function syncTaskIntervals(repos: Repos): Promise<number> {
  const sources = await repos.sources.list();
  const tasks = await repos.scheduledTasks.listAll();
  let changed = 0;
  for (const task of tasks) {
    if (task.kind !== 'source-scrape' || task.sourceKey === SYSTEM_TASK_KEY) continue;
    const source = sources.find((item) => item.key === task.sourceKey);
    const definition = SOURCE_DEFINITIONS.find((item) => item.key === task.sourceKey);
    const desired = source?.scrapeIntervalMinutes ?? definition?.intervalMinutes;
    if (desired && desired !== task.intervalMinutes) {
      await repos.scheduledTasks.setInterval(task.id, desired);
      changed += 1;
    }
  }
  return changed;
}

/** İnsan okur gecikme metni (panelde ve loglarda). */
export function describeScheduleDelay(delayMs: number | null | undefined): string {
  if (delayMs === null || delayMs === undefined) return 'bilinmiyor';
  if (delayMs < 60_000) return `${Math.round(delayMs / 1000)} sn`;
  if (delayMs < 3_600_000) return `${Math.round(delayMs / 60_000)} dk`;
  return `${(delayMs / 3_600_000).toFixed(1)} saat`;
}

/** Heartbeat yaşını milisaniyeye çevirir (bayat worker denetimi). */
export function heartbeatAgeMs(lastHeartbeatAt: string, now: Date): number {
  const age = now.getTime() - Date.parse(lastHeartbeatAt);
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY;
}

/** Bayat worker eşiği (ms). */
export const HEARTBEAT_STALE_MS = SCHEDULER_DEFAULTS.heartbeatStaleMs;

/** Sağlık denetimlerinde kullanılan yardımcı: bayatlık eşiğinden eski mi? */
export function isStale(timestampIso: string | null, now: Date, thresholdMs: number): boolean {
  if (!timestampIso) return true;
  const age = now.getTime() - Date.parse(timestampIso);
  return !Number.isFinite(age) || age > thresholdMs;
}
