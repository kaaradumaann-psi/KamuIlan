/**
 * İlan deposu: tekilleştirilmiş ilanlar, kaynak bağları, sürüm geçmişi ve arama.
 */
import { createId } from '../../domain/ids';
import { lowerTr, normalizeTr } from '../../domain/text';
import { toIstanbulDateOnly } from '../../domain/dates';
import type { JobStatus } from '../../domain';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { JobDoc, JobRevisionDoc, JobSourceDoc } from '../schemas';
import { validateDocument } from '../validate';
import type { Query, SortSpec } from '../query';

export interface JobSearchFilters {
  q?: string;
  institution?: string[];
  titles?: string[];
  cities?: string[];
  employmentTypes?: string[];
  educationLevels?: string[];
  departments?: string[];
  kpssScoreTypes?: string[];
  sourceKeys?: string[];
  status?: JobStatus[];
  /** Başvuru bitiş tarihi (YYYY-MM-DD) aralığı. */
  deadlineFrom?: string;
  deadlineTo?: string;
  createdFrom?: string;
  createdTo?: string;
  publishedFrom?: string;
  publishedTo?: string;
}

export type JobSort = 'newest' | 'deadline' | 'published' | 'institution' | 'title';

const SORTS: Record<JobSort, SortSpec> = {
  newest: [
    ['createdAt', -1],
    ['id', -1],
  ],
  deadline: [
    ['applicationEndDate', 1],
    ['createdAt', -1],
  ],
  published: [
    ['publishedAt', -1],
    ['createdAt', -1],
  ],
  institution: [
    ['institutionNormalized', 1],
    ['createdAt', -1],
  ],
  title: [
    ['titleNormalized', 1],
    ['createdAt', -1],
  ],
};

export interface JobSearchResult {
  items: JobDoc[];
  total: number;
  page: number;
  pageSize: number;
}

