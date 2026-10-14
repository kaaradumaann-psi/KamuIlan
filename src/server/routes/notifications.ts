/**
 * Bildirim tercihleri ve geçmişi (yalnızca oturum sahibi erişir).
 *
 * Kural: bir kullanıcı yalnızca kendi tercihlerini görür/değiştirir. Yönetici de
 * olsa başka kullanıcının verisine buradan erişilemez (admin uçları ayrıdır).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BRANDING } from '../../config/app';
import type { Repos } from '../../db/repos';
import { EDUCATION_LEVELS, EMPLOYMENT_TYPES, KPSS_SCORE_TYPES } from '../../domain';
import { audit, requireUser } from '../context';
import { ApiError } from '../errors';

const filtersSchema = z
  .object({
    keywords: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
    titles: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
    institutions: z.array(z.string().trim().min(2).max(120)).max(30).optional(),
    cities: z.array(z.string().trim().min(2).max(60)).max(81).optional(),
    employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(EMPLOYMENT_TYPES.length).optional(),
    educationLevels: z.array(z.enum(EDUCATION_LEVELS)).max(EDUCATION_LEVELS.length).optional(),
    departments: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
    kpssScoreTypes: z.array(z.enum(KPSS_SCORE_TYPES)).max(KPSS_SCORE_TYPES.length).optional(),
    kpssMinScore: z.number().min(0).max(100).nullable().optional(),
    minDaysUntilDeadline: z.number().int().min(0).max(365).nullable().optional(),
  })
  .strict();

const preferenceBody = z
  .object({
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
    mode: z.enum(['instant', 'daily-digest']).optional(),
    onlyNewJobs: z.boolean().optional(),
    notifyOnChanges: z.boolean().optional(),
    includeWorkerJobs: z.boolean().optional(),
    includeAcademicJobs: z.boolean().optional(),
    profilePersonalizationEnabled: z.boolean().optional(),
    candidateProfile: z
      .object({
        profession: z.string().trim().max(100).optional(),
        educationLevel: z.enum(EDUCATION_LEVELS).nullable().optional(),
        departments: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
        skills: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
        experienceYears: z.number().int().min(0).max(50).nullable().optional(),
      })
      .strict()
      .optional(),
    filters: filtersSchema.optional(),
  })
  .strict();

export function registerNotificationRoutes(app: FastifyInstance, repos: Repos): void {
  app.get(
    '/api/notifications/preferences',
    { schema: { tags: ['notifications'], summary: 'Bildirim tercihlerim' } },
    async (request) => {
      const user = requireUser(request);
      const preference = await repos.notifications.getPreference(user.id);
      return {
        preference,
        email: user.email,
        emailVerified: user.emailVerified,
        canReceive: Boolean(preference?.enabled) && !preference?.paused && user.emailVerified,
        options: {
          employmentTypes: EMPLOYMENT_TYPES,
          educationLevels: EDUCATION_LEVELS,
          kpssScoreTypes: KPSS_SCORE_TYPES,
          modes: ['instant', 'daily-digest'],
        },
        notice: user.emailVerified ? null : 'E-posta adresinizi doğrulamadan bildirim gönderilmez.',
      };
    },
  );

  app.put(
    '/api/notifications/preferences',
    { schema: { tags: ['notifications'], summary: 'Bildirim tercihlerini güncelle' } },
    async (request) => {
      const user = requireUser(request);
      const body = preferenceBody.parse(request.body ?? {});
      const preference = await repos.notifications.upsertPreference(user.id, {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.onlyNewJobs !== undefined ? { onlyNewJobs: body.onlyNewJobs } : {}),
        ...(body.notifyOnChanges !== undefined ? { notifyOnChanges: body.notifyOnChanges } : {}),
        ...(body.includeWorkerJobs !== undefined ? { includeWorkerJobs: body.includeWorkerJobs } : {}),
        ...(body.includeAcademicJobs !== undefined ? { includeAcademicJobs: body.includeAcademicJobs } : {}),
        ...(body.profilePersonalizationEnabled !== undefined
          ? { profilePersonalizationEnabled: body.profilePersonalizationEnabled }
          : {}),
        ...(body.candidateProfile !== undefined ? { candidateProfile: body.candidateProfile } : {}),
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
      });
      await audit(repos.audit, request, {
        action: 'notifications.preferences-updated',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
        meta: { fields: Object.keys(body) },
      });
      return {
        preference,
        message: [
          'Tercihler kaydedildi.',
          preference.enabled && !preference.paused
            ? 'Eşleşen yeni ilanlar için bildirim gönderilecek.'
            : 'Bildirimler şu anda kapalı.',
          user.emailVerified ? '' : 'E-posta doğrulanmadığı için gönderim yapılmaz.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    },
  );

  app.post(
    '/api/notifications/pause',
    { schema: { tags: ['notifications'], summary: 'Bildirimleri duraklat / devam ettir' } },
    async (request) => {
      const user = requireUser(request);
      const body = z.object({ paused: z.boolean() }).parse(request.body ?? {});
      const preference = await repos.notifications.upsertPreference(user.id, { paused: body.paused });
      await audit(repos.audit, request, {
        action: body.paused ? 'notifications.paused' : 'notifications.resumed',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return {
        preference,
        message: body.paused ? 'Bildirimler duraklatıldı.' : 'Bildirimler yeniden açıldı.',
      };
    },
  );

  app.get(
    '/api/notifications/history',
    { schema: { tags: ['notifications'], summary: 'Bildirim geçmişim' } },
    async (request) => {
      const user = requireUser(request);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
        .parse(request.query);
      const events = await repos.notifications.listEventsForUser(user.id, query.limit);
      const outbox = await repos.outbox.list({ userId: user.id }, query.limit);
      const jobIds = [...new Set(events.map((event) => event.jobId))];
      const jobs = await Promise.all(jobIds.map((jobId) => repos.jobs.findById(jobId)));
      const titles = new Map(jobs.filter((job) => job !== null).map((job) => [job.id, job.title]));

      return {
        events: events.map((event) => ({
          id: event.id,
          jobId: event.jobId,
          jobTitle: titles.get(event.jobId) ?? null,
          kind: event.kind,
          jobVersion: event.jobVersion,
          status: event.status,
          suppressionReason: event.suppressionReason,
          matchedOn: event.matchedOn,
          createdAt: event.createdAt,
        })),
        emails: outbox.map((item) => ({
          id: item.id,
          subject: item.subject,
          kind: item.kind,
          // Durum dürüstçe raporlanır: "accepted" = sağlayıcı kabul etti.
          status: item.status,
          statusLabel:
            item.status === 'accepted'
              ? 'sağlayıcıya iletildi / kabul edildi'
              : item.status === 'pending'
                ? 'gönderim bekliyor'
                : item.status === 'sending'
                  ? 'gönderiliyor'
                  : item.status === 'failed'
                    ? 'geçici hata, yeniden denenecek'
                    : item.status === 'dead'
                      ? 'gönderilemedi (denemeler tükendi)'
                      : 'gönderim durduruldu',
          attempts: item.attempts,
          createdAt: item.createdAt,
          acceptedAt: item.acceptedAt,
          lastError: item.lastError ? 'Gönderim sırasında hata oluştu.' : null,
        })),
        notice: 'E-posta durumu sağlayıcı raporudur; "teslim edildi" garantisi verilmez.',
      };
    },
  );

  /** Test e-postası: geliştirme posta sunucusu (MailHog benzeri) ile doğrulamak için. */
  app.post(
    '/api/notifications/test-email',
    { schema: { tags: ['notifications'], summary: 'Kendime test e-postası gönder' } },
    async (request) => {
      const user = requireUser(request);
      if (!user.emailVerified) throw ApiError.forbidden('Önce e-posta adresinizi doğrulayın.');
      const existing = await repos.outbox.list({ userId: user.id }, 5);
      const recent = existing.filter(
        (item) =>
          item.kind === 'test' && Date.parse(item.createdAt) > repos.clock.now().getTime() - 10 * 60_000,
      );
      if (recent.length >= 2)
        throw ApiError.rateLimited('Kısa süre içinde çok fazla test e-postası istendi.');

      const item = await repos.outbox.enqueue({
        eventId: null,
        jobId: null,
        userId: user.id,
        toEmail: user.email,
        kind: 'test',
        subject: `${BRANDING.name} test e-postası`,
        template: 'test',
        payload: {
          displayName: user.displayName ?? '',
          environment: process.env['NODE_ENV'] ?? 'development',
        },
        idempotencyKey: `test:${user.id}:${repos.clock.now().toISOString().slice(0, 16)}`,
      });
      return {
        outboxId: item.item.id,
        created: item.created,
        message: 'Test e-postası kuyruğa alındı; worker gönderdikten sonra geçmişte durumu görünür.',
      };
    },
  );
}
