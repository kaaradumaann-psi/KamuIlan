/**
 * Kaynak deposu: envanter kayıtları, sağlık bilgileri ve kapsam özeti.
 */
import { createId } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { SourceDoc } from '../schemas';
import { validateDocument } from '../validate';
import type { SourceDefinition } from '../../config/sources';
import { PLANNED_SOURCES, SOURCE_DEFINITIONS } from '../../config/sources';

export interface SourceHealthUpdate {
  lastRunAt: string;
  success: boolean;
  durationMs: number;
  discoveredCount: number;
  acceptedCount: number;
  errorMessage?: string | null;
  scheduleDelayMs?: number | null;
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
  /** Kaynak 304 döndürdü: "boş tarama" sayılmaz (emptyStreak artırılmaz). */
  contentUnchanged?: boolean;
}

export interface SourceCoverageEntry {
  key: string;
  name: string;
  institution: string;
  group: string;
  status: SourceDoc['status'];
  statusNote: string;
  enabled: boolean;
  /** Canlı doğrulama kanıtı var mı? */
  verified: boolean;
  /** Adaptör yazıldı mı (henüz canlı doğrulanmamış olabilir)? */
  built: boolean;
  lastVerifiedAt: string | null;
  verificationEvidence: string;
  coverageNote: string;
  intervalMinutes: number;
  health: SourceDoc['health'];
  lastRun: {
    startedAt: string;
    status: string;
    itemsFound: number;
    errorCount: number;
    result: string;
  } | null;
}

