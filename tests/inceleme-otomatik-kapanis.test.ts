/**
 * Kural güncellemesiyle incelemedeki kayıt sonraki taramada kendiliğinden ilana
 * dönüşürse, aynı bağlantının açık sınıflandırma incelemesi kapanır (kuyrukta
 * bayat kayıt kalmaz; yönetici aynı ilanı ikinci kez onaylamaz).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { fixedClock } from '../src/lib/clock';

const NOW = new Date('2026-10-24T09:00:00+03:00');
const URL = 'https://kariyerkapisi.gov.tr/IlanDetay?i=4850e095-8b16-4aba-9956-555740a41146';

let dir: string;
let store: FileStore;

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('inceleme kaydının otomatik kapanması', () => {
  it('ilan oluşunca aynı bağlantının açık sınıflandırma incelemesi çözülür', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kamuilan-review-close-'));
    store = new FileStore(dir);
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    await repos.sources.seed();
    // Eski kuralla incelemeye düşmüş kayıt.
    await repos.review.enqueue({
      kind: 'classification',
      sourceKey: 'kariyerkapisi-isealim',
      title: 'ORTA ANADOLU KALKINMA AJANSI - PERSONEL ALIM İLANI - 2026',
      url: URL,
      reason: 'Belge metni çıkarılamadı; alanların doğrulanması gerekiyor',
      confidence: 0.5,
      payload: {},
    });
    const other = await repos.review.enqueue({
      kind: 'classification',
      sourceKey: 'kariyerkapisi-isealim',
      title: 'BAŞKA İLAN',
      url: 'https://kariyerkapisi.gov.tr/IlanDetay?i=00000000-0000-0000-0000-000000000000',
      reason: 'Belge metni çıkarılamadı',
      confidence: 0.5,
      payload: {},
    });

    const outcome = await applyRawAnnouncement(
      {
        sourceKey: 'kariyerkapisi-isealim',
        sourceItemId: '4850e095-8b16-4aba-9956-555740a41146',
        url: URL,
        title: 'ORTA ANADOLU KALKINMA AJANSI - PERSONEL ALIM İLANI - 2026',
        institution: 'ORTA ANADOLU KALKINMA AJANSI',
        sourceCategory: 'Sözleşmeli Personel İlanları',
        applicationUrl: URL,
        attachments: [],
        extractionConfidence: 0.7,
      },
      { repos, now: NOW, workerId: 'test', provenance: 'scraped' },
    );

    expect(outcome.action).toBe('created');
    const open = await repos.review.list({ kind: 'classification', status: 'open' });
    expect(open.map((item) => item.id)).toEqual([other.item.id]);
    const resolved = await repos.review.list({ kind: 'classification', status: 'resolved' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.resolvedBy).toBe('system');
  });
});
