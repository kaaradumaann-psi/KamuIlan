/**
 * Kaynak deposu: envanter, sağlık bilgileri ve zamanlama tohumlaması.
 */
import { createId } from '../../domain/ids';
import { slugifyTr } from '../../domain/text';
import type { SourceDefinition } from '../../config/sources';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { SourceDoc } from '../schemas';
import { validateDocument } from '../validate';

export interface SourceHealthUpdate {
  lastRunAt: string;
  lastSuccess: boolean;
  durationMs: number;
  discoveredCount: number;
  acceptedCount: number;
  errorMessage?: string | null;
  scheduleDelayMs?: number | null;
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

export function sourceKeyFor(definition: Pick<SourceDefinition, 'listingUrl' | 'adapterKey' | 'name'>): string {
  try {
    const url = new URL(definition.listingUrl);
    const slug = `${url.hostname}${url.pathname}`.replace(/\/+$/, '');
    const key = slugifyTr(slug);
    if (key) return key.slice(0, 80);
  } catch {
    /* aşağıdaki yedek kullanılır */
  }
  return `${definition.adapterKey}-${slugifyTr(definition.name).slice(0, 40)}`;
}

export class SourceRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Envanteri veritabanına uygular.
   * Yönetici tarafından değiştirilebilir alanlar (enabled, sıklık, eşzamanlılık)
   * yalnızca ilk eklemede yazılır; yönetici kararları korunur.
   */
  async seed(definitions: readonly SourceDefinition[]): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    const now = this.clock.now().toISOString();
    for (const definition of definitions) {
      const key = sourceKeyFor(definition);
      const existing = await this.getByKey(key);
      const codeFields = {
        name: definition.name,
        institution: definition.institution,
        homepageUrl: definition.homepageUrl,
        listingUrl: definition.listingUrl,
        sourceType: definition.sourceType,
        method: definition.method,
        adapterKey: definition.adapterKey,
        allowHosts: definition.allowHosts,
        coverageNotes: definition.coverageNotes,
        statusNote: definition.statusNote,
        status: definition.status,
        verification: definition.verification,
        updatedAt: now,
      };
      if (existing) {
        await this.store.updateOne('sources', { id: existing.id }, codeFields);
        updated += 1;
        continue;
      }
      const doc: SourceDoc = {
        id: createId('src'),
        key,
        ...codeFields,
        enabled: definition.enabled,
        scrapeIntervalMinutes: definition.scrapeIntervalMinutes,
        minRequestIntervalMs: definition.minRequestIntervalMs,
        maxConcurrency: definition.maxConcurrency,
        tags: [...definition.tags],
        health: {
          lastRunAt: null,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          totalRuns: 0,
          totalSuccesses: 0,
          avgDurationMs: 0,
          lastDiscoveredCount: 0,
          lastAcceptedCount: 0,
          lastScheduleDelayMs: null,
          etag: null,
          lastModified: null,
          lastContentHash: null,
          emptyStreak: 0,
        },
        createdAt: now,
      };
      validateDocument('sources', doc);
      await this.store.insertOne('sources', doc);
      created += 1;
    }
    return { created, updated };
  }

  async list(filter: { enabled?: boolean; status?: SourceDoc['status'] } = {}): Promise<SourceDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.enabled !== undefined) query.enabled = filter.enabled;
    if (filter.status) query.status = filter.status;
    return this.store.find('sources', query, { sort: [['name', 1]] });
  }

  async getByKey(key: string): Promise<SourceDoc | null> {
    return this.store.findOne('sources', { key });
  }

  async getById(id: string): Promise<SourceDoc | null> {
    return this.store.findOne('sources', { id });
  }

  async update(key: string, patch: Partial<SourceDoc>): Promise<SourceDoc | null> {
    const updated = await this.store.updateOne('sources', { key }, { ...patch, updatedAt: this.clock.now().toISOString() });
    if (updated) validateDocument('sources', updated);
    return updated;
  }

  /** Tarama sonucunu sağlık alanlarına işler. Hata durumunda ilanlar SİLİNMEZ. */
  async recordHealth(key: string, update: SourceHealthUpdate): Promise<SourceDoc | null> {
    const current = await this.getByKey(key);
    if (!current) return null;
    const health = current.health;
    const totalRuns = health.totalRuns + 1;
    const totalSuccesses = health.totalSuccesses + (update.lastSuccess ? 1 : 0);
    const avgDurationMs =
      health.avgDurationMs === 0
        ? update.durationMs
        : Math.round((health.avgDurationMs * health.totalRuns + update.durationMs) / totalRuns);
    const emptyStreak = update.discoveredCount === 0 && update.lastSuccess ? health.emptyStreak + 1 : 0;
    const now = this.clock.now().toISOString();
    const patch = {
      'health.lastRunAt': update.lastRunAt,
      'health.totalRuns': totalRuns,
      'health.totalSuccesses': totalSuccesses,
      'health.avgDurationMs': avgDurationMs,
      'health.lastDiscoveredCount': update.discoveredCount,
      'health.lastAcceptedCount': update.acceptedCount,
      'health.emptyStreak': emptyStreak,
      'health.consecutiveFailures': update.lastSuccess ? 0 : health.consecutiveFailures + 1,
      'health.lastSuccessAt': update.lastSuccess ? update.lastRunAt : health.lastSuccessAt,
      'health.lastErrorAt': update.lastSuccess ? health.lastErrorAt : now,
      'health.lastErrorMessage': update.lastSuccess ? null : (update.errorMessage ?? 'Bilinmeyen hata'),
      'health.lastScheduleDelayMs': update.scheduleDelayMs ?? health.lastScheduleDelayMs,
      'health.etag': update.etag !== undefined ? update.etag : health.etag,
      'health.lastModified': update.lastModified !== undefined ? update.lastModified : health.lastModified,
      'health.lastContentHash': update.contentHash !== undefined ? update.contentHash : health.lastContentHash,
      updatedAt: now,
    };
    return this.store.updateOne('sources', { key }, patch);
  }

  /** Tüm kaynakların sağlık özetini tek çağrıda verir (yönetici paneli). */
  async healthOverview(): Promise<
    { key: string; name: string; status: SourceDoc['status']; enabled: boolean; health: SourceDoc['health'] }[]
  > {
    const sources = await this.list();
    return sources.map((source) => ({
      key: source.key,
      name: source.name,
      status: source.status,
      enabled: source.enabled,
      health: source.health,
    }));
  }
}
