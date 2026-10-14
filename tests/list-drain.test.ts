/**
 * İlan drenajı / açlık (starvation) regresyon testleri.
 *
 * Kullanıcı sorusu: "Her ilanı düzgün çekiyor mu? Sayfalardaki ilk ilanları mı
 * çekiyor? İkinci sayfasına geçiyor mu? İlan çekmediği sayfa var mı?"
 *
 * Buradaki testler GERÇEK adaptör + GERÇEK tarama hattı + GERÇEK sınıflandırma
 * + GERÇEK detay bütçesi (html-list = 8/koşum) ile çok koşumlu senaryolar
 * kurar ve şunları kanıtlar:
 *  1. Sayfa 2+'daki ilanlar keşfedilir ve işlenir (yalnız ilk sayfa değil).
 *  2. Bütçe dolunca ertelenen ilanlar sonraki koşumlarda tamamlanır (kaybolmaz).
 *  3. Reddedilen (ihale/sonuç) kayıtlar her koşumda yeniden işlenip bütçeyi
 *     yutarak sonraki sayfalardaki gerçek ilanları süresiz AÇ BIRAKMAZ.
 *  4. Jenerik yol sonlu URL'ler (ör. /TR-12345/duyuru-detay) kimlik
 *     çakışmasıyla tekilleşip kaybolmaz.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { loadKnownItemIds, loadKnownItemIdsWithDetail, runSourceScrape } from '../src/ingest/pipeline';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { requireAdapter } from '../src/sources/registry';
import type { SourceDefinition } from '../src/config/sources';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { SourceDoc } from '../src/db/schemas';
import type { AdapterContext } from '../src/sources/types';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const WORKER = 'worker-drain-test';

function htmlResponse(url: string, html: string): FetchResponse {
  const body = Buffer.from(html, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text: html, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

function fakeHttp(resolve: (url: string) => string | undefined): {
  http: HttpClient;
  calls: string[];
} {
  const calls: string[] = [];
  const handler = {
    async fetchText(url: string): Promise<FetchResponse> {
      calls.push(url);
      const html = resolve(url);
      if (html === undefined) throw new Error(`Beklenmeyen istek: ${url}`);
      return htmlResponse(url, html);
    },
    async fetchBinary(): Promise<FetchResponse> {
      throw new Error('İkili istek beklenmiyordu');
    },
    async close(): Promise<void> {
      /* ağ yok */
    },
  };
  return { http: handler as unknown as HttpClient, calls };
}

function definitionFor(key: string): SourceDefinition {
  return {
    key,
    name: `Test — ${key}`,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Denetim Kurumu',
    listingUrl: 'https://ornek.test/ilanlar',
    homepageUrl: 'https://ornek.test/',
    adapterKey: 'iskur-ilan-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote: 'Yalnızca testler için.',
    lastVerifiedAt: null,
    verificationEvidence: 'tests/list-drain.test.ts',
    coverageNote: 'Test.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 0,
    maxConcurrency: 1,
    allowedHosts: ['ornek.test'],
    tags: ['test'],
  };
}

async function makeRepos(): Promise<Repos> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-drain-'));
  const store = new FileStore(dir);
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function seed(repos: Repos, definition: SourceDefinition): Promise<SourceDoc> {
  await repos.sources.seed([definition]);
  const doc = await repos.sources.getByKey(definition.key);
  if (!doc) throw new Error('Test kaynağı oluşturulamadı');
  return doc;
}

/* --------------------------------------------------------------- */
/* Fixture üreticileri                                              */
/* --------------------------------------------------------------- */

/** Sınıflandırma motorunun kesin retle (ihale) döndürdüğü başlık. */
const rejectTitle = (n: number): string => `Denetim Kurumu ${n} doğalgaz alımı ihalesi ilanı duyurusu`;
const rejectBody =
  'Kurumumuzun ihtiyacı olan doğalgaz alımı 4734 sayılı Kamu İhale Kanunu hükümlerine göre açık ihale usulü ile yapılacaktır. Teklifler ihale komisyonuna sunulur.';

