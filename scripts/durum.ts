/**
 * Sade Türkçe sistem durum raporu — SALT OKUNUR (şema/indeks oluşturmaz, veri yazmaz).
 *
 *   npm run durum                       → okunur rapor
 *   npm run durum -- --json             → makine okunur (izleme/cron)
 *   npm run durum -- --log ./logs/x.log → ek log dosyası (varsayılan: LOG_FILE + ./logs/*.log)
 *
 * Çıkış kodu: 0 çalışıyor/uyarı · 2 kritik (izleme aracı alarm üretebilir) · 1 rapor üretilemedi.
 */
import { getEnv } from '../src/config/env';
import { closeStore, initStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { buildStatusReport, defaultLogPaths, formatStatusReport } from '../src/ops/status-report';

async function main(): Promise<void> {
  const env = getEnv();
  const logPaths = defaultLogPaths(env);
  process.argv.forEach((arg, index) => {
    if (arg === '--log' && process.argv[index + 1]) logPaths.push(process.argv[index + 1] as string);
  });
  const store = await initStore(undefined, { ensureIndexes: false });
  try {
    const report = await buildStatusReport(createRepos(store), env, new Date(), logPaths);
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatStatusReport(report));
    process.exitCode = report.level === 'critical' ? 2 : 0;
  } finally {
    await closeStore();
  }
}

main().catch((error: unknown) => {
  console.error(`Durum raporu üretilemedi: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Bu mesajı Claude Code\'a verin; çoğu zaman .env veya veritabanı bağlantısı sorunudur (npm run env:check).');
  process.exitCode = 1;
});
