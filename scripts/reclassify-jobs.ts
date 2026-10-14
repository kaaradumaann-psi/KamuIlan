/**
 * Mevcut ilan kayıtlarını güncel sınıflandırma ve temizlik kurallarıyla yeniden değerlendirir.
 *
 *   npm run jobs:reclassify                         → KURU ÇALIŞTIRMA: yalnızca özet
 *   npm run jobs:reclassify -- --report <dosya>     → kuru çalıştırma + kayıt bazlı JSON raporu (yazmaz)
 *   npm run jobs:reclassify -- --apply              → değişiklikleri yazar (önce tam yedek alır)
 *
 * Kararlar: iş ilanı (`job`) ve süreç duyurusu (`process`) akışta kalır; ret kuralına
 * takılanlar akıştan çıkar (silinmez). Yedekten geri dönüş: `npm run jobs:restore -- <yedek>`.
 *
 * Yapılandırılmış veritabanını (DATABASE_DRIVER) kullanır. Supabase/Postgres üzerinde
 * çalıştırmadan önce ilk satırdaki veritabanı adını ve kuru çalıştırma çıktısını mutlaka inceleyin.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getEnv } from '../src/config/env';
import { effectiveDriver, describeDriver, initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import {
  applyReclassification,
  buildReport,
  needsNotificationSuppression,
  planReclassification,
  writeJobsBackup,
} from '../src/ingest/reclassify-batch';
import { outboxSummaryForJob } from '../src/db/repos/outbox';

function optionValue(flag: string): string | null | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const reportOption = optionValue('--report');
  if (reportOption === null) throw new Error('--report için bir dosya yolu verin.');
  const env = getEnv();
  const driver = effectiveDriver(env);
  console.log(`Veritabanı: ${describeDriver(driver)}`);
  console.log(apply ? 'MOD: UYGULA (veritabanına yazılacak)' : 'MOD: KURU ÇALIŞTIRMA (yazılmayacak)');

  const store = await initStore(undefined, { ensureIndexes: false });
  createRepos(store);
  const jobs = (await store.find('jobs', {}, { limit: 100_000 })) as JobDoc[];
  const now = new Date();
  const { planned, summary } = planReclassification(jobs, now);

  if (reportOption) {
    const reportPath = resolve(reportOption);
    const rows = await buildReport(store, planned);
    writeFileSync(
      reportPath,
      JSON.stringify(
        { generatedAt: now.toISOString(), database: describeDriver(driver), summary, records: rows },
        null,
        2,
      ),
      { encoding: 'utf8' },
    );
    console.log(`Rapor yazıldı (${rows.length} kayıt, yalnızca okuma): ${reportPath}`);
  }

  let written = 0;
  if (apply) {
    // Yazmadan önce tam yedek: yedek yazılamazsa hiçbir kayıt değiştirilmez.
    const backupPath = writeJobsBackup(env.DATA_DIR, jobs, now, 'before-reclassify');
    console.log(`Yedek yazıldı (${jobs.length} kayıt): ${backupPath}`);
    const applied = await applyReclassification(store, planned, now);
    written = applied.written;
    console.log(`Bastırılan bekleyen bildirim: ${applied.notificationsSuppressed}`);
  }

  const rejectedSamples = planned
    .filter(({ job, result }) => job.classification.decision === 'accept' && result.decisionTo !== 'accept')
    .slice(0, 40)
    .map(
      ({ job, result }) =>
        `- [${result.decisionTo}] ${job.title} — ${result.classification.reasons[0] ?? ''}`,
    );
  const processSamples = planned
    .filter(({ result }) => result.decisionTo === 'accept' && result.kindTo === 'process')
    .map(({ job }) => `- ${job.title}`);

  console.log('');
  console.log(`Toplam ilan kaydı:                 ${summary.total}`);
  console.log(`Akışta (kabul) önce:               ${summary.acceptedBefore}`);
  console.log(`Akışta (kabul) sonra:              ${summary.acceptedAfter}`);
  console.log(`  - iş ilanı (job):                ${summary.acceptedJobs}`);
  console.log(`  - süreç duyurusu (process):      ${summary.keptAsProcess}`);
  console.log(`Akıştan çıkacak (reddedilen):      ${summary.rejected}`);
  console.log(`Akışa girecek:                     ${summary.newlyAccepted}`);
  console.log(`Türü değişecek (job/process):      ${summary.kindChanged}`);
  console.log(`Başlığı temizlenecek:              ${summary.titlesCleaned}`);
  console.log(`Durumu değişecek:                  ${summary.statusChanged}`);
  console.log(`Toplam değişecek kayıt:            ${summary.changed}`);
  const pendingNotifications = (
    await Promise.all(planned.map(({ job }) => outboxSummaryForJob(store, job.id)))
  ).reduce((total, item) => total + item.pending, 0);
  const suppressTargets = planned.filter(({ result }) => needsNotificationSuppression(result));
  console.log(`Bekleyen bildirim (tüm kayıtlar):  ${pendingNotifications}`);
  console.log(`Bastırılacak bildirim kaydı:       ${suppressTargets.length} ilan`);
  if (apply) console.log(`Yazılan kayıt:                     ${written}`);
  if (rejectedSamples.length > 0) {
    console.log('\nAkıştan çıkacak ilk örnekler:');
    console.log(rejectedSamples.join('\n'));
  }
  if (processSamples.length > 0) {
    console.log('\nSüreç duyurusu olarak akışta kalacaklar:');
    console.log(processSamples.join('\n'));
  }
  if (!apply) console.log('\nUygulamak için: npm run jobs:reclassify -- --apply');
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('Yeniden sınıflandırma başarısız:', error instanceof Error ? error.message : error);
  await closeStore().catch(() => undefined);
  process.exit(1);
});
