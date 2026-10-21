/**
 * R-03 (kalan): Postgres sürücüsünde filtre + sıralama + sayfalama SQL'de.
 *
 * Eski davranış: SQL yalnızca ÜST KÜME ön filtresi uyguluyor, sıralama ve
 * sayfalama bellekte yapılıyordu. Bu yüzden:
 *  - ilan kabul hattının her kayıtta çağırdığı `find('jobs', {}, {limit: 400,
 *    sort: createdAt})` tablo 20.000 satırı geçince HATA veriyordu (tarama durur);
 *  - ilan listesi kabul edilmiş ilan sayısı 20.000'i geçince 500 veriyordu.
 *
 * Yeni davranış: şeması sabit alanlarda sorgu SQL'e TAM (eşdeğer) çevrilir;
 * sıralama, LIMIT/OFFSET ve COUNT SQL'de çalışır. Doğruluk, dosya sürücüsüyle
 * (matchesQuery/sortDocuments) rastgele sorgularda birebir karşılaştırılır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { PostgresStore, type PostgresPoolLike } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { createRepos } from '../src/db/repos';
import { JobRepo, type JobSearchFilters, type JobSort } from '../src/db/repos/jobs';
import { matchesQuery, type Query, type SortSpec } from '../src/db/query';
import { escapeRegExp } from '../src/domain/text';
import { systemClock } from '../src/lib/clock';
import type { StoragePort } from '../src/db/ports';
import type { JobDoc } from '../src/db/schemas';

function pglitePool(db: PGlite): PostgresPoolLike {
  const query = async <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    const result = await db.query(text, values ?? []);
    return {
      rows: result.rows as R[],
      rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null,
    };
  };
  return { query, connect: async () => ({ query, release: () => undefined }), end: async () => db.close() };
}

/** Tekrarlanabilir sözde rastgele üreteç (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = ['Ankara', 'İstanbul', 'Bursa', 'İzmir', null];
const STATUSES = ['active', 'upcoming', 'closed', 'unknown', 'cancelled'];
const TYPES = ['memur', 'sozlesmeli', 'kamu-isci', 'akademik', 'belirsiz'];
const INSTITUTIONS = ['ankara buyuksehir belediyesi', 'bursa uludag universitesi', 'saglik bakanligi', 'sayistay'];
const EDUCATION = ['lisans', 'onlisans', 'ortaogretim', 'yuksek-lisans'];
const KPSS = ['P3', 'P93', 'P94', 'KPSSP1'];

/** Gerçek alan biçimlerini (null, eksik alan, boş dizi) karıştıran ilan belgeleri. */
function randomJobs(count: number, seed: number): JobDoc[] {
  const next = rng(seed);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const docs: JobDoc[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `job_p${String(index).padStart(5, '0')}`;
    const city = pick(CITIES);
    const day = String(1 + Math.floor(next() * 28)).padStart(2, '0');
    const classification: Record<string, unknown> = {
      decision: pick(['accept', 'accept', 'accept', 'reject', 'review']),
    };
    // Eski kayıtlarda `kind` alanı yoktur.
    if (next() < 0.7) classification.kind = pick(['job', 'job', 'process']);
    const doc: Record<string, unknown> = {
      id,
      title: `İlan ${index}`,
      titleNormalized: `ilan ${pick(['memur', 'isci', 'uzman', 'sofor'])} ${index}`,
      institution: 'Kurum',
      institutionNormalized: pick(INSTITUTIONS),
      employmentType: pick(TYPES),
      status: pick(STATUSES),
      city,
      cityNormalized: city ? city.toLocaleLowerCase('tr').replace('ı', 'i').replace('i̇', 'i') : '',
      quota: next() < 0.3 ? null : 1 + Math.floor(next() * 50),
      applicationEndDate: next() < 0.25 ? null : `2026-${pick(['09', '10', '11'])}-${day}`,
      publishedAt: next() < 0.1 ? null : `2026-10-${day}`,
      createdAt: `2026-10-${day}T${String(Math.floor(next() * 24)).padStart(2, '0')}:00:00.${String(index).padStart(3, '0').slice(-3)}Z`,
      sourceKeys: next() < 0.5 ? ['resmigazete'] : ['ilan-gov-tr', 'resmigazete'],
      requirements: {
        educationLevels: next() < 0.2 ? [] : [pick(EDUCATION)],
        departments: [],
        kpssScoreTypes: next() < 0.3 ? [] : [pick(KPSS)],
        kpssMinScore: next() < 0.5 ? null : Math.round(next() * 9000) / 100,
      },
      textNormalized: `${pick(['personel alimi', 'surekli isci', 'kadro ilani'])} ${pick(INSTITUTIONS)}`,
      classification,
    };
    if (next() < 0.8) doc.applicationUrl = next() < 0.5 ? null : `https://isealimkariyerkapisi.cbiko.gov.tr/${id}`;
    docs.push(doc as unknown as JobDoc);
  }
  return docs;
}

