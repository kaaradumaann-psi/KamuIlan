/**
 * Aynı kaynağın (varsayılan İŞKUR e-Şube) farklı ilan numaralarıyla yanlışlıkla
 * TEK ilana birleşmiş kayıtlarını ayırır.
 *
 *   npm run repair:iskur-split                 → KURU ÇALIŞTIRMA: yalnızca plan/özet (yazmaz)
 *   npm run repair:iskur-split -- --apply      → değişiklikleri yazar (yeni ilanlar + sürüm geçmişi)
 *   npm run repair:iskur-split -- --source <k> → başka bir kaynak anahtarı için çalıştırır
 *
 * Yapılandırılmış veritabanını (DATABASE_DRIVER) kullanır. Uzak/üretim veritabanında
 * ÖNCE kuru çalıştırma çıktısını ve ilk satırdaki veritabanı adını inceleyin.
 * İdempotenttir: ikinci koşuda ayrılacak kayıt kalmaz.
 */
import { getEnv } from '../src/config/env';
import { effectiveDriver, describeDriver, initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import {
  applyIskurSplit,
  planIskurSplit,
  DEFAULT_SPLIT_SOURCE_KEY,
} from '../src/ingest/iskur-split-repair';

function optionValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const sourceKey = optionValue('--source') ?? DEFAULT_SPLIT_SOURCE_KEY;
  const env = getEnv();
  const driver = effectiveDriver(env);
  console.log(`Veritabanı: ${describeDriver(driver)}`);
  console.log(`Kaynak: ${sourceKey}`);
  console.log(apply ? 'MOD: UYGULA (veritabanına yazılacak)' : 'MOD: KURU ÇALIŞTIRMA (yazılmayacak)');

  const store = await initStore(undefined, { ensureIndexes: false });
  const repos = createRepos(store);
  const now = new Date();

  const { plan, summary } = await planIskurSplit(store, sourceKey);

  console.log('');
  console.log(`Bu kaynaktan kaydı olan ilan:      ${summary.jobsWithSource}`);
  console.log(`Ayrılacak ilan (≥2 farklı no):     ${summary.jobsToSplit}`);
  console.log(`Oluşacak yeni ilan:                ${summary.newJobs}`);
  console.log(`Sonuçta bu kümedeki ilan sayısı:   ${summary.jobsToSplit} → ${summary.resultingJobs}`);

  if (plan.length > 0) {
    console.log('\nAyrılacak ilanlar (ilk 40):');
    for (const item of plan.slice(0, 40)) {
      console.log(
        `- ${item.jobId} (+${item.splitLinks.length} yeni) — ${item.jobTitle.slice(0, 90)}`,
      );
    }
  }

  if (apply) {
    const result = await applyIskurSplit(repos, plan, now);
    console.log('');
    console.log(`Ayrılan ilan:                      ${result.jobsSplit}`);
    console.log(`Oluşturulan yeni ilan:             ${result.newJobs}`);
    console.log(`Taşınan kaynak kaydı:              ${result.movedLinks}`);
  } else {
    console.log('\nUygulamak için: npm run repair:iskur-split -- --apply');
  }

  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('İŞKUR ayrıştırma onarımı başarısız:', error instanceof Error ? error.message : error);
  await closeStore().catch(() => undefined);
  process.exit(1);
});
