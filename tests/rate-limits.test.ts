import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';

const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('rate-limit sayacı', () => {
  it('aynı pencereye eşzamanlı vuruşları kayıpsız ve atomik artırır', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-rate-limit-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));

    const results = await Promise.all(
      Array.from({ length: 64 }, () => repos.rateLimits.hit('test-kota', 3_600)),
    );

    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
    expect(await repos.rateLimits.peek('test-kota', 3_600)).toBe(64);
    expect(await store.count('rateLimits')).toBe(1);
    await store.close();
  });

  it('bütçe rezervasyonu üst sınırını yarışta aşmaz ve reddedilenleri sayaca eklemez', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-rate-reserve-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));

    const results = await Promise.all(
      Array.from({ length: 64 }, () => repos.rateLimits.reserve('test-limit', 3_600, 1, 10)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(await repos.rateLimits.peek('test-limit', 3_600)).toBe(10);

    const weighted = await Promise.all(
      Array.from({ length: 12 }, () => repos.rateLimits.reserve('test-cost', 3_600, 40, 100)),
    );
    expect(weighted.filter((result) => result.allowed)).toHaveLength(2);
    expect(await repos.rateLimits.peek('test-cost', 3_600)).toBe(80);
    await store.close();
  });
});