function randomFilters(next: () => number): JobSearchFilters {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const filters: JobSearchFilters = {};
  if (next() < 0.3) filters.status = [pick(STATUSES) as never];
  if (next() < 0.3) filters.kind = pick(['job', 'process'] as const);
  if (next() < 0.25) filters.cities = [pick(['ankara', 'İSTANBUL', 'Bursa'])];
  if (next() < 0.25) filters.employmentTypes = [pick(TYPES)];
  if (next() < 0.2) filters.educationLevels = [pick(EDUCATION)];
  if (next() < 0.2) filters.kpssScoreTypes = [pick(KPSS)];
  if (next() < 0.2) filters.kpssMaxScore = Math.round(next() * 100);
  if (next() < 0.2) filters.sourceKeys = [pick(['resmigazete', 'ilan-gov-tr'])];
  if (next() < 0.2) filters.institution = pick(['ankara', 'Bursa Uludağ', 'bakanl']);
  if (next() < 0.15) filters.title = pick(['memur', 'şoför', 'uzman']);
  if (next() < 0.2) filters.q = pick(['personel', 'sayıştay', 'kadro', 'isci']);
  if (next() < 0.15) filters.deadlineFrom = '2026-10-10';
  if (next() < 0.15) filters.deadlineTo = '2026-10-25';
  if (next() < 0.15) filters.minQuota = 1 + Math.floor(next() * 40);
  if (next() < 0.1) filters.onlyWithApplicationUrl = true;
  else if (next() < 0.1) filters.onlyWithoutApplicationUrl = true;
  return filters;
}

let pglite: PGlite;
let pg: PostgresStore;
let file: FileStore;
const dataDir = mkdtempSync(join(tmpdir(), 'kamuilan-r03-'));

beforeAll(async () => {
  pglite = new PGlite();
  pg = new PostgresStore({ connectionString: 'postgres://yerel-test', tablePrefix: 'r03', pool: pglitePool(pglite) });
  file = new FileStore(dataDir, 'r03-oracle.json');
  await Promise.all([pg.init(), file.init()]);
  await Promise.all([pg.ensureIndexes(INDEXES), file.ensureIndexes(INDEXES)]);
});

afterAll(async () => {
  await Promise.allSettled([pg.close(), file.close()]);
});

describe('sorgu dili: eksik alan semantiği (Mongo ile aynı)', () => {
  it('$ne / $nin eksik alanı eşler; $ne null eksik alanı eşlemez', () => {
    const legacy = { classification: { decision: 'accept' } };
    expect(matchesQuery(legacy, { 'classification.kind': { $ne: 'process' } })).toBe(true);
    expect(matchesQuery(legacy, { 'classification.kind': { $nin: ['process'] } })).toBe(true);
    expect(matchesQuery(legacy, { 'classification.kind': { $ne: null } })).toBe(false);
    expect(matchesQuery(legacy, { 'classification.kind': { $nin: [null, 'process'] } })).toBe(false);
    // Diğer operatörler eksik alanda eşleşmez (önceki davranış korunur).
    expect(matchesQuery(legacy, { 'classification.kind': { $in: ['job'] } })).toBe(false);
    expect(matchesQuery(legacy, { 'classification.kind': { $ne: 'process', $exists: true } })).toBe(false);
    expect(matchesQuery(legacy, { 'classification.kind': 'job' })).toBe(false);
  });

  it('eski (kind alanı olmayan) kabul edilmiş ilan, iş ilanı listesinde ve özet sayılarda görünür', async () => {
    const legacy = {
      ...randomJobs(1, 1)[0],
      id: 'job_legacy_kind',
      status: 'active',
      classification: { decision: 'accept' },
    } as unknown as JobDoc;
    await file.insertOne('jobs', legacy);
    try {
      const repos = createRepos(file as unknown as StoragePort, systemClock);
      const listed = await repos.jobs.search({ kind: 'job' });
      expect(listed.items.map((item) => item.id)).toContain('job_legacy_kind');
      const stats = await repos.jobs.dashboardStats();
      expect(stats.active).toBeGreaterThanOrEqual(1);
    } finally {
      await file.deleteMany('jobs', { id: 'job_legacy_kind' });
    }
  });
});

