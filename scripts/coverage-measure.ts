/**
 * Kaynak başına kapsam ölçümü — SALT OKUNUR: `npm run sources:measure`
 *
 *   npm run sources:measure                → tablo
 *   npm run sources:measure -- --json      → makine okunur
 *   npm run sources:measure -- --open-jobs → açık ilanların kısa listesi (kurum, başlık, son başvuru; JSON)
 *
 * Yalnız `find` çağırır: şema/indeks DDL'i çalıştırmaz, kaynak tohumlamaz, veri yazmaz.
 * Üretim veritabanına karşı güvenle çalıştırılabilir.
 */
import { closeStore, initStore } from '../src/db/store';
import { toIstanbulDateOnly } from '../src/domain';
import { buildCoverageMeasure, formatCoverageMeasure } from '../src/ops/coverage-measure';

async function main(): Promise<void> {
  const store = await initStore(undefined, { ensureIndexes: false });
  try {
    const now = new Date();
    const today = toIstanbulDateOnly(now);
    const [sources, jobs, reviews, decisions, jobSources] = await Promise.all([
      store.find('sources'),
      store.find('jobs'),
      store.find('reviewQueue', { status: 'open' }),
      store.find('sourceItemDecisions', { decision: 'rejected' }),
      store.find('jobSources'),
    ]);

    if (process.argv.includes('--open-jobs')) {
      const open = jobs
        .filter(
          (job) =>
            job.status !== 'cancelled' &&
            (job.applicationEndDate ? job.applicationEndDate >= today : job.status !== 'closed'),
        )
        .map((job) => ({
          institution: job.institution,
          title: job.title,
          deadline: job.applicationEndDate,
          source: job.primarySourceKey,
          url: job.detailUrl,
        }));
      console.log(JSON.stringify({ today, count: open.length, jobs: open }, null, 2));
      return;
    }

    const report = buildCoverageMeasure({
      sources: sources.map((source) => ({ key: source.key, name: source.name, enabled: source.enabled })),
      jobs,
      reviews,
      decisions,
      jobSources,
      today,
      now,
    });
    process.stdout.write(
      process.argv.includes('--json')
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatCoverageMeasure(report),
    );
  } finally {
    await closeStore();
  }
}

main().catch((error: unknown) => {
  console.error('Kapsam ölçümü üretilemedi:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
