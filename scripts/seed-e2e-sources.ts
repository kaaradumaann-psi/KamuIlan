/**
 * Test-only bootstrap for Playwright's source inventory.
 *
 * The API process is intentionally not the worker: starting the worker would
 * make a browser test capable of scheduling source fetches. Seed only the
 * static definitions into a file-backed NODE_ENV=test store instead.
 */
import { getEnv, inspectEnvironment } from '../src/config/env';
import { closeStore, initStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';

async function main(): Promise<void> {
  const env = getEnv();
  const unsafe: string[] = [];
  if (env.NODE_ENV !== 'test') unsafe.push('NODE_ENV must be test');
  if (env.DATABASE_DRIVER !== 'file') unsafe.push('DATABASE_DRIVER must be file');
  if (env.SOURCE_LIVE_FETCH) unsafe.push('SOURCE_LIVE_FETCH must be disabled');
  if (env.SCHEDULER_ENABLED) unsafe.push('SCHEDULER_ENABLED must be disabled');
  if (env.LLM_CLASSIFIER_ENABLED) unsafe.push('LLM_CLASSIFIER_ENABLED must be disabled');
  if (env.AI_ASSISTANT_ENABLED) unsafe.push('AI_ASSISTANT_ENABLED must be disabled');
  if (env.EMAIL_PROVIDER !== 'file') unsafe.push('EMAIL_PROVIDER must be file');
  if (unsafe.length) {
    throw new Error(`E2E kaynak seed'i güvenlik nedeniyle durduruldu: ${unsafe.join('; ')}.`);
  }

  const inspection = inspectEnvironment(env);
  if (!inspection.ok) {
    throw new Error(`E2E kaynak seed'i ortam doğrulamasını geçemedi: ${inspection.problems.join('; ')}.`);
  }

  const store = await initStore();
  try {
    if (store.driver !== 'file') {
      throw new Error(`E2E kaynak seed'i yalnızca dosya deposunda çalışabilir.`);
    }
    const result = await createRepos(store).sources.seed();
    console.log(`E2E statik kaynak envanteri hazır: ${result.created} oluşturuldu, ${result.updated} güncellendi.`);
  } finally {
    await closeStore();
  }
}

main().catch((error: unknown) => {
  console.error('E2E kaynak seed’i başarısız:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
