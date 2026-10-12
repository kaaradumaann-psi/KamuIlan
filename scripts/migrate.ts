/**
 * Bakım/migrasyon betiği: `npm run db:migrate`
 *
 * Yaptıkları (idempotent):
 *  1. Depoyu açar, şema doğrulamasını çalıştırır (depo init).
 *  2. İndeksleri kurar.
 *  3. Kaynak envanterini (src/config/sources.ts) veritabanına yazar/günceller.
 *  4. Eksik zamanlanmış görevleri oluşturur (worker kapatıldıysa yeniden üretir).
 *  5. Süresi geçmiş kilit/oturum kayıtlarını temizler.
 *
 * Veri silmez; yalnızca ekler/günceller. Rapor basar.
 */
import { initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { ensureScheduledTasks } from '../src/worker/scheduler';
import { createLogger } from '../src/lib/logger';
import { SOURCE_DEFINITIONS } from '../src/config/sources';

async function main(): Promise<void> {
  const logger = createLogger('migrate', { level: 'info' });
  const store = await initStore();
  const repos = createRepos(store);

  const indexes = await store.ensureIndexes();
  console.log(`• indeksler: ${indexes.length} tanım (yeni: ${indexes.filter((index) => index.created).length})`);

  const seed = await repos.sources.seed(SOURCE_DEFINITIONS);
  console.log(`• kaynak envanteri: ${seed.created} eklendi, ${seed.updated} güncellendi (toplam ${SOURCE_DEFINITIONS.length})`);

  const tasks = await ensureScheduledTasks(repos, logger);
  console.log(
    `• zamanlanmış görevler: toplam ${tasks.total} (yeni ${tasks.created}, güncellenen ${tasks.updated}, devre dışı ${tasks.disabled})`,
  );

  const expiredLocks = await repos.locks.purgeExpired();
  const expiredSessions = await repos.users.purgeExpiredSessions();
  const expiredRateLimits = await repos.rateLimits.purgeOlderThan(new Date(Date.now() - 3_600_000).toISOString());
  console.log(`• temizlik: ${expiredLocks} süresi geçmiş kilit, ${expiredSessions} oturum, ${expiredRateLimits} hız sınırı kaydı`);

  const summary = await repos.runs.summary();
  console.log(
    `• tarama geçmişi: ${summary.total} kayıt (başarılı ${summary.success}, başarısız ${summary.failed}, atlanan ${summary.skipped})`,
  );
  console.log(`✔ Bakım tamamlandı (sürücü: ${store.driver}).`);
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('Bakım başarısız:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
