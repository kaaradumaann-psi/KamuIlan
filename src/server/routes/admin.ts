/**
 * Yönetici uçları (RBAC: role='admin').
 *
 * Kapsam: kaynak yönetimi, tarama geçmişi ve hataları, sınıflandırma/tekilleştirme
 * inceleme kuyruğu, e-posta outbox'ı, ilan revizyonları, kuyruk/ölü mektup
 * yönetimi, kapsam raporu ve denetim kaydı.
 *
 * Her yazma işlemi `auditLogs`'a yazılır; okuma uçları kullanıcı e-postalarını
 * maskeler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  APP_VERSION,
  CLASSIFICATION_VERSION,
  DEDUPE_VERSION,
  EXTRACTION_VERSION,
  SCHEDULER_DEFAULTS,
} from '../../config/app';
import {
  SOURCE_DEFINITIONS,
  type SourceDefinition,
  type SourceGroup,
  type SourceMethod,
  type SourceStatus,
  type SourceType,
} from '../../config/sources';
import type { Repos } from '../../db/repos';
import { createId, randomToken } from '../../domain/ids';
import { hashPassword } from '../passwords';
import { BRANDING } from '../../config/app';
import { getEnv } from '../../config/env';
import { audit, requireAdmin } from '../context';
import { ApiError } from '../errors';
import {
  toCoverageEntry,
  toReviewItem,
  toRevision,
  toRunSummary,
  toSourceStatus,
  toUserProfile,
} from '../serializers';
import { enqueueMaintenanceNow, enqueueSourceScrapeNow } from '../../worker/trigger';
import { applyRawAnnouncement } from '../../ingest/jobs-service';
import type { EmploymentType, RawAnnouncement } from '../../domain';

const sourceKeySchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'Kaynak anahtarı yalnızca küçük harf, rakam ve tire içerebilir.');

const sourceCreateSchema = z
  .object({
    key: sourceKeySchema,
    name: z.string().trim().min(4).max(160),
    group: z.enum(['ulusal', 'kurum', 'universite', 'belediye', 'sinav']),
    sourceType: z.enum([
      'official-portal',
      'official-index',
      'institution-page',
      'exam-authority',
      'regional-restricted',
      'manual',
    ]),
    institution: z.string().trim().min(3).max(160),
    listingUrl: z.string().trim().url().max(400),
    homepageUrl: z.string().trim().url().max(400),
    adapterKey: z.string().trim().min(2).max(64),
    method: z.enum(['html-list', 'pdf-index', 'json-api', 'browser', 'manual-entry']),
    status: z.enum([
      'verified',
      'scraper-built',
      'accessible',
      'method-defined',
      'researched',
      'not-researched',
      'temporary-error',
      'access-restricted',
      'needs-manual-method',
      'disabled',
    ]),
    statusNote: z.string().trim().max(600).default(''),
    coverageNote: z.string().trim().max(600).default(''),
    verificationEvidence: z.string().trim().max(600).default(''),
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().min(5).max(10_080).default(SCHEDULER_DEFAULTS.fastIntervalMinutes),
    allowedHosts: z.array(z.string().trim().min(3).max(120)).min(1).max(10),
  })
  .strict();

const sourcePatchSchema = z
  .object({
    name: z.string().trim().min(4).max(160).optional(),
    status: sourceCreateSchema.shape.status.optional(),
    statusNote: z.string().trim().max(600).optional(),
    coverageNote: z.string().trim().max(600).optional(),
    listingUrl: z.string().trim().url().max(400).optional(),
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().int().min(5).max(10_080).optional(),
    method: sourceCreateSchema.shape.method.optional(),
    allowedHosts: z.array(z.string().trim().min(3).max(120)).min(1).max(10).optional(),
  })
  .strict();

export function registerAdminRoutes(app: FastifyInstance, repos: Repos): void {
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/admin')) return;
    requireAdmin(request);
  });

  // ------------------------------------------------------------------ genel bakış
  app.get('/api/admin/overview', { schema: { tags: ['admin'], summary: 'Yönetici panosu' } }, async () => {
    const [stats, coverage, runSummary, reviewCounts, outboxStats, queueStats, heartbeats, auditCount] =
      await Promise.all([
        repos.jobs.dashboardStats(repos.clock.now()),
        repos.sources.coverage(),
        repos.runs.summary(),
        repos.review.countOpen(),
        repos.outbox.stats(),
        repos.queue.stats(),
        repos.heartbeats.list(),
        repos.store.count('auditLogs', {}),
      ]);
    const now = repos.clock.now().getTime();
    const workers = heartbeats.map((beat) => ({
      workerId: beat.workerId,
      role: beat.role,
      status: beat.status,
      version: beat.version,
      lastHeartbeatAt: beat.lastHeartbeatAt,
      processedJobs: beat.processedJobs,
      // Durdurulmuş süreçler bayat sayılmaz; panelde yanlış alarm üretmesinler.
      stale:
        beat.status !== 'stopped' &&
        now - Date.parse(beat.lastHeartbeatAt) > SCHEDULER_DEFAULTS.heartbeatStaleMs,
      lastError: beat.lastError,
    }));
    const hasActiveWorker = workers.some((worker) => worker.status === 'running' && !worker.stale);
    const hasStaleWorker = workers.some((worker) => worker.stale);
    return {
      appVersion: APP_VERSION,
      versions: {
        classification: CLASSIFICATION_VERSION,
        extraction: EXTRACTION_VERSION,
        dedupe: DEDUPE_VERSION,
      },
      jobs: stats,
      coverage: { summary: coverage.summary },
      runs: runSummary,
      reviewQueue: reviewCounts,
      outbox: outboxStats,
      // Arayüz sözleşmesi { backend, counts, dead } bekler; repo istatistiği
      // düz bir durum->sayı kaydıdır — burada normalize edilmezse panel
      // `counts.pending` okurken patlar (beyaz ekran).
      queue: { backend: repos.store.driver, counts: queueStats, dead: queueStats.dead ?? 0 },
      workers,
      workerWarning: !hasActiveWorker
        ? 'Aktif worker kalp atışı yok: zamanlanmış taramalar şu an yürütülmüyor. `npm run dev:worker` sürecini kontrol edin.'
        : hasStaleWorker
          ? 'En az bir worker kalp atışı bayat; ilgili sürecin günlüklerini kontrol edin.'
          : null,
      auditEntries: auditCount,
      generatedAt: repos.clock.now().toISOString(),
    };
  });

  // ------------------------------------------------------------------ kaynaklar
  app.get(
    '/api/admin/sources',
    { schema: { tags: ['admin'], summary: 'Kaynakları listele (sağlık dahil)' } },
    async () => {
      const coverage = await repos.sources.coverage();
      return {
        sources: coverage.sources.map(toCoverageEntry),
        summary: coverage.summary,
        planned: coverage.planned,
        registryKeys: SOURCE_DEFINITIONS.map((definition) => ({
          key: definition.key,
          adapterKey: definition.adapterKey,
        })),
      };
    },
  );

  app.post(
    '/api/admin/sources',
    { schema: { tags: ['admin'], summary: 'Yeni kaynak kaydı ekle' } },
    async (request, reply) => {
      const admin = requireAdmin(request);
      const body = sourceCreateSchema.parse(request.body);
      const existing = await repos.sources.getByKey(body.key);
      if (existing) throw ApiError.conflict('Bu anahtarla bir kaynak zaten var.');

      const definition: SourceDefinition = {
        key: body.key,
        name: body.name,
        group: body.group as SourceGroup,
        sourceType: body.sourceType as SourceType,
        institution: body.institution,
        listingUrl: body.listingUrl,
        homepageUrl: body.homepageUrl,
        adapterKey: body.adapterKey,
        method: body.method as SourceMethod,
        status: body.status as SourceStatus,
        statusNote: body.statusNote,
        lastVerifiedAt: null,
        verificationEvidence: body.verificationEvidence,
        coverageNote: body.coverageNote,
        enabled: body.enabled,
        intervalMinutes: body.intervalMinutes,
        minRequestIntervalMs: 1_500,
        maxConcurrency: 1,
        allowedHosts: body.allowedHosts,
        conditionalRequests: true,
        tags: ['elle-eklendi'],
      };
      await repos.sources.seed([definition]);
      await audit(repos.audit, request, {
        action: 'admin.source-created',
        targetType: 'source',
        targetId: body.key,
        actorUserId: admin.id,
        actorRole: admin.role,
        meta: { adapterKey: body.adapterKey },
      });
      const coverage = await repos.sources.coverage();
      const entry = coverage.sources.find((candidate) => candidate.key === body.key);
      reply.status(201);
      return {
        source: entry ? toCoverageEntry(entry) : null,
        message:
          'Kaynak eklendi. Adaptör kodu gerçek erişimle doğrulanmadan üretimde etkinleştirmeyin; kapsam raporunda "doğrulanmadı" olarak görünür.',
      };
    },
  );

  app.patch(
    '/api/admin/sources/:key',
    { schema: { tags: ['admin'], summary: 'Kaynak güncelle (durum, aralık, adres)' } },
    async (request) => {
      const admin = requireAdmin(request);
      const params = z.object({ key: sourceKeySchema }).parse(request.params);
      const body = sourcePatchSchema.parse(request.body);
      const source = await repos.sources.getByKey(params.key);
      if (!source) throw ApiError.notFound('Kaynak bulunamadı.');
      const updated = await repos.sources.update(params.key, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status as SourceStatus } : {}),
        ...(body.statusNote !== undefined ? { statusNote: body.statusNote } : {}),
        ...(body.coverageNote !== undefined ? { coverageNotes: body.coverageNote } : {}),
        ...(body.listingUrl !== undefined ? { listingUrl: body.listingUrl } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.intervalMinutes !== undefined ? { scrapeIntervalMinutes: body.intervalMinutes } : {}),
        ...(body.method !== undefined ? { method: body.method as SourceMethod } : {}),
        ...(body.allowedHosts !== undefined ? { allowedHosts: body.allowedHosts } : {}),
      });
      await audit(repos.audit, request, {
        action: 'admin.source-updated',
        targetType: 'source',
        targetId: params.key,
        actorUserId: admin.id,
        actorRole: admin.role,
        meta: { fields: Object.keys(body) },
      });
      return {
        source: updated ? toSourceStatus(updated, await repos.runs.lastRun(params.key)) : null,
        message: 'Kaynak güncellendi.',
      };
    },
  );

  app.post(
    '/api/admin/sources/:key/run',
    { schema: { tags: ['admin'], summary: 'Kaynağı hemen tara (kuyruğa alır)' } },
    async (request) => {
      const admin = requireAdmin(request);
      const params = z.object({ key: sourceKeySchema }).parse(request.params);
      const source = await repos.sources.getByKey(params.key);
      if (!source) throw ApiError.notFound('Kaynak bulunamadı.');
      if (!source.enabled) throw ApiError.badRequest('Kaynak devre dışı; önce etkinleştirin.');
      const result = await enqueueSourceScrapeNow({ repos, sourceKey: params.key, requestedBy: admin.id });
      await audit(repos.audit, request, {
        action: 'admin.source-scan-requested',
        targetType: 'source',
        targetId: params.key,
        actorUserId: admin.id,
        actorRole: admin.role,
        meta: { dedupeKey: result.dedupeKey, backend: result.backend },
      });
      return result;
    },
  );

  app.post(
    '/api/admin/maintenance/:kind',
    { schema: { tags: ['admin'], summary: 'Bakım işini hemen çalıştır' } },
    async (request) => {
      const admin = requireAdmin(request);
      const params = z.object({ kind: z.enum(['deadline-refresh', 'coverage-audit']) }).parse(request.params);
      const result = await enqueueMaintenanceNow({ repos, kind: params.kind, requestedBy: admin.id });
      await audit(repos.audit, request, {
        action: 'admin.maintenance-requested',
        targetType: 'system',
        targetId: params.kind,
        actorUserId: admin.id,
        actorRole: admin.role,
      });
      return result;
    },
  );

  // ------------------------------------------------------------------ tarama geçmişi
  app.get(
    '/api/admin/scrape-runs',
    { schema: { tags: ['admin'], summary: 'Tarama geçmişi (hata ayrıntılarıyla)' } },
    async (request) => {
      const query = z
        .object({
          sourceKey: sourceKeySchema.optional(),
          status: z
            .enum(['queued', 'running', 'success', 'partial', 'failed', 'skipped', 'locked'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      const runs = await repos.runs.list(
        {
          ...(query.sourceKey ? { sourceKey: query.sourceKey } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        query.limit,
      );
      const summary = await repos.runs.summary();
      return {
        runs: runs.map(toRunSummary),
        summary,
        /** HTML değişince oluşan doğrulama hataları burada görünür (kaynak sağlığı). */
        failing: runs
          .filter((run) => run.status === 'failed' || run.status === 'partial')
          .map((run) => ({
            id: run.id,
            sourceKey: run.sourceKey,
            startedAt: run.startedAt,
            result: run.result,
            errors: run.errors,
          })),
      };
    },
  );

  // ------------------------------------------------------------------ inceleme kuyruğu
  app.get(
    '/api/admin/review-queue',
    { schema: { tags: ['admin'], summary: 'İnceleme kuyruğu (sınıflandırma/tekilleştirme/çıkarım)' } },
    async (request) => {
      const query = z
        .object({
          kind: z.enum(['classification', 'dedupe', 'extraction']).optional(),
          status: z.enum(['open', 'resolved', 'ignored']).default('open'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      const [items, counts] = await Promise.all([
        repos.review.list({ ...(query.kind ? { kind: query.kind } : {}), status: query.status }, query.limit),
        repos.review.countOpen(),
      ]);
      const candidates = new Map<string, string>();
      for (const item of items) {
        for (const candidateId of item.candidateJobIds) {
          if (candidates.has(candidateId)) continue;
          const job = await repos.jobs.findById(candidateId);
          if (job) candidates.set(candidateId, job.title);
        }
      }
      return {
        items: items.map(toReviewItem),
        counts,
        candidateTitles: Object.fromEntries(candidates),
        note: 'Belirsiz kayıtlar sessizce silinmez; buradan karar verilir. "ignore" kaydı ilan listesinde göstermez.',
      };
    },
  );

  app.post(
    '/api/admin/review-queue/:id/resolve',
    { schema: { tags: ['admin'], summary: 'İnceleme kaydını çöz/geç' } },
    async (request) => {
      const admin = requireAdmin(request);
      const params = z.object({ id: z.string().min(5).max(64) }).parse(request.params);
      const body = z
        .object({
          action: z.enum(['accept', 'reject', 'merge', 'keep-separate', 'ignore']),
          note: z.string().trim().max(400).default(''),
        })
        .parse(request.body ?? {});
      const item = await repos.review.findById(params.id);
      if (!item) throw ApiError.notFound('İnceleme kaydı bulunamadı.');

      if (body.action === 'ignore') {
        await repos.review.ignore(params.id, body.note || 'Yönetici ilanı yok saydı.', admin.id);
      } else {
        await repos.review.resolve(params.id, `${body.action}${body.note ? `: ${body.note}` : ''}`, admin.id);
      }

      // Sınıflandırma kararında: yönetici "accept" derse inceleme kaydı gerçek ilana dönüştürülür.
      let acceptedJobId: string | null = null;
      if (body.action === 'accept' && item.kind === 'classification') {
        for (const candidateId of item.candidateJobIds) {
          const existingJob = await repos.jobs.findById(candidateId);
          if (existingJob && existingJob.classification.decision !== 'accept') {
            await repos.jobs.updateJob(existingJob.id, {
              classification: {
                ...existingJob.classification,
                decision: 'accept',
                classifiedAt: repos.clock.now().toISOString(),
              },
              updatedAt: repos.clock.now().toISOString(),
            });
            acceptedJobId = existingJob.id;
          }
        }
        if (
          !acceptedJobId &&
          typeof item.payload.sourceItemId === 'string' &&
          item.payload.sourceItemId.length > 0
        ) {
          const excerpt = typeof item.payload.excerpt === 'string' ? item.payload.excerpt : '';
          const raw: RawAnnouncement = {
            sourceKey: item.sourceKey,
            sourceItemId: item.payload.sourceItemId,
            url: item.url,
            title: item.title,
            ...(typeof item.payload.institution === 'string'
              ? { institution: item.payload.institution }
              : {}),
            ...(typeof item.payload.publishedAt === 'string'
              ? { publishedAt: item.payload.publishedAt }
              : {}),
            ...(typeof item.payload.applicationStartAt === 'string'
              ? { applicationStartAt: item.payload.applicationStartAt }
              : {}),
            ...(typeof item.payload.applicationEndAt === 'string'
              ? { applicationEndAt: item.payload.applicationEndAt }
              : {}),
            bodyText: excerpt,
            rawExcerpt: excerpt,
            extractionConfidence: item.confidence,
            attachments: Array.isArray(item.payload.attachments)
              ? (item.payload.attachments as RawAnnouncement['attachments'])
              : [],
          };
          const employmentType = (
            typeof item.payload.employmentType === 'string' ? item.payload.employmentType : 'belirsiz'
          ) as EmploymentType;
          const outcome = await applyRawAnnouncement(
            raw,
            { repos, now: repos.clock.now(), workerId: `admin:${admin.id}`, provenance: 'scraped' },
            {
              classificationOverride: {
                decision: 'accept',
                kind: 'job',
                employmentType,
                confidence: Math.max(item.confidence, 0.85),
                reasons: [
                  ...(Array.isArray(item.payload.reasons) ? item.payload.reasons.map(String) : []),
                  'Yönetici onayıyla kabul edildi',
                ],
                rules: Array.isArray(item.payload.rules) ? item.payload.rules.map(String) : ['admin-accept'],
                negativeSignals: [],
                version: CLASSIFICATION_VERSION,
              },
            },
          );
          acceptedJobId = outcome.jobId;
        }
      }

      // Tekilleştirme kararında: birleştirme yalnızca YÖNETİCİ onayıyla uygulanır.
      let mergeResult: { mergedJobId: string; removedJobId: string } | null = null;
      if (body.action === 'merge' && item.kind === 'dedupe' && item.candidateJobIds.length >= 2) {
        const [targetId, sourceId] = item.candidateJobIds;
        if (targetId && sourceId) {
          const target = await repos.jobs.findById(targetId);
          const duplicate = await repos.jobs.findById(sourceId);
          if (target && duplicate) {
            const links = await repos.jobs.listSourceLinks(duplicate.id);
            for (const link of links) {
              // Kaynak bağlantıları KORUNUR (hiçbiri silinmez), yalnızca hedef ilana taşınır.
              await repos.jobs.addSourceLink({ ...link, id: createId('jsrc'), jobId: target.id });
            }
            const now = repos.clock.now().toISOString();
            await repos.jobs.updateJob(target.id, {
              sourceKeys: [...new Set([...target.sourceKeys, ...duplicate.sourceKeys])],
              version: target.version + 1,
              updatedAt: now,
            });
            await repos.jobs.addRevision({
              id: createId('rev'),
              jobId: target.id,
              version: target.version + 1,
              changeTypes: ['source-added'],
              changedFields: ['sourceKeys'],
              summary: `Yönetici onayıyla birleştirildi: ${duplicate.title}`,
              previous: { sourceKeys: target.sourceKeys },
              current: { sourceKeys: [...new Set([...target.sourceKeys, ...duplicate.sourceKeys])] },
              createdAt: now,
              sourceKey: item.sourceKey,
            });
            await repos.jobs.updateJob(duplicate.id, {
              status: 'closed',
              statusReason: `Yönetici onayıyla ${target.id} ile birleştirildi.`,
              updatedAt: now,
            });
            mergeResult = { mergedJobId: target.id, removedJobId: duplicate.id };
          }
        }
      }

      await audit(repos.audit, request, {
        action: 'admin.review-resolved',
        targetType: 'review',
        targetId: params.id,
        actorUserId: admin.id,
        actorRole: admin.role,
        meta: { decision: body.action, mergeResult, acceptedJobId },
      });
      return {
        decision: body.action,
        mergeResult,
        acceptedJobId,
        message: mergeResult
          ? 'Kayıtlar birleştirildi; kaynak bağlantıları korundu ve ikinci kayıt kapatıldı.'
          : acceptedJobId
            ? 'İlan kabul edildi ve yayımlandı.'
            : 'Karar kaydedildi.',
      };
    },
  );

  // ------------------------------------------------------------------ e-posta outbox
  app.get(
    '/api/admin/email-outbox',
    { schema: { tags: ['admin'], summary: 'E-posta kuyruğu ve hataları' } },
    async (request) => {
      const query = z
        .object({
          status: z.enum(['pending', 'sending', 'accepted', 'failed', 'dead', 'suppressed']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      const [items, stats, dead] = await Promise.all([
        repos.outbox.list(query.status ? { status: query.status } : {}, query.limit),
        repos.outbox.stats(),
        repos.outbox.listDead(20),
      ]);
      return {
        items: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          to: `${item.toEmail.slice(0, 2)}***@${item.toEmail.split('@')[1] ?? ''}`,
          subject: item.subject,
          status: item.status,
          attempts: item.attempts,
          maxAttempts: item.maxAttempts,
          nextAttemptAt: item.nextAttemptAt,
          lockedBy: item.lockedBy,
          lastError: item.lastError,
          providerMessageId: item.providerMessageId,
          createdAt: item.createdAt,
          acceptedAt: item.acceptedAt,
          failedAt: item.failedAt,
        })),
        stats,
        dead: dead.map((item) => ({
          id: item.id,
          kind: item.kind,
          subject: item.subject,
          lastError: item.lastError,
        })),
        schema: 'pending → sending → accepted | failed → dead',
        notice: '"accepted" sağlayıcının kabul ettiği anlamına gelir; teslim garantisi değildir.',
      };
    },
  );

  app.post(
    '/api/admin/email-outbox/:id/requeue',
    { schema: { tags: ['admin'], summary: 'Ölü e-posta işini yeniden kuyruğa al' } },
    async (request) => {
      const admin = requireAdmin(request);
      const params = z.object({ id: z.string().min(5).max(64) }).parse(request.params);
      const item = await repos.outbox.requeue(params.id);
      if (!item) throw ApiError.badRequest('Yalnızca "dead" durumundaki işler yeniden kuyruğa alınabilir.');
      await audit(repos.audit, request, {
        action: 'admin.email-requeued',
        targetType: 'email-outbox',
        targetId: params.id,
        actorUserId: admin.id,
        actorRole: admin.role,
      });
      return {
        item: { id: item.id, status: item.status, attempts: item.attempts },
        message: 'İş yeniden denenecek.',
      };
    },
  );

  // ------------------------------------------------------------------ kuyruk / kilitler
  app.get(
    '/api/admin/queue',
    { schema: { tags: ['admin'], summary: 'Kuyruk durumu, ölü işler ve kilitler' } },
    async () => {
      const [stats, dead, locks, tasks] = await Promise.all([
        repos.queue.stats(),
        repos.queue.listDead(50),
        repos.locks.list(),
        repos.scheduledTasks.listAll(),
      ]);
      const now = repos.clock.now().toISOString();
      return {
        stats,
        dead: dead.map((job) => ({
          id: job.id,
          queue: job.queue,
          name: job.name,
          attempts: job.attempts,
          lastError: job.lastError,
          updatedAt: job.updatedAt,
        })),
        locks: locks.map((lock) => ({
          key: lock.key,
          owner: lock.owner,
          expiresAt: lock.expiresAt,
          expired: lock.expiresAt < now,
        })),
        tasks: tasks.map((task) => ({
          id: task.id,
          kind: task.kind,
          sourceKey: task.sourceKey,
          enabled: task.enabled,
          intervalMinutes: task.intervalMinutes,
          nextRunAt: task.nextRunAt,
          lastRunAt: task.lastRunAt,
          lastEnqueuedRunId: task.lastEnqueuedRunId,
          misses: task.misses,
          overdueMinutes: Math.max(0, Math.round((Date.parse(now) - Date.parse(task.nextRunAt)) / 60_000)),
        })),
        scheduleLagWarning: tasks.some((task) => Date.parse(now) - Date.parse(task.nextRunAt) > 10 * 60_000)
          ? 'Bazı görevlerin planlanan zamanı geçmiş: worker çalışmıyor ya da yoğun olabilir.'
          : null,
      };
    },
  );

  app.post(
    '/api/admin/queue/:id/requeue',
    { schema: { tags: ['admin'], summary: 'Ölü kuyruk işini yeniden dene' } },
    async (request) => {
      const admin = requireAdmin(request);
      const params = z.object({ id: z.string().min(5).max(64) }).parse(request.params);
      const job = await repos.queue.requeue(params.id);
      if (!job) throw ApiError.badRequest('Yalnızca "dead" durumundaki işler yeniden denenebilir.');
      await audit(repos.audit, request, {
        action: 'admin.queue-requeued',
        targetType: 'queue',
        targetId: params.id,
        actorUserId: admin.id,
        actorRole: admin.role,
      });
      return { job: { id: job.id, status: job.status }, message: 'İş yeniden kuyruğa alındı.' };
    },
  );

  // ------------------------------------------------------------------ revizyon geçmişi
  app.get(
    '/api/admin/jobs/:id/revisions',
    { schema: { tags: ['admin'], summary: 'İlan değişiklik geçmişi' } },
    async (request) => {
      const params = z.object({ id: z.string().min(5).max(64) }).parse(request.params);
      const [job, revisions, links] = await Promise.all([
        repos.jobs.findById(params.id),
        repos.jobs.listRevisions(params.id),
        repos.jobs.listSourceLinks(params.id),
      ]);
      if (!job) throw ApiError.notFound('İlan bulunamadı.');
      return {
        job: {
          id: job.id,
          title: job.title,
          institution: job.institution,
          status: job.status,
          classificationDecision: job.classification.decision,
          classification: job.classification,
          version: job.version,
          contentHash: job.contentHash,
          provenance: job.provenance,
          firstSeenAt: job.firstSeenAt,
          lastSeenAt: job.lastSeenAt,
          lastVerifiedAt: job.lastVerifiedAt,
        },
        revisions: revisions.map(toRevision),
        sources: links.map((link) => ({
          sourceKey: link.sourceKey,
          url: link.url,
          active: link.active,
          firstSeenAt: link.firstSeenAt,
          lastSeenAt: link.lastSeenAt,
        })),
      };
    },
  );

  // ------------------------------------------------------------------ kullanıcılar / denetim
  app.get(
    '/api/admin/users',
    { schema: { tags: ['admin'], summary: 'Kullanıcı listesi (e-postalar maskeli)' } },
    async (request) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(request.query);
      const [users, notifiableCount] = await Promise.all([
        repos.store.find('users', {}, { limit: query.limit, sort: [['createdAt', -1]] }),
        repos.notifications.countNotifiable(),
      ]);
      const preferences = await Promise.all(users.map((user) => repos.notifications.getPreference(user.id)));
      return {
        users: users.map((user, index) => ({
          ...toUserProfile(user, { self: false }),
          notificationsEnabled: Boolean(preferences[index]?.enabled) && !preferences[index]?.paused,
          notificationMode: preferences[index]?.mode ?? null,
        })),
        notifiableCount,
        notice:
          'KVKK gereği yönetici paneli e-posta adreslerini maskeli gösterir; iletişim yalnızca kullanıcı isteğiyle kurulur.',
      };
    },
  );

  /**
   * Kullanıcı daveti. Kamuİlan'da dışarıdan kayıt yoktur: hesabı yönetici açar,
   * kullanıcı tek kullanımlık bağlantıyla kendi şifresini belirler.
   * Parola üretilmez, düz metin parola hiçbir zaman oluşturulmaz/gönderilmez.
   */
  app.post(
    '/api/admin/users',
    { schema: { tags: ['admin'], summary: 'Kullanıcı davet et (hesabı yönetici açar)' } },
    async (request, reply) => {
      const body = z
        .object({
          email: z.email('Geçerli bir e-posta adresi girin.').trim().toLowerCase().max(160),
          displayName: z.string().trim().min(2).max(80).optional(),
          role: z.enum(['user', 'admin']).default('user'),
          note: z.string().trim().max(300).optional(),
        })
        .parse(request.body);

      const existing = await repos.users.findByEmail(body.email);
      if (existing) throw ApiError.conflict('Bu e-posta ile bir hesap zaten var.');

      // Parola yerine rastgele bir sır üretilip hash'lenir: kullanıcı bağlantıdan
      // kendi parolasını belirleyene kadar hesap giriş yapılamaz durumda kalır.
      const { hash, salt } = await hashPassword(randomToken(48));
      const created = await repos.users.create({
        email: body.email,
        passwordHash: hash,
        passwordSalt: salt,
        displayName: body.displayName ?? body.email.split('@')[0] ?? 'Kullanıcı',
        role: body.role,
      });
      if (!created.created) throw ApiError.conflict('Bu e-posta ile bir hesap zaten var.');
      const user = created.user;

      const token = randomToken(32);
      await repos.users.createToken({
        userId: user.id,
        type: 'password-reset',
        token,
        ttlMinutes: 60 * 24 * 3,
      });
      await repos.outbox.enqueue({
        eventId: null,
        jobId: null,
        userId: user.id,
        toEmail: user.email,
        kind: 'account-invite',
        subject: `${BRANDING.name} hesabınız açıldı — şifre belirleyin`,
        template: 'account-invite',
        payload: {
          displayName: user.displayName ?? '',
          roleLabel: user.role === 'admin' ? 'yönetici' : 'kullanıcı',
          inviteUrl: `${getEnv().APP_BASE_URL}/sifre-sifirla?token=${token}`,
          expiresInHours: 72,
        },
        idempotencyKey: `invite:${user.id}:${token}`,
      });

      await audit(repos.audit, request, {
        action: 'admin.user-invited',
        targetType: 'user',
        targetId: user.id,
        meta: { role: user.role, note: body.note ?? null },
      });
      reply.status(201);
      return {
        user: toUserProfile(user, { self: false }),
        message:
          'Hesap açıldı. Kullanıcıya tek kullanımlık şifre belirleme bağlantısı e-posta ile gönderiliyor; ' +
          'bağlantı 72 saat geçerlidir.',
      };
    },
  );

  app.get(
    '/api/admin/audit-logs',
    { schema: { tags: ['admin'], summary: 'Denetim kaydı' } },
    async (request) => {
      const query = z
        .object({
          action: z.string().trim().max(60).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .parse(request.query);
      const logs = await repos.audit.list(query.limit, query.action);
      return {
        logs: logs.map((log) => ({
          id: log.id,
          action: log.action,
          actorUserId: log.actorUserId,
          actorRole: log.actorRole,
          targetType: log.targetType,
          targetId: log.targetId,
          meta: log.meta,
          ipHash: log.ipHash,
          createdAt: log.createdAt,
        })),
      };
    },
  );

  // ------------------------------------------------------------------ kapsam raporu
  app.get(
    '/api/admin/coverage-report',
    { schema: { tags: ['admin'], summary: 'Kapsam raporu (doğrulanan / planlanan kaynaklar)' } },
    async () => {
      const coverage = await repos.sources.coverage();
      const byGroup = new Map<string, number>();
      for (const entry of coverage.sources) byGroup.set(entry.group, (byGroup.get(entry.group) ?? 0) + 1);
      const registryKeys = new Set(SOURCE_DEFINITIONS.map((definition) => definition.key));
      return {
        verified: coverage.sources.filter((entry) => entry.verified).length,
        enabled: coverage.sources.filter((entry) => entry.enabled).length,
        total: coverage.sources.length,
        planned: coverage.planned.length,
        byGroup: [...byGroup.entries()].map(([group, count]) => ({ group, count })),
        gaps: coverage.sources
          .filter((entry) => entry.enabled && (!entry.verified || entry.health.consecutiveFailures > 0))
          .map((entry) => ({
            key: entry.key,
            name: entry.name,
            reason: !entry.verified ? 'canlı doğrulama yapılmadı' : 'üst üste başarısız tarama',
          })),
        unscheduled: coverage.sources
          .filter((entry) => !registryKeys.has(entry.key))
          .map((entry) => entry.key),
        unknownRegistryAdapters: SOURCE_DEFINITIONS.filter(
          (definition) => !coverage.sources.some((entry) => entry.key === definition.key),
        ).map((definition) => definition.key),
        disclaimer:
          'Bu rapor hiçbir zaman "tüm ilanlar toplanıyor" iddiası taşımaz: yalnızca listede olan kaynaklara bakılır; henüz başlanmamış kurumlar listede açıkça görünür.',
        generatedAt: repos.clock.now().toISOString(),
      };
    },
  );

  /** Tüm kaynakları kuyruğa alır (yönetici acil tarama). */
  app.post(
    '/api/admin/sources/run-all',
    { schema: { tags: ['admin'], summary: 'Tüm etkin kaynakları tara' } },
    async (request) => {
      const admin = requireAdmin(request);
      const sources = await repos.sources.listEnabled();
      const results = [];
      for (const source of sources) {
        results.push({
          sourceKey: source.key,
          ...(await enqueueSourceScrapeNow({ repos, sourceKey: source.key, requestedBy: admin.id })),
        });
      }
      await audit(repos.audit, request, {
        action: 'admin.source-scan-all',
        targetType: 'system',
        targetId: 'all',
        actorUserId: admin.id,
        actorRole: admin.role,
        meta: { count: results.length },
      });
      return { requested: results.length, results };
    },
  );
}
