/**
 * Onarım: yanlış birleşmiş İŞKUR ilanlarını ayıran `repair:iskur-split` mantığı.
 * Yeni tekilleştirme kuralı artık birleşmeyi engellediği için, eski hatalı durum
 * ikinci bir kaynak kaydı elle aynı ilana bağlanarak kurulur.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { iskurRowToAnnouncement, type IskurListingRow } from '../src/sources/adapters/iskur-esube';
import { applyIskurSplit, planIskurSplit } from '../src/ingest/iskur-split-repair';
import { createId } from '../src/domain/ids';

const SOURCE_KEY = 'iskur-esube-kamu';

function row(overrides: Partial<IskurListingRow>): IskurListingRow {
  const ilanNo = overrides.ilanNo ?? '00009862271';
  return {
    ilanNo,
    occupation: 'Makinist',
    institution: 'TCDD TAŞIMACILIK A.Ş GENEL MÜDÜRLÜĞÜ',
    employerType: 'Kamu',
    workPeriod: 'Sürekli',
    workPattern: 'Tam Zamanlı',
    quota: 2,
    city: 'Ankara',
    district: null,
    locationText: 'İl Geneli (ANKARA)',
    applicationEndDate: '2026-10-26',
    detailUrl: `https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx?uiID=${ilanNo}`,
    ...overrides,
  };
}

async function freshCtx() {
  const now = new Date('2026-10-23T09:00:00+03:00');
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-iskur-split-')));
  await store.init();
  const repos = createRepos(store, fixedClock(now));
  return { repos, store, ctx: { repos, now, workerId: 'w', provenance: 'scraped' as const } };
}

describe('repair:iskur-split', () => {
  it('yanlış birleşmiş bir ilanı ayırır, idempotenttir ve sürüm geçmişi yazar', async () => {
    const { repos, store, ctx } = await freshCtx();

    // İlk ilan normal yolla oluşur.
    const first = await applyRawAnnouncement(
      iskurRowToAnnouncement(row({ ilanNo: '00009862271', city: 'Ankara' }), SOURCE_KEY, 'Detay metni.'),
      ctx,
    );
    expect(first.action).toBe('created');
    const jobId = first.jobId!;

    // Eski hatalı birleşme: FARKLI ilan noyla ikinci kaynak kaydı aynı ilana bağlanır.
    await repos.jobs.addSourceLink({
      id: createId('jsrc'),
      jobId,
      sourceKey: SOURCE_KEY,
      sourceItemId: 'iskur-esube:00009862396',
      url: 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanDetay.aspx?uiID=00009862396',
      title: 'KARAYOLLARI 6. BÖLGE MÜDÜRLÜĞÜ — Boyacı işçi alımı (İŞKUR, Kayseri)',
      institution: 'KARAYOLLARI 6. BÖLGE MÜDÜRLÜĞÜ',
      sourceCategory: 'iskur-esube-kamu',
      publishedAt: null,
      capturedTextCharacterCount: 0,
      capturedTextStatus: 'listing-only',
      attachments: [],
      active: true,
      firstSeenAt: '2026-10-23T08:00:00.000Z',
      lastSeenAt: '2026-10-23T08:00:00.000Z',
    });

    const { plan, summary } = await planIskurSplit(store, SOURCE_KEY);
    expect(summary.jobsToSplit).toBe(1);
    expect(summary.newJobs).toBe(1);
    expect(summary.resultingJobs).toBe(2);
    expect(plan[0]!.survivorSourceItemId).toBe('iskur-esube:00009862271');

    const result = await applyIskurSplit(repos, plan, new Date('2026-10-23T10:00:00+03:00'));
    expect(result.newJobs).toBe(1);
    expect(result.movedLinks).toBe(1);

    // İki ayrı ilan; her birinde tek İŞKUR kaydı.
    const jobs = await store.find('jobs', {});
    expect(jobs).toHaveLength(2);
    const parentLinks = await repos.jobs.listSourceLinks(jobId);
    expect(parentLinks).toHaveLength(1);
    expect(parentLinks[0]!.sourceItemId).toBe('iskur-esube:00009862271');

    // Yeni ilan Kayseri/Karayolları kaydını taşır.
    const splitJob = jobs.find((job) => job.id !== jobId)!;
    expect(splitJob.institution).toContain('KARAYOLLARI');
    const splitLinks = await repos.jobs.listSourceLinks(splitJob.id);
    expect(splitLinks).toHaveLength(1);
    expect(splitLinks[0]!.sourceItemId).toBe('iskur-esube:00009862396');

    // Sürüm geçmişi: yeni ilanda 'new', ebeveynde ayrıştırma kaydı.
    expect((await repos.jobs.listRevisions(splitJob.id)).some((r) => r.changeTypes.includes('new'))).toBe(true);
    expect((await repos.jobs.listRevisions(jobId)).some((r) => r.summary.includes('ayrı ilanlara taşındı'))).toBe(true);

    // İdempotent: ikinci koşuda ayrılacak kayıt kalmaz.
    const second = await planIskurSplit(store, SOURCE_KEY);
    expect(second.summary.jobsToSplit).toBe(0);
  });
});
