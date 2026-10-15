/**
 * Uçtan uca: kurum duyuru sayfası → gerçek adaptör → sınıflandırma → ilan kaydı → bildirim kuyruğu.
 *
 * Sayfada dört duyuru var; yalnızca gerçek personel alımı ilan olmalı ve abonelere bildirilmeli.
 * Haber (YÖK Başkanı mesajı), öğrenci kabulü (YKS) ve süreç duyurusu (sözlü sınav çağrısı)
 * ilan olarak kaydedilmemeli / bildirim üretmemeli.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc, SourceDoc } from '../src/db/schemas';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { runSourceScrape } from '../src/ingest/pipeline';
import { hashPassword } from '../src/server/passwords';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const LISTING = 'https://www.yok.gov.tr/announcements';
const ITEMS = {
  news: 'https://www.yok.gov.tr/announcements/ozvar-sinav-uyarisi-2026',
  student: 'https://www.yok.gov.tr/announcements/yks-ek-yerlestirme-2026',
  recruitment: 'https://www.yok.gov.tr/announcements/sozlesmeli-bilisim-personeli-alimi-2026',
  process: 'https://www.yok.gov.tr/announcements/bilisim-personeli-sozlu-sinav-cagri-2026',
} as const;

const PAGES: Record<string, string> = {
  [LISTING]: `<html><body><header>Menü: Anasayfa Haberler Duyurular</header><main><ul>
    <li><a href="${ITEMS.news}">Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere sınav uyarısı</a> <span>12.10.2026</span></li>
    <li><a href="${ITEMS.student}">2026-YKS Ek Yerleştirme Tercihleri Başladı</a> <span>13.10.2026</span></li>
    <li><a href="${ITEMS.recruitment}">Sözleşmeli Bilişim Personeli Alımı İlanı</a> <span>13.10.2026</span></li>
    <li><a href="${ITEMS.process}">Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru</a> <span>14.10.2026</span></li>
  </ul></main><footer>Çerez politikası</footer></body></html>`,
  [ITEMS.news]: `<html><body><main><h1>Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere sınav uyarısı</h1>
    <p>Başkan Özvar, üniversitelerin sınav takvimine dikkat etmesi gerektiğini belirtti. Basın birimi tarafından paylaşılmıştır.</p></main></body></html>`,
  [ITEMS.student]: `<html><body><main><h1>2026-YKS Ek Yerleştirme Tercihleri Başladı</h1>
    <p>Ek yerleştirme tercihleri 13.10.2026 - 15.10.2026 tarihleri arasında alınacaktır. Öğrenci kabulü ve tercih işlemleri ÖSYM tarafından yürütülür.</p></main></body></html>`,
  [ITEMS.recruitment]: `<html><body><main><h1>Sözleşmeli Bilişim Personeli Alımı İlanı</h1>
    <p>Kadro unvanı: Bilişim Personeli. Kontenjan: 3. Görev yeri: Ankara.</p>
    <p>Başvurular 13.10.2026 - 30.10.2026 tarihleri arasında alınacaktır. Başvuru e-Devlet üzerinden yapılacaktır.</p>
    <p>Lisans mezunu olmak şartı aranır.</p></main></body></html>`,
  [ITEMS.process]: `<html><body><main><h1>Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru</h1>
    <p>Sözlü sınav 20.10.2026 tarihinde yapılacaktır. Sınava çağrılacak adayların listesi aşağıdadır. Sonuçlar sınav sonrası ilan edilecektir.</p></main></body></html>`,
};

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

function fakeHttp(): HttpClient {
  return {
    async fetchText(url: string): Promise<FetchResponse> {
      // Adres normalizasyonu (www. kaldırma) gerçek kaynak adresleriyle aynı biçimde eşlenir.
      const html = PAGES[url] ?? PAGES[url.replace('https://yok.gov.tr', 'https://www.yok.gov.tr')];
      if (html === undefined) throw new Error(`Beklenmeyen istek: ${url}`);
      return htmlResponse(url, html);
    },
    async fetchBinary(): Promise<FetchResponse> {
      throw new Error('İkili istek beklenmiyordu');
    },
    async close(): Promise<void> {
      /* ağ yok */
    },
  } as unknown as HttpClient;
}

let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-e2e-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function subscribedUser(): Promise<string> {
  const password = await hashPassword('CokGuvenliSifre123');
  const { user } = await repos.users.create({
    email: 'e2e-aday@ornek.test',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, {
    enabled: true,
    onlyNewJobs: false,
    notifyOnChanges: true,
    filters: {
      keywords: [],
      titles: [],
      institutions: [],
      cities: [],
      employmentTypes: [],
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      minDaysUntilDeadline: null,
    },
  });
  return user.id;
}

describe('uçtan uca: kurum duyuru sayfası → ilan → bildirim', () => {
  it('yalnızca gerçek personel alımı ilan olur ve yalnızca o bildirilir', async () => {
    const userId = await subscribedUser();
    const source: SourceDoc | null = await repos.sources.getByKey('yok-duyurular');
    if (!source) throw new Error('yok-duyurular kaynağı yok');

    const run = await runSourceScrape({
      repos,
      source,
      trigger: 'schedule',
      workerId: 'worker-e2e',
      http: fakeHttp(),
      logger: createLogger('e2e', { level: 'silent' }),
      queueNotifications: true,
      liveFetch: true,
    });
    expect(run.itemsFound).toBe(4);
    // Beklenen dağılım: 2 ilan/süreç kaydı (personel ilanı + süreç), 2 red (haber + öğrenci kabulü), 0 inceleme.
    expect(run.itemsAccepted).toBe(2);
    expect(run.itemsRejected).toBe(2);
    expect(run.itemsReview).toBe(0);
    expect(run.jobsCreated).toBe(2);

    const jobs = (await store.find('jobs', {})) as unknown as JobDoc[];
    const byTitle = (fragment: string) => jobs.find((job) => job.title.includes(fragment));

    // Haber ve öğrenci kabulü ilan değildir: hiçbiri kayıtlı ilan olarak yer almaz.
    expect(byTitle("Özvar'dan")).toBeUndefined();
    expect(byTitle('YKS Ek Yerleştirme')).toBeUndefined();

    // Gerçek personel alımı: ilan, doğru alanlar, kanıtlı son başvuru tarihi.
    const recruitment = byTitle('Sözleşmeli Bilişim Personeli Alımı');
    expect(recruitment).toBeDefined();
    expect(recruitment?.classification.kind).toBe('job');
    expect(recruitment?.classification.decision).toBe('accept');
    expect(recruitment?.applicationEndDate).toBe('2026-10-30');
    expect(recruitment?.city).toBe('Ankara');

    // Süreç duyurusu ayrı türdür; ilan değildir.
    const process = byTitle('Sözlü/Uygulama Sınavına');
    expect(process?.classification.kind).toBe('process');

    // Bildirim: yalnızca gerçek personel alımı için yeni-ilan olayı. Süreç için olay yok.
    const events = await repos.notifications.listEventsForUser(userId, 50);
    const jobIdsWithEvents = new Set(events.map((event) => event.jobId));
    expect(recruitment && jobIdsWithEvents.has(recruitment.id)).toBe(true);
    expect(process && jobIdsWithEvents.has(process.id)).toBe(false);
    expect(events.length).toBe(1);
  });
});
