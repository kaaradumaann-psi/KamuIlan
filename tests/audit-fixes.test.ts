/**
 * Uçtan uca denetim (2026-10-13) sırasında bulunan hataların regresyon testleri.
 *
 * Her test, GERÇEK bir olayı/hedefi sabitler:
 *  1. Geliştirme deposunun kapanışta başka sürecin kayıtlarını ezmesi (veri kaybı).
 *  2. `X-Forwarded-For` başlığına koşulsuz güvenilmesi (hız sınırı atlama).
 *  3. Girişte hesap bazlı denemenin sınırsız olması (dağıtık kaba kuvvet).
 *  4. Onaylanmamış (incelemede/reddedilmiş) ilanın kaynak ve revizyon uçlarından sızması.
 *  5. Çıkarılan "başvuru yöntemi"nin depoya yazılmaması (detayda hep "belirtilmemiş").
 *  6. Son başvuru günü BUGÜN olan ilanın gün başı damgası yüzünden "Kapandı" olması.
 *  7. Taranan içerikten gelen e-posta konusunun denetim karakteri taşıması.
 *  8. `formatDateOnly`'nin tam ISO damgasında "NaN Ekim 2026" üretmesi.
 *  9. Sayısal/özel host adresleriyle SSRF denemeleri.
 * 10. `/api/auth/logout` CSRF muafiyeti (saldırgan sayfa zorla çıkış yaptırabiliyordu).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { resetEnvCache } from '../src/config/env';
import { hashPassword } from '../src/server/passwords';
import { applyRawAnnouncement, computeStatus } from '../src/ingest/jobs-service';
import { toPublicJobDetail } from '../src/server/serializers';
import { renderEmail } from '../src/email/templates';
import { formatDateMaybeTime, formatDateOnly } from '../src/lib/format';
import { assertSafeUrl, FetchError } from '../src/sources/fetcher';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';
import type { SourceDefinition } from '../src/config/sources';

const NOW = new Date('2026-10-13T09:00:00+03:00');
const LOGGER = createLogger('audit-test', { level: 'silent' });
const CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');

const TOUCHED_ENV = ['TRUST_PROXY', 'AUTH_RATE_LIMIT_MAX_REQUESTS', 'CORS_ORIGINS'] as const;

afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
  resetEnvCache();
});

async function makeWorld(): Promise<{ repos: Repos; app: FastifyInstance; store: FileStore }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-audit-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const { hash, salt } = await hashPassword(CREDENTIAL);
  await repos.users.create({
    email: 'aday@ornek.test',
    passwordHash: hash,
    passwordSalt: salt,
    displayName: 'Aday',
    emailVerified: true,
  });
  const app = await buildApp({ repos, logger: LOGGER });
  await app.ready();
  return { repos, app, store };
}

function definition(key: string, name: string): SourceDefinition {
  return {
    key,
    name,
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Test Kurumu',
    homepageUrl: 'https://ornek.test/',
    listingUrl: 'https://ornek.test/ilanlar',
    adapterKey: 'manual-entry',
    method: 'manual-entry',
    status: 'method-defined',
    statusNote: 'regresyon testi',
    lastVerifiedAt: null,
    verificationEvidence: 'test',
    coverageNote: 'test',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 0,
    maxConcurrency: 1,
    allowedHosts: ['ornek.test'],
    conditionalRequests: false,
    tags: ['test'],
  };
}

describe('dosya deposu — kapanışta veri kaybı koruması', () => {
  it('close() sırasında başka sürecin yazdığı kayıtlar korunur', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-close-'));
    // "Süreç A": dosyayı boş hâlde okur ve hiç yazmaz (ör. salt-okuma betiği).
    const first = new FileStore(dir);
    await first.init();

    // "Süreç B": aynı dosyaya kaynak yazar (ör. `npm run seed:demo`).
    const second = new FileStore(dir);
    await second.init();
    await createRepos(second).sources.seed([definition('kaynak-b', 'B kaynağı')]);

    // A kapanırken bayat kopyasını basmamalı: B'nin kaydı diskte kalmalı.
    await first.close();

    const reader = new FileStore(dir);
    await reader.init();
    const keys = (await reader.find('sources')).map((row) => row.key);
    expect(keys).toContain('kaynak-b');
  });
});

describe('istemci IP güveni (X-Forwarded-For)', () => {
  it('varsayılanda XFF yok sayılır: farklı sahte IP başlıkları aynı kovayı paylaşır', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '3';
    resetEnvCache();
    const { app, store } = await makeWorld();

    const responses = [];
    for (let index = 0; index < 4; index += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': `10.0.0.${index + 1}` },
          payload: { email: `deneme-${index}@ornek.test`, password: CREDENTIAL },
        }),
      );
    }
    expect(responses.slice(0, 3).every((response) => response.statusCode === 401)).toBe(true);
    expect(responses[3]?.statusCode).toBe(429);

    await app.close();
    await store.close();
  });

  it('doğrulama/sıfırlama istekleri hesap bazlı sınırlanır (posta bombardımanı engeli)', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '3';
    resetEnvCache();
    const { app, store } = await makeWorld();

    const responses = [];
    for (let index = 0; index < 4; index += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/api/auth/resend-verification',
          headers: { 'x-forwarded-for': `198.51.100.${index + 1}` },
          payload: { email: 'aday@ornek.test' },
        }),
      );
    }
    expect(responses.slice(0, 3).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[3]?.statusCode).toBe(429);

    await app.close();
    await store.close();
  });

  it('giriş hesap bazlı da sınırlanır: IP değişse bile aynı e-posta kilitlenir', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '3';
    resetEnvCache();
    const { app, store } = await makeWorld();

    const responses = [];
    for (let index = 0; index < 4; index += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': `10.0.1.${index + 1}` },
          payload: { email: 'aday@ornek.test', password: 'Yanlis-Parola-2026' },
        }),
      );
    }
    expect(responses.slice(0, 3).every((response) => response.statusCode === 401)).toBe(true);
    expect(responses[3]?.statusCode).toBe(429);

    await app.close();
    await store.close();
  });

  it('TRUST_PROXY=1 iken (vekil arkasında) başlık dikkate alınır', async () => {
    process.env.TRUST_PROXY = '1';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '2';
    resetEnvCache();
    const { app, store } = await makeWorld();

    const same = [];
    for (let index = 0; index < 3; index += 1) {
      same.push(
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': '203.0.113.7' },
          payload: { email: `vekil-${index}@ornek.test`, password: CREDENTIAL },
        }),
      );
    }
    expect(same[2]?.statusCode).toBe(429);

    // Farklı gerçek istemci kendi kovasına sahiptir.
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.8' },
      payload: { email: 'vekil-diger@ornek.test', password: CREDENTIAL },
    });
    expect(other.statusCode).toBe(401);

    await app.close();
    await store.close();
  });
});

describe('herkese açık ilan uçları', () => {
  it('kabul edilmemiş ilanın kaynakları ve revizyonları 404 döner', async () => {
    const { app, repos, store } = await makeWorld();
    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'audit-test',
      provenance: 'sample',
    });
    expect(outcome.action).toBe('created');
    const jobId = outcome.jobId as string;
    const job = await repos.jobs.findById(jobId);
    expect(job).toBeTruthy();

    // Kabul edilmiş ilan görünür…
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/sources` })).statusCode).toBe(200);

    // …karar "review"a dönerse (ör. yönetici yeniden incelerken) yayımlanmaz.
    await repos.jobs.updateJob(jobId, {
      classification: { ...job!.classification, decision: 'review' },
    });
    const sources = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/sources` });
    const revisions = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/revisions` });
    const detail = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(sources.statusCode).toBe(404);
    expect(revisions.statusCode).toBe(404);
    expect(detail.statusCode).toBe(404);

    await app.close();
    await store.close();
  });

  it('reddedilen ilan arama sonuçlarında da görünmez', async () => {
    const { app, repos, store } = await makeWorld();
    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'audit-test',
      provenance: 'sample',
    });
    const jobId = outcome.jobId as string;
    const job = await repos.jobs.findById(jobId);
    await repos.jobs.updateJob(jobId, {
      classification: { ...job!.classification, decision: 'reject' },
    });
    const list = await app.inject({ method: 'GET', url: '/api/jobs' });
    const body = list.json() as { items: { id: string }[]; total: number };
    expect(body.items.some((item) => item.id === jobId)).toBe(false);

    await app.close();
    await store.close();
  });
});

describe('başvuru yöntemi ve durum hesabı', () => {
  it('metinden okunan başvuru yöntemi kaydedilir ve detayda görünür', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-method-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    await repos.sources.seed();
    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'audit-test',
      provenance: 'sample',
    });
    const job = await repos.jobs.findById(outcome.jobId as string);
    expect(job?.applicationMethod).toContain('Kariyer Kapısı');

    const detail = toPublicJobDetail(job!, { sources: [], now: NOW });
    expect(detail.applicationMethod).toContain('Kariyer Kapısı');
    await store.close();
  });

  it('son başvuru günü bugün olan ilan gün boyu "açık" kalır', () => {
    // Çıkarım motoru saati bilinmeyen tarihlerde 00:00 yazar. Bu damga "geçmiş"
    // sayılırsa son gün gelen aday ilanı kapalı görür.
    const status = computeStatus({
      applicationStartAt: '2026-10-01T00:00:00+03:00',
      applicationEndAt: '2026-10-13T00:00:00+03:00',
      applicationEndDate: '2026-10-13',
      now: new Date('2026-10-13T09:00:00+03:00'),
    });
    expect(status).toBe('active');
  });

  it('metinde açıkça yazılmış geçmiş saat kapanış sayılır', () => {
    const status = computeStatus({
      applicationStartAt: '2026-10-01T09:00:00+03:00',
      applicationEndAt: '2026-10-13T09:00:00+03:00',
      applicationEndDate: '2026-10-13',
      now: new Date('2026-10-13T12:00:00+03:00'),
    });
    expect(status).toBe('closed');
  });

  it('son başvuru günü geçmişse kapanır', () => {
    expect(
      computeStatus({
        applicationStartAt: null,
        applicationEndAt: '2026-10-10T23:59:00+03:00',
        applicationEndDate: '2026-10-10',
        now: NOW,
      }),
    ).toBe('closed');
  });
});

describe('e-posta konusu', () => {
  it('taranan içerikten gelen denetim karakterleri temizlenir', () => {
    const rendered = renderEmail(
      'new-job',
      {
        title: 'Örnek İlan\r\nBcc: saldirgan@ornek.test',
        institution: 'Örnek Kurum',
        employmentType: 'kadrolu',
        city: 'Ankara',
        district: null,
        quota: 3,
        applicationEndAt: null,
        applicationEndDate: '2026-10-30',
        detailUrl: 'https://ornek.test/ilan/1',
        matchedOn: [],
      },
      { baseUrl: 'https://kamuilan.test', senderName: 'Kamuİlan' },
    );
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject).toContain('Bcc: saldirgan@ornek.test');
  });
});

describe('tarih biçimlendirme', () => {
  it('tam ISO damgası "NaN Ekim 2026" üretmez', () => {
    expect(formatDateOnly('2026-10-30T00:00:00+03:00')).toBe('30 Ekim 2026');
    expect(formatDateOnly('2026-10-30')).toBe('30 Ekim 2026');
    // Gece yarısı UTC damgası İstanbul'da ertesi gündür → gün kaymaz.
    expect(formatDateOnly('2026-10-29T21:30:00Z')).toBe('30 Ekim 2026');
  });

  it('saat bilinmiyorsa (00:00) yalnızca gün gösterilir', () => {
    expect(formatDateMaybeTime('2026-10-30T00:00:00+03:00')).toBe('30 Ekim 2026');
    expect(formatDateMaybeTime('2026-10-30T17:00:00+03:00')).toContain('17:00');
  });
});

describe('kaynak adresi güvenliği (SSRF)', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:3000/',
    'file:///etc/passwd',
  ])('%s reddedilir', (url) => {
    expect(() => assertSafeUrl(url, [])).toThrow(FetchError);
  });

  it('beyaz listedeki alan adı kabul edilir', () => {
    expect(assertSafeUrl('https://www.ilan.gov.tr/ilanlar', ['ilan.gov.tr']).hostname).toBe(
      'www.ilan.gov.tr',
    );
  });
});

describe('API yüzeyi ve başlıklar', () => {
  it('güvenlik başlıkları her cevapta vardır', async () => {
    const { app, store } = await makeWorld();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    const csp = String(response.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    await app.close();
    await store.close();
  });

  it('CORS varsayılanda kapalıdır; yalnızca CORS_ORIGINS listesi açabilir', async () => {
    const { app, store } = await makeWorld();
    const closed = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { origin: 'https://kotu-site.example' },
    });
    expect(closed.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
    await store.close();

    process.env.CORS_ORIGINS = 'https://panel.ornek.test';
    resetEnvCache();
    const { app: openApp, store: openStore } = await makeWorld();
    const allowed = await openApp.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { origin: 'https://panel.ornek.test' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://panel.ornek.test');
    const denied = await openApp.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { origin: 'https://kotu-site.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    delete process.env.CORS_ORIGINS;
    resetEnvCache();
    await openApp.close();
    await openStore.close();
  });

  it('statik varlıklar damgalı önbellek, HTML tazeleme alır', async () => {
    const { staticCacheHeaders } = await import('../src/server/context');
    expect(staticCacheHeaders('/assets/index-a1b2c3.js')['cache-control']).toContain('immutable');
    expect(staticCacheHeaders('/assets/index-a1b2c3.css')['cache-control']).toContain('immutable');
    expect(staticCacheHeaders('/index.html')['cache-control']).toBe('no-cache');
  });

  it('OpenAPI arayüzü geliştirme ortamında açıktır (üretimde varsayılan kapalı)', async () => {
    const { app, store } = await makeWorld();
    const docs = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(docs.statusCode).toBe(200);
    await app.close();
    await store.close();
  });
});

describe('arama güvenliği (ReDoS / regex enjeksiyonu)', () => {
  it('arama dizesi düz metin olarak işlenir; bozuk desen isteği çökertmez', async () => {
    const { app, repos, store } = await makeWorld();
    await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'audit-test',
      provenance: 'sample',
    });

    const hostile = ['(((((((a)+)+)+)+)+)+', 'hemşire.*', '[abc', 'a{1,99999}', '.*.*.*.*.*'];
    for (const q of hostile) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/jobs?q=${encodeURIComponent(q)}`,
      });
      expect(response.statusCode, q).toBe(200);
    }

    // Düz metin araması çalışmaya devam eder.
    const found = await app.inject({ method: 'GET', url: '/api/jobs?q=hemşire' });
    expect(found.statusCode).toBe(200);
    expect((found.json() as { total: number }).total).toBeGreaterThan(0);

    // `%` gibi karakterler joker DEĞİLDİR (kullanıcı ne yazdıysa o aranır).
    const literal = await app.inject({ method: 'GET', url: '/api/jobs?q=%25' });
    expect(literal.statusCode).toBe(200);
    expect((literal.json() as { total: number }).total).toBe(0);

    await app.close();
    await store.close();
  });
});

describe('CSRF — çıkış ucu da korunur', () => {
  it('oturum varken başlıksız çıkış isteği 403 döner, oturum kapanmaz', async () => {
    const { app, store } = await makeWorld();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'aday@ornek.test', password: CREDENTIAL },
    });
    expect(loginResponse.statusCode).toBe(200);
    const csrf = (loginResponse.json() as { csrfToken: string }).csrfToken;
    const sessionCookie = (loginResponse.cookies as { name: string; value: string }[]).find(
      (cookie) => cookie.name === 'kamuilan_session',
    )?.value;
    const csrfCookie = (loginResponse.cookies as { name: string; value: string }[]).find(
      (cookie) => cookie.name === 'kamuilan_csrf',
    )?.value;
    expect(sessionCookie).toBeTruthy();

    // Saldırgan sayfa senaryosu: çerezler gider, `x-csrf-token` başlığı YOK.
    const withoutToken = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { kamuilan_session: sessionCookie ?? '', kamuilan_csrf: csrfCookie ?? '' },
    });
    expect(withoutToken.statusCode).toBe(403);

    // Oturum hâlâ geçerlidir: zorla çıkış gerçekleşmedi.
    const stillIn = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { kamuilan_session: sessionCookie ?? '' },
    });
    expect((stillIn.json() as { authenticated: boolean }).authenticated).toBe(true);

    // Arayüzün yaptığı gibi başlık gönderilirse çıkış çalışır.
    const withToken = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { kamuilan_session: sessionCookie ?? '', kamuilan_csrf: csrfCookie ?? '' },
      headers: { 'x-csrf-token': csrf },
    });
    expect(withToken.statusCode).toBe(200);

    await app.close();
    await store.close();
  });
});
