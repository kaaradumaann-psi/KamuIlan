/**
 * Birleştirmede ilan durumu yayım tarihini kaybetmemeli.
 *
 * `mergeIntoExistingJob` durumu yeniden hesaplarken `merged.publishedAt` alanını
 * hiç doldurmuyordu: son başvuru tarihi OLMAYAN eski bir ilan (yayımından çok
 * geçmiş → `closed`) aynı kaynakta tekrar görüldüğünde `unknown` durumuna
 * dönüyordu. Gece bakımı (`closeStalePublications`) sonradan kapatsa da, arada
 * kapalı ilan "durumu belirsiz" olarak listede görünüyor ve `closed → unknown`
 * sahte bir sürüm kaydı yazılıyordu.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';
import type { RawAnnouncement } from '../src/domain';

const NOW = new Date('2026-10-22T09:00:00+03:00');

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-birlestirme-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

/** Tarihsiz gövde: son başvuru tarihi metinden çıkarılamaz. */
const BODY_WITHOUT_DATES =
  'Örnek Üniversitesi Rektörlüğünden: Üniversitemize 657 sayılı Kanunun 4/B maddesi uyarınca sözleşmeli personel alınacaktır. ' +
  'Adayların lisans mezunu olması ve KPSS P3 puanına sahip olması gerekmektedir. Başvurular şahsen yapılacaktır.';

function eskiIlan(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return sozlesmeliPersonelIlani({
    sourceItemId: 'ESKI-2019-0001',
    url: 'https://ornek.test/ilan/eski-2019',
    bodyText: BODY_WITHOUT_DATES,
    rawExcerpt: BODY_WITHOUT_DATES.slice(0, 300),
    publishedAt: '2019-03-01',
    applicationStartAt: undefined,
    applicationEndAt: undefined,
    ...overrides,
  });
}

describe('birleştirme: yayım tarihi ve durum', () => {
  it('son başvurusu olmayan eski ilan tekrar görüldüğünde kapalı kalır', async () => {
    const repos = await makeRepos();
    const ctx = { repos, now: NOW, workerId: 'w-test', provenance: 'scraped' as const };

    const first = await applyRawAnnouncement(eskiIlan(), ctx);
    expect(first.action).toBe('created');
    const created = await repos.jobs.findById(first.jobId ?? '');
    expect(created?.applicationEndDate).toBeNull();
    expect(created?.publishedAt).toBe('2019-03-01');
    expect(created?.status).toBe('closed');

    const second = await applyRawAnnouncement(eskiIlan(), ctx);
    expect(second.jobId).toBe(first.jobId);
    const merged = await repos.jobs.findById(first.jobId ?? '');
    expect(merged?.status).toBe('closed');
    expect(merged?.publishedAt).toBe('2019-03-01');
    // Durum değişmediği için sahte "closed → unknown" sürümü yazılmaz.
    const revisions = await repos.jobs.listRevisions(first.jobId ?? '');
    expect(revisions.some((revision) => revision.changedFields.includes('status'))).toBe(false);
  });

  it('önceki kayıtta yayım tarihi yoksa yeni okumadaki tarih doldurulur, varsa korunur', async () => {
    const repos = await makeRepos();
    const ctx = { repos, now: NOW, workerId: 'w-test', provenance: 'scraped' as const };

    const first = await applyRawAnnouncement(eskiIlan({ publishedAt: undefined }), ctx);
    expect((await repos.jobs.findById(first.jobId ?? ''))?.publishedAt).toBeNull();
    expect((await repos.jobs.findById(first.jobId ?? ''))?.status).toBe('unknown');

    await applyRawAnnouncement(eskiIlan(), ctx);
    const filled = await repos.jobs.findById(first.jobId ?? '');
    expect(filled?.publishedAt).toBe('2019-03-01');
    expect(filled?.status).toBe('closed');

    await applyRawAnnouncement(eskiIlan({ publishedAt: '2026-10-20' }), ctx);
    expect((await repos.jobs.findById(first.jobId ?? ''))?.publishedAt).toBe('2019-03-01');
  });
});
