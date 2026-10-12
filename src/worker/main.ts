/**
 * Worker giriş noktası.
 *
 * Kullanım:
 *   npm run start:worker         (üretim/sunucu)
 *   npm run dev:worker           (geliştirme, dosya değişiminde yeniden başlar)
 *
 * Yaptığı iş: ortamı doğrular → depoyu başlatır → kaynak envanterini veritabanına
 * yazar (idempotent) → zamanlanmış görevleri kurar → worker döngüsünü çalıştırır.
 * SIGINT/SIGTERM ile mevcut tur biter ve bağlantılar kapatılır.
 */
import { describeEnv, getEnv } from '../config/env';
import { BRANDING, EXTRACTION_VERSION } from '../config/app';
import { closeStore, initStore } from '../db/store';
import { createRepos } from '../db/repos';
import { createLogger } from '../lib/logger';
import { createQueueBackend } from './queue';
import { WorkerRuntime } from './runtime';

export async function startWorker(): Promise<void> {
  const env = getEnv();
  const logger = createLogger('worker-bootstrap', { level: env.LOG_LEVEL });

  const store = await initStore();
  const repos = createRepos(store);

  const seeded = await repos.sources.seed();
  logger.info(
    { created: seeded.created, updated: seeded.updated },
    'kaynak envanteri veritabanına yazıldı',
  );

  const queue = await createQueueBackend(repos, logger, env);
  const runtime = new WorkerRuntime({ repos, queue, env, logger });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'kapatma sinyali alındı');
    runtime.requestStop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    {
      app: BRANDING.name,
      version: EXTRACTION_VERSION,
      workerId: runtime.workerId,
      queue: queue.kind,
      tickMs: env.SCHEDULER_TICK_MS,
      liveFetch: env.SOURCE_LIVE_FETCH,
      env: describeEnv(env),
    },
    'worker başlatılıyor',
  );

  try {
    await runtime.run();
  } finally {
    await closeStore();
    logger.info({}, 'worker kapandı');
  }
}

const isDirectRun = process.argv[1]?.includes('worker/main') ?? false;

if (isDirectRun) {
  startWorker().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    // Üretimde sessizce çıkmak yok: hata basılır ve süreç hata kodu ile biter.
    process.stderr.write(`Worker başlatılamadı: ${message}\n`);
    process.exitCode = 1;
  });
}
