/**
 * Eski kural sürümüyle reddedilmiş kayıtlar yeniden değerlendirilebilmeli.
 *
 * Kanıt: #31 öncesi "Bursa …" kurumlarının ilanları "burs" sayılıp reddediliyordu.
 * Reddedilen kayıt ilan (`jobs`) oluşturmaz, yalnızca `sourceItemDecisions` kaydı
 * kalır; `jobs:reclassify` ona ulaşamaz. Üstelik adaptörler bu kaydı tarama
 * belleğinde (`knownItemIds`) "görüldü" sayıp her taramada atlıyordu: düzeltme
 * yayımlansa bile aynı ilan bir daha işlenmiyordu.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import { loadKnownItemIds, loadKnownItemIdsWithDetail } from '../src/ingest/pipeline';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-22T09:00:00+03:00');
const SOURCE = 'resmigazete-cestili-ilanlar';

async function makeRepos(): Promise<Repos> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-eski-ret-')));
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function decide(
  repos: Repos,
  sourceItemId: string,
  decision: 'rejected' | 'review',
  classificationVersion: string,
): Promise<void> {
  await repos.jobs.recordSourceItemDecision({
    sourceKey: SOURCE,
    sourceItemId,
    decision,
    capturedTextStatus: 'captured',
    title: `Kayıt ${sourceItemId}`,
    url: `https://www.resmigazete.gov.tr/ilanlar/eskiler/${sourceItemId}.pdf`,
    classificationVersion,
  });
}

describe('tarama belleği: eski sürümlü ret kararları', () => {
  it('eski sürümle reddedilen kayıt bilinen kümeden düşer; güncel ret ve inceleme kalır', async () => {
    const repos = await makeRepos();
    await decide(repos, 'eski-ret', 'rejected', '2026.10.4');
    await decide(repos, 'guncel-ret', 'rejected', CLASSIFICATION_VERSION);
    await decide(repos, 'eski-inceleme', 'review', '2026.10.4');

    const known = await loadKnownItemIds(repos, SOURCE);
    const withDetail = await loadKnownItemIdsWithDetail(repos, SOURCE);
    for (const set of [known, withDetail]) {
      expect(set.has('eski-ret')).toBe(false);
      expect(set.has('guncel-ret')).toBe(true);
      expect(set.has('eski-inceleme')).toBe(true);
    }
  });

  it('eski sürümde reddedilen Bursa ilanı yeniden işlenince kabul edilir ve tekrar "bilinen" olur', async () => {
    const repos = await makeRepos();
    const bursa = sozlesmeliPersonelIlani({
      sourceKey: SOURCE,
      sourceItemId: '20261017-4-12',
      url: 'https://www.resmigazete.gov.tr/ilanlar/eskiler/2026/10/20261017-4-12.pdf',
      title: 'Bursa Uludağ Üniversitesi Rektörlüğünden: Sözleşmeli Personel Alım İlanı',
      institution: 'Bursa Uludağ Üniversitesi Rektörlüğü',
    });
    // #31 öncesi koşumun bıraktığı kayıt: eski sürümle "ret".
    await decide(repos, bursa.sourceItemId, 'rejected', '2026.10.4');
    expect((await loadKnownItemIds(repos, SOURCE)).has(bursa.sourceItemId)).toBe(false);

    const outcome = await applyRawAnnouncement(bursa, { repos, now: NOW, workerId: 'w', provenance: 'scraped' });
    expect(outcome.action).toBe('created');
    expect(outcome.classification.decision).toBe('accept');
    // Artık ilan bağlantısı var: sonraki taramada yeniden indirilmez.
    expect((await loadKnownItemIds(repos, SOURCE)).has(bursa.sourceItemId)).toBe(true);
  });
});
