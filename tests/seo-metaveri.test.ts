/**
 * SEO — site haritası (API) ve `JobPosting` yapılandırılmış verisi.
 *
 * Site haritası yalnızca herkese açık vitrin açıkken yayımlanır ve yalnızca onaylı
 * ilanları içerir. `JobPosting` yalnızca ilanda bulunan alanlardan üretilir; eksik
 * alan uydurulmaz, `</script>` içeriği kaçışlanır (XSS).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { resetEnvCache } from '../src/config/env';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { belirsizDuyuru, sozlesmeliPersonelIlani } from './fixtures/announcements';
import { jobPostingJsonLd, serializeJsonLd } from '../src/lib/page-meta';
import type { PublicJobDetail } from '../src/types';

const NOW = new Date('2026-10-21T09:00:00+03:00');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const task of cleanups.splice(0)) await task();
  delete process.env.PUBLIC_LISTINGS_ENABLED;
  delete process.env.APP_BASE_URL;
  resetEnvCache();
});

async function sitemapApp(flag: string) {
  process.env.PUBLIC_LISTINGS_ENABLED = flag;
  process.env.APP_BASE_URL = 'https://kamuilan.test';
  resetEnvCache();
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-seo-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const accepted = await applyRawAnnouncement(sozlesmeliPersonelIlani({ sourceItemId: 'SEO-1' }), {
    repos,
    now: NOW,
    workerId: 'w-seo',
    provenance: 'scraped',
  });
  await applyRawAnnouncement(belirsizDuyuru(), { repos, now: NOW, workerId: 'w-seo', provenance: 'scraped' });
  // İncelemedeki (yayımlanmamış) ilan: site haritasına GİRMEMELİ.
  const acceptedDoc = (await store.find('jobs', { id: accepted.jobId! }))[0]!;
  await store.insertOne('jobs', {
    ...acceptedDoc,
    id: 'job_incelemede',
    dedupeKey: 'seo-incelemede',
    normalizedUrl: 'https://ornek.test/ilanlar/SEO-INCELEMEDE',
    classification: { ...acceptedDoc.classification, decision: 'review' },
  });
  const app = await buildApp({
    repos,
    logger: createLogger('seo-test', { level: 'silent' }),
    disableRateLimit: true,
  });
  cleanups.push(async () => {
    await app.close();
    await store.close();
  });
  const allJobs = await store.find('jobs', {});
  return { app, acceptedId: accepted.jobId!, allJobs };
}

describe('GET /api/sitemap.xml', () => {
  it('vitrin kapalıyken yayımlanmaz (404)', async () => {
    const { app } = await sitemapApp('0');
    expect((await app.inject({ method: 'GET', url: '/api/sitemap.xml' })).statusCode).toBe(404);
  });

  it('vitrin açıkken yalnızca onaylı ilanları ve sabit sayfaları listeler', async () => {
    const { app, acceptedId, allJobs } = await sitemapApp('1');
    const response = await app.inject({ method: 'GET', url: '/api/sitemap.xml' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/xml');
    const body = response.body;
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body).toContain(`<loc>https://kamuilan.test/ilanlar/${acceptedId}</loc>`);
    expect(body).toContain('<loc>https://kamuilan.test/ilanlar</loc>');
    expect(allJobs.some((item) => item.classification.decision !== 'accept')).toBe(true);
    for (const job of allJobs.filter((item) => item.classification.decision !== 'accept')) {
      expect(body).not.toContain(job.id);
    }
    expect(body.match(/<loc>[^<]*\/ilanlar\/[^<]+<\/loc>/g)?.length).toBe(
      allJobs.filter((item) => item.classification.decision === 'accept').length,
    );
  });
});

describe('JobPosting yapılandırılmış verisi', () => {
  const base = {
    id: 'job_1',
    kind: 'job',
    title: 'Sözleşmeli Personel Alım İlanı',
    institution: 'Örnek Bakanlığı',
    city: 'Ankara',
    district: null,
    quota: 5,
    publishedAt: '2026-10-20T09:00:00+03:00',
    applicationEndAt: null,
    applicationEndDate: '2026-11-05',
    textExcerpt: 'Örnek Bakanlığı 5 sözleşmeli personel alacaktır.',
  } as unknown as PublicJobDetail;

  it('yalnızca mevcut alanları yazar', () => {
    const data = jobPostingJsonLd(base, 'https://kamuilan.test/ilanlar/job_1')!;
    expect(data).toMatchObject({
      '@type': 'JobPosting',
      title: base.title,
      datePosted: '2026-10-20',
      validThrough: '2026-11-05T23:59:59+03:00',
      hiringOrganization: { name: 'Örnek Bakanlığı' },
      jobLocation: { address: { addressRegion: 'Ankara', addressCountry: 'TR' } },
      totalJobOpenings: 5,
    });
    const sparse = jobPostingJsonLd(
      { ...base, city: null, quota: null, applicationEndDate: null } as PublicJobDetail,
      'https://kamuilan.test/ilanlar/job_1',
    )!;
    expect(sparse).not.toHaveProperty('jobLocation');
    expect(sparse).not.toHaveProperty('totalJobOpenings');
    expect(sparse).not.toHaveProperty('validThrough');
  });

  it('yayım tarihi yoksa ya da süreç duyurusuysa üretilmez', () => {
    expect(jobPostingJsonLd({ ...base, publishedAt: null } as PublicJobDetail, 'u')).toBeNull();
    expect(jobPostingJsonLd({ ...base, kind: 'process' } as PublicJobDetail, 'u')).toBeNull();
  });

  it('kaynak metnindeki </script> kaçışlanır', () => {
    const data = jobPostingJsonLd(
      { ...base, textExcerpt: 'a</script><script>alert(1)</script>' } as PublicJobDetail,
      'u',
    )!;
    const serialized = serializeJsonLd(data);
    expect(serialized).not.toContain('</script>');
    expect(JSON.parse(serialized).description).toBe('a</script><script>alert(1)</script>');
  });
});
