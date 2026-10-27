/**
 * Düzeltme ilanı → hedef ilan: Resmî Gazete atfı (gerçek metinler, RG 16/17/20.10.2026).
 *
 * Bursa Uludağ Üniversitesi'nin iki "DÜZELTME İLANI" metni hedefini açıkça yazar:
 * "16.10.2026 tarih ve 33402 sayılı Resmî Gazete'de yayınlanan … ilanlarımızda".
 * Eski hedef seçimi (resmî no / URL / başlık kapsama / başlık benzerliği) bu
 * kanıtı kullanmıyordu: "… DÜZELTME İLANI" başlığı özgün başlığa benzemediği için
 * kayıt her seferinde insan incelemesine düşüyordu (03 / P2-6).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement, citedResmiGazeteDate } from '../src/ingest/jobs-service';
import type { RawAnnouncement } from '../src/domain';

interface FixtureItem {
  id: string;
  pdfUrl: string;
  institution: string;
  publishedAt: string;
  title: string;
  text: string;
}
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-duzeltme-ilanlari.json'), 'utf8'),
) as { items: FixtureItem[] };
const byId = (id: string): FixtureItem => fixture.items.find((item) => item.id === id) as FixtureItem;
const NOW = new Date('2026-10-21T09:00:00+03:00');
const SOURCE = 'resmigazete-cestili-ilanlar';

function raw(item: FixtureItem, overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return {
    sourceKey: SOURCE,
    sourceItemId: item.id,
    url: item.pdfUrl,
    title: item.title,
    institution: item.institution,
    publishedAt: `${item.publishedAt}T00:00:00+03:00`,
    bodyText: item.text,
    bodyTextSource: 'document',
    attachments: [{ url: item.pdfUrl, label: 'Resmî Gazete ilan belgesi', kind: 'pdf' }],
    ...overrides,
  } as RawAnnouncement;
}

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-duzeltme-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

const ctx = (repos: Repos) => ({ repos, now: NOW, workerId: 'w', provenance: 'scraped' as const });

describe('citedResmiGazeteDate', () => {
  it('gerçek atıf biçimlerinden yayım gününü okur', () => {
    expect(citedResmiGazeteDate(byId('20261017-4-12').text)).toBe('2026-10-16');
    expect(citedResmiGazeteDate(byId('20261020-4-5').text)).toBe('2026-10-16');
    expect(citedResmiGazeteDate('Sınav 16.10.2026 tarihinde yapılacaktır.')).toBeNull();
  });
});

describe('düzeltme ilanı hedefi', () => {
  it('atıf yapılan günün aynı kurum ilanına bağlanır; ilan kapatılmaz, sürüm yazılır', async () => {
    const repos = await makeRepos();
    const original = await applyRawAnnouncement(raw(byId('20261016-4-14')), ctx(repos));
    expect(original.action).toBe('created');
    const before = await repos.jobs.findById(original.jobId ?? '');

    for (const id of ['20261017-4-12', '20261020-4-5']) {
      const outcome = await applyRawAnnouncement(raw(byId(id)), ctx(repos));
      expect(outcome.action, id).toBe('withdrawal-signal');
      expect(outcome.jobId, id).toBe(original.jobId);
    }
    const after = await repos.jobs.findById(original.jobId ?? '');
    expect(after?.status).toBe(before?.status);
    expect(after?.statusReason).toContain('Düzeltme ilanı');
    const revisions = await repos.jobs.listRevisions(original.jobId ?? '');
    expect(revisions.filter((revision) => revision.summary.includes('düzeltme')).length).toBe(2);
    expect(await repos.review.countOpen()).toMatchObject({ total: 0 });
  });

  it('atıf yapılan günde kurumun birden fazla ilanı varsa tahmin etmez, incelemeye gönderir', async () => {
    const repos = await makeRepos();
    const first = await applyRawAnnouncement(raw(byId('20261016-4-14')), ctx(repos));
    const existing = await repos.jobs.findById(first.jobId ?? '');
    // Aynı gün, aynı kurumun ikinci (ayrı) ilanı.
    await repos.store.insertOne('jobs', {
      ...(existing as NonNullable<typeof existing>),
      id: 'job_ayni_gun_ikinci',
      dedupeKey: 'ayni-gun-ikinci',
      normalizedUrl: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261016-4-15.pdf',
      detailUrl: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261016-4-15.pdf',
      title: 'Bursa Uludağ Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
    });
    const outcome = await applyRawAnnouncement(raw(byId('20261017-4-12')), ctx(repos));
    expect(outcome.action).toBe('review');
  });

  it('kurumun sistemde hiç ilanı yoksa incelemeye düşmez; kaynak kararı olarak kaydedilir', async () => {
    const repos = await makeRepos();
    const outcome = await applyRawAnnouncement(raw(byId('20261017-4-12')), ctx(repos));
    // Düzeltilecek kayıt yok: insan incelemesi gereksiz (27.10.2026 kuyruk yükü).
    expect(outcome.action).toBe('withdrawal-signal');
    expect(outcome.jobId).toBeNull();
    expect(await repos.review.list({ status: 'open' })).toHaveLength(0);
  });
});

describe('iptal duyurusu', () => {
  it('Resmî Gazete atfı tek başına ilan İPTALİ için yeterli kanıt sayılmaz', async () => {
    const repos = await makeRepos();
    const original = await applyRawAnnouncement(raw(byId('20261016-4-14')), ctx(repos));
    const outcome = await applyRawAnnouncement(
      raw(byId('20261017-4-12'), {
        sourceItemId: '20261017-4-99',
        url: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261017-4-99.pdf',
        title: 'Bursa Uludağ Üniversitesi Rektörlüğünden: İPTAL İLANI',
        bodyText:
          'Bursa Uludağ Üniversitesi Rektörlüğünden: 16.10.2026 tarih ve 33402 sayılı Resmî Gazete’de yayımlanan ihale ilanı iptal edilmiştir.',
      }),
      ctx(repos),
    );
    expect(outcome.action).toBe('review');
    expect((await repos.jobs.findById(original.jobId ?? ''))?.status).not.toBe('cancelled');
  });
});