/** Sınıflandırma motorunun kabulle döndürdüğü (personel alımı) başlık/gövde. */
const acceptTitle = (n: number, branch: string): string =>
  `Denetim Kurumu ${branch} birimine ${n} sözleşmeli personel alım ilanı`;
const acceptBody = (n: number, branch: string): string =>
  `Denetim Kurumu ${branch} birimlerinde istihdam edilmek üzere sözleşmeli personel alımı yapılacaktır. ` +
  `Alınacak personel: ${branch} personeli ${n}. Kontenjan: ${n + 3} kişi. ` +
  'Başvuru şartları: 2026 yılı KPSS (P3) puanına sahip olmak. Başvurular Kariyer Kapısı üzerinden alınacaktır.';

function row(id: number, title: string, date: string): string {
  return `<li><a href="/ilanlar/2026/${id}">${title}</a> <time>${date}</time></li>`;
}

function detailPage(title: string, body: string): string {
  return `<html><body><main><article><h1>${title}</h1><p>${body}</p></article></main></body></html>`;
}

function pager(next: string | null, current = 1): string {
  return next
    ? `<nav class="pagination"><a href="?page=${current}">${current}</a><a rel="next" href="?page=${current + 1}">Sonraki</a></nav>`
    : `<nav class="pagination"><a href="?page=${current}">${current}</a><a rel="next" aria-disabled="true" class="disabled" href="?page=${current + 1}">Sonraki</a></nav>`;
}

/**
 * Birbirinden gerçekten farklı 3 personel alımı ilanı (başlık/metin benzerliği
 * tekilleştirme eşiklerinin çok altında: dice < 0.25, jaccard < 0.25 — üçü de
 * ayrı ilan olarak kaydedilir).
 */
const distinctAccepts: { title: string; body: string }[] = [
  {
    title: 'Bilgi işlem dairesi başkanlığı bilişim personeli alım ilanı',
    body:
      'Bilgi İşlem Dairesi Başkanlığına sözleşmeli bilişim personeli alınacaktır. ' +
      'Kontenjan: 4 kişi. Başvurular Kariyer Kapısı üzerinden alınacaktır. KPSS puanı esas alınır.',
  },
  {
    title: 'Hemşire ve ebe kadrosu için sağlık personeli başvuru duyurusu',
    body:
      'Sağlık Hizmetleri biriminde istihdam edilmek üzere hemşire ve ebe kadrosuna personel alınacaktır. ' +
      'Kontenjan: 7 kişi. Adaylar için lisans mezuniyeti şarttır.',
  },
  {
    title: 'Şoför ve temizlik görevlisi işçi alımı hakkında duyuru metni',
    body:
      'Destek Hizmetleri şubesinde çalıştırılmak üzere şoför ve temizlik görevlisi kadrosuna işçi alınacaktır. ' +
      'Kontenjan: 2 kişi. En az lise mezunu olmak gerekir.',
  },
];

/* --------------------------------------------------------------- */

