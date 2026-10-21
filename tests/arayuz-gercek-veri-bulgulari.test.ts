/**
 * Gerçek Resmî Gazete verisiyle yerel arayüz incelemesinde görülen iki yanıltıcı durum
 * (22.10.2026; 25 kayıt, 6 ilan, koşum durumu `partial`):
 *  1. Kısmi koşum veri üretmişken durum şeridi "Henüz başarılı tarama kaydı yok" diyordu
 *     (`runs.summary().lastSuccessAt` yalnızca `success` arıyordu; kaynak sağlığı ise
 *     kısmi koşumu başarılı sayıyor).
 *  2. Kaynaktan az önce okunan ilan kartında "Son kontrol: henüz yapılmadı" yazıyordu
 *     (`lastVerifiedAt` yalnızca ikinci görülmede doluyordu).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { EMPTY_TOTALS } from '../src/db/repos/runs';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-22T09:00:00+03:00');

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-arayuz-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

describe('tarama özeti: son başarılı koşum', () => {
  it('kısmi (partial) koşum son başarılı tarama sayılır; başarısız/atlanan sayılmaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-arayuz-')));
    await store.init();
    let minute = 0;
    // Her koşum ayrı dakikada başlar: "son" karşılaştırması gerçekten sıraya bakar.
    const repos = createRepos(store, { now: () => new Date(NOW.getTime() + minute++ * 60_000) });
    const totals = { ...EMPTY_TOTALS, httpStatuses: [], errors: [], notes: [] };
    const failed = await repos.runs.start({ sourceKey: 'kaynak-a', trigger: 'manual', workerId: 'w' });
    await repos.runs.finish(failed.id, totals, 'failed', 'hata');
    const skipped = await repos.runs.start({ sourceKey: 'kaynak-a', trigger: 'manual', workerId: 'w' });
    await repos.runs.finish(skipped.id, totals, 'skipped', 'atlandı');
    expect((await repos.runs.summary()).lastSuccessAt).toBeNull();

    const partial = await repos.runs.start({ sourceKey: 'resmigazete', trigger: 'manual', workerId: 'w' });
    await repos.runs.finish(partial.id, totals, 'partial', 'kapsam kısmi');
    const summary = await repos.runs.summary();
    expect(summary.lastSuccessAt).toBe(partial.startedAt);
    // Aynı koşum "son başarısız" olarak da görünmez; başarısız = yalnız ölümcül hata.
    expect(summary.lastFailureAt).toBe(failed.startedAt);
    expect(summary.failed).toBe(1);
    expect(summary.partial).toBe(1);
  });
});

describe('ilan kaydı: son kontrol zamanı', () => {
  it('taranan ilan kayıt anında doğrulanmış sayılır; manuel kayıt sayılmaz', async () => {
    const repos = await makeRepos();
    const scraped = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'w',
      provenance: 'scraped',
    });
    expect((await repos.jobs.findById(scraped.jobId ?? ''))?.lastVerifiedAt).toBe(NOW.toISOString());

    // Ayrı depo: aynı metin taranan ilanla birleşirdi (doğru tekilleştirme).
    const manualRepos = await makeRepos();
    const manual = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos: manualRepos,
      now: NOW,
      workerId: 'w',
      provenance: 'manual',
    });
    expect((await manualRepos.jobs.findById(manual.jobId ?? ''))?.lastVerifiedAt).toBeNull();
  });
});
