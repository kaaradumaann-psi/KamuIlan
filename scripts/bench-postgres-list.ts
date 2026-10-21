/**
 * R-03 ölçümü: N ilanlık Postgres tablosunda ilan listesi sorgusunun süresi.
 *
 * Varsayılan hedef PGlite'tır (Postgres 16 WASM, süreç içi): gerçek bir sunucu
 * gerekmez ama sonuç gerçek Postgres/Supabase performansını TEMSİL ETMEZ
 * (tek iş parçacığı, WASM, ağ yok). Gerçek ölçüm için BENCH_POSTGRES_URL ile
 * staging veritabanı verilir; komut yalnızca `bench_` önekli tablolar yazar.
 *
 *   npx tsx scripts/bench-postgres-list.ts            # PGlite, 50.000 kayıt
 *   BENCH_ROWS=20000 npx tsx scripts/bench-postgres-list.ts
 *   BENCH_POSTGRES_URL=postgres://… npx tsx scripts/bench-postgres-list.ts
 *
 * Her satırda ~4 KB metin vardır: gerçek ilanlar gibi JSONB TOAST'a taşar.
 */
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { PostgresStore, type PostgresPoolLike } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { JobRepo } from '../src/db/repos/jobs';
import { systemClock } from '../src/lib/clock';
import type { StoragePort } from '../src/db/ports';

const ROWS = Number(process.env.BENCH_ROWS ?? 50_000);
const RUNS = 7;

function pglitePool(db: PGlite): PostgresPoolLike {
  const query = async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query(text, values ?? []);
    return { rows: result.rows as R[], rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null };
  };
  return { query, connect: async () => ({ query, release: () => undefined }), end: async () => db.close() };
}

async function main(): Promise<void> {
  const url = process.env.BENCH_POSTGRES_URL;
  const pglite = url ? null : new PGlite();
  const store = new PostgresStore({
    connectionString: url ?? 'postgres://pglite',
    tablePrefix: 'bench',
    ...(pglite ? { pool: pglitePool(pglite) } : {}),
  });
  await store.init();
  await store.ensureIndexes(INDEXES);
  await store.truncate('jobs');

  const seedStart = performance.now();
  await store['pool'].query(
    `INSERT INTO bench_jobs (id, data)
     SELECT 'job_b' || lpad(n::text, 7, '0'),
            jsonb_build_object(
              'id', 'job_b' || lpad(n::text, 7, '0'),
              'status', (ARRAY['active','closed','upcoming','unknown'])[1 + n % 4],
              'employmentType', (ARRAY['memur','sozlesmeli','kamu-isci','akademik'])[1 + n % 4],
              'city', (ARRAY['Ankara','İstanbul','Bursa','İzmir'])[1 + n % 4],
              'cityNormalized', (ARRAY['ankara','istanbul','bursa','izmir'])[1 + n % 4],
              'institutionNormalized', 'kurum ' || (n % 700),
              'titleNormalized', 'personel alim ilani ' || n,
              'applicationEndDate', to_char(date '2026-09-01' + (n % 120), 'YYYY-MM-DD'),
              'publishedAt', to_char(date '2026-08-01' + (n % 90), 'YYYY-MM-DD'),
              'createdAt', to_char(timestamp '2026-01-01' + (n || ' minutes')::interval, 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
              'quota', 1 + n % 40,
              'sourceKeys', jsonb_build_array('resmigazete'),
              'requirements', jsonb_build_object('educationLevels', jsonb_build_array('lisans'), 'kpssScoreTypes', jsonb_build_array('P3'), 'departments', '[]'::jsonb, 'kpssMinScore', null),
              'textNormalized', repeat('kamu personel alimi ilan metni ', 140),
              'classification', jsonb_build_object('decision', CASE WHEN n % 10 = 0 THEN 'reject' ELSE 'accept' END, 'kind', CASE WHEN n % 15 = 0 THEN 'process' ELSE 'job' END))
     FROM generate_series(1, $1::int) AS series(n)`,
    [ROWS],
  );
  await store['pool'].query('ANALYZE bench_jobs');
  console.log(`hedef: ${url ? 'Postgres (BENCH_POSTGRES_URL)' : 'PGlite (WASM) — gerçek sunucuyu temsil etmez'}`);
  console.log(`tohum: ${ROWS} satır, ${Math.round(performance.now() - seedStart)} ms`);

  const repo = new JobRepo(store as unknown as StoragePort, systemClock);
  const cases: { label: string; run: () => Promise<unknown> }[] = [
    { label: 'GET /api/jobs?page=1 (varsayılan)', run: () => repo.search({}, { page: 1, pageSize: 20 }) },
    { label: 'page=50', run: () => repo.search({}, { page: 50, pageSize: 20 }) },
    { label: 'kind=job + status=active + şehir', run: () => repo.search({ kind: 'job', status: ['active'], cities: ['Ankara'] }, { pageSize: 20 }) },
    { label: 'q=personel (metin araması)', run: () => repo.search({ q: 'personel' }, { pageSize: 20 }) },
    { label: 'sort=deadline', run: () => repo.search({}, { pageSize: 20, sort: 'deadline' }) },
    { label: 'kabul hattı: son 400 ilan', run: () => store.find('jobs', {}, { limit: 400, sort: [['createdAt', -1]] }) },
  ];
  for (const testCase of cases) {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      await testCase.run();
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    console.log(`${testCase.label}: medyan ${times[Math.floor(RUNS / 2)]!.toFixed(1)} ms · en kötü ${times[RUNS - 1]!.toFixed(1)} ms`);
  }
  const first = await repo.search({}, { page: 1, pageSize: 20 });
  console.log(`doğrulama: total=${first.total}, ilk=${first.items[0]?.id ?? '-'}`);
  await store.truncate('jobs');
  await store.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