export class JobRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async findById(id: string): Promise<JobDoc | null> {
    return this.store.findOne('jobs', { id });
  }

  async findByDedupeKey(dedupeKey: string): Promise<JobDoc | null> {
    return this.store.findOne('jobs', { dedupeKey });
  }

  async findByNormalizedUrl(normalizedUrl: string): Promise<JobDoc | null> {
    return this.store.findOne('jobs', { normalizedUrl });
  }

  /**
   * Aynı ilan metnini/başlığını taşıyan adayları bulur (tekilleştirme adımı 4).
   * Tam eşleşme değil, aday listesidir; karar dedupe motorunda verilir.
   */
  async findDedupeCandidates(params: {
    institutionNormalized: string;
    titleNormalized: string;
    applicationEndDate?: string | null;
    limit?: number;
  }): Promise<JobDoc[]> {
    const direct = await this.store.find('jobs', {
      institutionNormalized: params.institutionNormalized,
      titleNormalized: params.titleNormalized,
    }, { limit: params.limit ?? 5 });
    if (direct.length > 0) return direct;
    return this.store.find(
      'jobs',
      {
        institutionNormalized: params.institutionNormalized,
        applicationEndDate: params.applicationEndDate ?? null,
      },
      { limit: params.limit ?? 5, sort: [['createdAt', -1]] },
    );
  }

  async insertJob(doc: JobDoc): Promise<{ job: JobDoc; created: boolean }> {
    validateDocument('jobs', doc);
    const result = await this.store.insertIfAbsent('jobs', doc);
    return { job: result.document, created: result.inserted };
  }

  async updateJob(jobId: string, patch: Record<string, unknown>): Promise<JobDoc | null> {
    const updated = await this.store.updateOne('jobs', { id: jobId }, {
      ...patch,
      updatedAt: this.clock.now().toISOString(),
    });
    if (updated) validateDocument('jobs', updated);
    return updated;
  }

  async addSourceLink(doc: JobSourceDoc): Promise<{ link: JobSourceDoc; created: boolean }> {
    validateDocument('jobSources', doc);
    const result = await this.store.insertIfAbsent('jobSources', doc);
    return { link: result.document, created: result.inserted };
  }

  async listSourceLinks(jobId: string): Promise<JobSourceDoc[]> {
    return this.store.find('jobSources', { jobId }, { sort: [['firstSeenAt', 1]] });
  }

  async findLinkBySourceItem(sourceKey: string, sourceItemId: string): Promise<JobSourceDoc | null> {
    return this.store.findOne('jobSources', { sourceKey, sourceItemId });
  }

  async touchSourceLink(linkId: string, patch: { lastSeenAt: string; title?: string; active?: boolean }): Promise<void> {
    await this.store.updateOne('jobSources', { id: linkId }, patch);
  }

  async addRevision(doc: JobRevisionDoc): Promise<{ revision: JobRevisionDoc; created: boolean }> {
    validateDocument('jobRevisions', doc);
    const result = await this.store.insertIfAbsent('jobRevisions', doc);
    return { revision: result.document, created: result.inserted };
  }

  async listRevisions(jobId: string): Promise<JobRevisionDoc[]> {
    return this.store.find('jobRevisions', { jobId }, { sort: [['version', -1]] });
  }

  async search(filters: JobSearchFilters, sort: JobSort = 'newest', page = 1, pageSize = 20): Promise<JobSearchResult> {
    const clauses: Query[] = [];
    if (filters.status && filters.status.length > 0) clauses.push({ status: { $in: filters.status } });
    if (filters.employmentTypes && filters.employmentTypes.length > 0) {
      clauses.push({ employmentType: { $in: filters.employmentTypes } });
    }
    if (filters.cities && filters.cities.length > 0) clauses.push({ city: { $in: filters.cities } });
    if (filters.sourceKeys && filters.sourceKeys.length > 0) clauses.push({ sourceKeys: { $in: filters.sourceKeys } });
    if (filters.institution && filters.institution.length > 0) {
      clauses.push({ institutionNormalized: { $in: filters.institution.map((value) => normalizeTr(value)) } });
    }
    if (filters.educationLevels && filters.educationLevels.length > 0) {
      clauses.push({ 'requirements.educationLevels': { $in: filters.educationLevels } });
    }
    if (filters.kpssScoreTypes && filters.kpssScoreTypes.length > 0) {
      clauses.push({ 'requirements.kpssScoreTypes': { $in: filters.kpssScoreTypes } });
    }
    if (filters.departments && filters.departments.length > 0) {
      clauses.push({ 'requirements.departments': { $in: filters.departments.map((value) => normalizeTr(value)) } });
    }
    if (filters.titles && filters.titles.length > 0) {
      clauses.push({
        $or: filters.titles.map((title) => ({
          titles: { $regex: escapeRegex(normalizeTr(title)), $regexFlags: 'i' },
        })),
      });
    }
    if (filters.q && filters.q.trim().length > 0) {
      const needle = escapeRegex(normalizeTr(filters.q));
      clauses.push({
        $or: [
          { titleNormalized: { $regex: needle, $regexFlags: 'i' } },
          { institutionNormalized: { $regex: needle, $regexFlags: 'i' } },
          { textExcerpt: { $regex: needle, $regexFlags: 'i' } },
          { titles: { $regex: needle, $regexFlags: 'i' } },
        ],
      });
    }
    if (filters.deadlineFrom) clauses.push({ applicationEndDate: { $gte: filters.deadlineFrom } });
    if (filters.deadlineTo) clauses.push({ applicationEndDate: { $lte: filters.deadlineTo } });
    if (filters.createdFrom) clauses.push({ createdAt: { $gte: filters.createdFrom } });
    if (filters.createdTo) clauses.push({ createdAt: { $lte: filters.createdTo } });
    if (filters.publishedFrom) clauses.push({ publishedAt: { $gte: filters.publishedFrom } });
    if (filters.publishedTo) clauses.push({ publishedAt: { $lte: filters.publishedTo } });

    const query: Query = clauses.length > 0 ? { $and: clauses } : {};
    // Ana akışta reddedilen/incelemedeki kayıtlar görünmez.
    query.classification = { decision: 'accept' };

    const total = await this.store.count('jobs', query);
    const safePageSize = Math.min(Math.max(pageSize, 1), 100);
    const safePage = Math.max(page, 1);
    const items = await this.store.find('jobs', query, {
      sort: SORTS[sort],
      limit: safePageSize,
      skip: (safePage - 1) * safePageSize,
    });
    return { items, total, page: safePage, pageSize: safePageSize };
  }

  /** Ana sayfa istatistikleri — veriden üretilir, uydurma sayı yoktur. */
  async dashboardStats(now: Date = this.clock.now()): Promise<{
    total: number;
    active: number;
    upcoming: number;
    closed: number;
    addedToday: number;
    addedLast7Days: number;
    deadlineSoon: number;
    byEmploymentType: { key: string; count: number }[];
    byCity: { key: string; count: number }[];
  }> {
    const base: Query = { classification: { decision: 'accept' } };
    const today = toIstanbulDateOnly(now);
    const in7 = toIstanbulDateOnly(new Date(now.getTime() + 7 * 86_400_000));
    const iso7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const isoToday = new Date(`${today}T00:00:00+03:00`).toISOString();

    const [total, active, upcoming, closed, addedToday, addedLast7Days, deadlineSoon] = await Promise.all([
      this.store.count('jobs', base),
      this.store.count('jobs', { ...base, status: 'active' }),
      this.store.count('jobs', { ...base, status: 'upcoming' }),
      this.store.count('jobs', { ...base, status: 'closed' }),
      this.store.count('jobs', { ...base, createdAt: { $gte: isoToday } }),
      this.store.count('jobs', { ...base, createdAt: { $gte: iso7 } }),
      this.store.count('jobs', { ...base, status: 'active', applicationEndDate: { $gte: today, $lte: in7 } }),
    ]);

    const accepted = await this.store.find('jobs', base, { limit: 5_000 });
    const typeCounts = new Map<string, number>();
    const cityCounts = new Map<string, number>();
    for (const job of accepted) {
      typeCounts.set(job.employmentType, (typeCounts.get(job.employmentType) ?? 0) + 1);
      if (job.city) cityCounts.set(job.city, (cityCounts.get(job.city) ?? 0) + 1);
    }
    const top = (map: Map<string, number>, limit: number) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => ({ key, count }));

    return {
      total,
      active,
      upcoming,
      closed,
      addedToday,
      addedLast7Days,
      deadlineSoon,
      byEmploymentType: top(typeCounts, 8),
      byCity: top(cityCounts, 8),
    };
  }

  /** Kapanan ilanların durum güncellemesi (başvuru bitiş tarihi geçenler). */
  async closeExpiredJobs(todayDateOnly: string): Promise<number> {
    const now = this.clock.now().toISOString();
    return this.store.updateMany(
      'jobs',
      { status: { $in: ['active', 'upcoming'] }, applicationEndDate: { $lt: todayDateOnly }, classification: { decision: 'accept' } },
      { status: 'closed', statusReason: 'Başvuru bitiş tarihi geçti (otomatik)', updatedAt: now },
    );
  }

  /** Başvuru penceresi bugün açılan ilanları aktif işaretler. */
  async activateStartedJobs(todayDateOnly: string): Promise<number> {
    const now = this.clock.now().toISOString();
    return this.store.updateMany(
      'jobs',
      {
        status: 'upcoming',
        applicationStartAt: { $lte: `${todayDateOnly}T23:59:59+03:00` },
        applicationEndDate: { $gte: todayDateOnly },
      },
      { status: 'active', statusReason: 'Başvuru penceresi açıldı (otomatik)', updatedAt: now },
    );
  }

  async findBySourceKey(sourceKey: string, limit = 500): Promise<JobDoc[]> {
    return this.store.find('jobs', { sourceKeys: sourceKey }, { limit, sort: [['createdAt', -1]] });
  }

  async countAccepted(): Promise<number> {
    return this.store.count('jobs', { classification: { decision: 'accept' } });
  }

  /** Yeni ilan kaydı oluşturur (kimlik, normalize alanlar ve zaman damgaları). */
  buildJobDocument(input: Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'> & {
    seenAt: string;
  }): JobDoc {
    const { seenAt, ...rest } = input;
    return {
      ...rest,
      id: createId('job'),
      version: 1,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      createdAt: seenAt,
      updatedAt: seenAt,
    };
  }

  static normalizedInstitution(value: string): string {
    return normalizeTr(value);
  }

  static normalizedTitle(value: string): string {
    return normalizeTr(value);
  }
}

function escapeRegex(value: string): string {
  return lowerTr(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
