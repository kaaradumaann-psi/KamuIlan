/**
 * Filtreleme mantığı — uçtan uca doğruluk denetimi.
 *
 * Üç ilan gerçek üretim hattından (`applyRawAnnouncement`) geçirilir, sonra
 * alanları çeşitlendirilir ve her filtre KAMU API'si üzerinden tek tek ve
 * birlikte doğrulanır. Amaç: "filtre seçtim ama yanlış sonuç geldi" sınıfı
 * hataları (büyük/küçük harf, Türkçe karakter, ters tarih aralığı, geçersiz
 * değer) kalıcı olarak yakalamak.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');

interface Setup {
  app: Awaited<ReturnType<typeof buildApp>>;
  ids: { a: string; b: string; c: string };
}

async function setup(): Promise<Setup> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-filters-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();

  async function makeJob(title: string, itemId: string, kurum: string): Promise<string> {
    const applied = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({
        sourceKey: 'test-kaynak',
        title,
        sourceItemId: itemId,
        institution: kurum,
        url: `https://ornek.test/ilanlar/${itemId}`,
      }),
      { repos, now: NOW, workerId: 'filter-test', provenance: 'scraped' },
    );
    return applied.jobId as string;
  }

  const a = await makeJob('A Kurumu Hemşire Alımı 2026', 'FILTRE-A-0001', 'A Kurumu');
  const b = await makeJob('B Kurumu Zabıt Kâtibi Alımı 2026', 'FILTRE-B-0002', 'B Kurumu');
  const c = await makeJob('C Kurumu Temizlik Görevlisi Alımı 2026', 'FILTRE-C-0003', 'C Kurumu');
  if (new Set([a, b, c]).size !== 3) throw new Error('İlanlar tekilleştirmede birleşti; test verisi hatalı');

  const reqOf = async (id: string) => (await repos.jobs.findById(id))!.requirements;
  await repos.jobs.updateJob(a, {
    city: 'Ankara',
    cityNormalized: 'ankara',
    employmentType: 'sozlesmeli',
    status: 'active',
    quota: 50,
    applicationEndDate: '2026-11-30',
    applicationEndAt: '2026-11-30T23:59:59+03:00',
    applicationUrl: 'https://ornek.test/basvuru-a',
    requirements: { ...(await reqOf(a)), educationLevels: ['lisans'], kpssScoreTypes: ['P3'], kpssMinScore: 70 },
  });
  await repos.jobs.updateJob(b, {
    city: 'İstanbul',
    cityNormalized: 'istanbul',
    employmentType: 'kadrolu',
    status: 'closed',
    quota: null,
    applicationEndDate: '2026-09-01',
    applicationEndAt: '2026-09-01T23:59:59+03:00',
    applicationUrl: null,
    requirements: { ...(await reqOf(b)), educationLevels: ['ortaogretim'], kpssScoreTypes: [], kpssMinScore: null },
  });
  await repos.jobs.updateJob(c, {
    city: 'İzmir',
    cityNormalized: 'izmir',
    employmentType: 'kamu-isci',
    status: 'upcoming',
    quota: 5,
    applicationEndDate: '2027-01-15',
    applicationEndAt: '2027-01-15T23:59:59+03:00',
    applicationUrl: null,
    requirements: { ...(await reqOf(c)), educationLevels: ['lisans', 'onlisans'], kpssScoreTypes: ['P93'], kpssMinScore: 55 },
  });

  const app = await buildApp({
    repos,
    logger: createLogger('filters-test', { level: 'silent' }),
    disableRateLimit: true,
  });
  return { app, ids: { a, b, c } };
}

interface ListPayload {
  total: number;
  items: { id: string }[];
}

async function listIds(app: Setup['app'], query: string): Promise<{ status: number; payload: ListPayload }> {
  const response = await app.inject({ method: 'GET', url: `/api/jobs${query}` });
  return { status: response.statusCode, payload: JSON.parse(response.body) as ListPayload };
}

describe('ilan filtreleri (API)', () => {
  it('filtresiz liste üç ilanı da döndürür', async () => {
    const { app, ids } = await setup();
    const { payload } = await listIds(app, '');
    expect(payload.total).toBe(3);
    expect(payload.items.map((item) => item.id).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    await app.close();
  });

  it('şehir filtresi Türkçe/büyük-küçük duyarsızdır', async () => {
    const { app, ids } = await setup();
    expect((await listIds(app, '?city=ankara')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    expect((await listIds(app, '?city=ANKARA')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    expect((await listIds(app, '?city=İSTANBUL')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    expect((await listIds(app, '?city=Istanbul')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    expect((await listIds(app, '?city=izmir')).payload.items.map((i) => i.id)).toEqual([ids.c]);
    expect((await listIds(app, '?city=Bursa')).payload.total).toBe(0);
    await app.close();
  });

  it('istihdam türü tek tek ve geçersiz değerde doğru davranır', async () => {
    const { app, ids } = await setup();
    expect((await listIds(app, '?employmentType=sozlesmeli')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    expect((await listIds(app, '?employmentType=kadrolu')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    expect((await listIds(app, '?employmentType=kamu-isci')).payload.items.map((i) => i.id)).toEqual([ids.c]);
    const invalid = await listIds(app, '?employmentType=boyle-bir-tur-yok');
    expect(invalid.status).toBe(200);
    expect(invalid.payload.total).toBe(0);
    await app.close();
  });

  it('durum, tarih aralığı, kontenjan ve başvuru bağlantısı filtreleri', async () => {
    const { app, ids } = await setup();
    expect((await listIds(app, '?status=closed')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    expect((await listIds(app, '?status=active')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    expect((await listIds(app, '?deadlineFrom=2026-11-01&deadlineTo=2026-12-31')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    expect((await listIds(app, '?deadlineTo=2026-10-01')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    expect((await listIds(app, '?minQuota=10')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    expect((await listIds(app, '?hasApplicationUrl=true')).payload.items.map((i) => i.id)).toEqual([ids.a]);
    await app.close();
  });

  it('eğitim filtresi takma adı kanonik değere çevrilir; tanınmayan değer 0 sonuç vermez', async () => {
    const { app, ids } = await setup();
    // Eski paylaşılmış bağlantıdaki 'lise' takma adı 'ortaogretim' ile aynı sonucu verir.
    expect((await listIds(app, '?education=lise')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    // Tanınmayan değer yok sayılmaz: "bu düzeyde ilan yok" dürüst cevabı döner.
    expect((await listIds(app, '?education=belirtilmemis')).payload.total).toBe(0);
    expect((await listIds(app, '?education=olmayan-duzey')).payload.total).toBe(0);
    await app.close();
  });

  it('eğitim ve KPSS filtreleri (puansız ilan KPSS filtresinde elenir)', async () => {
    const { app, ids } = await setup();
    expect((await listIds(app, '?education=ortaogretim')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    const lisans = await listIds(app, '?education=lisans');
    expect(lisans.payload.items.map((i) => i.id).sort()).toEqual([ids.a, ids.c].sort());
    // A'nın taban puanı 70, C'ninki 55; B'nin puanı yok → 60 sınırı yalnız C'yi bırakır.
    expect((await listIds(app, '?kpssMaxScore=60')).payload.items.map((i) => i.id)).toEqual([ids.c]);
    expect((await listIds(app, '?kpssType=P93')).payload.items.map((i) => i.id)).toEqual([ids.c]);
    await app.close();
  });

  it('arama metni başlık, kurum ve ilan gövdesinde Türkçe duyarsız eşleşir', async () => {
    const { app, ids } = await setup();
    // Başlıkta eşleşen terim: yalnızca o ilan (ı/i ve büyük/küçük duyarsız).
    expect((await listIds(app, '?q=ZABIT')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    expect((await listIds(app, '?q=katibi')).payload.items.map((i) => i.id)).toEqual([ids.b]);
    // Gövde metninde ortak geçen terim: üç ilan da eşleşir (Türkçe karakter
    // duyarsızlığı gövdede de çalışır; eskiden yalnızca düz ASCII'de çalışıyordu).
    expect((await listIds(app, '?q=HEMŞİRE')).payload.items.map((i) => i.id).sort()).toEqual(
      [ids.a, ids.b, ids.c].sort(),
    );
    expect((await listIds(app, '?q=sağlık')).payload.total).toBe(3);
    await app.close();
  });

  it('filtreler birlikte uygulanır; çelişen seçim boş döner', async () => {
    const { app, ids } = await setup();
    expect(
      (await listIds(app, '?city=ankara&employmentType=sozlesmeli&status=active')).payload.items.map((i) => i.id),
    ).toEqual([ids.a]);
    expect((await listIds(app, '?city=ankara&employmentType=kadrolu')).payload.total).toBe(0);
    await app.close();
  });

  it('sayfalama ve son tarihe göre sıralama tutarlıdır', async () => {
    const { app, ids } = await setup();
    const page1 = await listIds(app, '?pageSize=2&page=1');
    const page2 = await listIds(app, '?pageSize=2&page=2');
    expect(page1.payload.total).toBe(3);
    expect(page1.payload.items).toHaveLength(2);
    expect(page2.payload.items).toHaveLength(1);
    const sorted = await listIds(app, '?sort=deadline');
    expect(sorted.payload.items.map((i) => i.id)).toEqual([ids.b, ids.a, ids.c]);
    await app.close();
  });
});
