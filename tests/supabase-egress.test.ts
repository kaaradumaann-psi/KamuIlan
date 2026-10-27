/**
 * Supabase veri aktarımı (egress) — 27.10.2026 üretim bulgusu.
 *
 * pg_stat_statements: kuyruk istatistiği (`count('queueJobs', {status})`) tam çeviri
 * listesinde olmadığı için eşleşen TÜM satırların `data` belgesini çekip bellekte
 * sayıyordu (85.815 çağrı / 11 milyon satır ≈ 7 GB). Bu test, sayımın `count(*)` ile
 * yapıldığını ve tamamlanmış işlerin saklama süresinden sonra silindiğini kilitler.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore, type PostgresPoolLike } from '../src/db/postgres-store';
import { INDEXES } from '../src/db/indexes';
import { createRepos } from '../src/db/repos';
import { systemClock } from '../src/lib/clock';
import type { QueueJobDoc } from '../src/db/schemas';

const queries: string[] = [];

function pglitePool(db: PGlite): PostgresPoolLike {
  const query = async <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    queries.push(text);
    const result = await db.query(text, values ?? []);
    return {
      rows: result.rows as R[],
      rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : null,
    };
  };
  return { query, connect: async () => ({ query, release: () => undefined }), end: async () => db.close() };
}

function job(index: number, status: QueueJobDoc['status'], updatedAt: string): QueueJobDoc {
  return {
    id: `qjb_${String(index).padStart(24, '0')}`,
    queue: 'kamuilan',
    name: 'scrape',
    dedupeKey: `source-scrape:x:${index}`,
    payload: { kind: 'source-scrape', sourceKey: 'x' },
    status,
    attempts: 1,
    maxAttempts: 3,
    runAt: updatedAt,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
    createdAt: updatedAt,
    updatedAt,
    completedAt: status === 'completed' ? updatedAt : null,
  };
}

let pg: PostgresStore;

beforeAll(async () => {
  pg = new PostgresStore({ connectionString: 'postgres://yerel-test', tablePrefix: 'egr', pool: pglitePool(new PGlite()) });
  await pg.init();
  await pg.ensureIndexes(INDEXES);
});

afterAll(async () => {
  await pg.close();
});

describe('Supabase egress: kuyruk', () => {
  it('kuyruk istatistiği satır belgesi çekmeden count(*) ile hesaplanır', async () => {
    const docs: QueueJobDoc[] = [];
    for (let i = 0; i < 40; i += 1) docs.push(job(i, 'completed', '2026-10-20T00:00:00.000Z'));
    for (let i = 40; i < 43; i += 1) docs.push(job(i, 'pending', '2026-10-27T00:00:00.000Z'));
    docs.push(job(43, 'dead', '2026-10-27T00:00:00.000Z'));
    await pg.insertMany('queueJobs', docs);
    const repos = createRepos(pg, systemClock);

    queries.length = 0;
    const stats = await repos.queue.stats();
    expect(stats).toEqual({ pending: 3, active: 0, completed: 40, failed: 0, dead: 1 });
    // Tip sapması denetimi (kısmi indeksli, normalde 0 satır) dışında belge okunmaz.
    const dataReads = queries.filter(
      (text) => text.startsWith('SELECT data FROM egr_queue_jobs') && !text.includes('NOT IN ('),
    );
    expect(dataReads).toEqual([]);
    expect(queries.filter((text) => text.startsWith('SELECT count(*)')).length).toBe(5);
  });

  it('tamamlanmış işler saklama süresinden sonra silinir; bekleyen/ölü işler korunur', async () => {
    const repos = createRepos(pg, systemClock);
    const deleted = await repos.queue.purgeCompletedOlderThan('2026-10-25T00:00:00.000Z');
    expect(deleted).toBe(40);
    const stats = await repos.queue.stats();
    expect(stats).toEqual({ pending: 3, active: 0, completed: 0, failed: 0, dead: 1 });
  });
});
