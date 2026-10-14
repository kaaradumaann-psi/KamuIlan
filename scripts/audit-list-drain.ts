/**
 * Çevrimdışı ilan kapsam/drenaj denetimi: `npx tsx scripts/audit-list-drain.ts`
 *
 * Ne yapar: Her adaptör ailesini çok sayfalı sahte listelerle (gerçek sayfa
 * URL kalıpları ve sayfalama işaretleriyle) çalıştırır ve ardından GERÇEK
 * tarama hattını (runSourceScrape + sınıflandırma + gerçek detay bütçesi +
 * kalıcı knownItemIds belleği) ardışık koşumlarda koşturarak şunları kanıtlar:
 *
 *   1. Sayfa 2/3'teki ilanlar gerçekten keşfediliyor mu? (yalnız ilk sayfa mı?)
 *   2. Bir koşumda bütçe dolarsa kalan ilanlar sonraki koşumlara erteleniyor mu,
 *      yoksa SONSUZA KADAR aç/açmaz mı? (drenaj testi)
 *   3. Reddedilen (ihale/sonuç vb.) ilanlar her koşumda yeniden işlenip detay
 *      bütçesini yiyerek yeni ilanları aç bırakıyor mu? (açlık testi)
 *
 * Ağa ÇIKMAZ; sahte HTTP istemcisi ve fixture HTML kullanır. Veritabanı
 * olarak geçici FileStore kullanılır. Kod değişikliği gerektirmez; "kayıp
 * ilan var mı?" sorusunun yazılı kanıtıdır.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { runSourceScrape, detailFetchBudget } from '../src/ingest/pipeline';
import { SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { requireAdapter } from '../src/sources/registry';
import type { SourceDoc } from '../src/db/schemas';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { AdapterContext } from '../src/sources/types';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const WORKER = 'audit-worker';

/* ------------------------------------------------------------------ */
/* Sahte HTTP                                                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Senaryo üreteçleri                                                 */
/* ------------------------------------------------------------------ */

function iskurRow(id: number, title: string, date: string): string {
  return `<li><a href="/ilanlar/2026/${id}">${title}</a> <time>${date}</time></li>`;
}

function iskurDetail(title: string, body: string): string {
  return `<html><body><main><article><h1>${title}</h1><p>${body}</p></article></main></body></html>`;
}

const REJECT_TITLE = (n: number): string => `Kurum ${n} adet mal alımı ihale ilanı duyurusu hakkında`;
const REJECT_BODY =
  'İhale komisyonu kararı ile mal alımı ihalesi yapılacaktır. Teklifler ihale şartnamesine göre sunulur.';
const ACCEPT_TITLE = (n: number): string => `Kurum ${n} sözleşmeli personel alımı ilanı başvuru kılavuzu`;
const ACCEPT_BODY =
  'Sözleşmeli personel alımı için başvurular alınacaktır. KPSS puan esasına göre 5 personel alınacak olup adaylar başvurularını e-Devlet üzerinden yapacaktır.';

function iskurPage1(rejectCount: number): string {
  const rows = Array.from({ length: rejectCount }, (_v, i) =>
    iskurRow(1001 + i, REJECT_TITLE(i + 1), '12.10.2026'),
  ).join('\n');
  return `<html><body><main><ul>
${rows}
</ul><nav class="pagination"><a href="?page=1">1</a><a rel="next" href="?page=2">Sonraki</a></nav></main></body></html>`;
}

function iskurPage2(acceptStart: number, acceptCount: number): string {
  const rows = Array.from({ length: acceptCount }, (_v, i) =>
    iskurRow(2001 + i, ACCEPT_TITLE(acceptStart + i), '13.10.2026'),
  ).join('\n');
  return `<html><body><main><ul>
${rows}
</ul><nav class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><a rel="next" aria-disabled="true" class="disabled" href="?page=3">Sonraki</a></nav></main></body></html>`;
}