describe('R-03: 20.000 satırı aşan tabloda SQL sıralama/sayfalama', () => {
  it('ilan kabul hattının sorguları (son 400 ilan, kurum araması) hata vermez ve doğru sırayı döner', async () => {
    const total = 20_050;
    await pglite.query(
      `INSERT INTO r03_jobs (id, data)
       SELECT 'job_bulk_' || lpad(n::text, 6, '0'),
              jsonb_build_object(
                'id', 'job_bulk_' || lpad(n::text, 6, '0'),
                'status', 'active',
                'institutionNormalized', CASE WHEN n % 1000 = 0 THEN 'ankara valiligi' ELSE 'diger kurum' END,
                'createdAt', to_char(timestamp '2026-01-01' + (n || ' minutes')::interval, 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
                'classification', jsonb_build_object('decision', 'accept', 'kind', 'job'))
       FROM generate_series(1, $1::int) AS series(n)`,
      [total],
    );
    try {
      const recent = await pg.find('jobs', {}, { limit: 400, sort: [['createdAt', -1]] });
      expect(recent).toHaveLength(400);
      expect(recent[0]?.id).toBe('job_bulk_020050');
      expect(recent[399]?.id).toBe('job_bulk_019651');

      const byInstitution = await pg.find(
        'jobs',
        { institutionNormalized: { $regex: escapeRegExp('ankara'), $regexFlags: 'i' } },
        { limit: 25, sort: [['createdAt', -1]] },
      );
      expect(byInstitution.map((row) => row.id)).toEqual(
        Array.from({ length: 20 }, (_, i) => `job_bulk_${String((20 - i) * 1000).padStart(6, '0')}`),
      );

      const repos = createRepos(pg as unknown as StoragePort, systemClock);
      const page = await repos.jobs.search({}, { page: 3, pageSize: 20 });
      expect(page.total).toBe(total);
      expect(page.items.map((item) => item.id)).toEqual(
        Array.from({ length: 20 }, (_, i) => `job_bulk_${String(total - 40 - i).padStart(6, '0')}`),
      );
      const stats = await repos.jobs.dashboardStats();
      expect(stats.total).toBe(total);
      expect(stats.active).toBe(total);
    } finally {
      await pglite.query("DELETE FROM r03_jobs WHERE id LIKE 'job_bulk_%'");
    }
  }, 120_000);
});

describe('R-03: Postgres = dosya sürücüsü (rastgele ilan aramaları)', () => {
  it('filtre + sıralama + sayfa + toplam birebir aynı', async () => {
    // Kimlikler artan sırada eklenir: dosya sürücüsünün eşitlikte koruduğu ekleme
    // sırası, Postgres'in `id` eşitlik kırıcısıyla aynı olur.
    const docs = randomJobs(400, 7);
    await pg.insertMany('jobs', docs);
    await file.insertMany('jobs', docs);
    try {
      const pgRepo = new JobRepo(pg as unknown as StoragePort, systemClock);
      const fileRepo = new JobRepo(file as unknown as StoragePort, systemClock);
      const sorts: JobSort[] = ['newest', 'deadline', 'published', 'institution', 'title'];
      for (const seed of [11, 23, 37]) {
        const next = rng(seed);
        for (let round = 0; round < 80; round += 1) {
          const filters = randomFilters(next);
          const options = {
            sort: sorts[Math.floor(next() * sorts.length)],
            page: 1 + Math.floor(next() * 3),
            pageSize: 5 + Math.floor(next() * 20),
            includeNonAccepted: next() < 0.2,
          };
          const [fromPg, fromFile] = await Promise.all([
            pgRepo.search(filters, options),
            fileRepo.search(filters, options),
          ]);
          const label = JSON.stringify({ filters, options });
          expect(fromPg.total, label).toBe(fromFile.total);
          expect(fromPg.items.map((item) => item.id), label).toEqual(fromFile.items.map((item) => item.id));
        }
      }
    } finally {
      await pg.deleteMany('jobs', { id: { $in: docs.map((doc) => doc.id) } });
      await file.deleteMany('jobs', { id: { $in: docs.map((doc) => doc.id) } });
    }
  }, 120_000);

  it('doğrudan operatör sorguları (null, $exists, $nin, aralık) iki sürücüde aynı', async () => {
    const docs = randomJobs(200, 3);
    await pg.insertMany('jobs', docs);
    await file.insertMany('jobs', docs);
    const queries: Query[] = [
      { applicationUrl: null },
      { applicationUrl: { $exists: false } },
      { applicationUrl: { $ne: null } },
      { 'classification.kind': { $nin: ['process'] } },
      { 'classification.kind': { $in: ['job', null] } },
      { status: { $nin: ['closed', 'cancelled'] }, quota: { $gt: 10, $lte: 40 } },
      { $nor: [{ status: 'closed' }, { 'requirements.kpssMinScore': { $gte: 50 } }] },
      { publishedAt: { $lt: '2026-10-15' }, $or: [{ city: 'Ankara' }, { cityNormalized: { $in: ['bursa'] } }] },
      { sourceKeys: 'ilan-gov-tr', 'requirements.educationLevels': { $in: ['lisans', 'onlisans'] } },
    ];
    const sorts: SortSpec[] = [[['createdAt', -1]], [['applicationEndDate', 1]], [['quota', -1], ['publishedAt', 1]]];
    try {
      for (const query of queries) {
        expect(await pg.count('jobs', query), JSON.stringify(query)).toBe(await file.count('jobs', query));
        for (const sort of sorts) {
          const options = { sort, skip: 3, limit: 15 };
          const [a, b] = await Promise.all([pg.find('jobs', query, options), file.find('jobs', query, options)]);
          expect(a.map((row) => row.id), JSON.stringify({ query, sort })).toEqual(b.map((row) => row.id));
        }
      }
    } finally {
      await pg.deleteMany('jobs', { id: { $in: docs.map((doc) => doc.id) } });
      await file.deleteMany('jobs', { id: { $in: docs.map((doc) => doc.id) } });
    }
  }, 120_000);
});
