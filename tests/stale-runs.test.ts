/**
 * Bayat "running" tarama kayıtları: süreç ölümüyle yarım kalan kayıtlar
 * worker açılışında kapatılmalı; taze kayıtlara dokunulmamalıdır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos/index';
import { fixedClock } from '../src/lib/clock';

const NOW = new Date('2026-10-13T12:00:00+03:00');

describe('closeStaleRunning', () => {
  it('eski running kaydı failed kapatır, taze kayda dokunmaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-stale-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));

    const stale = await repos.runs.start({ sourceKey: 'kaynak-a', trigger: 'schedule', workerId: 'old' });
    await store.updateOne('scrapeRuns', { id: stale.id }, { startedAt: '2026-10-13T08:00:00+03:00' });
    const fresh = await repos.runs.start({ sourceKey: 'kaynak-b', trigger: 'schedule', workerId: 'new' });

    const closed = await repos.runs.closeStaleRunning(NOW.toISOString(), 'süreç sonlandı');
    expect(closed).toBe(1);

    const staleAfter = await store.findOne('scrapeRuns', { id: stale.id });
    expect(staleAfter?.status).toBe('failed');
    expect(staleAfter?.errors.join(' ')).toContain('süreç sonlandı');
    const freshAfter = await store.findOne('scrapeRuns', { id: fresh.id });
    expect(freshAfter?.status).toBe('running');
    await store.close();
  });
});
