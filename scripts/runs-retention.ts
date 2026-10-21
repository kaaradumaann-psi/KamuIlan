/**
 * Tarama koşum kayıtları (scrapeRuns) saklama önizlemesi — SALT OKUNUR.
 *
 *   npm run runs:retention                 → 90 günden eski, silinecek koşum sayısı (hiçbir şey silmez)
 *   npm run runs:retention -- --days 120   → farklı eşikle önizleme
 *
 * Gerçek silme yalnız worker bakım görevinde (`maintenance`, 90 gün) yapılır. Her kaynağın son
 * koşumu ve son başarılı/kısmi koşumu ile kuyruktaki/çalışan koşumlar korunur.
 *
 * Yapılandırılmış veritabanını (DATABASE_DRIVER) okur; ilk satırdaki veritabanı adını inceleyin.
 */
import { getEnv } from '../src/config/env';
import { effectiveDriver, describeDriver, initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';

async function main(): Promise<void> {
  const index = process.argv.indexOf('--days');
  const days = index < 0 ? 90 : Number(process.argv[index + 1]);
  if (!Number.isInteger(days) || days < 30 || days > 3_650) throw new Error('--days 30–3650 arasında bir tam sayı olmalıdır.');
  const env = getEnv();
  console.log(`Veritabanı: ${describeDriver(effectiveDriver(env))}`);
  console.log('MOD: ÖNİZLEME (hiçbir kayıt silinmez)');

  const store = await initStore(undefined, { ensureIndexes: false });
  try {
    const repos = createRepos(store);
    const cutoff = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
    const total = await store.count('scrapeRuns', {});
    const preview = await repos.runs.purgeFinishedOlderThan(cutoff, { dryRun: true, maxBatches: 1_000 });
    console.log(`Eşik: ${cutoff} (${days} gün)`);
    console.log(`Toplam koşum: ${total} · silinecek: ${preview.matched} · eski ama korunan: ${preview.kept}`);
  } finally {
    await closeStore();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