export class SourceRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Envanteri veritabanıyla eşitler (idempotent). */
  async seed(definitions: readonly SourceDefinition[] = SOURCE_DEFINITIONS): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    const now = this.clock.now().toISOString();

    for (const definition of definitions) {
      const existing = await this.store.findOne('sources', { key: definition.key });
      const shared = {
        name: definition.name,
        institution: definition.institution,
        homepageUrl: definition.homepageUrl,
        listingUrl: definition.listingUrl,
        sourceType: definition.sourceType,
        method: definition.method,
        adapterKey: definition.adapterKey,
        status: definition.status,
        statusNote: definition.statusNote,
        verification: {
          verified: definition.status === 'verified',
          built: definition.status === 'verified' || definition.status === 'scraper-built',
          verifiedAt: definition.lastVerifiedAt,
          method: definition.method,
          evidence: definition.verificationEvidence,
          scope: definition.coverageNote,
        },
        coverageNotes: definition.coverageNote,
        allowHosts: definition.allowedHosts,
        tags: definition.tags,
        updatedAt: now,
      };

      if (existing) {
        await this.store.updateOne('sources', { key: definition.key }, shared);
        updated += 1;
        continue;
      }

      const doc: SourceDoc = {
        id: createId('src'),
        key: definition.key,
        ...shared,
        enabled: definition.enabled,
        scrapeIntervalMinutes: definition.intervalMinutes,
        minRequestIntervalMs: definition.minRequestIntervalMs,
        maxConcurrency: definition.maxConcurrency,
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
      } as SourceDoc;
      validateDocument('sources', doc);
      await this.store.insertOne('sources', doc);
      created += 1;
    }

    return { created, updated };
  }

  async list(): Promise<SourceDoc[]> {
    return this.store.find('sources', {}, { sort: [['name', 1]] });
  }

  async listEnabled(): Promise<SourceDoc[]> {
    return this.store.find('sources', { enabled: true }, { sort: [['name', 1]] });
  }

  async getByKey(key: string): Promise<SourceDoc | null> {
    return this.store.findOne('sources', { key });
  }

  async getById(id: string): Promise<SourceDoc | null> {
    return this.store.findOne('sources', { id });
  }

  async update(key: string, patch: Partial<SourceDoc>): Promise<SourceDoc | null> {
    const { id: _id, key: _key, createdAt: _createdAt, ...rest } = patch;
    const updated = await this.store.updateOne('sources', { key }, { ...rest, updatedAt: this.clock.now().toISOString() });
    if (updated) validateDocument('sources', updated, 'skip');
    return updated;
  }

  async setEnabled(key: string, enabled: boolean): Promise<SourceDoc | null> {
    return this.update(key, { enabled });
  }

  async setStatus(key: string, status: SourceDoc['status'], statusNote?: string): Promise<SourceDoc | null> {
    return this.update(key, statusNote === undefined ? { status } : { status, statusNote });
  }

  /**
   * Tarama sonucunu sağlık alanlarına işler.
   *
   * ÖNEMLİ: bu metot hiçbir koşulda ilanları silmez/etkilemez. Kaynak erişilemezse
   * yalnızca sağlık bilgisi (başarısız deneme, hata mesajı, ardışık hata sayısı)
   * güncellenir; mevcut ilanlar olduğu gibi kalır.
   */
  async recordHealth(key: string, update: SourceHealthUpdate): Promise<SourceDoc | null> {
    const current = await this.getByKey(key);
    if (!current) return null;
    const health = current.health;
    const now = this.clock.now().toISOString();
    const totalRuns = health.totalRuns + 1;
    const totalSuccesses = health.totalSuccesses + (update.success ? 1 : 0);
    const avgDurationMs =
      health.avgDurationMs === 0
        ? update.durationMs
        : Math.round((health.avgDurationMs * health.totalRuns + update.durationMs) / totalRuns);

    const patch = {
      'health.lastRunAt': update.lastRunAt,
      'health.totalRuns': totalRuns,
      'health.totalSuccesses': totalSuccesses,
      'health.avgDurationMs': avgDurationMs,
      'health.lastDiscoveredCount': update.discoveredCount,
      'health.lastAcceptedCount': update.acceptedCount,
      'health.consecutiveFailures': update.success ? 0 : health.consecutiveFailures + 1,
      'health.lastSuccessAt': update.success ? update.lastRunAt : health.lastSuccessAt,
      'health.lastErrorAt': update.success ? health.lastErrorAt : now,
      'health.lastErrorMessage': update.success ? null : (update.errorMessage ?? health.lastErrorMessage ?? 'Bilinmeyen hata'),
      'health.lastScheduleDelayMs': update.scheduleDelayMs ?? health.lastScheduleDelayMs,
      'health.etag': update.etag !== undefined ? update.etag : health.etag,
      'health.lastModified': update.lastModified !== undefined ? update.lastModified : health.lastModified,
      'health.lastContentHash': update.contentHash !== undefined ? update.contentHash : health.lastContentHash,
      'health.emptyStreak': update.contentUnchanged
        ? health.emptyStreak
        : update.discoveredCount === 0 && update.success
          ? health.emptyStreak + 1
          : 0,
      updatedAt: now,
    };

    return this.store.updateOne('sources', { key }, patch);
  }

  /** Kapsam raporu: entegre kaynaklar + henüz entegre edilmemiş hedefler. */
  async coverage(): Promise<{
    sources: SourceCoverageEntry[];
    planned: typeof PLANNED_SOURCES;
    summary: {
      total: number;
      enabled: number;
      verified: number;
      built: number;
      failing: number;
      stale: number;
      planned: number;
    };
  }> {
    const sources = await this.store.find('sources', {}, { sort: [['name', 1]] });
    const entries: SourceCoverageEntry[] = [];
    const staleThreshold = Date.now() - 6 * 3_600_000;
    let failing = 0;
    let stale = 0;

    for (const source of sources) {
      const lastRunRows = await this.store.find(
        'scrapeRuns',
        { sourceKey: source.key },
        { limit: 1, sort: [['startedAt', -1]] },
      );
      const lastRun = lastRunRows[0] ?? null;
      const isStale = !source.health.lastRunAt || Date.parse(source.health.lastRunAt) < staleThreshold;
      if (source.health.consecutiveFailures > 0) failing += 1;
      if (source.enabled && isStale) stale += 1;
      entries.push({
        key: source.key,
        name: source.name,
        institution: source.institution,
        group: source.tags[0] ?? 'diger',
        status: source.status,
        statusNote: source.statusNote,
        enabled: source.enabled,
        verified: source.verification.verified,
        built: source.verification.built,
        lastVerifiedAt: source.verification.verifiedAt,
        verificationEvidence: source.verification.evidence,
        coverageNote: source.coverageNotes,
        intervalMinutes: source.scrapeIntervalMinutes,
        health: source.health,
        lastRun: lastRun
          ? {
              startedAt: lastRun.startedAt,
              status: lastRun.status,
              itemsFound: lastRun.itemsFound,
              errorCount: lastRun.errorCount,
              result: lastRun.result,
            }
          : null,
      });
    }

    return {
      sources: entries,
      planned: PLANNED_SOURCES,
      summary: {
        total: entries.length,
        enabled: entries.filter((entry) => entry.enabled).length,
        verified: entries.filter((entry) => entry.verified).length,
        built: entries.filter((entry) => entry.built).length,
        failing,
        stale,
        planned: PLANNED_SOURCES.length,
      },
    };
  }
}
