/**
 * Mevcut ilan kayıtlarını güncel sınıflandırma ve temizlik kurallarıyla yeniden değerlendirir.
 *
 *   npm run jobs:reclassify            → KURU ÇALIŞTIRMA: yalnızca ne değişeceğini raporlar
 *   npm run jobs:reclassify -- --apply → değişiklikleri veritabanına yazar
 *
 * Yapılan işler: sayfa kabuğu temizliği, iş ilanı kanıt kapısı (iş ilanı olmayanlar
 * "reddedildi" olarak işaretlenir ve akıştan kalkar; kayıt silinmez), yayım tarihi
 * doğrulaması ve eski ilanların durumunun yeniden hesaplanması.
 *
 * Yapılandırılmış veritabanını (DATABASE_DRIVER) kullanır. Supabase/Postgres üzerinde
 * çalıştırmadan önce mutlaka kuru çalıştırma çıktısını inceleyin.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv } from '../src/config/env';
import { effectiveDriver, describeDriver, initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import { reclassifyJob } from '../src/ingest/reclassify';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const env = getEnv();
  const driver = effectiveDriver(env);
  console.log(`Veritabanı: ${describeDriver(driver)}`);
  console.log(apply ? 'MOD: UYGULA (veritabanına yazılacak)' : 'MOD: KURU ÇALIŞTIRMA (yazılmayacak)');

  const store = await initStore(undefined, { ensureIndexes: false });
  createRepos(store);
  const jobs = await store.find('jobs', {}, { limit: 100_000 });
  const now = new Date();

  if (apply) {
    // Yazmadan önce tam yedek: veritabanı değişikliği geri alınabilir olmalı.
    // Yedek yazılamazsa hiçbir kayıt değiştirilmez.
    const backupDir = join(env.DATA_DIR, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(
      backupDir,
      `jobs-before-reclassify-${now.toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(backupPath, JSON.stringify(jobs, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(`Yedek yazıldı (${jobs.length} kayıt): ${backupPath}`);
  }

  let acceptedBefore = 0;
  let acceptedAfter = 0;
  let newlyRejected = 0;
  let newlyAccepted = 0;
  let titlesCleaned = 0;
  let statusChanged = 0;
  let written = 0;
  const rejectedSamples: string[] = [];

  for (const job of jobs as JobDoc[]) {
    if (job.classification.decision === 'accept') acceptedBefore += 1;
    const result = reclassifyJob(job, now);
    if (result.decisionTo === 'accept') acceptedAfter += 1;
    else if (job.classification.decision === 'accept') {
      newlyRejected += 1;
      if (rejectedSamples.length < 40) {
        rejectedSamples.push(`- [${result.decisionTo}] ${job.title}`);
      }
    }
    if (result.decisionTo === 'accept' && job.classification.decision !== 'accept') newlyAccepted += 1;
    if (result.titleCleaned) titlesCleaned += 1;
    if (result.statusFrom !== result.statusTo) statusChanged += 1;
    if (result.changed && apply) {
      await store.updateOne('jobs', { id: job.id }, result.patch);
      written += 1;
    }
  }

  console.log('');
  console.log(`Toplam ilan kaydı:            ${jobs.length}`);
  console.log(`Akışta (kabul) önce:          ${acceptedBefore}`);
  console.log(`Akışta (kabul) sonra:         ${acceptedAfter}`);
  console.log(`Akıştan çıkacak (reddedilen): ${newlyRejected}`);
  console.log(`Akışa girecek:                ${newlyAccepted}`);
  console.log(`Başlığı temizlenecek:         ${titlesCleaned}`);
  console.log(`Durumu değişecek:             ${statusChanged}`);
  if (apply) console.log(`Yazılan kayıt:                ${written}`);
  if (rejectedSamples.length > 0) {
    console.log('\nAkıştan çıkacak ilk örnekler:');
    console.log(rejectedSamples.join('\n'));
  }
  if (!apply) console.log('\nUygulamak için: npm run jobs:reclassify -- --apply');
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('Yeniden sınıflandırma başarısız:', error instanceof Error ? error.message : error);
  await closeStore().catch(() => undefined);
  process.exit(1);
});