function bigAcceptPage(startId: number, count: number, pageNo: number, nextPage: number | null): string {
  const rows = Array.from({ length: count }, (_v, i) =>
    iskurRow(startId + i, ACCEPT_TITLE(startId + i), `${10 + pageNo}.10.2026`),
  ).join('\n');
  const pager = nextPage
    ? `<nav class="pagination"><a rel="next" href="?page=${nextPage}">Sonraki</a></nav>`
    : `<nav class="pagination"><a href="?page=${pageNo}">${pageNo}</a><a rel="next" aria-disabled="true" class="disabled" href="?page=${pageNo + 1}">Sonraki</a></nav>`;
  return `<html><body><main><ul>${rows}</ul>${pager}</main></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                        */
/* ------------------------------------------------------------------ */

interface ScenarioReport {
  name: string;
  lines: string[];
  ok: boolean;
}

function definitionFor(key: string, listingUrl: string): SourceDefinition {
  return {
    key,
    name: `Denetim — ${key}`,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Denetim Kurumu',
    listingUrl,
    homepageUrl: 'https://ornek.test/',
    adapterKey: 'iskur-ilan-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote: 'Yalnızca çevrimdışı denetim için.',
    lastVerifiedAt: null,
    verificationEvidence: 'scripts/audit-list-drain.ts',
    coverageNote: 'Denetim.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 0,
    maxConcurrency: 1,
    allowedHosts: ['ornek.test'],
    tags: ['denetim'],
  };
}

async function makeRepos(): Promise<Repos> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-audit-'));
  const store = new FileStore(dir);
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function seed(repos: Repos, definition: SourceDefinition): Promise<SourceDoc> {
  await repos.sources.seed([definition]);
  const doc = await repos.sources.getByKey(definition.key);
  if (!doc) throw new Error('kaynak oluşturulamadı');
  return doc;
}

/* ------------------------------------------------------------------ */
/* Senaryolar                                                         */
/* ------------------------------------------------------------------ */

/**
 * Açlık senaryosu: 1. sayfada 8 REDDEDİLEN (ihale) ilan, 2. sayfada 3 KABUL
 * edilen personel alımı ilanı. Gerçek detay bütçesi = 8/koşum.
 *
 * Sağlıklı sistem: koşum 1 retleri işler ve belleğe alır; koşum 2'de 2.
 * sayfadaki 3 ilan yakalanır.
 * Hatalı sistem: retler her koşumda "yeni" sayılır, bütçenin 8'ini birden
 * yutar; 2. sayfadaki ilanlar hiçbir koşumda yakalanmaz.
 */
async function scenarioStarvation(): Promise<ScenarioReport> {
  const lines: string[] = [];
  const definition = definitionFor('denetim-aclik', 'https://ornek.test/ilanlar');
  const listingUrl = definition.listingUrl;
  const routes = (url: string): string | undefined => {
    if (url === listingUrl) return iskurPage1(8);
    if (url === `${listingUrl}?page=2`) return iskurPage2(1, 3);
    const detail = /\/ilanlar\/2026\/(\d+)$/.exec(url);
    if (detail) {
      const id = Number(detail[1]);
      return id >= 2001
        ? iskurDetail(ACCEPT_TITLE(id - 2000), ACCEPT_BODY)
        : iskurDetail(REJECT_TITLE(id - 1000), REJECT_BODY);
    }
    return undefined;
  };

  // Tek repo ile ardışık koşumlar: her koşumdan sonra knownItemIds kalıcı
  // depodan (jobSources + karar kayıtları) yeniden yüklenir — tıpkı üretimdeki
  // gibi.
  const captured = new Map<string, string>(); // sourceItemId → başlık
  let ok = true;
  const repos = await makeRepos();
  const source = await seed(repos, definition);
  const { http } = fakeHttp(routes);
  for (let run = 1; run <= 4; run += 1) {
    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      http,
      logger: createLogger('audit', { level: 'silent' }),
      queueNotifications: false,
      liveFetch: true,
    });
    const linkCount = await repos.store.find('jobSources', { sourceKey: definition.key }, {});
    for (const link of linkCount) captured.set(link.sourceItemId, link.title);
    lines.push(
      `  Koşum ${run}: bulunan=${result.itemsFound} yeni=${result.jobsCreated} ` +
        `reddedilen=${result.itemsRejected} birikim=${captured.size}/11 ` +
        `(${result.status}${result.coverageStatus ? `, kapsam ${result.coverageStatus}` : ''})`,
    );
    for (const note of result.notes.slice(0, 4)) lines.push(`    · ${note}`);
  }

  const capturedIds = [...captured.keys()].sort();
  const expected = ['2001', '2002', '2003'];
  const missing = expected.filter((id) => !capturedIds.includes(id));
  if (missing.length > 0) {
    ok = false;
    lines.push(
      `  ✖ 2. sayfadaki ${missing.length} personel alımı ilanı HİÇBİR koşumda yakalanmadı: ${missing.join(', ')} — ` +
        'ret edilen ilanlar her koşumda detay bütçesini yutuyor (açlık).',
    );
  } else {
    lines.push(`  ✓ 2. sayfadaki 3 ilanın tamamı yakalandı (toplam ${captured.size} kayıt).`);
  }
  return { name: 'Açlık: 1. sayfa retlerle dolu, 2. sayfada gerçek ilanlar', lines, ok };
}

/**
 * Drenaj senaryosu: iki sayfada toplam 20 KABUL edilen ilan, gerçek bütçe
 * 8/koşum. 3 koşumda 8+8+4 hepsi yakalanmalı; ertelenen ilan kaybolmamalı.
 */
async function scenarioDrain(): Promise<ScenarioReport> {
  const lines: string[] = [];
  const definition = definitionFor('denetim-drenaj', 'https://ornek.test/ilanlar');
  const listingUrl = definition.listingUrl;
  const routes = (url: string): string | undefined => {
    if (url === listingUrl) return bigAcceptPage(101, 12, 1, 2);
    if (url === `${listingUrl}?page=2`) return bigAcceptPage(201, 8, 2, null);
    const detail = /\/ilanlar\/2026\/(\d+)$/.exec(url);
    if (detail) return iskurDetail(ACCEPT_TITLE(Number(detail[1])), ACCEPT_BODY);
    return undefined;
  };

  const repos = await makeRepos();
  const source = await seed(repos, definition);
  const { http } = fakeHttp(routes);
  const captured = new Set<string>();
  let ok = true;
  for (let run = 1; run <= 5; run += 1) {
    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: WORKER,
      http,
      logger: createLogger('audit', { level: 'silent' }),
      queueNotifications: false,
      liveFetch: true,
    });
    for (const link of await repos.store.find('jobSources', { sourceKey: definition.key }, {})) {
      captured.add(link.sourceItemId);
    }
    lines.push(
      `  Koşum ${run}: bulunan=${result.itemsFound} yeni=${result.jobsCreated} birikim=${captured.size}/20`,
    );
  }
  const missing: string[] = [];
  for (let id = 101; id <= 112; id += 1) if (!captured.has(String(id))) missing.push(String(id));
  for (let id = 201; id <= 208; id += 1) if (!captured.has(String(id))) missing.push(String(id));
  if (missing.length > 0) {
    ok = false;
    lines.push(`  ✖ ${missing.length} ilan hiçbir koşumda yakalanmadı: ${missing.join(', ')}`);
  } else {
    lines.push('  ✓ 20 ilanın tamamı 3 koşumda (8+8+4) yakalandı; ertelenen ilan kaybolmadı.');
  }
  return { name: 'Drenaj: bütçe aşımında ertelenen ilanlar sonraki koşumlarda tamamlanıyor', lines, ok };
}

/**
 * Sayfa keşfi: her adaptörün 2. sayfaya gerçekten geçip geçmediği, ilanları
 * oradan da alıp almadığı ve son-sayfa işaretine göre kapsam bildirdiği.
 */
async function scenarioPagination(): Promise<ScenarioReport> {
  const lines: string[] = [];
  let ok = true;

  // --- anchor-list (İŞKUR kalıbı): 2 sayfa, sayfa 2'de 2 ilan ---
  {
    const definition = definitionFor('denetim-sayfalama', 'https://ornek.test/ilanlar');
    const routes = (url: string): string | undefined => {
      if (url === definition.listingUrl) return iskurPage1(2);
      if (url === `${definition.listingUrl}?page=2`) return iskurPage2(1, 2);
      const detail = /\/ilanlar\/2026\/(\d+)$/.exec(url);
      if (detail) return iskurDetail('Ankara Üniversitesi sözleşmeli personel alım ilanı', ACCEPT_BODY);
      return undefined;
    };
    const { http, calls } = fakeHttp(routes);
    const adapter = requireAdapter('iskur-ilan-listesi');
    const result = await adapter.run({
      source: definition,
      http,
      logger: createLogger('audit', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: NOW,
      maxDetailFetches: 25,
    } as AdapterContext);
    const pages = calls.filter((url) => url.includes('/ilanlar') && !/\/ilanlar\/2026\//.test(url));
    const page2Items = result.items.filter(
      (item) => item.url.includes('/2001') || item.url.includes('/2002'),
    );
    const pass = pages.length === 2 && page2Items.length === 2 && result.coverage?.status === 'complete';
    if (!pass) ok = false;
    lines.push(
      `  ${pass ? '✓' : '✖'} anchor-list: ${pages.length} liste sayfası gezildi, ` +
        `sayfa 2'den ${page2Items.length}/2 ilan alındı, kapsam=${result.coverage?.status}`,
    );
  }

  // --- ilan.gov.tr: currentPage=N ile 3 sayfa ---
  {
    const sourceDef = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'ilan-gov-tr');
    if (!sourceDef) throw new Error('ilan.gov.tr envanterde yok');
    const row = (id: number, extra: string): string =>
      `<a href="/ilan/${id}">Kamu kurumuna ${id} sayılı ${extra} personel alım ilanı başvurusu</a>`;
    const pageHtml = (ids: number[], pageNo: number): string => {
      const rows = ids.map((id) => `<li class="ad-list-item">${row(id, 'sözleşmeli')}</li>`).join('');
      const empty = pageNo === 4 ? '<p class="no-results">Sonuç bulunamadı</p>' : '';
      return `<html><body><main><ul class="ad-list">${rows}${empty}</ul></main></body></html>`;
    };
    const routes = (url: string): string | undefined => {
      const target = new URL(url);
      const page = target.searchParams.get('currentPage');
      if (target.pathname.includes('/ilan/') && target.pathname.match(/\/ilan\/\d+/)) {
        return `<html><body><article><h1>Personel alım ilanı</h1><p>${'Sözleşmeli personel alımı başvuruları hakkında duyuru metni. '.repeat(6)}</p></article></body></html>`;
      }
      if (page === null) return pageHtml([1, 2, 3, 4, 5], 1);
      if (page === '2') return pageHtml([6, 7, 8, 9, 10], 2);
      if (page === '3') return pageHtml([11, 12, 13], 3);
      return pageHtml([], 4); // açık boş liste
    };
    const { http, calls } = fakeHttp(routes);
    const adapter = requireAdapter('ilan-gov-tr');
    const result = await adapter.run({
      source: sourceDef,
      http,
      logger: createLogger('audit', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: NOW,
      maxDetailFetches: 20,
    } as AdapterContext);
    const pageParamCalls = calls.filter((url) => url.includes('currentPage='));
    const allIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
    const found = allIds.filter((id) => result.items.some((item) => item.url.endsWith(`/ilan/${id}`)));
    const pass = pageParamCalls.length >= 3 && found.length === 13 && result.coverage?.status === 'complete';
    if (!pass) ok = false;
    lines.push(
      `  ${pass ? '✓' : '✖'} ilan.gov.tr: ${pageParamCalls.length + 1} sayfa istendi (currentPage=N), ` +
        `3 sayfadaki ${found.length}/13 ilan alındı, kapsam=${result.coverage?.status}`,
    );
  }

  // --- ÖSYM: sayfa 2 ---
  {
    const sourceDef = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'osym-duyuru');
    if (!sourceDef) throw new Error('ÖSYM envanterde yok');
    const routes = (url: string): string | undefined => {
      if (url === sourceDef.listingUrl) {
        return `<html><body><main><ul>
          <li><a href="/2026-kamu-personeli-alim-sinavi-duyurusu">2026 Kamu Personeli Alım Sınavı Duyurusu ve başvuru bilgileri</a></li>
        </ul><nav class="pagination"><a rel="next" href="?page=2">Sonraki</a></nav></main></body></html>`;
      }
      if (url.includes('page=2')) {
        return `<html><body><main><ul>
          <li><a href="/2026-uzman-yardimciligi-giris-sinavi-basvuru-klavuzu">2026 Uzman Yardımcılığı Giriş Sınavı başvuru kılavuzu yayımlandı</a></li>
        </ul><nav class="pagination"><a href="?page=1">1</a><a rel="next" aria-disabled="true" class="disabled" href="?page=3">Sonraki</a></nav></main></body></html>`;
      }
      return `<html><body><article><main><h1>Duyuru</h1><p>${'Sınav başvuruları personel alımı sürecinde adaylara duyurulmuştur. '.repeat(8)}</p></main></article></body></html>`;
    };
    const { http } = fakeHttp(routes);
    const adapter = requireAdapter('osym-duyuru');
    const result = await adapter.run({
      source: sourceDef,
      http,
      logger: createLogger('audit', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: NOW,
      maxDetailFetches: 10,
    } as AdapterContext);
    const page2 = result.items.some((item) => item.url.includes('uzman-yardimciligi'));
    const pass = result.items.length === 2 && page2 && result.coverage?.status === 'complete';
    if (!pass) ok = false;
    lines.push(
      `  ${pass ? '✓' : '✖'} ÖSYM: 2 sayfa gezildi, sayfa 2 ilanı ${page2 ? 'alındı' : 'ALINAMADI'}, kapsam=${result.coverage?.status}`,
    );
  }

  // --- SBB: sayfa 2 ---
  {
    const sourceDef = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'sbb-kamuilan');
    if (!sourceDef) throw new Error('SBB envanterde yok');
    const row = (id: number, title: string): string =>
      `<li><a href="https://kamuilan.sbb.gov.tr/ilan/${id}">${title}</a><div>Adalet Bakanlığı • İl: Ankara • 12.10.2026</div></li>`;
    const routes = (url: string): string | undefined => {
      if (url === sourceDef.listingUrl) {
        return `<html><body><main><ul>
          ${row(1, 'Zabıt Kâtibi Personel Alım İlanı Başvuru Duyurusu')}
        </ul><nav class="pagination"><a rel="next" href="?sayfa=2">Sonraki</a></nav></main></body></html>`;
      }
      if (url.includes('sayfa=2')) {
        return `<html><body><main><ul>
          ${row(2, 'Mühendis Personel Alım İlanı ve Şartları Hakkında')}
        </ul><nav class="pagination"><a href="?sayfa=1">1</a><a rel="next" aria-disabled="true" class="disabled" href="?sayfa=3">Sonraki</a></nav></main></body></html>`;
      }
      return undefined;
    };
    const { http } = fakeHttp(routes);
    const adapter = requireAdapter('sbb-kamuilan');
    const result = await adapter.run({
      source: sourceDef,
      http,
      logger: createLogger('audit', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: NOW,
      maxDetailFetches: 5,
    } as AdapterContext);
    const page2 = result.items.some((item) => item.url.includes('/ilan/2'));
    const pass = result.items.length === 2 && page2 && result.coverage?.status === 'complete';
    if (!pass) ok = false;
    lines.push(
      `  ${pass ? '✓' : '✖'} SBB: 2 sayfa gezildi, sayfa 2 ilanı ${page2 ? 'alındı' : 'ALINAMADI'}, kapsam=${result.coverage?.status}`,
    );
  }

  return { name: 'Sayfa keşfi: adaptörler 2. sayfaya geçiyor mu, o ilanları alıyor mu?', lines, ok };
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const scenarios: ScenarioReport[] = [];
  scenarios.push(await scenarioPagination());
  scenarios.push(await scenarioDrain());
  scenarios.push(await scenarioStarvation());

  let allOk = true;
  for (const scenario of scenarios) {
    console.log(`\n■ ${scenario.name}`);
    for (const line of scenario.lines) console.log(line);
    if (!scenario.ok) allOk = false;
    console.log(`  → ${scenario.ok ? 'GEÇTİ' : 'KALDI'}`);
  }
  console.log(`\nSonuç: ${allOk ? 'TÜM SENARYOLAR GEÇTİ' : 'KALAN SENARYOLAR VAR — yukarıya bakın'}`);
  console.log(
    `(Gerçek detay bütçesi: html-list=${detailFetchBudget('html-list')}/koşum, pdf-index=${detailFetchBudget('pdf-index')}/koşum)`,
  );
  process.exitCode = allOk ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