describe('çok koşumlu tarama drenajı (gerçek adaptör + gerçek hatt)', () => {
  it('retlerle dolu ilk sayfa, 2. sayfadaki gerçek ilanları süresiz aç bırakmaz', async () => {
    const definition = definitionFor('test-aclik');
    const listingUrl = definition.listingUrl;
    const routes = (url: string): string | undefined => {
      if (url === listingUrl) {
        const rows = Array.from({ length: 8 }, (_v, i) =>
          row(1001 + i, rejectTitle(i + 1), '12.10.2026'),
        ).join('');
        return `<html><body><main><ul>${rows}</ul><nav class="pagination"><a href="?page=1">1</a><a rel="next" href="?page=2">Sonraki</a></nav></main></body></html>`;
      }
      if (url === `${listingUrl}?page=2`) {
        const rows = distinctAccepts.map((accept, i) => row(2001 + i, accept.title, '13.10.2026')).join('');
        return `<html><body><main><ul>${rows}</ul>${pager(null, 2)}</main></body></html>`;
      }
      const detail = /\/ilanlar\/2026\/(\d+)$/.exec(url);
      if (detail) {
        const id = Number(detail[1]);
        if (id >= 2001) {
          const accept = distinctAccepts[id - 2001];
          return detailPage(accept!.title, accept!.body);
        }
        return detailPage(rejectTitle(id - 1000), rejectBody);
      }
      return undefined;
    };

    const repos = await makeRepos();
    const source = await seed(repos, definition);
    const { http } = fakeHttp(routes);

    // Koşum 1: 1. sayfadaki 8 ihale duyurusu bütçenin tamamını kullanır ve
    // reddedilir. Karar belleği bunları "görüldü" olarak yazmalıdır.
    const run1 = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      http,
      logger: createLogger('test', { level: 'silent' }),
      queueNotifications: false,
      liveFetch: true,
    });
    expect(run1.itemsFound).toBe(8);
    expect(run1.itemsRejected).toBe(8);
    expect(run1.jobsCreated).toBe(0);

    const knownAfterRun1 = await loadKnownItemIds(repos, definition.key);
    for (let id = 1001; id <= 1008; id += 1) {
      expect(knownAfterRun1.has(String(id))).toBe(true);
    }

    // Koşum 2: aynı liste gezilir; retler artık "yeni" DEĞİLDİR, bütçe 2.
    // sayfadaki 3 personel alımı ilanına gider.
    const run2 = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      http,
      logger: createLogger('test', { level: 'silent' }),
      queueNotifications: false,
      liveFetch: true,
    });
    expect(run2.itemsFound).toBe(3);
    expect(run2.jobsCreated).toBe(3);

    const links = await repos.store.find('jobSources', { sourceKey: definition.key }, {});
    const capturedIds = links.map((link) => link.sourceItemId).sort();
    expect(capturedIds).toEqual(['2001', '2002', '2003']);
  });

  it('bütçe aşımında ertelenen ilanlar sonraki koşumlarda tamamlanır, hiçbiri kaybolmaz', async () => {
    const definition = definitionFor('test-drenaj');
    const listingUrl = definition.listingUrl;
    const page = (startId: number, count: number, next: number | null, current: number): string => {
      const rows = Array.from({ length: count }, (_v, i) =>
        row(startId + i, acceptTitle(startId + i, 'Mühendislik'), `${10 + current}.10.2026`),
      ).join('');
      return `<html><body><main><ul>${rows}</ul>${pager(next ? `?page=${next}` : null, current)}</main></body></html>`;
    };
    const routes = (url: string): string | undefined => {
      if (url === listingUrl) return page(101, 12, 2, 1);
      if (url === `${listingUrl}?page=2`) return page(201, 8, null, 2);
      const detail = /\/ilanlar\/2026\/(\d+)$/.exec(url);
      if (detail) {
        const id = Number(detail[1]);
        return detailPage(acceptTitle(id, 'Mühendislik'), acceptBody(id, 'Mühendislik'));
      }
      return undefined;
    };

    const repos = await makeRepos();
    const source = await seed(repos, definition);
    const { http } = fakeHttp(routes);

    // html-list bütçesi = 8/koşum: 12+8 ilan 3 koşumda (8+8+4) tamamlanmalı.
    for (let run = 1; run <= 3; run += 1) {
      await runSourceScrape({
        repos,
        source,
        trigger: 'schedule',
        workerId: WORKER,
        http,
        logger: createLogger('test', { level: 'silent' }),
        queueNotifications: false,
        liveFetch: true,
      });
    }
    const links = await repos.store.find('jobSources', { sourceKey: definition.key }, {});
    expect(links).toHaveLength(20);
    const captured = new Set(links.map((link) => link.sourceItemId));
    for (let id = 101; id <= 112; id += 1) expect(captured.has(String(id))).toBe(true);
    for (let id = 201; id <= 208; id += 1) expect(captured.has(String(id))).toBe(true);

    // 4. koşum yeni ilan bulmamalı (idempotent).
    const run4 = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      http,
      logger: createLogger('test', { level: 'silent' }),
      queueNotifications: false,
      liveFetch: true,
    });
    expect(run4.itemsFound).toBe(0);
    expect(run4.jobsCreated).toBe(0);
    expect(run4.jobsUpdated).toBe(0);
  });

  it('ret kararı gövde metniyle birlikte kaydedilir; bilinen-detaylı kümesine de girer', async () => {
    const repos = await makeRepos();
    await applyRawAnnouncement(
      {
        sourceKey: 'test-karar',
        sourceItemId: 'karar-1',
        url: 'https://ornek.test/ilanlar/karar-1',
        title: 'Kurum doğalgaz alımı ihalesi ilanı duyurusu',
        bodyText: rejectBody,
        bodyTextSource: 'detail',
        attachments: [],
        sourceCategory: 'kurum duyurusu',
        extractionConfidence: 0.5,
      },
      { repos, now: NOW, workerId: WORKER, provenance: 'sample' },
    );
    const decision = await repos.jobs.findSourceItemDecision('test-karar', 'karar-1');
    expect(decision?.decision).toBe('rejected');
    expect(decision?.capturedTextStatus).toBe('captured');

    const known = await loadKnownItemIds(repos, 'test-karar');
    expect(known.has('karar-1')).toBe(true);
    const withDetail = await loadKnownItemIdsWithDetail(repos, 'test-karar');
    expect(withDetail.has('karar-1')).toBe(true);
  });

  it('gövde metni olmadan reddedilen kayıt detay için yeniden denenebilir kalır', async () => {
    const repos = await makeRepos();
    await applyRawAnnouncement(
      {
        sourceKey: 'test-karar-metinsiz',
        sourceItemId: 'karar-2',
        url: 'https://ornek.test/ilanlar/karar-2',
        title: 'Kurum temizlik hizmeti alımı ilanı',
        rawExcerpt: 'Temizlik hizmeti alımı 4734 sayılı kanuna göre yapılacaktır.',
        attachments: [],
        sourceCategory: 'kurum duyurusu',
        extractionConfidence: 0.4,
      },
      { repos, now: NOW, workerId: WORKER, provenance: 'sample' },
    );
    const decision = await repos.jobs.findSourceItemDecision('test-karar-metinsiz', 'karar-2');
    expect(decision?.decision).toBe('rejected');
    expect(decision?.capturedTextStatus).toBe('listing-only');

    const known = await loadKnownItemIds(repos, 'test-karar-metinsiz');
    expect(known.has('karar-2')).toBe(true);
    // Detay metni yok: adaptör detay alındığında sınıflandırma yeniden
    // çalışabilsin diye "bilinen-detaylı" sayılmamalı.
    const withDetail = await loadKnownItemIdsWithDetail(repos, 'test-karar-metinsiz');
    expect(withDetail.has('karar-2')).toBe(false);
  });

  it('inceleme kuyruğuna alınan kayıt da tarama belleğine yazılır', async () => {
    const repos = await makeRepos();
    const outcome = await applyRawAnnouncement(
      {
        sourceKey: 'test-karar-review',
        sourceItemId: 'karar-3',
        url: 'https://ornek.test/ilanlar/karar-3',
        title: 'Belirsiz başlıklı bir duyuru kaydı hakkında',
        bodyText: 'Bu kaydın içeriği personel alımı olup olmadığı belirsizdir.',
        bodyTextSource: 'detail',
        attachments: [],
        sourceCategory: 'kurum duyurusu',
        extractionConfidence: 0.3,
      },
      { repos, now: NOW, workerId: WORKER, provenance: 'sample' },
    );
    expect(['review', 'rejected']).toContain(outcome.action);
    const known = await loadKnownItemIds(repos, 'test-karar-review');
    expect(known.has('karar-3')).toBe(true);
  });

  it('iptal/düzeltme sinyali kaynak bağı üretir; aynı sinyal her taramada yeni sürüm yazmaz', async () => {
    const repos = await makeRepos();
    // Hedef ilan
    await applyRawAnnouncement(
      {
        sourceKey: 'test-sinyal',
        sourceItemId: 'ilan-1',
        url: 'https://ornek.test/ilanlar/ilan-1',
        title: 'Denetim Kurumu sözleşmeli personel alım ilanı',
        bodyText: acceptBody(1, 'Mühendislik'),
        bodyTextSource: 'detail',
        attachments: [],
        sourceCategory: 'personel alımı',
        extractionConfidence: 0.8,
      },
      { repos, now: NOW, workerId: WORKER, provenance: 'sample' },
    );
    // İptal duyurusu (aynı başlık yapısı, farklı kaynak kaydı)
    const withdrawal = {
      sourceKey: 'test-sinyal',
      sourceItemId: 'iptal-1',
      url: 'https://ornek.test/ilanlar/iptal-1',
      title: 'Denetim Kurumu sözleşmeli personel alım ilanı iptal edilmiştir',
      bodyText: 'Yayımlanan sözleşmeli personel alım ilanı iptal edilmiştir.',
      bodyTextSource: 'detail' as const,
      attachments: [],
      sourceCategory: 'duyuru',
      extractionConfidence: 0.5,
    };
    const first = await applyRawAnnouncement(withdrawal, {
      repos,
      now: NOW,
      workerId: WORKER,
      provenance: 'sample',
    });
    expect(first.action).toBe('withdrawal-signal');

    // Sinyal, hedefe bağlanan bir kaynak kaydı üretmelidir.
    const link = await repos.jobs.findLinkBySourceItem('test-sinyal', 'iptal-1');
    expect(link).not.toBeNull();

    // Aynı sinyal tekrar görülürse yeni sürüm YAZILMAZ (idempotent).
    const jobsBefore = await repos.store.find('jobs', { sourceKeys: 'test-sinyal' }, {});
    const revisionCountBefore = await repos.store.find('jobRevisions', { sourceKey: 'test-sinyal' }, {});
    await applyRawAnnouncement(withdrawal, {
      repos,
      now: NOW,
      workerId: WORKER,
      provenance: 'sample',
    });
    const revisionCountAfter = await repos.store.find('jobRevisions', { sourceKey: 'test-sinyal' }, {});
    expect(revisionCountAfter.length).toBe(revisionCountBefore.length);
    expect(jobsBefore.length).toBeGreaterThan(0);
  });
});

