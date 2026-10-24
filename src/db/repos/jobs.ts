/**
 * İlan deposu: tekil ilanlar, kaynak bağları, sürüm geçmişi ve arama.
 */
import { createId } from '../../domain/ids';
import { escapeRegExp, normalizeTr } from '../../domain/text';
import {
  addDaysDateOnly,
  isStalePublication,
  sanePublishedDate,
  STALE_PUBLICATION_DAYS,
  toIstanbulDateOnly,
} from '../../domain/dates';
import type { JobStatus } from '../../domain';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { JobDoc, JobRevisionDoc, JobSourceDoc, SourceItemDecisionDoc } from '../schemas';
import { validateDocument } from '../validate';
import type { Query, SortSpec } from '../query';

export interface JobSearchFilters {
  q?: string;
  institution?: string;
  title?: string;
  cities?: string[];
  employmentTypes?: string[];
  /** `process`: yalnızca süreç duyuruları; `job`: süreç duyuruları hariç iş ilanları. */
  kind?: 'job' | 'process';
  educationLevels?: string[];
  departments?: string[];
  kpssScoreTypes?: string[];
  /** Aday uygunluğu: belirtilen taban puan bu değerden yüksek olan ilanlar elenir. */
  kpssMaxScore?: number;
  sourceKeys?: string[];
  status?: JobStatus[];
  deadlineFrom?: string;
  deadlineTo?: string;
  minQuota?: number;
  /** Yalnızca başvuru bağlantısı olan ilanlar. */
  onlyWithApplicationUrl?: boolean;
  /** Yalnızca başvuru bağlantısı BELİRTİLMEMİŞ ilanlar (paylaşılabilir bağlantı sözleşmesi). */
  onlyWithoutApplicationUrl?: boolean;
}

export type JobSort = 'newest' | 'deadline' | 'published' | 'institution' | 'title';

const SORTS: Record<JobSort, SortSpec> = {
  newest: [['createdAt', -1]],
  deadline: [['applicationEndDate', 1]],
  published: [['publishedAt', -1]],
  institution: [['institutionNormalized', 1]],
  title: [['titleNormalized', 1]],
};

export interface JobSearchResult {
  items: JobDoc[];
  total: number;
  page: number;
  pageSize: number;
}

export interface JobSearchOptions {
  page?: number;
  pageSize?: number;
  sort?: JobSort;
  /** Yönetici aramalarında taslak/incelemedeki kayıtlar da görünür. */
  includeNonAccepted?: boolean;
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

  /** Kaynak içi kimlik eşleşmesi: aynı kaynak aynı ilanı yeniden yayımladı. */
  async findLinkBySourceItem(sourceKey: string, sourceItemId: string): Promise<JobSourceDoc | null> {
    return this.store.findOne('jobSources', { sourceKey, sourceItemId });
  }

  async listSourceLinks(jobId: string): Promise<JobSourceDoc[]> {
    return this.store.find('jobSources', { jobId }, { sort: [['firstSeenAt', 1]] });
  }

  /**
   * Tekilleştirme adayları: aynı kurum, benzer başlık ya da aynı başvuru dönemi.
   * Karar burada verilmez; aday listesi dedupe motoruna verilir.
   */
  async findDedupeCandidates(params: {
    institutionNormalized: string;
    titleNormalized: string;
    applicationEndDate?: string | null;
    limit?: number;
  }): Promise<JobDoc[]> {
    const limit = params.limit ?? 40;
    const byInstitution = await this.store.find(
      'jobs',
      {
        institutionNormalized: {
          $regex: escapeRegExp(params.institutionNormalized.slice(0, 24)),
          $regexFlags: 'i',
        },
      },
      { limit, sort: [['createdAt', -1]] },
    );
    const byTitle = await this.store.find(
      'jobs',
      { titleNormalized: { $regex: escapeRegExp(params.titleNormalized.slice(0, 24)), $regexFlags: 'i' } },
      { limit, sort: [['createdAt', -1]] },
    );
    const byPeriod = params.applicationEndDate
      ? await this.store.find('jobs', { applicationEndDate: params.applicationEndDate }, { limit })
      : [];

    const map = new Map<string, JobDoc>();
    for (const job of [...byInstitution, ...byTitle, ...byPeriod]) map.set(job.id, job);
    return [...map.values()];
  }

