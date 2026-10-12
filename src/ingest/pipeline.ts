/**
 * Tarama hattı (pipeline): kaynak kaydı → adaptör → sınıflandırma → çıkarım →
 * tekilleştirme → kayıt → bildirim olayları → tarama kaydı + kaynak sağlığı.
 *
 * Garantiler:
 *  - Bir kaynak aynı anda YALNIZCA bir kez taranır (veritabanı kilidi).
 *  - Kaynağa erişilemese bile mevcut ilanlar SİLİNMEZ; yalnızca sağlık durumu
 *    ve hata kaydı güncellenir.
 *  - Adaptör yapısı değiştiğinde boş sonuç döndürmek yerine hata kaydedilir
 *    (sessiz veri kaybı yok).
 *  - Bildirim olayları taramanın içinde üretilir ama gönderim worker'a aittir;
 *    SMTP erişilemese de tarama tamamlanır.
 */
import { getEnv } from '../config/env';
import { findSourceDefinition } from '../config/sources';
import type { RawAnnouncement } from '../domain';
import { sha256Hex } from '../domain/ids';
import type { JobDoc, ScrapeRunDoc, SourceDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import type { ScrapeRunTotals } from '../db/repos/runs';
import { EMPTY_TOTALS } from '../db/repos/runs';
import { createLogger, type Logger } from '../lib/logger';
import type { Clock } from '../lib/clock';
import { HttpFetcher } from '../sources/fetcher';
import { requireAdapter } from '../sources/registry';
import { AdapterStructureError, AdapterUnavailableError } from '../sources/errors';
import type { AdapterContext, AdapterLimits, Fetcher, SourceAdapter } from '../sources/types';
import { queueNotificationsForJob } from '../notifications/service';
import { applyRawAnnouncement } from './jobs-service';

export interface RunSourceOptions {
  repos: Repos;
  source: SourceDoc;
  trigger: ScrapeRunDoc['trigger'];
  workerId: string;
  /** Testlerde sahte fetcher verilir; üretimde HttpFetcher kullanılır. */
  fetcher?: Fetcher;
  logger?: Logger;
  queueNotifications?: boolean;
  liveFetch?: boolean;
  now?: Date;
  scheduledFor?: string | null;
  /** Adaptörü doğrudan çalıştırmak için (test/kapsam denetimi). */
  adapter?: SourceAdapter;
}

export interface RunSourceResult {
  runId: string;
  sourceKey: string;
  status: ScrapeRunDoc['status'];
  itemsFound: number;
  itemsAccepted: number;
  itemsRejected: number;
  itemsReview: number;
  jobsCreated: number;
  jobsUpdated: number;
  itemsMerged: number;
  revisionsCreated: number;
  notificationsQueued: number;
  durationMs: number;
  notes: string[];
  errors: string[];
  locked: boolean;
}

const LOCK_TTL_PADDING_MS = 90_000;
const ADMIN_WARNING_FAILURE_THRESHOLD = 3;
const KNOWN_ITEMS_LOOKBACK = 5_000;

/** Adaptör sınırları: kaynak tanımından + ortam ayarlarından türetilir. */
export function resolveAdapterLimits(source: SourceDoc): AdapterLimits {
  const env = getEnv();
  const definition = findSourceDefinition(source.adapterKey, source.listingUrl);
  return {
    maxListingPages: definition?.maxListingPages ?? 2,
    timeoutMs: env.SCRAPE_TIMEOUT_MS,
    maxDetailFetches: source.method === 'browser' ? 5 : 25,
    maxDocumentBytes: env.MAX_DOCUMENT_BYTES,
  };
}

/** Daha önce görülmüş kaynak içi kimlikler (pahalı indirmeleri atlamak için). */
export async function loadKnownItemIds(repos: Repos, sourceKey: string): Promise<Set<string>> {
  const links = await repos.store.find('jobSources', { sourceKey }, { limit: KNOWN_ITEMS_LOOKBACK });
  return new Set(links.map((link) => link.sourceItemId));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} zaman aşımına uğradı (${timeoutMs} ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runSourceScrape(options: RunSourceOptions): Promise<RunSourceResult> {
  const env = getEnv();
  const { repos, source, trigger, workerId } = options;
  const now = options.now ?? repos.clock.now();
  const logger = options.logger ?? createLogger('scrape');
  const limits = resolveAdapterLimits(source);
  const lockKey = `scrape:${source.key}`;
  const lockTtl = limits.timeoutMs + LOCK_TTL_PADDING_MS;

  const acquired = await repos.locks.acquire(lockKey, workerId, lockTtl);
  if (!acquired) {
    await repos.runs.markSkipped(source.key, workerId, 'Bu kaynak başka bir worker tarafından taranıyor (kilit alınamadı).');
    logger.warn({ sourceKey: source.key, workerId }, 'kaynak zaten taranıyor; çift tarama engellendi');
    return {
      runId: '',
      sourceKey: source.key,
      status: 'locked',
      itemsFound: 0,
      itemsAccepted: 0,
      itemsRejected: 0,
      itemsReview: 0,
      jobsCreated: 0,
      jobsUpdated: 0,
      itemsMerged: 0,
      revisionsCreated: 0,
      notificationsQueued: 0,
      durationMs: 0,
      notes: ['Kilit alınamadı: başka bir tarama sürüyor.'],
      errors: [],
      locked: true,
    };
  }

  const run = await repos.runs.start({
    sourceKey: source.key,
    trigger,
    workerId,
    scheduledFor: options.scheduledFor ?? null,
  });

  const totals: ScrapeRunTotals = { ...EMPTY_TOTALS, httpStatuses: [], errors: [], notes: [] };
  const notificationCounts = { queued: 0 };
  const startedAt = Date.now();
  let status: ScrapeRunDoc['status'] = 'success';
  let resultMessage = '';
  let fatalError: Error | null = null;

  try {
    const adapter = options.adapter ?? requireAdapter(source.adapterKey);
    const fetcher = options.fetcher ?? new HttpFetcher({ logger });
    const knownItemIds = await loadKnownItemIds(repos, source.key);
    const liveFetch = options.liveFetch ?? env.SOURCE_LIVE_FETCH;

    const ctx: AdapterContext = {
      fetcher,
      logger: logger.child({ sourceKey: source.key }),
      clock: clockAt(now),
      source,
      limits,
      liveFetch,
      knownItemIds,
    };

    const runResult = await withTimeout(adapter.run(ctx), limits.timeoutMs, `${adapter.label} taraması`);
    totals.itemsFound = runResult.items.length;
    totals.httpStatuses = runResult.httpStatuses.slice(0, 50);
    totals.notes = runResult.notes.slice(0, 20);

    if (runResult.notModified) {
      // İçerik değişmemiş: gereksiz işlem yapılmaz, ilanlar korunur.
      status = 'skipped';
      resultMessage = 'Kaynak içeriği değişmemiş (ETag/Last-Modified eşleşti).';
      totals.notes.push(resultMessage);
    }

    for (const item of runResult.items) {
      try {
        const outcome = await processItem(item, { repos, now, workerId, logger });
        if (outcome === 'created') totals.jobsCreated += 1;
        else if (outcome === 'updated') totals.jobsUpdated += 1;
        else if (outcome === 'merged') totals.itemsMerged += 1;
        else if (outcome === 'review') totals.itemsReview += 1;
        else if (outcome === 'rejected') totals.itemsRejected += 1;
        if (outcome === 'created' || outcome === 'updated') totals.itemsAccepted += 1;
        if (outcome === 'created' || outcome === 'updated') totals.revisionsCreated += 1;
        if (outcome === 'created' || outcome === 'updated' || outcome === 'merged' || outcome === 'review') {
          notificationCounts.queued += await notify(item, outcome, {
            repos,
            logger,
            now,
            enabled: options.queueNotifications ?? true,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        totals.errors.push(`${item.url}: ${message}`);
        logger.error({ err: message, url: item.url }, 'ilan işlenemedi');
      }
    }

    if (totals.errors.length > 0) {
      status = 'partial';
      resultMessage = `${totals.errors.length} ilan işlenemedi, ${totals.itemsFound - totals.errors.length} ilan işlendi.`;
    } else if (status !== 'skipped') {
      resultMessage = `${totals.itemsFound} ilan bulundu, ${totals.jobsCreated} yeni kayıt, ${totals.itemsMerged} birleştirme, ${totals.itemsReview} inceleme.`;
    }
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error(String(error));
    const isUnavailable = error instanceof AdapterUnavailableError;
    const isStructure = error instanceof AdapterStructureError;
    status = isUnavailable ? 'skipped' : 'failed';
    resultMessage = isUnavailable
      ? `Kaynak atlandı: ${fatalError.message}`
      : isStructure
        ? `Kaynak yapısı beklenenden farklı (HTML değişmiş olabilir): ${fatalError.message}`
        : `Tarama başarısız: ${fatalError.message}`;
    totals.errors.push(resultMessage);
    logger.error({ err: fatalError.message, sourceKey: source.key }, 'tarama başarısız');
  }

  const finished = await repos.runs.finish(run.id, totals, status, resultMessage);
  const durationMs = Date.now() - startedAt;

  await repos.sources.recordHealth(source.key, {
    lastRunAt: now.toISOString(),
    lastSuccess: fatalError === null && status !== 'skipped',
    durationMs,
    discoveredCount: totals.itemsFound,
    acceptedCount: totals.itemsAccepted,
    errorMessage: fatalError ? fatalError.message : totals.errors[0] ?? null,
    scheduleDelayMs: finished?.scheduleDelayMs ?? null,
    etag: undefined,
    lastModified: undefined,
    contentHash: totals.itemsFound > 0 ? sha256Hex(totals.itemsFound.toString()) : null,
  });

  await warnOnRepeatedFailures({ repos, source, logger, fatalError });

  await repos.locks.release(lockKey, workerId);

  return {
    runId: run.id,
    sourceKey: source.key,
    status,
    itemsFound: totals.itemsFound,
    itemsAccepted: totals.itemsAccepted,
    itemsRejected: totals.itemsRejected,
    itemsReview: totals.itemsReview,
    jobsCreated: totals.jobsCreated,
    jobsUpdated: totals.jobsUpdated,
    itemsMerged: totals.itemsMerged,
    revisionsCreated: totals.revisionsCreated,
    notificationsQueued: notificationCounts.queued,
    durationMs,
    notes: totals.notes,
    errors: totals.errors,
    locked: false,
  };
}

function clockAt(now: Date): Clock {
  return { now: () => now };
}

async function processItem(
  item: RawAnnouncement,
  ctx: { repos: Repos; now: Date; workerId: string; logger: Logger },
): Promise<'created' | 'updated' | 'merged' | 'review' | 'rejected' | 'withdrawal'> {
  const outcome = await applyRawAnnouncement(item, {
    repos: ctx.repos,
    now: ctx.now,
    workerId: ctx.workerId,
    provenance: 'scraped',
  });
  switch (outcome.action) {
    case 'created':
      return 'created';
    case 'updated':
      return 'updated';
    case 'merged':
      return 'merged';
    case 'review':
      return 'review';
    case 'rejected':
      return 'rejected';
    case 'withdrawal-signal':
      return 'withdrawal';
    default:
      return 'review';
  }
}

async function notify(
  item: RawAnnouncement,
  action: 'created' | 'updated' | 'merged' | 'review' | 'rejected' | 'withdrawal',
  ctx: { repos: Repos; logger: Logger; now: Date; enabled: boolean },
): Promise<number> {
  if (!ctx.enabled) return 0;
  if (action !== 'created' && action !== 'updated') return 0;

  const link = await ctx.repos.jobs.findLinkBySourceItem(item.sourceKey, item.sourceItemId);
  const jobId = link?.jobId;
  if (!jobId) return 0;
  const job: JobDoc | null = await ctx.repos.jobs.findById(jobId);
  if (!job) return 0;

  const env = getEnv();
  try {
    const result = await queueNotificationsForJob({
      repos: ctx.repos,
      job,
      kind: action === 'created' ? 'new-job' : 'job-changed',
      baseUrl: env.APP_BASE_URL,
      senderName: env.APP_DISPLAY_NAME,
      now: ctx.now,
    });
    return result.queued;
  } catch (error) {
    // Bildirim kuyruğu hatası tarama sonucunu bozmaz; ilan kaydedilmiştir.
    ctx.logger.error(
      { err: error instanceof Error ? error.message : String(error), jobId },
      'bildirim olayı oluşturulamadı',
    );
    return 0;
  }
}

async function warnOnRepeatedFailures(input: {
  repos: Repos;
  source: SourceDoc;
  logger: Logger;
  fatalError: Error | null;
}): Promise<void> {
  const { repos, source, logger, fatalError } = input;
  const current = await repos.sources.getByKey(source.key);
  const failures = current?.health.consecutiveFailures ?? 0;
  if (!fatalError || failures < ADMIN_WARNING_FAILURE_THRESHOLD) return;

  const message = `${source.name} kaynağı ${failures} kez üst üste başarısız oldu: ${fatalError.message}`;
  logger.warn({ sourceKey: source.key, failures }, message);
  await repos.audit.append({
    actorUserId: null,
    actorRole: 'worker',
    action: 'source.failing',
    targetType: 'source',
    targetId: source.key,
    meta: { failures, error: fatalError.message, lastSuccessAt: current?.health.lastSuccessAt ?? null },
  });
}
