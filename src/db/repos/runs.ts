/**
 * Tarama kayıtları (scrapeRuns) — gözlemlenebilirlik ve kapsam raporu için.
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
    const scheduleDelayMs = input.scheduledFor ? Math.max(0, now.getTime() - new Date(input.scheduledFor).getTime()) : null;
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
    const updated = await this.store.updateOne('scrapeRuns', { id: runId }, {
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
      httpStatuses: totals.httpStatuses,
      errors: totals.errors.slice(0, 20),
      result,
      notes: totals.notes.slice(0, 20),
    });
    if (updated) validateDocument('scrapeRuns', updated);
    return updated;
  }

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

  async list(filter: { sourceKey?: string; status?: ScrapeRunDoc['status'] } = {}, limit = 50): Promise<ScrapeRunDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.sourceKey) query.sourceKey = filter.sourceKey;
    if (filter.status) query.status = filter.status;
    return this.store.find('scrapeRuns', query, { limit, sort: [['startedAt', -1]] });
  }

  async lastRun(sourceKey: string): Promise<ScrapeRunDoc | null> {
    const rows = await this.list({ sourceKey }, 1);
    return rows[0] ?? null;
  }

  async recentFailures(limit = 20): Promise<ScrapeRunDoc[]> {
    return this.store.find('scrapeRuns', { status: { $in: ['failed', 'partial'] } }, { limit, sort: [['startedAt', -1]] });
  }
}
