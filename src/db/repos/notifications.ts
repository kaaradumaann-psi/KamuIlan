/**
 * Bildirim tercihleri ve bildirim olayları.
 *
 * Idempotency: her (kullanıcı, ilan, tür [, sürüm]) için benzersiz anahtar
 * üretilir. Benzersiz indeks sayesinde aynı olay iki kez oluşturulamaz —
 * dolayısıyla aynı ilan için ikinci e-posta gönderilmez.
 */
import { createId, sha256Hex } from '../../domain/ids';
import { normalizeTr } from '../../domain/text';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { NotificationEventDoc, NotificationPreferenceDoc } from '../schemas';
import { validateDocument } from '../validate';

export interface PreferenceFilters {
  keywords: string[];
  titles: string[];
  institutions: string[];
  cities: string[];
  employmentTypes: NotificationPreferenceDoc['filters']['employmentTypes'];
  educationLevels: NotificationPreferenceDoc['filters']['educationLevels'];
  departments: string[];
  kpssScoreTypes: NotificationPreferenceDoc['filters']['kpssScoreTypes'];
  kpssMinScore: number | null;
  minDaysUntilDeadline: number | null;
}

export const EMPTY_FILTERS: PreferenceFilters = {
  keywords: [],
  titles: [],
  institutions: [],
  cities: [],
  employmentTypes: [],
  educationLevels: [],
  departments: [],
  kpssScoreTypes: [],
  kpssMinScore: null,
  minDaysUntilDeadline: null,
};

export function eventIdempotencyKey(input: {
  userId: string;
  jobId: string;
  kind: NotificationEventDoc['kind'];
  jobVersion?: number;
}): string {
  const parts = [input.userId, input.jobId, input.kind, input.kind === 'job-changed' ? String(input.jobVersion ?? 0) : ''];
  return sha256Hex(parts.join('|')).slice(0, 48);
}

export class NotificationRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async getPreference(userId: string): Promise<NotificationPreferenceDoc | null> {
    return this.store.findOne('notificationPreferences', { userId });
  }

  async upsertPreference(
    userId: string,
    input: Omit<
      Partial<NotificationPreferenceDoc>,
      'id' | 'userId' | 'createdAt' | 'updatedAt' | 'filters'
    > & {
      /** Filtreler kısmi verilebilir; verilmeyen alanlar mevcut/korunur. */
      filters?: Partial<PreferenceFilters>;
    },
  ): Promise<NotificationPreferenceDoc> {
    const now = this.clock.now().toISOString();
    const existing = await this.getPreference(userId);
    if (existing) {
      const filters: PreferenceFilters = { ...existing.filters, ...(input.filters ?? {}) };
      const patch = { ...input, filters, updatedAt: now };
      const updated = await this.store.updateOne('notificationPreferences', { userId }, patch);
      validateDocument('notificationPreferences', updated);
      return updated as NotificationPreferenceDoc;
    }
    const doc: NotificationPreferenceDoc = {
      id: createId('npr'),
      userId,
      enabled: input.enabled ?? true,
      paused: input.paused ?? false,
      mode: input.mode ?? 'instant',
      onlyNewJobs: input.onlyNewJobs ?? true,
      notifyOnChanges: input.notifyOnChanges ?? true,
      includeWorkerJobs: input.includeWorkerJobs ?? true,
      includeAcademicJobs: input.includeAcademicJobs ?? true,
      filters: { ...EMPTY_FILTERS, ...(input.filters ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    validateDocument('notificationPreferences', doc);
    await this.store.insertOne('notificationPreferences', doc);
    return doc;
  }

  /** Bildirim gönderilebilecek (aktif, duraklatılmamış) tercihler. */
  async listNotifiable(cursorUserId?: string, limit = 200): Promise<NotificationPreferenceDoc[]> {
    const filter: Record<string, unknown> = { enabled: true, paused: false };
    if (cursorUserId) filter.userId = { $gt: cursorUserId };
    return this.store.find('notificationPreferences', filter, { limit, sort: [['userId', 1]] });
  }

  async recordEvent(input: {
    userId: string;
    jobId: string;
    kind: NotificationEventDoc['kind'];
    jobVersion: number;
    matchedOn: string[];
  }): Promise<{ event: NotificationEventDoc; created: boolean }> {
    const now = this.clock.now().toISOString();
    const doc: NotificationEventDoc = {
      id: createId('nev'),
      userId: input.userId,
      jobId: input.jobId,
      kind: input.kind,
      jobVersion: input.jobVersion,
      idempotencyKey: eventIdempotencyKey({
        userId: input.userId,
        jobId: input.jobId,
        kind: input.kind,
        jobVersion: input.jobVersion,
      }),
      status: 'created',
      suppressionReason: null,
      matchedOn: input.matchedOn,
      createdAt: now,
    };
    validateDocument('notificationEvents', doc);
    const result = await this.store.insertIfAbsent('notificationEvents', doc);
    return { event: result.document, created: result.inserted };
  }

  async markEvent(eventId: string, status: NotificationEventDoc['status'], reason?: string | null): Promise<void> {
    await this.store.updateOne('notificationEvents', { id: eventId }, {
      status,
      suppressionReason: reason ?? null,
    });
  }

  async listEventsForUser(userId: string, limit = 50): Promise<NotificationEventDoc[]> {
    return this.store.find('notificationEvents', { userId }, { limit, sort: [['createdAt', -1]] });
  }

  async listEventsForJob(jobId: string): Promise<NotificationEventDoc[]> {
    return this.store.find('notificationEvents', { jobId }, { limit: 500 });
  }
}

/** Tercihleri okunabilir bir özet metne çevirir (e-posta "hangi kriter" satırı). */
export function describeFilters(filters: PreferenceFilters): string[] {
  const parts: string[] = [];
  if (filters.keywords.length) parts.push(`anahtar kelime: ${filters.keywords.join(', ')}`);
  if (filters.titles.length) parts.push(`unvan: ${filters.titles.join(', ')}`);
  if (filters.institutions.length) parts.push(`kurum: ${filters.institutions.join(', ')}`);
  if (filters.cities.length) parts.push(`il: ${filters.cities.join(', ')}`);
  if (filters.employmentTypes.length) parts.push(`istihdam türü: ${filters.employmentTypes.length} seçim`);
  if (filters.educationLevels.length) parts.push(`öğrenim: ${filters.educationLevels.length} seçim`);
  if (filters.departments.length) parts.push(`bölüm: ${filters.departments.join(', ')}`);
  if (filters.kpssScoreTypes.length) parts.push(`KPSS puan türü: ${filters.kpssScoreTypes.join(', ')}`);
  if (filters.kpssMinScore !== null) parts.push(`en az ${filters.kpssMinScore} KPSS puanı`);
  if (filters.minDaysUntilDeadline !== null) parts.push(`son başvuruya en az ${filters.minDaysUntilDeadline} gün`);
  return parts.length > 0 ? parts : ['tüm kamu personel ilanları'];
}

export function normalizeFilterValues(values: string[]): string[] {
  return values.map((value) => normalizeTr(value)).filter(Boolean);
}
