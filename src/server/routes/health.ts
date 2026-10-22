/**
 * Sağlık ve sistem durumu uçları.
 *
 * `/api/health` yalnızca gerçek ölçümleri döner: veritabanı ping süresi, worker
 * kalp atışları, kuyruk ve son başarılı tarama. Uydurma istatistik yoktur.
 */
import { requireAdmin } from '../context';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  APP_VERSION,
  BRANDING,
  CLASSIFICATION_VERSION,
  DEDUPE_VERSION,
  EXTRACTION_VERSION,
} from '../../config/app';
import { describeEnv, getEnv } from '../../config/env';
import type { Repos } from '../../db/repos';
import { maskEmail } from '../../domain/text';
import { HEARTBEAT_STALE_MS } from '../../worker/scheduler';

const workerHealthResponse = z.object({
  checkedAt: z.string(),
  workers: z.object({
    total: z.number(),
    running: z.number(),
    starting: z.number(),
    stale: z.number(),
  }),
});

const healthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  app: z.string(),
  version: z.string(),
  environment: z.string(),
  checkedAt: z.string(),
  database: z.object({
    driver: z.string(),
    healthy: z.boolean(),
    latencyMs: z.number().nullable(),
    detail: z.string().nullable(),
  }),
  versions: z.object({
    classification: z.string(),
    extraction: z.string(),
    dedupe: z.string(),
  }),
  scans: z.object({
    lastSuccessAt: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    minutesSinceSuccess: z.number().nullable(),
    totalRuns: z.number(),
    failedRuns: z.number(),
  }),
  workers: z.object({
    total: z.number(),
    running: z.number(),
    stale: z.number(),
    items: z.array(
      z.object({
        workerId: z.string(),
        role: z.string(),
        status: z.string(),
        lastHeartbeatAt: z.string(),
        processedJobs: z.number(),
      }),
    ),
  }),
  queue: z.object({
    backend: z.string(),
    pending: z.number(),
    active: z.number(),
    dead: z.number(),
  }),
  sources: z.object({
    total: z.number(),
    enabled: z.number(),
    verified: z.number(),
    failing: z.number(),
    stale: z.number(),
  }),
  warnings: z.array(z.string()),
});