describe('jenerik yol sonlu ilan kimlikleri', () => {
  it('/TR-<id>/duyuru-detay gibi URL’ler kimlik çakışmasıyla tekilleşip kaybolmaz', async () => {
    const definition = { ...definitionFor('test-kimlik'), adapterKey: 'kurum-duyuru-listesi' };
    const listingUrl = definition.listingUrl;
    const routes = (url: string): string | undefined => {
      if (url === listingUrl) {
        return `<html><body><main><ul>
          <li><a href="/TR-120694/duyuru-detay">Sözleşmeli personel alımı duyurusu bir</a></li>
          <li><a href="/TR-120801/duyuru-detay">Sözleşmeli personel alımı duyurusu iki</a></li>
        </ul><nav class="pagination"><a href="?page=1">1</a><a rel="next" aria-disabled="true" class="disabled" href="?page=2">Sonraki</a></nav></main></body></html>`;
      }
      return detailPage('Sözleşmeli personel alımı duyurusu', acceptBody(5, 'Sağlık'));
    };
    const { http } = fakeHttp(routes);
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const result = await adapter.run({
      source: definition,
      http,
      logger: createLogger('test', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: NOW,
      maxDetailFetches: 10,
    } as AdapterContext);

    expect(result.items).toHaveLength(2);
    const ids = result.items.map((item) => item.sourceItemId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('TR-120694-duyuru-detay');
    expect(ids).toContain('TR-120801-duyuru-detay');
  });
});
