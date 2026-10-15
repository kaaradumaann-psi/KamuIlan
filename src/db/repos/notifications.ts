/**
 * Bildirim tercihleri ve bildirim olayları.
 *
 * Idempotency: her (kullanıcı, ilan, tür[, sürüm]) için deterministik anahtar
 * üretilir; benzersiz indeks sayesinde aynı olay ikinci kez oluşturulamaz.
 * Böylece aynı ilan için iki kez e-posta gönderilemez.
 */
import { createId, sha256Hex } from '../../domain/ids';
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

export const EMPTY_CANDIDATE_PROFILE: NotificationPreferenceDoc['candidateProfile'] = {
  profession: '',
  educationLevel: null,
  departments: [],
  skills: [],
  experienceYears: null,
};

/** (kullanıcı, ilan, tür, sürüm) → benzersiz anahtar. */
export function eventIdempotencyKey(input: {
  userId: string;
  jobId: string;
  kind: NotificationEventDoc['kind'];
  jobVersion?: number;
}): string {
  const parts = [
    input.userId,
    input.jobId,
    input.kind,
    input.kind === 'job-changed' ? String(input.jobVersion ?? 0) : '',
  ];
  return sha256Hex(parts.join('|')).slice(0, 48);
}

export class NotificationRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async getPreference(userId: string): Promise<NotificationPreferenceDoc | null> {
    const preference = await this.store.findOne('notificationPreferences', { userId });
    if (!preference) return null;
    // Legacy records predate profile matching; default them to opt-out and do
    // not treat missing data as consent or as an empty-list schema failure.
    return {
      ...preference,
      aiConsentAt: preference.aiConsentAt ?? null,
      profilePersonalizationEnabled: preference.profilePersonalizationEnabled ?? false,
      candidateProfile: { ...EMPTY_CANDIDATE_PROFILE, ...(preference.candidateProfile ?? {}) },
    };
  }

  /** Tercih yoksa varsayılanlarla oluşturur; varsa yalnızca verilen alanları günceller. */
  async upsertPreference(
    userId: string,
    input: Partial<
      Omit<
        NotificationPreferenceDoc,
        'id' | 'userId' | 'createdAt' | 'updatedAt' | 'filters' | 'candidateProfile'
      >
    > & {
      filters?: Partial<PreferenceFilters>;
      candidateProfile?: Partial<NotificationPreferenceDoc['candidateProfile']>;
    },
  ): Promise<NotificationPreferenceDoc> {
    const now = this.clock.now().toISOString();
    const existing = await this.getPreference(userId);

    if (existing) {
      const filters: PreferenceFilters = { ...existing.filters, ...(input.filters ?? {}) };
      const candidateProfile = {
        ...EMPTY_CANDIDATE_PROFILE,
        ...existing.candidateProfile,
        ...(input.candidateProfile ?? {}),
      };
      const patch = {
        ...input,
        filters,
        candidateProfile,
        profilePersonalizationEnabled:
          input.profilePersonalizationEnabled ?? existing.profilePersonalizationEnabled ?? false,
        updatedAt: now,
      };
      const updated = await this.store.updateOne('notificationPreferences', { userId }, patch);
      if (!updated) throw new Error('Bildirim tercihi güncellenemedi.');
      validateDocument('notificationPreferences', updated);
      return updated;
    }

    const doc: NotificationPreferenceDoc = {
      id: createId('npr'),
      userId,
      // A profile-only update or pause request must never subscribe someone by default.
      // Email is opt-in; the Panel sends `enabled: true` only after an explicit user action.
      enabled: input.enabled ?? false,
      paused: input.paused ?? false,
      mode: input.mode ?? 'instant',
      onlyNewJobs: input.onlyNewJobs ?? true,
      notifyOnChanges: input.notifyOnChanges ?? true,
      includeWorkerJobs: input.includeWorkerJobs ?? true,
      includeAcademicJobs: input.includeAcademicJobs ?? true,
      profilePersonalizationEnabled: input.profilePersonalizationEnabled ?? false,
      aiConsentAt: input.aiConsentAt ?? null,
      candidateProfile: { ...EMPTY_CANDIDATE_PROFILE, ...(input.candidateProfile ?? {}) },
      filters: { ...EMPTY_FILTERS, ...(input.filters ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    validateDocument('notificationPreferences', doc);
    await this.store.insertOne('notificationPreferences', doc);
    return doc;
  }

  /** Bildirim alabilecek (kapalı/duraklatılmış olmayan) tercihler. */
  async listNotifiable(cursorUserId?: string, limit = 200): Promise<NotificationPreferenceDoc[]> {
    const filter: Record<string, unknown> = { enabled: true, paused: false };
    if (cursorUserId) filter.userId = { $gt: cursorUserId };
    return this.store.find('notificationPreferences', filter, { limit, sort: [['userId', 1]] });
  }

  async countNotifiable(): Promise<number> {
    return this.store.count('notificationPreferences', { enabled: true, paused: false });
  }

  /** Olayı yalnızca bir kez oluşturur. */
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

  async markEvent(
    eventId: string,
    status: NotificationEventDoc['status'],
    reason?: string | null,
  ): Promise<void> {
    await this.store.updateOne(
      'notificationEvents',
      { id: eventId },
      {
        status,
        suppressionReason: reason ?? null,
      },
    );
  }

  async listEventsForUser(userId: string, limit = 50): Promise<NotificationEventDoc[]> {
    return this.store.find('notificationEvents', { userId }, { limit, sort: [['createdAt', -1]] });
  }

  async listEventsForJob(jobId: string): Promise<NotificationEventDoc[]> {
    return this.store.find('notificationEvents', { jobId }, { limit: 500, sort: [['createdAt', -1]] });
  }

  async eventStats(): Promise<{ created: number; queued: number; suppressed: number; failed: number }> {
    const [created, queued, suppressed, failed] = await Promise.all([
      this.store.count('notificationEvents', { status: 'created' }),
      this.store.count('notificationEvents', { status: 'queued' }),
      this.store.count('notificationEvents', { status: 'suppressed' }),
      this.store.count('notificationEvents', { status: 'failed' }),
    ]);
    return { created, queued, suppressed, failed };
  }
}