  async insertJob(doc: JobDoc): Promise<{ job: JobDoc; created: boolean }> {
    validateDocument('jobs', doc);
    const result = await this.store.insertIfAbsent('jobs', doc);
    return { job: result.document, created: result.inserted };
  }

  async updateJob(jobId: string, patch: Record<string, unknown>): Promise<JobDoc | null> {
    const updated = await this.store.updateOne(
      'jobs',
      { id: jobId },
      {
        ...patch,
        updatedAt: this.clock.now().toISOString(),
      },
    );
    if (updated) validateDocument('jobs', updated);
    return updated;
  }

  async addSourceLink(doc: JobSourceDoc): Promise<{ link: JobSourceDoc; created: boolean }> {
    validateDocument('jobSources', doc);
    const result = await this.store.insertIfAbsent('jobSources', doc);
    return { link: result.document, created: result.inserted };
  }

  async touchSourceLink(
    linkId: string,
    patch: Partial<
      Pick<
        JobSourceDoc,
        | 'lastSeenAt'
        | 'title'
        | 'active'
        | 'capturedTextCharacterCount'
        | 'capturedTextStatus'
        | 'attachments'
      >
    >,
  ): Promise<void> {
    await this.store.updateOne('jobSources', { id: linkId }, patch);
  }

  /**
   * İlan oluşturmayan işlenmiş kaynak kaydı (ret/inceleme/sinyal): adaptör aynı
   * ilanı bir sonraki taramada yeniden "yeni" saymasın diye tarama belleğine
   * yazılır. Benzersiz (sourceKey, sourceItemId) indeksi eşzamanlı yazmayı
   * tekilleştirir.
   */
  async recordSourceItemDecision(input: {
    sourceKey: string;
    sourceItemId: string;
    decision: SourceItemDecisionDoc['decision'];
    capturedTextStatus: SourceItemDecisionDoc['capturedTextStatus'];
    title: string;
    url: string;
    classificationVersion: string;
    /** Kararın gerekçesi (açıklamalar); verilmezse kayıt gerekçesiz kalır. */
    reasons?: readonly string[];
    /** Karara katılan kural kimlikleri. */
    rules?: readonly string[];
    confidence?: number | null;
  }): Promise<SourceItemDecisionDoc> {
    const now = this.clock.now().toISOString();
    const explanation = decisionExplanation(input);
    const existing = await this.store.findOne('sourceItemDecisions', {
      sourceKey: input.sourceKey,
      sourceItemId: input.sourceItemId,
    });
    if (existing) {
      const updated = await this.store.updateOne(
        'sourceItemDecisions',
        { id: existing.id },
        {
          decision: input.decision,
          capturedTextStatus: input.capturedTextStatus,
          title: input.title.slice(0, 300),
          classificationVersion: input.classificationVersion,
          // Gerekçe her kararda güncel kararın gerekçesiyle değiştirilir (eskisi
          // başka bir kurala ait olabilir); verilmediyse alan kaldırılmaz.
          ...explanation,
          lastSeenAt: now,
        },
      );
      return updated ?? existing;
    }
    const doc: SourceItemDecisionDoc = {
      id: createId('sid'),
      sourceKey: input.sourceKey,
      sourceItemId: input.sourceItemId,
      decision: input.decision,
      capturedTextStatus: input.capturedTextStatus,
      title: input.title.slice(0, 300),
      url: input.url,
      classificationVersion: input.classificationVersion,
      ...explanation,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    validateDocument('sourceItemDecisions', doc);
    const result = await this.store.insertIfAbsent('sourceItemDecisions', doc);
    return result.document;
  }

  async listSourceItemDecisions(sourceKey: string, limit = 5_000): Promise<SourceItemDecisionDoc[]> {
    return this.store.find('sourceItemDecisions', { sourceKey }, { limit, sort: [['firstSeenAt', -1]] });
  }

  async findSourceItemDecision(
    sourceKey: string,
    sourceItemId: string,
  ): Promise<SourceItemDecisionDoc | null> {
    return this.store.findOne('sourceItemDecisions', { sourceKey, sourceItemId });
  }

  async addRevision(doc: JobRevisionDoc): Promise<{ revision: JobRevisionDoc; created: boolean }> {
    validateDocument('jobRevisions', doc);
    const result = await this.store.insertIfAbsent('jobRevisions', doc);
    return { revision: result.document, created: result.inserted };
  }

  async listRevisions(jobId: string): Promise<JobRevisionDoc[]> {
    return this.store.find('jobRevisions', { jobId }, { sort: [['version', -1]] });
  }

  async search(filters: JobSearchFilters, options: JobSearchOptions = {}): Promise<JobSearchResult> {
    const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
    const page = Math.max(options.page ?? 1, 1);
    const query = this.buildFilter(filters, options.includeNonAccepted ?? false);
    // Sayım ve sayfa birbirinden bağımsız okumalardır: paralel çalışır. Uzak veritabanında
    // (Supabase ap-south-1, Türkiye'den ölçülen gidiş-dönüş ~200 ms; 22.10.2026) sıralı çalıştırmak
    // her listeleme isteğine bir gidiş-dönüş ekliyordu.
    const [total, items] = await Promise.all([
      this.store.count('jobs', query),
      this.store.find('jobs', query, {
        sort: SORTS[options.sort ?? 'newest'],
        limit: pageSize,
        skip: (page - 1) * pageSize,
      }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Bellekte eşleştirme için aday ilanlar (sayfasız, üst sınırlı). Ana sayfa
   * "Size uygun ilanlar" listesi bildirim eşleştiricisiyle süzülür; eşleştirici
   * sorguya çevrilemeyen kurallar (içerme, "belirtilmemiş" dahil etme) içerir.
   */
  async listForMatching(filters: JobSearchFilters, limit: number): Promise<JobDoc[]> {
    return this.store.find('jobs', this.buildFilter(filters), {
      sort: SORTS.deadline,
      limit: Math.max(1, limit),
    });
  }

  buildFilter(filters: JobSearchFilters, includeNonAccepted = false): Query {
    const clauses: Query[] = [];
    if (!includeNonAccepted) clauses.push({ 'classification.decision': 'accept' });
    if (filters.status && filters.status.length > 0) {
      // Süreç duyurusunun başvuru durumu yoktur: durum filtresi yalnızca iş ilanlarına uygulanır.
      clauses.push({ status: { $in: filters.status } });
      clauses.push({ 'classification.kind': { $ne: 'process' } });
    }
    if (filters.employmentTypes && filters.employmentTypes.length > 0) {
      clauses.push({ employmentType: { $in: filters.employmentTypes } });
    }
    // Eski kayıtlarda classification.kind yoktur; bunlar iş ilanıdır ($ne eksik alanı eşler).
    if (filters.kind === 'process') clauses.push({ 'classification.kind': 'process' });
    if (filters.kind === 'job') clauses.push({ 'classification.kind': { $ne: 'process' } });
    if (filters.cities && filters.cities.length > 0) {
      // Türkçe duyarlı karşılaştırma: kullanıcı 'istanbul', 'İSTANBUL' ya da
      // 'Istanbul' yazsa da aynı şehri bulur (normalize edilmiş alanla).
      // Eski kayıtlarda normalize alan yoksa ham değer de birebir denenir.
      const needles = filters.cities.map((city) => normalizeTr(city)).filter(Boolean);
      if (needles.length > 0) {
        clauses.push({
          $or: [{ cityNormalized: { $in: needles } }, { city: { $in: filters.cities } }],
        });
      }
    }
    if (filters.sourceKeys && filters.sourceKeys.length > 0)
      clauses.push({ sourceKeys: { $in: filters.sourceKeys } });
    if (filters.educationLevels && filters.educationLevels.length > 0) {
      clauses.push({ 'requirements.educationLevels': { $in: filters.educationLevels } });
    }
    if (filters.departments && filters.departments.length > 0) {
      clauses.push({
        'requirements.departments': { $in: filters.departments.map((value) => value) },
      });
    }
    if (filters.kpssScoreTypes && filters.kpssScoreTypes.length > 0) {
      clauses.push({ 'requirements.kpssScoreTypes': { $in: filters.kpssScoreTypes } });
    }
    if (filters.kpssMaxScore !== undefined) {
      // Taban puanı belirtilmemiş ilanlar bu filtrede elenir (puan uydurulmaz);
      // arayüz bu sınırı kullanıcaya açıkça söyler.
      clauses.push({ 'requirements.kpssMinScore': { $lte: filters.kpssMaxScore } });
    }
    if (filters.institution)
      clauses.push({
        institutionNormalized: { $regex: escapeRegExp(normalizeTr(filters.institution)), $regexFlags: 'i' },
      });
    if (filters.title)
      clauses.push({
        titleNormalized: { $regex: escapeRegExp(normalizeTr(filters.title)), $regexFlags: 'i' },
      });
    if (filters.q) {
      // Kullanıcı girdisi DÜZ METİN olarak aranır (regex değil): aksi hâlde
      // geçersiz desen 500'e, kötü desen kilitlenmeye (ReDoS) yol açardı.
      const needle = escapeRegExp(normalizeTr(filters.q));
      clauses.push({
        $or: [
          { titleNormalized: { $regex: needle, $regexFlags: 'i' } },
          { institutionNormalized: { $regex: needle, $regexFlags: 'i' } },
          // Gövde araması normalize edilmiş kopyada yapılır (Türkçe karakterler).
          { textNormalized: { $regex: needle, $regexFlags: 'i' } },
        ],
      });
    }
    if (filters.deadlineFrom) clauses.push({ applicationEndDate: { $gte: filters.deadlineFrom } });
    if (filters.deadlineTo) clauses.push({ applicationEndDate: { $lte: filters.deadlineTo } });
    if (filters.minQuota !== undefined) clauses.push({ quota: { $gte: filters.minQuota } });
    if (filters.onlyWithApplicationUrl) clauses.push({ applicationUrl: { $ne: null } });
    // `applicationUrl` alanı olmayan eski belgeler de "bağlantı belirtilmemiş" sayılır.
    if (filters.onlyWithoutApplicationUrl) {
      clauses.push({ $or: [{ applicationUrl: null }, { applicationUrl: { $exists: false } }] });
    }
    return clauses.length > 0 ? { $and: clauses } : {};
  }

  /** Ana sayfa istatistikleri — yalnızca gerçek verilerden üretilir. */
  async dashboardStats(now: Date = this.clock.now()): Promise<{
    total: number;
    active: number;
    upcoming: number;
    closed: number;
    closingSoon: number;
    addedToday: number;
    byEmploymentType: { key: string; count: number }[];
    lastSuccessfulScanAt: string | null;
  }> {
    // İstatistikler iş ilanlarını sayar; süreç duyuruları "açık ilan" olarak sayılmaz.
    const base: Query = { 'classification.decision': 'accept', 'classification.kind': { $ne: 'process' } };
    const today = toIstanbulDateOnly(now);
    const soon = toIstanbulDateOnly(new Date(now.getTime() + 7 * 86_400_000));

    const [total, active, upcoming, closed, closingSoon, addedToday, jobs] = await Promise.all([
      this.store.count('jobs', base),
      this.store.count('jobs', { ...base, status: 'active' }),
      this.store.count('jobs', { ...base, status: 'upcoming' }),
      this.store.count('jobs', { ...base, status: 'closed' }),
      this.store.count('jobs', {
        ...base,
        status: 'active',
        applicationEndDate: { $gte: today, $lte: soon },
      }),
      this.store.count('jobs', { ...base, publishedAt: { $gte: `${today}T00:00:00+03:00` } }),
      this.store.find('jobs', base, { limit: 2_000, sort: [['createdAt', -1]] }),
    ]);

    const counts = new Map<string, number>();
    for (const job of jobs) counts.set(job.employmentType, (counts.get(job.employmentType) ?? 0) + 1);

    const lastRuns = await this.store.find(
      'scrapeRuns',
      { status: 'success' },
      { limit: 1, sort: [['startedAt', -1]] },
    );
    const lastRun = lastRuns[0];

    return {
      total,
      active,
      upcoming,
      closed,
      closingSoon,
      addedToday,
      byEmploymentType: [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
      lastSuccessfulScanAt: lastRun?.startedAt ?? null,
    };
  }

  /** Kapanan ilanların durumunu günceller (başvuru bitiş tarihi geçti). */
  async closeExpiredJobs(todayDateOnly: string): Promise<number> {
    const now = this.clock.now().toISOString();
    return this.store.updateMany(
      'jobs',
      { status: { $in: ['active', 'upcoming'] }, applicationEndDate: { $lt: todayDateOnly } },
      { status: 'closed', statusReason: 'Başvuru süresi doldu.', updatedAt: now },
    );
  }

  /**
   * Son başvuru tarihi hiç olmayan ve yayımından çok geçmiş ilanları kapatır.
   * Eski kayıtlar (ör. 2008/2018 yayımlı) yeniden işlenmeden de bu bakımda düzelir.
   */
  async closeStalePublications(todayDateOnly: string, maxAgeDays = STALE_PUBLICATION_DAYS): Promise<number> {
    const cutoff = addDaysDateOnly(todayDateOnly, -maxAgeDays);
    const candidates = await this.store.find(
      'jobs',
      { status: { $in: ['active', 'upcoming', 'unknown'] }, publishedAt: { $lt: cutoff } },
      { limit: 5_000 },
    );
    const now = this.clock.now().toISOString();
    let closed = 0;
    for (const job of candidates) {
      if (job.applicationEndDate || job.applicationEndAt) continue;
      if (!isStalePublication(sanePublishedDate(job.publishedAt, todayDateOnly), todayDateOnly, maxAgeDays))
        continue;
      await this.store.updateOne(
        'jobs',
        { id: job.id },
        {
          status: 'closed',
          statusReason: 'Yayımından uzun süre geçti ve son başvuru tarihi belirtilmemiş.',
          updatedAt: now,
        },
      );
      closed += 1;
    }
    return closed;
  }

  /** Başvurusu bugün başlayan ilanları "aktif" durumuna alır. */
  async activateStartedJobs(todayDateOnly: string): Promise<number> {
    const now = this.clock.now().toISOString();
    return this.store.updateMany(
      'jobs',
      {
        status: 'upcoming',
        applicationStartAt: { $lte: `${todayDateOnly}T23:59:59+03:00` },
        applicationEndDate: { $gte: todayDateOnly },
      },
      { status: 'active', statusReason: 'Başvuru penceresi açıldı.', updatedAt: now },
    );
  }

  buildJobDocument(
    input: Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'> & {
      seenAt: string;
    },
  ): JobDoc {
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

const MAX_DECISION_REASONS = 20;
const MAX_DECISION_RULES = 40;

/** Karar gerekçesini şema sınırlarına göre kırpar; boş alanları yazmaz. */
function decisionExplanation(input: {
  reasons?: readonly string[];
  rules?: readonly string[];
  confidence?: number | null;
}): Pick<SourceItemDecisionDoc, 'reasons' | 'rules' | 'confidence'> {
  const out: Pick<SourceItemDecisionDoc, 'reasons' | 'rules' | 'confidence'> = {};
  const reasons = [...new Set((input.reasons ?? []).map((r) => r.trim()).filter(Boolean))]
    .slice(0, MAX_DECISION_REASONS)
    .map((r) => r.slice(0, 500));
  if (reasons.length > 0) out.reasons = reasons;
  const rules = [...new Set((input.rules ?? []).map((r) => r.trim()).filter(Boolean))]
    .slice(0, MAX_DECISION_RULES)
    .map((r) => r.slice(0, 120));
  if (rules.length > 0) out.rules = rules;
  if (typeof input.confidence === 'number' && Number.isFinite(input.confidence)) {
    out.confidence = Math.min(1, Math.max(0, input.confidence));
  }
  return out;
}
