/**
 * İlan uçları (herkese açık).
 *
 * Filtreler paylaşılabilir sorgu parametreleridir; sunucu tarafında sayfalanır ve
 * sıralanır. Hiçbir istatistik uydurulmaz: özet sayılar doğrudan depodan gelir.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PAGINATION } from '../../config/app';
import type { Repos } from '../../db/repos';
import type { JobSort } from '../../db/repos/jobs';
import { JOB_STATUSES } from '../../domain';
import { toIstanbulDateOnly } from '../../domain/dates';

type JobStatus = (typeof JOB_STATUSES)[number];
import { ApiError } from '../errors';
import { requireUser } from '../context';
import { toPublicJobDetail, toPublicJobSummary, toRevision } from '../serializers';

const listQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  institution: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  city: z.union([z.string(), z.array(z.string())]).optional(),
  employmentType: z.union([z.string(), z.array(z.string())]).optional(),
  kind: z.enum(['job', 'process']).optional(),
  education: z.union([z.string(), z.array(z.string())]).optional(),
  department: z.union([z.string(), z.array(z.string())]).optional(),
  kpssType: z.union([z.string(), z.array(z.string())]).optional(),
  kpssMaxScore: z.coerce.number().min(0).max(100).optional(),
  sourceKey: z.union([z.string(), z.array(z.string())]).optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  deadlineFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  deadlineTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  minQuota: z.coerce.number().int().min(1).max(100_000).optional(),
  hasApplicationUrl: z.coerce.boolean().optional(),
  sort: z.enum(['newest', 'deadline', 'published', 'institution', 'title']).default('newest'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.maxPageSize).default(PAGINATION.defaultPageSize),
});

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : value.split(',')).map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Görüntüleme takma adlarını kanonik filtre değerine çevirir.
 *
 * Arayüz yalnızca kanonik değer gönderir (`ortaogretim`); ama eski/paylaşılmış
 * bağlantılarda `lise` gibi takma ad bulunabilir. Bu değer olduğu gibi filtreye
 * geçerse sorgu sessizce boş dönerdi (kullanıcı "ilan yok" sanırdı). Takma ad
 * çevrilir; TANINMAYAN değer olduğu gibi bırakılır (filtre boş sonuç verir —
 * "seçtiğiniz düzeyde ilan yok" dürüst cevaptır, filtreyi yok saymak değil).
 */
const EDUCATION_ALIASES: Record<string, string> = { lise: 'ortaogretim' };

function canonicalEducation(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map((value) => EDUCATION_ALIASES[value] ?? value))];
}

