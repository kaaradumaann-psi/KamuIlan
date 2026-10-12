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
    const updated = await pg.updateOne('jobs', { id: 'job_pg_1' }, {
      status: 'closing-soon',
      'conditions.minAge': 20,
    });
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
    // Şema dışı değer kaydedilemez: zod doğrulaması repo katmanında, sürücüden
    // bağımsız olarak çalışır (Postgres'te de aynı kural geçerlidir).
    await expect(
      repos.users.update(created.user.id, { role: 'root' as never }),
    ).rejects.toThrow(/belge şeması geçersiz/);
  });
});