export function registerHealthRoutes(app: FastifyInstance, repos: Repos): void {
  // Hafif readiness ucu: dev başlatıcısı bunu kullanır; tam /api/health
  // kaynak başına tarama istatistikleri topladığından Supabase'ta ağır olabilir.
  app.get(
    '/api/health/worker',
    {
      schema: {
        tags: ['health'],
        summary: 'Worker başlangıç/heartbeat durumu',
        response: { 200: workerHealthResponse },
      },
    },
    async () => {
      const now = repos.clock.now();
      const staleThreshold = new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString();
      const heartbeats = (await repos.heartbeats.list()).filter((beat) => beat.role === 'worker');
      const recent = heartbeats.filter((beat) => beat.lastHeartbeatAt >= staleThreshold);
      return {
        checkedAt: now.toISOString(),
        workers: {
          total: heartbeats.length,
          running: recent.filter((beat) => beat.status === 'running').length,
          starting: recent.filter((beat) => beat.status === 'starting').length,
          stale: heartbeats.filter(
            (beat) => beat.status !== 'stopped' && beat.lastHeartbeatAt < staleThreshold,
          ).length,
        },
      };
    },
  );

  app.get(
    '/api/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Sistem sağlığı',
        response: { 200: healthResponse },
      },
    },
    async (request) => {
      const env = getEnv();
      const now = repos.clock.now();
      const startedAt = Date.now();
      const health = await repos.store.health();
      const latencyMs = Date.now() - startedAt;
      const [runSummary, heartbeats, queueStats, coverage] = await Promise.all([
        repos.runs.summary(),
        repos.heartbeats.list(),
        repos.queue.stats(),
        repos.sources.coverage({ termsPolicy: env.SOURCE_TERMS_POLICY }),
      ]);

      const staleThreshold = new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString();
      // 'stopped' kayıtlar bayat sayılmaz: süreç bilinçli/kendiliğinden durmuştur.
      const staleWorkers = heartbeats.filter(
        (beat) => beat.status !== 'stopped' && beat.lastHeartbeatAt < staleThreshold,
      );
      const runningWorkers = heartbeats.filter(
        (beat) => beat.status === 'running' && beat.lastHeartbeatAt >= staleThreshold,
      ).length;
      const warnings: string[] = [];
      if (!health.ok) warnings.push('Veritabanına erişilemiyor.');
      if (coverage.summary.failing > 0)
        warnings.push(`${coverage.summary.failing} kaynak üst üste başarısız.`);
      if (coverage.summary.stale > 0) {
        warnings.push(`${coverage.summary.stale} kaynağın uzun süredir başarılı taraması yok.`);
      }
      if ((queueStats.dead ?? 0) > 0) warnings.push(`${queueStats.dead} iş ölü mektup kuyruğunda.`);
      if (runningWorkers === 0) warnings.push('Aktif worker kalp atışı yok; zamanlanmış taramalar şu an yürütülmüyor.');
      const rlsStore = repos.store as { rowLevelSecurityReport?: () => Promise<{ enabled: boolean }[]> };
      if (health.ok && typeof rlsStore.rowLevelSecurityReport === 'function') {
        const rlsOff = (await rlsStore.rowLevelSecurityReport()).filter((row) => !row.enabled).length;
        if (rlsOff > 0) warnings.push(`${rlsOff} veritabanı tablosunda satır düzeyi güvenlik (RLS) kapalı.`);
      }

      const minutesSinceSuccess = runSummary.lastSuccessAt
        ? Math.round((now.getTime() - Date.parse(runSummary.lastSuccessAt)) / 60_000)
        : null;

      const status = !health.ok ? 'down' : warnings.length > 0 ? 'degraded' : 'ok';

      return {
        status,
        app: BRANDING.name,
        version: APP_VERSION,
        environment: env.NODE_ENV,
        checkedAt: now.toISOString(),
        database: {
          driver: health.driver,
          healthy: health.ok,
          latencyMs,
          // Sürücü hata mesajı host/port/dosya yolu sızdırabilir: sağlıklıyken
          // herkese, başarısızken yalnızca yöneticiye gösterilir. Ayrıntılı tanı
          // için anonim erişilebilir yol `npm run db:tls-doctor`'dır.
          detail: health.ok || request.auth?.user?.role === 'admin' ? health.detail : null,
        },
        versions: {
          classification: CLASSIFICATION_VERSION,
          extraction: EXTRACTION_VERSION,
          dedupe: DEDUPE_VERSION,
        },
        scans: {
          lastSuccessAt: runSummary.lastSuccessAt,
          lastFailureAt: runSummary.lastFailureAt,
          minutesSinceSuccess,
          totalRuns: runSummary.total,
          failedRuns: runSummary.failed,
        },
        workers: {
          total: heartbeats.length,
          // "çalışıyor" demek için yalnızca status alanı yetmez: kalp atışı taze olmalı.
          running: runningWorkers,
          stale: staleWorkers.length,
          items: heartbeats.slice(0, 10).map((beat) => ({
            workerId: beat.workerId,
            role: beat.role,
            status: beat.status,
            lastHeartbeatAt: beat.lastHeartbeatAt,
            processedJobs: beat.processedJobs,
          })),
        },
        queue: {
          backend: repos.store.driver,
          pending: queueStats.pending ?? 0,
          active: queueStats.active ?? 0,
          dead: queueStats.dead ?? 0,
        },
        sources: coverage.summary,
        warnings,
      };
    },
  );

  app.get(
    '/api/health/config',
    {
      schema: {
        tags: ['health'],
        summary: 'Maskeli ortam özeti (yalnızca yönetici)',
      },
    },
    // Maskeli olsa da altyapı bilgisi (baseUrl, sürücü, TLS modu, veri dizini,
    // sağlayıcı açık/kapalı) anonim ziyaretçiye açık olmamalıdır. Yerel tanı için
    // ağ gerektirmeyen `npm run env:check` aynı özeti verir.
    async (request) => {
      requireAdmin(request);
      const env = getEnv();
      return {
        ...describeEnv(env),
        adminContact: maskEmail(env.ADMIN_EMAIL || 'tanimli-degil@example.invalid'),
        schedulerEnabled: env.SCHEDULER_ENABLED,
      };
    },
  );
}