export function registerJobRoutes(app: FastifyInstance, repos: Repos): void {
  app.get(
    '/api/jobs',
    { schema: { tags: ['jobs'], summary: 'İlan arama (filtreli, sayfalı)' } },
    async (request) => {
      const query = listQuery.parse(request.query);
      const statuses = asArray(query.status)?.filter((value): value is JobStatus =>
        (JOB_STATUSES as readonly string[]).includes(value),
      );
      const result = await repos.jobs.search(
        {
          ...(query.q !== undefined ? { q: query.q } : {}),
          ...(query.institution !== undefined ? { institution: query.institution } : {}),
          ...(query.title !== undefined ? { title: query.title } : {}),
          ...(asArray(query.city) !== undefined ? { cities: asArray(query.city) } : {}),
          ...(asArray(query.employmentType) !== undefined
            ? { employmentTypes: asArray(query.employmentType) }
            : {}),
          ...(query.kind !== undefined ? { kind: query.kind } : {}),
          ...(canonicalEducation(asArray(query.education)) !== undefined
            ? { educationLevels: canonicalEducation(asArray(query.education)) }
            : {}),
          ...(asArray(query.department) !== undefined ? { departments: asArray(query.department) } : {}),
          ...(asArray(query.kpssType) !== undefined ? { kpssScoreTypes: asArray(query.kpssType) } : {}),
          ...(query.kpssMaxScore !== undefined ? { kpssMaxScore: query.kpssMaxScore } : {}),
          ...(asArray(query.sourceKey) !== undefined ? { sourceKeys: asArray(query.sourceKey) } : {}),
          ...(statuses !== undefined && statuses.length > 0 ? { status: statuses } : {}),
          ...(query.deadlineFrom !== undefined ? { deadlineFrom: query.deadlineFrom } : {}),
          ...(query.deadlineTo !== undefined ? { deadlineTo: query.deadlineTo } : {}),
          ...(query.minQuota !== undefined ? { minQuota: query.minQuota } : {}),
          ...(query.hasApplicationUrl === true ? { onlyWithApplicationUrl: true } : {}),
        },
        { page: query.page, pageSize: query.pageSize, sort: query.sort as JobSort },
      );
      const now = repos.clock.now();
      return {
        items: result.items.map((job) => toPublicJobSummary(job, now)),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        pages: Math.max(1, Math.ceil(result.total / result.pageSize)),
        sort: query.sort,
        generatedAt: now.toISOString(),
      };
    },
  );

  app.get(
    '/api/jobs/stats',
    { schema: { tags: ['jobs'], summary: 'Ana sayfa özeti (yalnızca gerçek veriler)' } },
    async () => {
      const stats = await repos.jobs.dashboardStats(repos.clock.now());
      const reviewCounts = await repos.review.countOpen();
      return { ...stats, reviewQueue: reviewCounts, generatedAt: repos.clock.now().toISOString() };
    },
  );

  app.get(
    '/api/jobs/:id',
    { schema: { tags: ['jobs'], summary: 'İlan detayı (alan kaynakları ve belirsizliklerle)' } },
    async (request) => {
      const params = z.object({ id: z.string().min(3).max(64) }).parse(request.params);
      const job = await repos.jobs.findById(params.id);
      if (!job || job.classification.decision !== 'accept') {
        throw ApiError.notFound('İlan bulunamadı.');
      }
      const links = await repos.jobs.listSourceLinks(job.id);
      const sources = await repos.store.find('sources', {}, { limit: 200 });
      const names = new Map(sources.map((source) => [source.key, source.name]));
      return toPublicJobDetail(job, { sources: links, sourceNames: names, now: repos.clock.now() });
    },
  );

  app.get(
    '/api/jobs/:id/sources',
    { schema: { tags: ['jobs'], summary: 'İlanın tüm kaynak bağlantıları' } },
    async (request) => {
      const params = z.object({ id: z.string().min(3).max(64) }).parse(request.params);
      const job = await repos.jobs.findById(params.id);
      // Yalnızca KABUL EDİLMİŞ ilanlar: sınıflandırma/tekilleştirme kararı
      // bekleyen (ya da reddedilmiş) ham kayıtlar herkese açık uçtan dönmez.
      if (!job || job.classification.decision !== 'accept') throw ApiError.notFound('İlan bulunamadı.');
      const links = await repos.jobs.listSourceLinks(job.id);
      return {
        jobId: job.id,
        dedupeKey: job.dedupeKey,
        sources: links.map((link) => ({
          sourceKey: link.sourceKey,
          sourceItemId: link.sourceItemId,
          url: link.url,
          title: link.title,
          publishedAt: link.publishedAt,
          firstSeenAt: link.firstSeenAt,
          lastSeenAt: link.lastSeenAt,
          active: link.active,
        })),
      };
    },
  );

  app.get(
    '/api/jobs/:id/revisions',
    { schema: { tags: ['jobs'], summary: 'İlanın değişiklik geçmişi' } },
    async (request) => {
      const params = z.object({ id: z.string().min(3).max(64) }).parse(request.params);
      const job = await repos.jobs.findById(params.id);
      if (!job || job.classification.decision !== 'accept') throw ApiError.notFound('İlan bulunamadı.');
      const revisions = await repos.jobs.listRevisions(params.id);
      return { jobId: params.id, revisions: revisions.map(toRevision) };
    },
  );

  // --- Kaydedilen ilanlar (yalnızca oturum sahibi) -------------------------
  // Adayın kendi takip listesi: ilan kartındaki "Kaydet" bu uçları kullanır.
  // Başka kullanıcının listesi hiçbir koşulda dönülmez.
  app.get(
    '/api/me/saved-jobs',
    { schema: { tags: ['jobs'], summary: 'Kaydettiğim ilanlar' } },
    async (request) => {
      const user = requireUser(request);
      const saved = await repos.savedJobs.listForUser(user.id, 200);
      const now = repos.clock.now();
      const items = [];
      for (const entry of saved) {
        const job = await repos.jobs.findById(entry.jobId);
        if (!job || job.classification.decision !== 'accept') continue;
        items.push({ job: toPublicJobSummary(job, now), savedAt: entry.createdAt });
      }
      // Son başvurusu yakın olan üstte: aday önce acil olana bakar.
      items.sort((a, b) =>
        (a.job.applicationEndDate ?? '9999').localeCompare(b.job.applicationEndDate ?? '9999'),
      );
      return { items, total: items.length, generatedAt: now.toISOString() };
    },
  );

  app.post(
    '/api/jobs/:id/save',
    { schema: { tags: ['jobs'], summary: 'İlanı kaydet / kaydı kaldır' } },
    async (request) => {
      const user = requireUser(request);
      const params = z.object({ id: z.string().min(3).max(64) }).parse(request.params);
      const job = await repos.jobs.findById(params.id);
      if (!job || job.classification.decision !== 'accept') throw ApiError.notFound('İlan bulunamadı.');
      const result = await repos.savedJobs.toggle(user.id, job.id);
      return {
        saved: result.saved,
        jobId: job.id,
        message: result.saved ? 'İlan kaydedildi.' : 'Kayıt kaldırıldı.',
      };
    },
  );

  app.get(
    '/api/jobs/:id/save-state',
    { schema: { tags: ['jobs'], summary: 'İlan kayıt durumu' } },
    async (request) => {
      const params = z.object({ id: z.string().min(3).max(64) }).parse(request.params);
      const user = request.auth?.user ?? null;
      if (!user) return { saved: false, authenticated: false };
      return { saved: await repos.savedJobs.isSaved(user.id, params.id), authenticated: true };
    },
  );

  /** Takvim görünümü: yaklaşan başvuru bitiş tarihleri. */
  app.get(
    '/api/jobs/deadlines/upcoming',
    { schema: { tags: ['jobs'], summary: 'Yaklaşan son başvuru tarihleri' } },
    async (request) => {
      const query = z
        .object({
          days: z.coerce.number().int().min(1).max(60).default(14),
          city: z.string().trim().max(60).optional(),
        })
        .parse(request.query);
      const now = repos.clock.now();
      // Tarih karşılaştırması Türkiye gününe göre yapılır: UTC'de gün dönümü
      // İstanbul'dan 3 saat önce olduğu için pencere bir gün kayabiliyordu.
      const from = toIstanbulDateOnly(now);
      const to = toIstanbulDateOnly(new Date(now.getTime() + query.days * 86_400_000));
      const result = await repos.jobs.search(
        {
          status: ['active'],
          deadlineFrom: from,
          deadlineTo: to,
          ...(query.city !== undefined ? { cities: [query.city] } : {}),
        },
        { pageSize: 50, sort: 'deadline' },
      );
      return {
        range: { from, to, days: query.days },
        humanRange: `önümüzdeki ${query.days} gün içinde kapanan ilanlar`,
        items: result.items.map((job) => toPublicJobSummary(job, now)),
        total: result.total,
      };
    },
  );
}
