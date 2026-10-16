/**
 * Kaynağın KENDİ liste/dizin sayfası ilan kaydı olamaz — gerçek veri regresyonu
 * (16.10.2026 denetimi).
 *
 * Gerçek veritabanındaki iki kayıt bu yüzden çöptü:
 *   - Karayolları: başlık "Daha yüksek erişilebilirlik modunu aç" (sayfadaki
 *     erişilebilirlik düğmesi), detay bağlantısı .../Root/Duyurular.aspx
 *   - İçişleri: başlık sayfanın TÜM menüsü, detay bağlantısı /duyurular
 * İkisinin de durumu "açık" görünüyordu. Bir liste sayfası ilan değildir:
 * başlık ve tarih sayfa iskeletinden gelir, kayıt uydurma olur.
 *
 * Bu testler gerçek kaynak tanımlarını (src/config/sources.ts) ve gerçek kayıt
 * yolunu (applyRawAnnouncement) kullanır; dosya deposu, dış istek yok.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc, SourceItemDecisionDoc } from '../src/db/schemas';
import { applyRawAnnouncement, isSourceListingUrl } from '../src/ingest/jobs-service';

const NOW = new Date('2026-10-16T09:00:00+03:00');
const KGM_LISTING = 'https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Root/Duyurular.aspx';
const ICISLERI_LISTING = 'https://www.icisleri.gov.tr/duyurular';
const ICISLERI_HOME = 'https://www.icisleri.gov.tr/';

let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  store = new FileStore(mkdtempSync(join(tmpdir(), 'liste-sayfasi-')));
  await store.init();
  repos = createRepos(store, { now: () => NOW });
});

afterEach(async () => {
  await store.close();
});

async function seed() {
  await repos.sources.seed([
    {
      key: 'icisleri-bakanligi-duyurular',
      name: 'İçişleri Bakanlığı — Duyurular',
      group: 'kurum',
      sourceType: 'institution-page',
      institution: 'T.C. İçişleri Bakanlığı',
      homepageUrl: ICISLERI_HOME,
      listingUrl: ICISLERI_LISTING,
      adapterKey: 'kurum-duyuru-listesi',
      method: 'html-list',
      status: 'verified',
      statusNote: 'test',
      lastVerifiedAt: null,
      verificationEvidence: 'test',
      coverageNote: 'test',
      enabled: true,
      intervalMinutes: 60,
      minRequestIntervalMs: 0,
      maxConcurrency: 1,
      allowedHosts: ['icisleri.gov.tr'],
      tags: ['kurum'],
    },
  ]);
}

describe('kaynağın liste sayfası ilan kaydı olmaz', () => {
  it('liste adresi (www ve sorgu farkıyla) reddedilir ve kayıt oluşmaz', async () => {
    await seed();
    const outcome = await applyRawAnnouncement(
      {
        sourceKey: 'icisleri-bakanligi-duyurular',
        sourceItemId: 'liste-1',
        url: 'https://icisleri.gov.tr/duyurular?sayfa=2',
        title: 'T.C. İÇİŞLERİ BAKANLIĞI T.C. İÇİŞLERİ BAKANLIĞI Bakanımız Hakkımızda Teşkilat Şeması Duyurular',
        bodyText: 'Duyurular sayfası.',
        rawExcerpt: 'Duyurular',
        institution: 'T.C. İçişleri Bakanlığı',
        attachments: [],
        sourceCategory: 'Duyurular',
        extractionConfidence: 0.5,
      },
      { repos, now: NOW, workerId: 'test', provenance: 'scraped' },
    );

    expect(outcome.action).toBe('rejected');
    expect(outcome.jobId).toBeNull();
    const jobs = (await store.find('jobs', {}, { limit: 10 })) as JobDoc[];
    expect(jobs).toHaveLength(0);
  });

  it('reddedilen liste sayfası tarama belleğine yazılır (yeniden işlenmez)', async () => {
    await seed();
    await applyRawAnnouncement(
      {
        sourceKey: 'icisleri-bakanligi-duyurular',
        sourceItemId: 'liste-2',
        url: KGM_LISTING.replace('kgm', 'icisleri').replace('/Sayfalar/KGM/SiteTr/Root/Duyurular.aspx', '/duyurular'),
        title: 'Daha yüksek erişilebilirlik modunu aç',
        bodyText: 'Kurum duyuruları listesi.',
        rawExcerpt: 'Duyurular',
        institution: 'T.C. İçişleri Bakanlığı',
        attachments: [],
        sourceCategory: 'Duyurular',
        extractionConfidence: 0.5,
      },
      { repos, now: NOW, workerId: 'test', provenance: 'scraped' },
    );

    const decisions = (await store.find('sourceItemDecisions', {}, { limit: 10 })) as SourceItemDecisionDoc[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe('rejected');
    expect(decisions[0]?.sourceItemId).toBe('liste-2');
  });

  it('kurum ana sayfası da ilan kaydı olmaz', async () => {
    await seed();
    const outcome = await applyRawAnnouncement(
      {
        sourceKey: 'icisleri-bakanligi-duyurular',
        sourceItemId: 'ana-sayfa',
        url: 'https://icisleri.gov.tr/',
        title: 'T.C. İçişleri Bakanlığı',
        bodyText: 'Bakanlık ana sayfası.',
        rawExcerpt: 'Bakanlık',
        institution: 'T.C. İçişleri Bakanlığı',
        attachments: [],
        sourceCategory: 'Duyurular',
        extractionConfidence: 0.5,
      },
      { repos, now: NOW, workerId: 'test', provenance: 'scraped' },
    );
    expect(outcome.action).toBe('rejected');
  });

  it('gerçek ilan adresi (liste dışı) engellenmez', async () => {
    await seed();
    const outcome = await applyRawAnnouncement(
      {
        sourceKey: 'icisleri-bakanligi-duyurular',
        sourceItemId: 'gercek-ilan',
        url: 'https://icisleri.gov.tr/2026-yili-icisleri-uzman-yardimcisi-giris-sozlu-sinavi-duyurusu',
        title: '2026 Yılı İçişleri Uzman Yardımcılığı Giriş Sınavı Duyurusu',
        bodyText:
          'Bakanlığımızca 40 adet İçişleri Uzman Yardımcısı alınacaktır. Başvurular 01.11.2026 - 20.11.2026 tarihleri arasında e-Devlet üzerinden yapılacaktır. Lisans mezunu olmak şarttır. Kontenjan 40 kişidir.',
        rawExcerpt: 'İçişleri Uzman Yardımcısı alınacaktır.',
        institution: 'T.C. İçişleri Bakanlığı',
        attachments: [],
        sourceCategory: 'Duyurular',
        extractionConfidence: 0.8,
      },
      { repos, now: NOW, workerId: 'test', provenance: 'scraped' },
    );

    expect(['created', 'updated', 'merged', 'review']).toContain(outcome.action);
    expect(outcome.action).not.toBe('rejected');
  });
});

describe('isSourceListingUrl yardımcı fonksiyonu', () => {
  it('gerçek kaynak tanımlarından liste ve ana sayfayı tanır', async () => {
    await seed();
    expect(await isSourceListingUrl(KGM_LISTING, 'kgm-duyurular', repos)).toBe(true);
    expect(await isSourceListingUrl('https://kgm.gov.tr/Sayfalar/KGM/SiteTr/Root/Duyurular.aspx', 'kgm-duyurular', repos)).toBe(true);
    expect(await isSourceListingUrl(ICISLERI_HOME, 'icisleri-bakanligi-duyurular', repos)).toBe(true);
    expect(
      await isSourceListingUrl('https://icisleri.gov.tr/duyuru/bir-ilan', 'icisleri-bakanligi-duyurular', repos),
    ).toBe(false);
  });

  it('başka kaynağın liste adresini kendi kaydına eşlemez', async () => {
    await seed();
    expect(await isSourceListingUrl(KGM_LISTING, 'icisleri-bakanligi-duyurular', repos)).toBe(false);
  });

  it('bozuk/kısa adreste çökmez', async () => {
    await seed();
    expect(await isSourceListingUrl('bu-bir-url-degil', 'icisleri-bakanligi-duyurular', repos)).toBe(false);
  });
});
