/**
 * Yeniden sınıflandırma öncesi alınan yedekten ilan kayıtlarını geri yükler.
 *
 *   npm run jobs:restore -- <yedek.json>            → KURU ÇALIŞTIRMA: ne geri yüklenecek, yazmaz
 *   npm run jobs:restore -- <yedek.json> --apply    → geri yükler (önce mevcut durumun yedeğini alır)
 *
 * Yedek dosyası `data/backups/jobs-before-reclassify-*.json` biçimindedir. Yalnızca yedekte
 * bulunan kimlikler geri yüklenir; yedekte olmayan kayıtlara dokunulmaz.
 */
import { resolve } from 'node:path';
import { getEnv } from '../src/config/env';
import { effectiveDriver, describeDriver, initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import { readJobsBackup, restoreJobsFromBackup, writeJobsBackup } from '../src/ingest/reclassify-batch';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const file = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('Yedek dosyası yolu verin: npm run jobs:restore -- <yedek.json>');
  const env = getEnv();
  const driver = effectiveDriver(env);
  console.log(`Veritabanı: ${describeDriver(driver)}`);
  console.log(apply ? 'MOD: UYGULA (yedekten geri yüklenecek)' : 'MOD: KURU ÇALIŞTIRMA (yazılmayacak)');

  const backup = readJobsBackup(resolve(file));
  const store = await initStore(undefined, { ensureIndexes: false });
  createRepos(store);

  if (apply) {
    // Geri yüklemeden önce mevcut durumu yedekle; geri alma da geri alınabilir olsun.
    const current = (await store.find('jobs', {}, { limit: 100_000 })) as JobDoc[];
    const preRestore = writeJobsBackup(env.DATA_DIR, current, new Date(), 'before-restore');
    console.log(`Geri yükleme öncesi yedek: ${preRestore}`);
  }

  const summary = await restoreJobsFromBackup(store, backup, { apply });
  console.log('');
  console.log(`Yedekteki kayıt:                   ${summary.inBackup}`);
  console.log(`Zaten yedekle aynı:                ${summary.alreadyEqual}`);
  console.log(`Geri yüklenecek (değişen):         ${summary.wouldRestore}`);
  console.log(`Veritabanında bulunamayan:         ${summary.missingInStore.length}`);
  if (summary.missingInStore.length > 0) {
    console.log(`  ${summary.missingInStore.slice(0, 20).join(', ')}`);
  }
  if (apply) console.log(`Geri yüklenen:                     ${summary.restored}`);
  if (!apply) console.log('\nGeri yüklemek için: npm run jobs:restore -- <yedek.json> --apply');
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('Geri yükleme başarısız:', error instanceof Error ? error.message : error);
  await closeStore().catch(() => undefined);
  process.exit(1);
});
