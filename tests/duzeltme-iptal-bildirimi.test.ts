/**
 * İptal/düzeltme duyurusu → tercihi eşleşen kullanıcıya "ilanda değişiklik" bildirimi.
 *
 * Eski davranış: tarama hattı yalnızca `created`/`updated` sonuçlarında bildirim
 * üretiyordu; ilan resmî olarak iptal edildiğinde (`withdrawal-signal`) kullanıcı
 * haber alamıyordu. Ayrıca güncelleme bildirimine değişiklik özeti geçirilmiyordu
 * ("güncelleme var" deyip neyin değiştiğini söylemiyordu).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { runSourceScrape } from '../src/ingest/pipeline';
import type { SourceDefinition } from '../src/config/sources';
import type { AdapterRunResult, SourceAdapter } from '../src/sources/types';
import type { RawAnnouncement } from '../src/domain';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-22T09:00:00+03:00');

const DEFINITION: SourceDefinition = {
  key: 'test-bildirim-kaynagi',
  name: 'Test Kaynağı',
  group: 'kurum',
  sourceType: 'institution-page',
  institution: 'Örnek Üniversitesi',
  homepageUrl: 'https://ornek.test/',
  listingUrl: 'https://ornek.test/ilanlar',
  adapterKey: 'test-liste',
  method: 'html-list',
  status: 'method-defined',
  statusNote: 'Yalnızca testler için.',
  lastVerifiedAt: null,
  verificationEvidence: 'Testlerde canlı erişim yapılmaz.',
  coverageNote: 'Test.',
  enabled: true,
  intervalMinutes: 60,
  minRequestIntervalMs: 0,
  maxConcurrency: 1,
  allowedHosts: ['ornek.test'],
  tags: ['test'],
};

function adapter(items: RawAnnouncement[]): SourceAdapter {
  return {
    key: 'test-liste',
    label: 'Test listesi',
    method: 'html-list',
    notes: 'Sahte adaptör; ağa çıkmaz.',
    run: async (): Promise<AdapterRunResult> => ({
      items,
      requestCount: 1,
      notes: [],
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses: [200],
    }),
  };
}

async function setup(): Promise<{ repos: Repos; scan: (items: RawAnnouncement[]) => ReturnType<typeof runSourceScrape> }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-iptal-bildirim-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed([DEFINITION]);
  const source = await repos.sources.getByKey(DEFINITION.key);
  const { user } = await repos.users.create({
    email: 'aday@ornek.test',
    passwordHash: 'scrypt$test-hash-value',
    passwordSalt: 'test-salt-value',
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, { enabled: true, filters: {} });
  const scan = (items: RawAnnouncement[]) =>
    runSourceScrape({
      repos,
      source: source!,
      trigger: 'manual',
      workerId: 'w',
      adapter: adapter(items),
      logger: createLogger('test', { level: 'silent' }),
    });
  return { repos, scan };
}

describe('iptal duyurusu bildirimi', () => {
  it('ilan iptal edilince eşleşen kullanıcıya özetli tek değişiklik bildirimi gider', async () => {
    const { repos, scan } = await setup();
    const ilan = sozlesmeliPersonelIlani({ sourceKey: DEFINITION.key });
    const first = await scan([ilan]);
    expect(first.notificationsQueued).toBe(1);

    const iptal = sozlesmeliPersonelIlani({
      sourceKey: DEFINITION.key,
      sourceItemId: 'IPTAL-0001',
      url: 'https://ornek.test/ilanlar/iptal-0001',
      title: `${ilan.title} İptal Edilmiştir`,
      bodyText: 'Örnek Üniversitesi Rektörlüğünce yayımlanan sözleşmeli personel alım ilanı iptal edilmiştir.',
    });
    const second = await scan([ilan, iptal]);
    expect(second.notificationsQueued).toBe(1);

    const outbox = await repos.outbox.list({}, 10);
    expect(outbox).toHaveLength(2);
    const changed = outbox.find((item) => item.template === 'job-changed');
    expect(changed).toBeTruthy();
    expect(changed?.subject).toContain('Güncelleme');
    // Değişiklik özeti e-postaya taşınır (yalnızca "güncelleme var" değil).
    expect(JSON.stringify(changed?.payload)).toContain('iptal edildi');

    // Aynı iptal duyurusu tekrar görülür: yeni bildirim üretilmez.
    const third = await scan([ilan, iptal]);
    expect(third.notificationsQueued).toBe(0);
    expect(await repos.outbox.list({}, 10)).toHaveLength(2);
  });
});
