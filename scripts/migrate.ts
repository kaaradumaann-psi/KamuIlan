/**
 * Bakım/migrasyon betiği: `npm run db:migrate`
 *
 * Yaptıkları (idempotent):
 *  1. Depoyu açar, şema doğrulamasını çalıştırır (depo init).
 *  2. İndeksleri kurar.
 *  3. Kaynak envanterini (src/config/sources.ts) veritabanına yazar/günceller.
 *  4. Eksik zamanlanmış görevleri oluşturur (worker kapatıldıysa yeniden üretir).
 *  5. Süresi geçmiş kilit/oturum kayıtlarını temizler.
 *  6. Job-source kayıtlarındaki `capturedText`/`rawExcerpt` gövdelerini ve
 *     kullanılmayan `rawContentHash` değerlerini temizler; durum/sayı metadata'sı kalır.
 *  7. Mevcut ilan alıntılarını sınırlar ve iletişim bilgisini redakte eder,
 *     `textNormalized` alanını güvenli alıntıdan üretir, eski içerik hash'lerini
 *     yeniden hesaplar; inceleme alıntıları ve sürüm anlık görüntülerini temizler.
 *
 * Gövde/alinti içerikleri rapora yazılmaz; yalnızca sayısal sonuçlar basılır.
 */
import { initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { ensureScheduledTasks } from '../src/worker/scheduler';
import { createLogger } from '../src/lib/logger';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { getEnv } from '../src/config/env';
import { migrateCapturedTextMetadata } from '../src/db/migrations/captured-text-metadata';
import { migrateJobTextMinimization } from '../src/db/migrations/job-text-minimization';
import { safeErrorFields } from '../src/lib/safe-error';
import { databaseTlsHelp } from '../src/lib/tls-trust';

async function main(): Promise<void> {
  const env = getEnv();
  const logger = createLogger('migrate', { level: env.LOG_LEVEL });
  const store = await initStore(undefined, { ensureIndexes: false });
  const repos = createRepos(store);

  const indexes = await store.ensureIndexes();
  console.log(
    `• indeksler: ${indexes.length} tanım kontrol edildi (yeni: ${indexes.filter((index) => index.created).length})`,
  );

  const captureMigration = await migrateCapturedTextMetadata(store);
  console.log(
    `• kaynak gövdesi: ${captureMigration.scanned} kaynak bağı incelendi; ${captureMigration.capturedBodiesCleared} yakalanmış gövde, ${captureMigration.rawExcerptsCleared} kullanılmayan alıntı ve ${captureMigration.rawContentHashesCleared} gövde özeti temizlendi; ${captureMigration.countsBackfilled} karakter sayısı ve ${captureMigration.statusesBackfilled} durum tamamlandı`,
  );

  const jobTextMigration = await migrateJobTextMinimization(store);
  console.log(
    `• ilan metni: ${jobTextMigration.jobsScanned} ilan incelendi/${jobTextMigration.jobsUpdated} güncellendi; alıntı ${jobTextMigration.excerptsSanitized}, arama kopyası ${jobTextMigration.searchCopiesRebuilt}, alan izleri ${jobTextMigration.fieldSnippetsSanitized}, hash ${jobTextMigration.hashesRebuilt}; ${jobTextMigration.reviewItemsScanned} inceleme kaydı/${jobTextMigration.reviewExcerptsSanitized} alıntı, ${jobTextMigration.revisionsScanned} sürüm/${jobTextMigration.revisionSnapshotsSanitized} anlık görüntü temizlendi`,
  );

  const seed = await repos.sources.seed(SOURCE_DEFINITIONS);
  console.log(
    `• kaynak envanteri: ${seed.created} eklendi, ${seed.updated} güncellendi (toplam ${SOURCE_DEFINITIONS.length})`,
  );

  const tasks = await ensureScheduledTasks(repos, logger, env.SCAN_INTERVAL_MINUTES);
  console.log(
    `• zamanlanmış görevler: toplam ${tasks.total} (yeni ${tasks.created}, güncellenen ${tasks.updated}, devre dışı ${tasks.disabled})`,
  );

  const expiredLocks = await repos.locks.purgeExpired();
  const expiredSessions = await repos.users.purgeExpiredSessions();
  const expiredRateLimits = await repos.rateLimits.purgeOlderThan(
    new Date(Date.now() - 3_600_000).toISOString(),
  );
  console.log(
    `• temizlik: ${expiredLocks} süresi geçmiş kilit, ${expiredSessions} oturum, ${expiredRateLimits} hız sınırı kaydı`,
  );

  const summary = await repos.runs.summary();
  console.log(
    `• tarama geçmişi: ${summary.total} kayıt (başarılı ${summary.success}, başarısız ${summary.failed}, atlanan ${summary.skipped})`,
  );
  console.log(`✔ Bakım tamamlandı (sürücü: ${store.driver}).`);
  await closeStore();
}

main().catch(async (error: unknown) => {
  // DB hatalarının `detail` alanı, örneğin benzersiz indeks çakışmasında e-posta
  // gibi kayıt değerlerini içerebilir. Ham hata nesnesi/mesajı/stack'i yazma.
  console.error('Bakım başarısız:', safeErrorFields(error));
  const tlsHelp = databaseTlsHelp(error);
  if (tlsHelp) console.error(tlsHelp);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
