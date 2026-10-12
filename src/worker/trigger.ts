/**
 * Yönetici tetiklemeli işlerin kuyruğa alınması.
 *
 * Önemli: API süreci taramayı KENDİSİ çalıştırmaz. İş, kalıcı kuyruğa yazılır ve
 * worker süreci tarafından alınır. Böylece:
 *  - aynı kaynak iki kez taranmaz (kilit + dedupe anahtarı),
 *  - API yeniden başlasa da istek kaybolmaz,
 *  - tarama süresi API yanıt süresini etkilemez.
 */
import type { Repos } from '../db/repos';
import type { Env } from '../config/env';
import { getEnv } from '../config/env';
import type { Logger } from '../lib/logger';
import { createLogger } from '../lib/logger';
import { createQueueBackend, QUEUE_NAMES } from './queue';

export interface TriggerResult {
  queued: boolean;
  backend: 'builtin' | 'redis';
  jobId: string | null;
  dedupeKey: string;
  runAt: string;
  note: string;
}

/** Kaynağı hemen tarama isteği yayınlar (yönetici "şimdi tara" düğmesi). */
export async function enqueueSourceScrapeNow(input: {
  repos: Repos;
  sourceKey: string;
  requestedBy: string;
  env?: Env;
  logger?: Logger;
}): Promise<TriggerResult> {
  const env = input.env ?? getEnv();
  const logger = input.logger ?? createLogger('trigger', { level: env.LOG_LEVEL });
  const backend = await createQueueBackend(input.repos, logger, env);
  const runAt = input.repos.clock.now();
  // Dedupe anahtarı dakika hassasiyetindedir: aynı dakikada art arda basılan
  // düğme ikinci bir iş üretmez, farklı dakikada yeni tarama başlatılabilir.
  const dedupeKey = `scrape:${input.sourceKey}:manual:${runAt.toISOString().slice(0, 16)}`;

  try {
    const result = await backend.enqueue(QUEUE_NAMES.scrape, {
      name: 'source-scrape',
      dedupeKey,
      payload: {
        sourceKey: input.sourceKey,
        trigger: 'manual',
        requestedBy: input.requestedBy,
        requestedAt: runAt.toISOString(),
      },
      runAt: runAt.toISOString(),
      maxAttempts: 2,
    });
    return {
      queued: true,
      backend: backend.kind,
      jobId: result.id,
      dedupeKey,
      runAt: runAt.toISOString(),
      note: 'İş kuyruğa alındı; worker bir sonraki tick içinde taramayı başlatır.',
    };
  } finally {
    await backend.close();
  }
}

/** Bakım işi (son başvuru tarihi yenileme / kapsam denetimi) yayınlar. */
export async function enqueueMaintenanceNow(input: {
  repos: Repos;
  kind: 'deadline-refresh' | 'coverage-audit';
  requestedBy: string;
  env?: Env;
  logger?: Logger;
}): Promise<TriggerResult> {
  const env = input.env ?? getEnv();
  const logger = input.logger ?? createLogger('trigger', { level: env.LOG_LEVEL });
  const backend = await createQueueBackend(input.repos, logger, env);
  const runAt = input.repos.clock.now();
  const dedupeKey = `maintenance:${input.kind}:manual:${runAt.toISOString().slice(0, 16)}`;

  try {
    const result = await backend.enqueue(QUEUE_NAMES.maintenance, {
      name: input.kind,
      dedupeKey,
      payload: { kind: input.kind, trigger: 'manual', requestedBy: input.requestedBy },
      runAt: runAt.toISOString(),
      maxAttempts: 1,
    });
    return {
      queued: true,
      backend: backend.kind,
      jobId: result.id,
      dedupeKey,
      runAt: runAt.toISOString(),
      note: 'Bakım işi kuyruğa alındı.',
    };
  } finally {
    await backend.close();
  }
}
