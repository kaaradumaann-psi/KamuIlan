/**
 * Tekilleştirme incelemesi → yönetici kararı, gerçek alım hattından geçerek.
 *
 * Önceden "ayrı bırak" yalnız inceleme kaydını kapatıyordu: yeni kayıt için ilan hiç
 * oluşmuyordu ve tarama belleği onu "görüldü" saydığından kalıcı olarak kayboluyordu.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { RawAnnouncement } from '../src/domain';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { applyDedupeReviewDecision } from '../src/ingest/review-decisions';
import { fixedClock } from '../src/lib/clock';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-dedupe-karar-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Aynı kurum + aynı başlık, FARKLI dönem ve metin: otomatik birleştirilmez, incelemeye düşer. */
function benzerAmaFarkliDonem(): RawAnnouncement {
  const body =
    'Örnek Üniversitesi Rektörlüğünden: Üniversitemiz hastanesinde 4/B kapsamında sözleşmeli hemşire ve ' +
    'sağlık teknikeri istihdam edilecektir. Adaylar önlisans mezunu olmalı ve 2024 KPSS P93 puanına sahip ' +
    'olmalıdır. Başvurular 01.12.2026 tarihinde başlayıp 15.12.2026 tarihinde sona erecektir. İletişim: ' +
    'basvuru@ornek.edu.tr, 0312 555 44 33.';
  return sozlesmeliPersonelIlani({
    sourceKey: 'test-kaynak-3',
    sourceItemId: 'BASKA-KAYNAK-0042',
    url: 'https://baska-kaynak.test/ilan/0042',
    bodyText: body,
    rawExcerpt: body.slice(0, 400),
    attachments: [],
  });
}

async function reviewFor(raw: RawAnnouncement) {
  const outcome = await applyRawAnnouncement(raw, { repos, now: NOW, workerId: 'w', provenance: 'scraped' });
  expect(outcome.action).toBe('review');
  const item = await repos.review.findById(outcome.reviewId as string);
  if (!item) throw new Error('inceleme kaydı yok');
  return item;
}

describe('tekilleştirme incelemesi kararları', () => {
  it('"ayrı yayımla" yeni kaydı ayrı ilan yapar; bilgiler korunur, metin küçültme ilkesine uyar', async () => {
    const first = await applyRawAnnouncement(sozlesmeliPersonelIlani(), { repos, now: NOW, workerId: 'w', provenance: 'scraped' });
    const item = await reviewFor(benzerAmaFarkliDonem());
    expect(item.kind).toBe('dedupe');
    expect(item.candidateJobIds).toContain(first.jobId);

    // Anlık görüntü: tam metin değil, iletişim bilgisi karartılmış sınırlı özet.
    const snapshot = item.payload.raw as RawAnnouncement;
    expect(snapshot.sourceItemId).toBe('BASKA-KAYNAK-0042');
    expect(snapshot.bodyText?.length ?? 0).toBeLessThanOrEqual(2_500);
    expect(snapshot.bodyText).not.toContain('basvuru@ornek.edu.tr');
    expect(snapshot.bodyText).not.toContain('555 44 33');

    const outcome = await applyDedupeReviewDecision(repos, item, { action: 'keep-separate' }, 'usr_admin');
    expect(outcome.action).toBe('created');
    expect(outcome.jobId).not.toBe(first.jobId);
    const job = await repos.jobs.findById(outcome.jobId as string);
    expect(job?.classification.decision).toBe('accept');
    expect(job?.applicationEndDate).toBe('2026-12-15');
    expect(await repos.jobs.findLinkBySourceItem('test-kaynak-3', 'BASKA-KAYNAK-0042')).toBeTruthy();
    // Var olan ilan değişmez.
    expect((await repos.jobs.findById(first.jobId as string))?.status).not.toBe('closed');

    // Kaynak aynı kaydı yeniden verirse yeni ilanı günceller (tekrar incelemeye düşmez).
    const again = await applyRawAnnouncement(benzerAmaFarkliDonem(), { repos, now: NOW, workerId: 'w', provenance: 'scraped' });
    expect(again.jobId).toBe(outcome.jobId);
  });

  it('"bu ilanla aynı" yeni kaydı seçilen ilana kaynak olarak bağlar', async () => {
    const first = await applyRawAnnouncement(sozlesmeliPersonelIlani(), { repos, now: NOW, workerId: 'w', provenance: 'scraped' });
    const item = await reviewFor(benzerAmaFarkliDonem());
    const outcome = await applyDedupeReviewDecision(
      repos,
      item,
      { action: 'merge', targetJobId: first.jobId as string },
      'usr_admin',
    );
    expect(outcome.jobId).toBe(first.jobId);
    const links = await repos.jobs.listSourceLinks(first.jobId as string);
    expect(links.map((link) => link.sourceItemId)).toContain('BASKA-KAYNAK-0042');
    expect(await repos.store.count('jobs', {})).toBe(1);
  });

  it('geri çekme kaydında karar ilan oluşturmaz (duyuru ilan değildir)', async () => {
    const { item } = await repos.review.enqueue({
      kind: 'dedupe',
      sourceKey: 'test-kaynak',
      title: 'İlan iptali duyurusu',
      url: 'https://ornek.test/iptal',
      reason: 'İptal/geri çekme duyurusu için eşleşen ilan bulunamadı; insan incelemesi gerekiyor.',
      confidence: 0.4,
      payload: { sourceItemId: 'IPTAL-1', withdrawal: 'withdrawn', excerpt: 'İlan iptal edilmiştir.' },
    });
    const outcome = await applyDedupeReviewDecision(repos, item, { action: 'keep-separate' }, 'usr_admin');
    expect(outcome).toEqual({ jobId: null, action: 'closed-only' });
    expect(await repos.store.count('jobs', {})).toBe(0);
  });
});
