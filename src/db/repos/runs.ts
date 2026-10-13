/**
 * Tarama çalıştırma kayıtları (scrapeRuns) — gözlemlenebilirlik ve kapsam raporu.
 */
import { createId } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { ScrapeRunDoc } from '../schemas';
import { validateDocument } from '../validate';

export interface ScrapeRunTotals {
  itemsFound: number;
  itemsAccepted: number;
  itemsRejected: number;
  itemsReview: number;
  jobsCreated: number;
  jobsUpdated: number;
  itemsMerged: number;
  revisionsCreated: number;
  httpStatuses: number[];
  errors: string[];
  notes: string[];
}

export const EMPTY_TOTALS: ScrapeRunTotals = {
  itemsFound: 0,
  itemsAccepted: 0,
  itemsRejected: 0,
  itemsReview: 0,
  jobsCreated: 0,
  jobsUpdated: 0,
  itemsMerged: 0,
  revisionsCreated: 0,
  httpStatuses: [],
  errors: [],
  notes: [],
};

/** Sorgu sonucunun ilk kaydı (yoksa null). */
async function firstOrNull<T>(promise: Promise<T[]>): Promise<T | null> {
  const rows = await promise;
  return rows[0] ?? null;
}

export class ScrapeRunRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async start(input: {
    sourceKey: string;
    trigger: ScrapeRunDoc['trigger'];
    workerId: string;
    scheduledFor?: string | null;
  }): Promise<ScrapeRunDoc> {
    const now = this.clock.now();
    const scheduleDelayMs = input.scheduledFor
      ? Math.max(0, now.getTime() - new Date(input.scheduledFor).getTime())
      : null;

    const doc: ScrapeRunDoc = {
      id: createId('run'),
      sourceKey: input.sourceKey,
      trigger: input.trigger,
      status: 'running',
      startedAt: now.toISOString(),
      finishedAt: null,
      durationMs: null,
      scheduledFor: input.scheduledFor ?? null,
      scheduleDelayMs,
      itemsFound: 0,
      itemsAccepted: 0,
      itemsRejected: 0,
      itemsReview: 0,
      jobsCreated: 0,
      jobsUpdated: 0,
      itemsMerged: 0,
      revisionsCreated: 0,
      errorCount: 0,
      httpStatuses: [],
      errors: [],
      result: '',
      workerId: input.workerId,
      notes: [],
    };
    validateDocument('scrapeRuns', doc);
    await this.store.insertOne('scrapeRuns', doc);
    return doc;
  }

  async finish(
    runId: string,
    totals: ScrapeRunTotals,
    status: ScrapeRunDoc['status'],
    result: string,
  ): Promise<ScrapeRunDoc | null> {
    const now = this.clock.now();
    const current = await this.store.findOne('scrapeRuns', { id: runId });
    if (!current) return null;
    const durationMs = now.getTime() - new Date(current.startedAt).getTime();

    const updated = await this.store.updateOne(
      'scrapeRuns',
      { id: runId },
      {
        status,
        finishedAt: now.toISOString(),
        durationMs,
        itemsFound: totals.itemsFound,
        itemsAccepted: totals.itemsAccepted,
        itemsRejected: totals.itemsRejected,
        itemsReview: totals.itemsReview,
        jobsCreated: totals.jobsCreated,
        jobsUpdated: totals.jobsUpdated,
        itemsMerged: totals.itemsMerged,
        revisionsCreated: totals.revisionsCreated,
        errorCount: totals.errors.length,
        httpStatuses: totals.httpStatuses.slice(0, 50),
        errors: totals.errors.slice(0, 20),
        result,
        notes: totals.notes.slice(0, 20),
      },
    );
    if (updated) validateDocument('scrapeRuns', updated);
    return updated;
  }

  /**
   * Süreç ölümüyle yarım kalmış "running" kayıtlarını kapatır. Kapatılmazsa
   * panelde sonsuza dek "çalışıyor" görünür ve sağlık özetini kirletirler.
   */
  async closeStaleRunning(thresholdIso: string, reason: string): Promise<number> {
    const stale = await this.store.find(
      'scrapeRuns',
      { status: 'running', startedAt: { $lt: thresholdIso } },
      { limit: 100, sort: [['startedAt', 1]] },
    );
    let closed = 0;
    for (const run of stale) {
      const finished = await this.finish(
        run.id,
        {
          itemsFound: run.itemsFound,
          itemsAccepted: run.itemsAccepted,
          itemsRejected: run.itemsRejected,
          itemsReview: run.itemsReview,
          jobsCreated: run.jobsCreated,
          jobsUpdated: run.jobsUpdated,
          itemsMerged: run.itemsMerged,
          revisionsCreated: run.revisionsCreated,
          httpStatuses: run.httpStatuses,
          errors: [...run.errors, reason].slice(0, 20),
          notes: run.notes,
        },
        'failed',
        reason,
      );
      if (finished) closed += 1;
    }
    return closed;
  }

  /** Kilit alınamadığında/hiç çalıştırılmadığında kayıt (çift tarama görünür olsun). */
  async markSkipped(sourceKey: string, workerId: string, reason: string): Promise<ScrapeRunDoc> {
    const now = this.clock.now().toISOString();
    const doc: ScrapeRunDoc = {
      id: createId('run'),
      sourceKey,
      trigger: 'schedule',
      status: 'locked',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      scheduledFor: null,
      scheduleDelayMs: null,
      itemsFound: 0,
      itemsAccepted: 0,
      itemsRejected: 0,
      itemsReview: 0,
      jobsCreated: 0,
      jobsUpdated: 0,
      itemsMerged: 0,
      revisionsCreated: 0,
      errorCount: 0,
      httpStatuses: [],
      errors: [],
      result: reason,
      workerId,
      notes: [],
    };
    validateDocument('scrapeRuns', doc);
    await this.store.insertOne('scrapeRuns', doc);
    return doc;
  }

  async list(
    filter: { sourceKey?: string; status?: ScrapeRunDoc['status'] } = {},
    limit = 50,
  ): Promise<ScrapeRunDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.sourceKey) query.sourceKey = filter.sourceKey;
    if (filter.status) query.status = filter.status;
    return this.store.find('scrapeRuns', query, { limit, sort: [['startedAt', -1]] });
  }

  async lastRun(sourceKey: string): Promise<ScrapeRunDoc | null> {
    const rows = await this.store.find('scrapeRuns', { sourceKey }, { limit: 1, sort: [['startedAt', -1]] });
    return rows[0] ?? null;
  }

  async recentFailures(limit = 20): Promise<ScrapeRunDoc[]> {
    return this.store.find(
      'scrapeRuns',
      { status: { $in: ['failed', 'partial'] } },
      { limit, sort: [['startedAt', -1]] },
    );
  }

  async summary(): Promise<{
    total: number;
    success: number;
    failed: number;
    skipped: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    avgDurationMs: number;
  }> {
    const [total, success, failed, skipped, lastSuccess, lastFailure] = await Promise.all([
      this.store.count('scrapeRuns', {}),
      this.store.count('scrapeRuns', { status: 'success' }),
      this.store.count('scrapeRuns', { status: { $in: ['failed', 'partial'] } }),
      this.store.count('scrapeRuns', { status: { $in: ['skipped', 'locked'] } }),
      firstOrNull(
        this.store.find('scrapeRuns', { status: 'success' }, { limit: 1, sort: [['startedAt', -1]] }),
      ),
      firstOrNull(
        this.store.find(
          'scrapeRuns',
          { status: { $in: ['failed', 'partial'] } },
          { limit: 1, sort: [['startedAt', -1]] },
        ),
      ),
    ]);

    const recent = await this.store.find(
      'scrapeRuns',
      { durationMs: { $ne: null } },
      { limit: 50, sort: [['startedAt', -1]] },
    );
    const durations = recent.map((run) => run.durationMs ?? 0).filter((value) => value > 0);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0;

    return {
      total,
      success,
      failed,
      skipped,
      lastSuccessAt: lastSuccess?.startedAt ?? null,
      lastFailureAt: lastFailure?.startedAt ?? null,
      avgDurationMs,
    };
  }
}
