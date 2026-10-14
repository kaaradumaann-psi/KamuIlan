/**
 * Postgres (Supabase) depo sürücüsü testleri — gerçek Postgres üzerinde.
 *
 * Neden PGlite: sürücü, Supabase'e bağlanmadan doğrulanmalı. PGlite, Postgres
 * 16'nın WASM derlemesidir; JSONB kapsama (`@>`), GIN indeksleri, `ON CONFLICT`
 * ve `SELECT … FOR UPDATE` dahil gerçek Postgres davranışını çalıştırır. Böylece
 * test "sahte bir SQL motoru"nu değil, üretimde kullanılacak sorguları ölçer.
 *
 * Kapsanan garantiler:
 *  1. `ensureIndexes` tüm koleksiyonlar için tablo + indeks kurar ve idempotenttir.
 *  2. JSONB ön filtresi ile nihai karar AYNI sonucu verir: aynı veri kümesi
 *     FileStore'a da yazılır ve iki sürücünün sonuçları birebir karşılaştırılır.
 *  3. Benzersiz indeks çakışmasında `insertIfAbsent` çift kayıt oluşturmaz,
 *     mevcut kaydı döner (iki worker aynı ilanı işlediğinde veri bozulmaz).
 *  4. Nokta yollu kısmi güncelleme (`data.a.b`) ve eşleşmeyen güncellemede `null`.
 *  5. Sıralama/projeksiyon/sayım/silme semantiği FileStore ile aynıdır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { PostgresStore, type PostgresPoolLike, type PostgresQueryable } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { createRepos } from '../src/db/repos';
import { systemClock } from '../src/lib/clock';
import type { StoragePort } from '../src/db/ports';
import type { JobDoc } from '../src/db/schemas';

/** PGlite'ı `pg` havuz yüzeyine uyarlar; üretim kodu ile aynı çağrı biçimi kullanılır. */
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
  const queryable: PostgresQueryable = { query };
  return {
    query: queryable.query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => {
      await db.close();
    },
  };
}

function job(overrides: Partial<JobDoc> & Pick<JobDoc, 'id'>): JobDoc {
  const now = '2026-10-12T06:00:00.000Z';
  return {
    dedupeKey: `key-${overrides.id}`,
    normalizedUrl: `https://ornek.test/ilan/${overrides.id}`,
    title: 'Sözleşmeli Personel Alım İlanı',
    titleNormalized: 'sozlesmeli personel alim ilani',
    institution: 'Test Kurumu',
    institutionNormalized: 'test kurumu',
    city: 'Ankara',
    employmentType: 'sozlesmeli',
    status: 'open',
    publishedAt: '2026-10-10',
    applicationEndDate: '2026-10-30',
    sourceKeys: ['test-kaynak'],
    applicationUrl: null,
    officialUrl: `https://ornek.test/ilan/${overrides.id}`,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    ...overrides,
  } as unknown as JobDoc;
}

let pg: PostgresStore;
let file: FileStore;
let pglite: PGlite;
const dataDir = mkdtempSync(join(tmpdir(), 'kamuilan-pg-'));

beforeAll(async () => {
  pglite = new PGlite();
  pg = new PostgresStore({
    connectionString: 'postgres://inhisarli-yerel-test',
    tablePrefix: 'kamuilan_test',
    pool: pglitePool(pglite),
  });
  file = new FileStore(dataDir, 'pg-oracle.json');
  await Promise.all([pg.init(), file.init()]);
  await Promise.all([pg.ensureIndexes(INDEXES), file.ensureIndexes(INDEXES)]);
});

afterAll(async () => {
  await Promise.allSettled([pg.close(), file.close()]);
});

