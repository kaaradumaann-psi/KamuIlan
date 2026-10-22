/**
 * API süreci girişi.
 *
 * Sıra önemlidir: ortam doğrulaması → veritabanı bağlantısı → indeksler → sunucu.
 * Ortam hatalıysa süreç anlamlı bir hata ile durur (sessizce yanlış ayarla
 * çalışmaz). Kapanışta açık istekler tamamlanır ve bağlantı kapatılır.
 */
import { BRANDING, APP_VERSION } from '../config/app';
import { getEnv, inspectEnvironment } from '../config/env';
import { initStore } from '../db/store';
import { createRepos } from '../db/repos';
import { createLogger } from '../lib/logger';
import { buildApp } from './app';

async function main(): Promise<void> {
  const env = getEnv();
  const logger = createLogger('api', { level: env.LOG_LEVEL });

  const inspection = inspectEnvironment(env);
  if (!inspection.ok) {
    logger.error({ problems: inspection.problems }, 'ortam doğrulaması başarısız');
    process.exitCode = 1;
    return;
  }
  for (const warning of inspection.warnings) logger.warn({ warning }, 'yapılandırma uyarısı');

  const store = await initStore();
  const repos = createRepos(store);
  logger.info({ driver: store.driver }, 'veritabanı ve indeksler hazır');

  // Derlenmiş arayüz yalnız üretimde aynı süreçten sunulur (geliştirmede Vite sunar).
  const app = await buildApp({ repos, serveStatic: env.NODE_ENV === 'production' });
  const port = env.PORT;
  const host = env.HOST;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'kapanış sinyali alındı');
    try {
      await app.close();
      await store.close();
      logger.info({}, 'API kapatıldı');
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'kapanış sırasında hata');
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port, host });
  logger.info(
    {
      url: `http://${host}:${port}`,
      docs: `http://${host}:${port}/api/docs`,
      version: APP_VERSION,
      app: BRANDING.name,
    },
    'API hazır',
  );
}

main().catch((error: unknown) => {
  // Loglayıcı kurulmadan önce hata olursa güvenli biçimde stderr'e yazılır.
  console.error('API başlatılamadı:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
