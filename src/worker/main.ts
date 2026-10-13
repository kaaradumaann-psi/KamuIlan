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
import { APP_VERSION, BRANDING, EXTRACTION_VERSION } from '../config/app';
import { closeStore, initStore } from '../db/store';
import { createRepos } from '../db/repos';
import { createLogger } from '../lib/logger';
import { createQueueBackend } from './queue';
import { WorkerRuntime } from './runtime';

export async function startWorker(): Promise<void> {
  const env = getEnv();
  const logger = createLogger('worker-bootstrap', { level: env.LOG_LEVEL });

  // Tabloları aç, fakat uzak DB indeksleri tamamlanana kadar worker'ı görünmez
  // bırakma: heartbeat tablosu init aşamasında hazır olduğundan starting hemen yazılabilir.
  const store = await initStore(undefined, { ensureIndexes: false });
  const repos = createRepos(store);
  const workerId = `${env.WORKER_NAMESPACE}-${process.pid}`;
  let runtime: WorkerRuntime | null = null;

  try {
    // Kaynak envanteri/takvim Supabase'ta çok sayıda gidiş-dönüş gerektirebilir.
    // Bu erken işaret, yavaş başlangıç sırasında worker'ı "kapalı" göstermesin.
    await repos.heartbeats.beat({
      workerId,
      role: 'worker',
      version: APP_VERSION,
      status: 'starting',
      processedJobs: 0,
    });

    const indexes = await store.ensureIndexes();
    logger.info({ count: indexes.length }, 'worker veritabanı indeksleri hazır');

    const seeded = await repos.sources.seed();
    logger.info(
      { created: seeded.created, updated: seeded.updated },
      'kaynak envanteri veritabanına yazıldı',
    );

    const queue = await createQueueBackend(repos, logger, env);
    runtime = new WorkerRuntime({ repos, queue, env, logger, workerId });

    const shutdown = (signal: string) => {
      logger.info({ signal }, 'kapatma sinyali alındı');
      runtime?.requestStop();
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

    await runtime.run();
  } finally {
    if (!runtime) {
      await repos.heartbeats
        .beat({ workerId, role: 'worker', version: APP_VERSION, status: 'stopped', processedJobs: 0 })
        .catch((error: unknown) => logger.warn({ err: error }, 'başlatılamayan worker durdu olarak işaretlenemedi'));
    }
    await closeStore();
    logger.info({ workerId }, 'worker kapandı');
  }
}

/**
 * `process.argv[1]` keeps the host platform's path separator. In Windows,
 * `tsx watch` supplies `C:\\repo\\src\\worker\\main.ts`, so a POSIX-only
 * `worker/main` substring check silently skips the worker bootstrap.
 */
export function isDirectWorkerExecution(entry = process.argv[1]): boolean {
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, '/');
  return /(?:^|\/)worker\/main\.(?:[cm]?[jt]s|tsx?)$/i.test(normalized);
}

if (isDirectWorkerExecution()) {
  startWorker().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    // Üretimde sessizce çıkmak yok: hata basılır ve süreç hata kodu ile biter.
    process.stderr.write(`Worker başlatılamadı: ${message}\n`);
    process.exitCode = 1;
  });
}