describe('Postgres depo sürücüsü', () => {
  it('sağlık kontrolü ve sürücü kimliği doğru', async () => {
    const health = await pg.health();
    expect(health.ok).toBe(true);
    expect(pg.driver).toBe('postgres');
    expect(health.detail).toContain('PostgreSQL');
  });

  it('ensureIndexes tabloları ve benzersiz indeksleri kurar, tekrar çalıştırılabilir', async () => {
    const tables = await pglite.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'kamuilan_test_%'`,
    );
    expect(tables.rows.length).toBeGreaterThanOrEqual(10);
    const indexes = await pglite.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'kamuilan_test_jobs'`,
    );
    const uniqueDedupe = indexes.rows.find((row) => row.indexname.includes('uniq_dedupe_key'));
    expect(uniqueDedupe?.indexdef).toContain('UNIQUE');
    const gin = indexes.rows.find((row) => row.indexname.includes('_data_gin'));
    expect(gin?.indexdef).toContain('gin');
  });

  it('dosya sürücüsü ile birebir aynı sonucu verir (JSONB ön filtresi doğru çalışır)', async () => {
    const docs: JobDoc[] = [
      job({ id: 'job_pg_1' }),
      job({
        id: 'job_pg_2',
        city: 'İzmir',
        employmentType: 'kadrolu',
        status: 'closed',
        applicationEndDate: '2026-09-01',
        sourceKeys: ['test-kaynak', 'ikinci-kaynak'],
      }),
      job({
        id: 'job_pg_3',
        city: 'Ankara',
        institution: 'Başka Kurum',
        institutionNormalized: 'baska kurum',
        applicationEndDate: null,
        // Nokta yollu sorgu için iç içe alan (koşullar/koşul kaynağı).
        ...({ conditions: { minAge: 18, kpssType: 'P93' } } as Record<string, unknown>),
      }),
    ];
    await pg.insertMany('jobs', docs);
    await file.insertMany('jobs', docs);

    const queries: Record<string, unknown>[] = [
      { city: 'Ankara' },
      { city: { $in: ['Ankara', 'Bursa'] } },
      { status: { $ne: 'open' } },
      { applicationEndDate: null },
      { applicationEndDate: { $exists: true } },
      { 'conditions.minAge': 18 },
      { sourceKeys: 'ikinci-kaynak' },
      { employmentType: 'kadrolu', city: 'İzmir' },
      { $or: [{ city: 'İzmir' }, { employmentType: 'sozlesmeli' }] },
      { city: 'ankara' },
    ];

    for (const query of queries) {
      const pgRows = await pg.find('jobs', query as never, { sort: [['id', 1]] });
      const fileRows = await file.find('jobs', query as never, { sort: [['id', 1]] });
      expect(pgRows.map((row) => row.id)).toEqual(fileRows.map((row) => row.id));
    }

    // Sayı eşitliği iki yönlü kapsanmalı: değer sayı, kayıt metin olsa da eşleşir.
    const withQuota = Object.assign(job({ id: 'job_pg_4' }), { quota: '25' });
    await pg.insertOne('jobs', withQuota);
    await file.insertOne('jobs', withQuota);
    const pgNumeric = await pg.find('jobs', { quota: 25 } as never);
    const fileNumeric = await file.find('jobs', { quota: 25 } as never);
    expect(pgNumeric.map((row) => row.id)).toEqual(fileNumeric.map((row) => row.id));
    expect(pgNumeric.map((row) => row.id)).toEqual(['job_pg_4']);

    expect(await pg.count('jobs', { city: 'Ankara' })).toBe(await file.count('jobs', { city: 'Ankara' }));
    const limited = await pg.find('jobs', {}, { sort: [['id', -1]], limit: 2 });
    expect(limited.map((row) => row.id)).toEqual(['job_pg_4', 'job_pg_3']);

    // Invalid pagination inputs keep the previous in-memory slice semantics;
    // the SQL fast path is restricted to non-negative safe integer pages.
    const negativeSkip = await pg.find('jobs', {}, { sort: [['id', 1]], skip: -1, limit: 1 });
    const negativeSkipFile = await file.find('jobs', {}, { sort: [['id', 1]], skip: -1, limit: 1 });
    expect(negativeSkip.map((row) => row.id)).toEqual(negativeSkipFile.map((row) => row.id));
    const negativeLimit = await pg.find('jobs', {}, { sort: [['id', 1]], limit: -1 });
    const negativeLimitFile = await file.find('jobs', {}, { sort: [['id', 1]], limit: -1 });
    expect(negativeLimit.map((row) => row.id)).toEqual(negativeLimitFile.map((row) => row.id));
  });

  it('id sıralı tam tablo sayfaları 20.000 satırlık tarama sınırını aşabilir', async () => {
    const insertedCount = 20_050;
    try {
      await pglite.query(
        `INSERT INTO kamuilan_test_jobs (id, data)
         SELECT 'z_migration_bulk_' || lpad(n::text, 5, '0'),
                jsonb_build_object('id', 'z_migration_bulk_' || lpad(n::text, 5, '0'))
         FROM generate_series(1, $1::int) AS series(n)`,
        [insertedCount],
      );

      const countResult = await pglite.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM kamuilan_test_jobs',
      );
      const total = Number(countResult.rows[0]?.count ?? 0);
      expect(total).toBeGreaterThan(20_000);

      const options = { sort: [['id', 1] as const], skip: 20_000, limit: 500 };
      const page = await pg.find('jobs', {}, options);
      const expected = await pglite.query<{ id: string }>(
        'SELECT id FROM kamuilan_test_jobs ORDER BY id COLLATE "C" ASC LIMIT $1 OFFSET $2',
        [options.limit, options.skip],
      );
      expect(page.map((row) => row.id)).toEqual(expected.rows.map((row) => row.id));
      expect(page.length).toBeGreaterThan(0);
    } finally {
      await pglite.query("DELETE FROM kamuilan_test_jobs WHERE id LIKE 'z_migration_bulk_%'");
    }
  });

  it('insertIfAbsent benzersiz çakışmada çift kayıt oluşturmaz, mevcut kaydı döner', async () => {
    // Parola özeti yalnızca biçim olarak gerçekçi: bu test kimlik doğrulamıyor.
    const hash = `scrypt$16384$8$1$${'c'.repeat(64)}`;
    const first = await pg.insertIfAbsent('users', {
      id: 'usr_pg_1',
      email: 'ayni@ornek.test',
      emailNormalized: 'ayni@ornek.test',
      passwordHash: hash,
      passwordSalt: 'd'.repeat(32),
      displayName: 'İlk Kayıt',
      role: 'user',
      status: 'active',
      emailVerified: true,
      notificationOptIn: true,
      createdAt: '2026-10-12T06:00:00.000Z',
      updatedAt: '2026-10-12T06:00:00.000Z',
      lastLoginAt: null,
    } as never);
    expect(first.inserted).toBe(true);

    const second = await pg.insertIfAbsent('users', {
      id: 'usr_pg_2',
      email: 'ayni@ornek.test',
      emailNormalized: 'ayni@ornek.test',
      passwordHash: hash,
      passwordSalt: 'd'.repeat(32),
      displayName: 'İkinci Kayıt',
      role: 'user',
      status: 'active',
      emailVerified: true,
      notificationOptIn: true,
      createdAt: '2026-10-12T06:00:00.000Z',
      updatedAt: '2026-10-12T06:00:00.000Z',
      lastLoginAt: null,
    } as never);

    expect(second.inserted).toBe(false);
    expect(second.document.id).toBe('usr_pg_1');
    expect(await pg.count('users', { emailNormalized: 'ayni@ornek.test' })).toBe(1);
  });

  it('updateOne nokta yollu yamayı uygular, eşleşmeyen koşulda null döner', async () => {
    const updated = await pg.updateOne(
      'jobs',
      { id: 'job_pg_1' },
      {
        status: 'closing-soon',
        'conditions.minAge': 20,
      },
    );
    expect(updated?.status).toBe('closing-soon');
    expect((updated as unknown as { conditions: { minAge: number } }).conditions.minAge).toBe(20);

    const missing = await pg.updateOne('jobs', { id: 'job_yok' }, { status: 'closed' });
    expect(missing).toBeNull();
    // Değişiklik kalıcı olmalı: yazan süreçten sonra okuyan da görmeli.
    const reread = await pg.findOne('jobs', { id: 'job_pg_1' });
    expect(reread?.status).toBe('closing-soon');
  });

  it('upsertOne ve deleteMany sözleşmeye uyar', async () => {
    const doc = job({ id: 'job_pg_upsert' });
    const created = await pg.upsertOne('jobs', { dedupeKey: doc.dedupeKey }, doc);
    expect(created.created).toBe(true);
    const updated = await pg.upsertOne('jobs', { dedupeKey: doc.dedupeKey }, doc, { status: 'closed' });
    expect(updated.created).toBe(false);
    expect(updated.document.status).toBe('closed');

    const removed = await pg.deleteMany('jobs', { id: { $in: ['job_pg_upsert', 'job_yok'] } });
    expect(removed).toBe(1);
    expect(await pg.findOne('jobs', { id: 'job_pg_upsert' })).toBeNull();
  });

  it('argümansız ensureIndexes varsayılan indeks kümesini kurar (diğer sürücülerle aynı sözleşme)', async () => {
    // `initStore` / `db:migrate` / `db:indexes` argümansız çağırır. Postgres'te
    // varsayılan boş küme olursa benzersiz indeksler hiç kurulmaz ve migrate
    // çıktısı "indeksler: 0 tanım" olur (rapor edilen çalışmadaki ilk belirti).
    const results = await pg.ensureIndexes();
    expect(results).toHaveLength(INDEXES.length);
    expect(results.filter((result) => result.name.includes('uniq'))).toHaveLength(
      INDEXES.filter((index) => index.unique).length,
    );
  });

  it('çevrilemeyen koşulla karışan eşitlik sorguları bind hatası vermez, dosya sürücüsüyle aynı sonucu döner', async () => {
    // Regresyon: ön filtre, çevrilemeyen bir koşul (aralık/$exists/$regex/
    // noktalı yol/$nor) yüzünden düştüğünde, çevrilebilen kardeş koşulların
    // `params`'a yazdığı değerler geri alınmıyordu. Yer tutucusuz
    // `WHERE TRUE` sorgusuna parametre gidince Postgres şu hatayı veriyordu:
    //   bind message supplies N parameters, but prepared statement "" requires 0
    // İlk görüldüğü yer: `db:migrate`'ın eksik `textNormalized` sorgusu.
    // Aynı kökten etkilenenler: zamanlayıcı `listDue`, kuyruk/outbox
    // `claim`, ilan arama (`$and` + noktalı yol/aralık/regex), süre dolan
    // ilanları kapatma ve bayat çalışma temizliği.
    const mix1 = job({ id: 'job_pg_mix_1', status: 'active', applicationEndDate: '2026-10-30' });
    const mix2 = Object.assign(
      job({ id: 'job_pg_mix_2', status: 'closed', city: 'İzmir', applicationEndDate: '2026-09-01' }),
      {
        textNormalized: '',
        classification: { decision: 'accept' },
        requirements: { educationLevels: ['lisans'], kpssMinScore: 70 },
      },
    );
    const mix3 = Object.assign(
      job({ id: 'job_pg_mix_3', status: 'active', applicationEndDate: '2026-11-15' }),
      {
        textNormalized: 'ucuncu govde',
        classification: { decision: 'accept' },
        requirements: { educationLevels: ['onlisans'], kpssMinScore: 60 },
      },
    );
    const mixDocs = [mix1, mix2, mix3] as unknown as JobDoc[];
    await pg.insertMany('jobs', mixDocs);
    await file.insertMany('jobs', mixDocs);

    const queries: Record<string, unknown>[] = [
      // db:migrate (rapor edilen sorgunun birebir hâli)
      { $or: [{ textNormalized: { $exists: false } }, { textNormalized: '' }] },
      // ScheduledTaskRepo.listDue / kuyruk-outbox claim: eşitlik + $lte
      { status: { $in: ['active', 'closed'] }, applicationEndDate: { $lt: '2026-10-15' } },
      { status: 'active', applicationEndDate: { $gte: '2026-10-01', $lte: '2026-12-31' } },
      // JobRepo.search: $and içinde noktalı yol + $in + aralık / $regex
      {
        $and: [
          { 'classification.decision': 'accept' },
          { status: { $in: ['active'] } },
          { applicationEndDate: { $gte: '2026-01-01' } },
        ],
      },
      {
        $and: [
          { status: { $in: ['active', 'closed'] } },
          { 'requirements.educationLevels': { $in: ['lisans'] } },
        ],
      },
      { $and: [{ status: { $in: ['active'] } }, { 'requirements.kpssMinScore': { $lte: 65 } }] },
      { $or: [{ titleNormalized: { $regex: 'sozlesmeli', $regexFlags: 'i' } }, { city: 'İzmir' }] },
      // $nor ve tek başına çevrilemeyen kontroller
      { city: 'Ankara', $nor: [{ status: 'closed' }] },
      { status: { $ne: 'active' } },
      { applicationEndDate: { $ne: null } },
      // İç içe: $or içinde $and + aralık
      {
        $or: [
          { $and: [{ status: 'active' }, { applicationEndDate: { $lt: '2026-11-01' } }] },
          { city: 'İzmir' },
        ],
      },
    ];

    for (const query of queries) {
      const pgRows = await pg.find('jobs', query as never, { sort: [['id', 1]] });
      const fileRows = await file.find('jobs', query as never, { sort: [['id', 1]] });
      expect(pgRows.map((row) => row.id)).toEqual(fileRows.map((row) => row.id));
      expect(await pg.count('jobs', query as never)).toBe(await file.count('jobs', query as never));
    }

    // Repo katmanındaki gerçek çağrılar da aynı yoldan geçer (migrate/worker):
    const repos = createRepos(pg as unknown as StoragePort, systemClock);
    const task = await repos.scheduledTasks.ensure({
      kind: 'maintenance',
      sourceKey: '*',
      intervalMinutes: 60,
    });
    const due = await repos.scheduledTasks.listDue(new Date(Date.now() + 60_000).toISOString());
    expect(due.map((item) => item.id)).toContain(task.id);

    const search = await repos.jobs.search({ cities: ['Ankara'], deadlineFrom: '2026-01-01' });
    expect(search.items.map((item) => item.id)).toContain('job_pg_mix_3');
    // Kapatma/özet yolları aralık + $in / $ne karıştırır; hata vermeden sayı döner.
    await expect(repos.jobs.closeExpiredJobs('2026-10-15')).resolves.toBeTypeOf('number');
    await expect(repos.runs.summary()).resolves.toMatchObject({ total: expect.any(Number) });
    await expect(repos.locks.purgeExpired()).resolves.toBeTypeOf('number');

    // updateMany / deleteMany de aynı ön filtreden geçer:
    const mixIds = ['job_pg_mix_1', 'job_pg_mix_2', 'job_pg_mix_3'];
    const closeFilter = { id: { $in: mixIds }, applicationEndDate: { $lt: '2026-11-01' } } as never;
    expect(await pg.updateMany('jobs', closeFilter, { status: 'closed' })).toBe(
      await file.updateMany('jobs', closeFilter, { status: 'closed' }),
    );

    const migrateFilter = {
      id: { $in: mixIds },
      $or: [{ textNormalized: { $exists: false } }, { textNormalized: '' }],
    } as never;
    expect(await pg.deleteMany('jobs', migrateFilter)).toBe(await file.deleteMany('jobs', migrateFilter));

    // Temizlik: karışım kayıtlarının kalanını iki sürücüden de kaldır.
    await pg.deleteMany('jobs', { id: { $in: mixIds } });
    await file.deleteMany('jobs', { id: { $in: mixIds } });
  });

  it('repo katmanı Postgres üzerinde zod doğrulamasıyla çalışır', async () => {
    const repos = createRepos(pg as unknown as StoragePort, systemClock);
    const created = await repos.users.create({
      email: 'depo@ornek.test',
      passwordHash: `scrypt$16384$8$1$${'a'.repeat(64)}`,
      passwordSalt: 'b'.repeat(32),
      displayName: 'Depo Kullanıcısı',
    });
    expect(created.created).toBe(true);
    expect(created.user.emailNormalized).toBe('depo@ornek.test');

    const preference = await repos.notifications.upsertPreference(created.user.id, {
      filters: { cities: ['Ankara'], keywords: ['mühendis'] },
    });
    expect(preference.userId).toBe(created.user.id);
    expect(preference.enabled).toBe(false);
    // Şema dışı değer kaydedilemez: zod doğrulaması repo katmanında, sürücüden
    // bağımsız olarak çalışır (Postgres'te de aynı kural geçerlidir).
    await expect(repos.users.update(created.user.id, { role: 'root' as never })).rejects.toThrow(
      /belge şeması geçersiz/,
    );
  });
});
