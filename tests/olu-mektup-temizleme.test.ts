/**
 * Ölü mektup kuyruğu temizliği (23.10.2026): bölge engelli kaynak düzeltmesinden
 * önce biriken ölü işler sağlığı sürekli "degraded" tutuyordu. Bakım görevi artık
 * 2 günden eski ölü işleri ve artık taranmayan kaynakların ölü işlerini siler.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createId } from '../src/domain/ids';

const NOW = new Date('2026-10-23T12:00:00Z');

let dir: string;
let store: FileStore;
let repos: Repos;

async function deadJob(sourceKey: string, updatedAt: string): Promise<void> {
  await store.insertOne('queueJobs', {
    id: createId('qjb'),
    queue: 'scrape',
    name: 'source-scrape',
    dedupeKey: `source-scrape:${sourceKey}:${updatedAt}`,
    payload: { kind: 'source-scrape', sourceKey },
    status: 'dead',
    attempts: 3,
    maxAttempts: 3,
    runAt: updatedAt,
    lockedBy: null,
    lockedUntil: null,
    lastError: 'UND_ERR_CONNECT_TIMEOUT',
    createdAt: updatedAt,
    updatedAt,
    completedAt: null,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-oluq-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ölü mektup temizliği', () => {
  it('2 günden eski ölü işleri siler, yeni olanı korur', async () => {
    await deadJob('resmigazete-cestili-ilanlar', '2026-10-19T12:00:00Z'); // 4 gün önce
    await deadJob('resmigazete-cestili-ilanlar', '2026-10-23T09:00:00Z'); // bugün
    const deleted = await repos.queue.purgeDeadOlderThan(
      new Date(NOW.getTime() - 2 * 24 * 3_600_000).toISOString(),
    );
    expect(deleted).toBe(1);
    expect((await repos.queue.listDead(50)).length).toBe(1);
  });

  it('bölge engelli kaynağın ölü işlerini siler, erişilebilir kaynağınkini korur', async () => {
    await deadJob('kariyerkapisi-isealim', '2026-10-23T09:00:00Z');
    await deadJob('kariyerkapisi-isealim', '2026-10-23T10:00:00Z');
    await deadJob('resmigazete-cestili-ilanlar', '2026-10-23T11:00:00Z');
    const deleted = await repos.queue.purgeDeadForSources(['kariyerkapisi-isealim']);
    expect(deleted).toBe(2);
    const remaining = await repos.queue.listDead(50);
    expect(remaining.map((job) => job.payload['sourceKey'])).toEqual(['resmigazete-cestili-ilanlar']);
  });

  it('boş anahtar listesi hiçbir şeyi silmez', async () => {
    await deadJob('kariyerkapisi-isealim', '2026-10-23T09:00:00Z');
    expect(await repos.queue.purgeDeadForSources([])).toBe(0);
    expect((await repos.queue.listDead(50)).length).toBe(1);
  });
});
