/**
 * Kaynak deposu: envanter kayıtları, sağlık bilgileri ve kapsam özeti.
 */
import { isDeepStrictEqual } from 'node:util';
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
  /**
   * Tarama "atlandı" (ör. adaptör için gereken tarayıcı çalışma zamanı yok,
   * kaynak erişim kısıtlı). Atlama bir KAYNAK HATASI DEĞİLDİR: hata sayacını
   * artırmaz, "üst üste başarısız" uyarısını tetiklemez; ayrı sayılır.
   */
  skipped?: boolean;
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
    coverageStatus: 'complete' | 'partial' | 'unknown';
    coverageNote: string;
  } | null;
}

export class SourceRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Envanteri veritabanıyla eşitler (idempotent); mevcut kayıtları tek sorguda yükler. */
  async seed(definitions: readonly SourceDefinition[] = SOURCE_DEFINITIONS): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    const now = this.clock.now().toISOString();
    const existingRows = definitions.length
      ? await this.store.find('sources', { key: { $in: definitions.map((definition) => definition.key) } }, { limit: definitions.length })
      : [];
    const existingByKey = new Map(existingRows.map((source) => [source.key, source]));

    for (const definition of definitions) {
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
      };
      const existing = existingByKey.get(definition.key);

      if (existing) {
        const current = {
          name: existing.name,
          institution: existing.institution,
          homepageUrl: existing.homepageUrl,
          listingUrl: existing.listingUrl,
          sourceType: existing.sourceType,
          method: existing.method,
          adapterKey: existing.adapterKey,
          status: existing.status,
          statusNote: existing.statusNote,
          verification: existing.verification,
          coverageNotes: existing.coverageNotes,
          allowHosts: existing.allowHosts,
          tags: existing.tags,
        };
        if (!isDeepStrictEqual(current, shared)) {
          await this.store.updateOne('sources', { key: definition.key }, { ...shared, updatedAt: now });
          updated += 1;
        }
        continue;
      }

      const doc: SourceDoc = {
        id: createId('src'),
        key: definition.key,
        ...shared,
        updatedAt: now,
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
          consecutiveSkips: 0,
          lastWarningAt: null,
        },
        createdAt: now,
      } as SourceDoc;
      validateDocument('sources', doc);
      await this.store.insertOne('sources', doc);
      existingByKey.set(definition.key, doc);
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
    const updated = await this.store.updateOne(
      'sources',
      { key },
      { ...rest, updatedAt: this.clock.now().toISOString() },
    );
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
  /**
   * Yönetici uyarısının zamanını yazar.
   *
   * Neden ayrı alan: 1 dakikalık test taramasında aynı kaynak için her dakika
   * denetim kaydı ve uyarı üretilirse panel ve log okunamaz hale gelir. Uyarı
   * üretimi bu damgayla sınırlanır (bkz. pipeline SOURCE_WARNING_REPEAT_MS).
   */
  async recordWarning(key: string, at: string): Promise<SourceDoc | null> {
    const updated = await this.store.updateOne(
      'sources',
      { key },
      { 'health.lastWarningAt': at, updatedAt: at },
    );
    if (updated) validateDocument('sources', updated);
    return updated;
  }

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
      // Atlama da bir başarısızlıktır (kaynak toplanamıyor); ayrıca kaç kez
      // üst üste atlandığı izlenir ki panelde "atlanıyor" ile "hata" ayırt edilsin.
      'health.consecutiveFailures': update.success ? 0 : health.consecutiveFailures + 1,
      'health.consecutiveSkips': update.success ? 0 : update.skipped ? health.consecutiveSkips + 1 : 0,
      'health.lastSuccessAt': update.success ? update.lastRunAt : health.lastSuccessAt,
      'health.lastErrorAt': update.success ? health.lastErrorAt : now,
      'health.lastErrorMessage': update.success
        ? null
        : (update.errorMessage ?? health.lastErrorMessage ?? 'Bilinmeyen hata'),
      'health.lastScheduleDelayMs': update.scheduleDelayMs ?? health.lastScheduleDelayMs,
      'health.etag': update.etag !== undefined ? update.etag : health.etag,
      'health.lastModified': update.lastModified !== undefined ? update.lastModified : health.lastModified,
      'health.lastContentHash':
        update.contentHash !== undefined ? update.contentHash : health.lastContentHash,
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
      /** Hazır adaptörü olan ama canlı doğrulaması olmayan kaynak sayısı. */
      built: number;
      failing: number;
      stale: number;
      planned: number;
    };
  }> {
    const allSources = await this.store.find('sources', {}, { sort: [['name', 1]] });
    // Demo/örnek veri kaydı gerçek bir tarama kaynağı değildir; kapsam sayılarına
    // girmez (seed:demo bunu coverageNote alanında taahhüt ediyor).
    const sources = allSources.filter((source) => !source.tags.includes('demo'));
    const scheduledTasks = await this.store.find('scheduledTasks', { kind: 'source-scrape' }, { limit: 500 });
    const scheduledIntervals = new Map(scheduledTasks.map((task) => [task.sourceKey, task.intervalMinutes]));
    const entries: SourceCoverageEntry[] = [];
    const staleThreshold = this.clock.now().getTime() - 6 * 3_600_000;
    let failing = 0;
    let stale = 0;

    for (const source of sources) {
      const lastRunRows = await this.store.find(
        'scrapeRuns',
        { sourceKey: source.key },
        { limit: 1, sort: [['startedAt', -1]] },
      );
      const lastRun = lastRunRows[0] ?? null;
      // Son deneme değil, son gerçek başarı belirleyicidir: başarısız/atlanan
      // deneme kaynağı "yakın zamanda tarandı" gibi gösteremez.
      const isStale = !source.health.lastSuccessAt || Date.parse(source.health.lastSuccessAt) < staleThreshold;
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
        intervalMinutes: scheduledIntervals.get(source.key) ?? source.scrapeIntervalMinutes,
        health: source.health,
        lastRun: lastRun
          ? {
              startedAt: lastRun.startedAt,
              status: lastRun.status,
              itemsFound: lastRun.itemsFound,
              errorCount: lastRun.errorCount,
              result: lastRun.result,
              coverageStatus: lastRun.coverageStatus ?? 'unknown',
              coverageNote: lastRun.coverageNote ?? 'Eski tarama kaydı; kapsam bilinmiyor.',
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
        // "Hazırlanan": adaptörü var ama henüz canlı doğrulaması yapılmamış kaynak.
        built: entries.filter((entry) => entry.built && !entry.verified).length,
        failing,
        stale,
        planned: PLANNED_SOURCES.length,
      },
    };
  }
}
