/**
 * Supabase REST (PostgREST) üzerinden anon/authenticated erişimine karşı RLS (R-02).
 *
 * Eski davranış: `kamuilan_*` tablolarında RLS kapalıydı; anon rolüne SELECT yetkisi verilen
 * (Supabase varsayılanı) bir ortamda kullanıcı tablosu dahil tüm satırlar okunabilirdi.
 * PGlite gerçek Postgres 16+ çekirdeğidir: rol, GRANT ve RLS semantiği aynıdır.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore, type PostgresPoolLike } from '../src/db/postgres-store';

function pglitePool(db: PGlite): PostgresPoolLike {
  const query = async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query(text, values ?? []);
    return { rows: result.rows as R[], rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null };
  };
  return { query, connect: async () => ({ query, release: () => undefined }), end: async () => db.close() };
}

let db: PGlite;
let store: PostgresStore;

beforeAll(async () => {
  db = new PGlite();
  store = new PostgresStore({ connectionString: 'postgres://rls-test', tablePrefix: 'kamuilan_rls', pool: pglitePool(db) });
  await store.init();
  await store.ensureIndexes([]);
  await db.query(`INSERT INTO kamuilan_rls_users (id, data) VALUES ('usr_rls_1', '{"email":"gizli@ornek.test"}')`);
  // Supabase varsayılanı: anon rolü public şemadaki tablolara SELECT/INSERT yetkisine sahiptir.
  await db.exec(`CREATE ROLE anon NOLOGIN; GRANT USAGE ON SCHEMA public TO anon;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO anon;`);
});

afterAll(async () => {
  await store.close();
});

describe('RLS (politikasız) — Supabase anon erişimi kapalı', () => {
  it('tüm uygulama tablolarında RLS açık', async () => {
    const report = await store.rowLevelSecurityReport();
    expect(report.length).toBeGreaterThan(10);
    expect(report.filter((row) => !row.enabled)).toEqual([]);
  });

  it('anon rolü SELECT yetkisi olsa da satır göremez ve yazamaz; tablo sahibi etkilenmez', async () => {
    const owner = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM kamuilan_rls_users');
    expect(owner.rows[0]?.n).toBeGreaterThan(0);
    await db.exec('SET ROLE anon');
    try {
      const anon = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM kamuilan_rls_users');
      expect(anon.rows[0]?.n).toBe(0);
      await expect(db.query(`INSERT INTO kamuilan_rls_users (id, data) VALUES ('x', '{}')`)).rejects.toThrow(/row-level security/i);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('ensureIndexes tekrar çalıştırıldığında hata vermez (idempotent)', async () => {
    await expect(store.ensureIndexes([])).resolves.toBeDefined();
  });
});
