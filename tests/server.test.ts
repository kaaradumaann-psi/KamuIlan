/**
 * API ve güvenlik testleri (§13, §14, §17).
 *
 * Kapsanan garantiler:
 *  - Hata biçimi standart; bilinmeyen kayıt 404 döner (stack sızmaz).
 *  - Güvenlik başlıkları her yanıtta vardır.
 *  - Kayıt → doğrulama → oturum akışı; doğrulanmamış kullanıcı bildirim almaz.
 *  - Oturum olmadan korumalı uçlar 401; CSRF başlığı olmadan yazan istekler 403.
 *  - Kullanıcılar birbirinin verisini göremez (izolasyon).
 *  - Yönetici uçları RBAC ile korunur; kararlar denetim kaydına yazılır.
 *  - Tekilleştirme birleştirmesi yalnızca yönetici onayıyla ve kaynak
 *    bağlantıları korunarak yapılır.
 *  - Hız sınırı aşılırsa 429 + `retry-after` döner.
 *
 * Hiçbir test gerçek kaynağa/ağa istek atmaz.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock, type Clock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { resetEnvCache } from '../src/config/env';
import { hashPassword } from '../src/server/passwords';
import { buildApp } from '../src/server/app';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { ihaleIlani, sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const LOGGER = createLogger('api-test', { level: 'silent' });
const SOURCE_KEY = 'test-kaynak';

interface World {
  store: FileStore;
  repos: Repos;
  clock: Clock & { advance(ms: number): void };
  app: FastifyInstance;
}

let world: World;
/** API testleri için tohumlanan iki ayrı kabul edilmiş ilan. */
const seeded: { firstJobId: string; secondJobId: string } = { firstJobId: '', secondJobId: '' };

/** Kullanıcı oluşturur (repoyu doğrudan kullanır: HTTP akışı ayrı test edilir). */
async function createUser(
  repos: Repos,
  input: { email: string; password: string; role?: 'user' | 'admin'; verified?: boolean },
): Promise<string> {
  const { hash, salt } = await hashPassword(input.password);
  const result = await repos.users.create({
    email: input.email,
    passwordHash: hash,
    passwordSalt: salt,
    displayName: input.email.split('@')[0] ?? 'Test',
    ...(input.role ? { role: input.role } : {}),
    emailVerified: input.verified ?? true,
  });
  await repos.notifications.upsertPreference(result.user.id, { filters: {} });
  return result.user.id;
}

/** Giriş yapıp çerez/CSRF bilgisini döner. */
async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ session: string; csrf: string; userId: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { user: { id: string }; csrfToken: string };
  const cookies = response.cookies as { name: string; value: string }[];
  const session = cookies.find((cookie) => cookie.name === 'kamuradar_session')?.value ?? '';
  expect(session.length).toBeGreaterThan(20);
  return { session, csrf: body.csrfToken, userId: body.user.id };
}

beforeAll(async () => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuradar-api-')));
  await store.init();
  const clock = fixedClock(NOW);
  const repos = createRepos(store, clock);
  await repos.sources.seed();

  // Gerçekçi bir kabul edilmiş ilan (fixture) — 'sample' kaynağı işaretlenir.
  const first = await applyRawAnnouncement(sozlesmeliPersonelIlani({ sourceKey: SOURCE_KEY }), {
    repos,
    now: NOW,
    workerId: 'api-test',
    provenance: 'sample',
  });
  // Farklı kurum + farklı dönem: ayrı bir ilan olarak kalır (otomatik birleşme yok).
  const second = await applyRawAnnouncement(
    sozlesmeliPersonelIlani({
      sourceKey: SOURCE_KEY,
      sourceItemId: 'ORNEK-2026-0009',
      url: 'https://ornek.test/ilanlar/ORNEK-2026-0009',
      title: 'Örnek Belediyesi Başkanlığından: Zabıta Memuru Alım İlanı',
      institution: 'Örnek Belediyesi Başkanlığı',
      bodyText: `
Örnek Belediyesi Başkanlığından:
Belediyemiz bünyesinde 657 sayılı Devlet Memurları Kanunu'na tabi kadrolu zabıta memuru alımı yapılacaktır.
Kontenjan: 12 kişi.
Başvuru şartları: Lise mezunu olmak, 2026 yılı KPSS (P94) puanına sahip olmak, 18 yaşını doldurmuş olmak.
Başvurular 02.11.2026 tarihinde saat 09:00'da başlayacak olup 11.11.2026 tarihinde saat 23:59'da sona erecektir.
Başvurular Kariyer Kapısı üzerinden elektronik ortamda alınacaktır.
`,
      rawExcerpt: 'Örnek Belediyesi kadrolu zabıta memuru alımı, kontenjan 12',
    }),
    { repos, now: NOW, workerId: 'api-test', provenance: 'sample' },
  );
  expect(first.jobId).toBeTruthy();
  expect(second.jobId).toBeTruthy();
  expect(second.jobId).not.toBe(first.jobId);
  seeded.firstJobId = first.jobId as string;
  seeded.secondJobId = second.jobId as string;
  // İhale ilanı: reddedilir, kullanıcıya gösterilmez.
  await applyRawAnnouncement(ihaleIlani({ sourceKey: SOURCE_KEY }), {
    repos,
    now: NOW,
    workerId: 'api-test',
    provenance: 'sample',
  });

  // Yönetici onayı gerektiren tekilleştirme kaydı (iki ayrı ilan).
  await repos.review.enqueue({
    kind: 'dedupe',
    sourceKey: SOURCE_KEY,
    title: 'Olası aynı ilan',
    url: 'https://ornek.test/ilanlar/ORNEK-2026-0009',
    reason: 'Benzer başlık + aynı kurum; otomatik birleştirme yapılmadı.',
    confidence: 0.62,
    payload: {},
    candidateJobIds: [seeded.firstJobId, seeded.secondJobId],
  });

  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
  await app.ready();
  world = { store, repos, clock, app };
});

afterAll(async () => {
  await world.app.close();
  await world.store.close();
});

describe('sağlık ve güvenlik başlıkları', () => {
  it('health gerçek ölçümleri döner, güvenlik başlıkları ekli', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      database: { healthy: boolean; driver: string };
      scans: { totalRuns: number };
      sources: { total: number };
      warnings: string[];
    };
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.database.healthy).toBe(true);
    expect(body.database.driver).toBe('file');
    expect(body.scans.totalRuns).toBeGreaterThanOrEqual(0);
    expect(body.sources.total).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(response.headers['x-frame-options']).toBeTruthy();
  });

  it('bilinmeyen uç standart hata gövdesi döner', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/bulunmayan-uc' });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string; message: string; requestId?: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('bulunamadı');
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});

describe('ilan uçları', () => {
  it('yalnızca kabul edilen ilanlar listelenir, filtre ve sayfalama çalışır', async () => {
    const all = await world.app.inject({ method: 'GET', url: '/api/jobs?pageSize=50' });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { items: { id: string; title: string }[]; total: number; pages: number };
    expect(allBody.total).toBeGreaterThanOrEqual(2);
    expect(allBody.items.every((item) => !/ihale/i.test(item.title))).toBe(true);

    const filtered = await world.app.inject({ method: 'GET', url: '/api/jobs?city=Ankara&pageSize=50' });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { items: { city: string | null }[] };
    for (const item of filteredBody.items) expect(item.city).toBe('Ankara');

    const paged = await world.app.inject({ method: 'GET', url: '/api/jobs?pageSize=1&page=1&sort=deadline' });
    const pagedBody = paged.json() as { items: unknown[]; pageSize: number; pages: number };
    expect(pagedBody.pageSize).toBe(1);
    expect(pagedBody.items).toHaveLength(Math.min(1, allBody.total));
    expect(pagedBody.pages).toBeGreaterThanOrEqual(1);
  });

  it('geçersiz filtre 400 validation_error döner', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/jobs?page=0' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.some((issue) => issue.path === 'page')).toBe(true);
  });

  it('ilan detayı alan kaynaklarını, kaynak bağlantılarını ve belirsizlikleri içerir', async () => {
    const list = await world.app.inject({ method: 'GET', url: '/api/jobs?pageSize=50' });
    const job = (list.json() as { items: { id: string }[] }).items[0];
    expect(job).toBeTruthy();
    const detail = await world.app.inject({ method: 'GET', url: `/api/jobs/${job?.id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      id: string;
      provenance: string;
      sources: { sourceKey: string; url: string; active: boolean }[];
      fieldSources: Record<string, { kind: string }>;
      uncertainties: string[];
      criticalMissingFields: string[];
      applicationEndDate: string | null;
    };
    expect(body.provenance).toBe('sample');
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources[0]?.url).toContain('https://');
    expect(Object.keys(body.fieldSources).length).toBeGreaterThan(0);
    expect(Array.isArray(body.uncertainties)).toBe(true);
    expect(body.applicationEndDate).toBe('2026-10-30');

    const missing = await world.app.inject({ method: 'GET', url: '/api/jobs/job_yok123' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('kaynak şeffaflığı', () => {
  it('kapsam listesi doğrulanan ve planlanan kaynakları birlikte gösterir', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/sources' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sources: { key: string; enabled: boolean; verified: boolean }[];
      planned: { id: string }[];
      summary: { total: number; verified: number; planned: number };
      disclaimer: string;
    };
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.planned.length).toBeGreaterThan(0);
    expect(body.summary.planned).toBe(body.planned.length);
    expect(body.disclaimer).toContain('eksiksiz değildir');
  });
});

describe('kimlik akışı', () => {
  it('kayıt doğrulama e-postası kuyruğa alır, zayıf parola reddedilir', async () => {
    const weak = await world.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'zayif@ornek.test', password: 'parola', consent: true },
    });
    expect(weak.statusCode).toBe(400);

    const noConsent = await world.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'onaysiz@ornek.test', password: 'Guclu-Parola-2026', consent: false },
    });
    expect(noConsent.statusCode).toBe(400);

    const ok = await world.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'yeni@ornek.test', password: 'Guclu-Parola-2026', consent: true },
    });
    expect(ok.statusCode).toBe(201);
    const outbox = await world.repos.outbox.list({ status: 'pending' }, 20);
    const verification = outbox.find((item) => item.kind === 'email-verification' && item.toEmail === 'yeni@ornek.test');
    expect(verification).toBeTruthy();
    const token = String((verification?.payload as { verifyUrl: string }).verifyUrl).split('token=')[1] as string;

    const verified = await world.app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } });
    expect(verified.statusCode).toBe(200);
    const reused = await world.app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } });
    expect(reused.statusCode).toBe(400);

    const user = await world.repos.users.findByEmail('yeni@ornek.test');
    expect(user?.emailVerified).toBe(true);
    // Doğrulanmış ama şifre düz metin saklanmaz.
    expect(user?.passwordHash).not.toContain('Guclu-Parola-2026');
  });

  it('oturum çerezi olmadan korumalı uçlar 401, CSRF olmadan yazan istek 403', async () => {
    const anonymous = await world.app.inject({ method: 'GET', url: '/api/notifications/preferences' });
    expect(anonymous.statusCode).toBe(401);

    const userId = await createUser(world.repos, { email: 'csrf@ornek.test', password: 'Guclu-Parola-2026' });
    expect(userId).toBeTruthy();
    const session = await login(world.app, 'csrf@ornek.test', 'Guclu-Parola-2026');

    const withoutCsrf = await world.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      payload: { enabled: true },
      cookies: { kamuradar_session: session.session, kamuradar_csrf: session.csrf },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect((withoutCsrf.json() as { error: { message: string } }).error.message).toContain('CSRF');

    const withCsrf = await world.app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      payload: { enabled: true, filters: { cities: ['Ankara'] } },
      cookies: { kamuradar_session: session.session, kamuradar_csrf: session.csrf },
      headers: { 'x-csrf-token': session.csrf },
    });
    expect(withCsrf.statusCode).toBe(200);
    const preference = await world.repos.notifications.getPreference(session.userId);
    expect(preference?.enabled).toBe(true);
    expect(preference?.filters.cities).toContain('Ankara');
  });

  it('doğrulanmamış kullanıcı bildirim açamaz ve test e-postası gönderemez', async () => {
    const userId = await createUser(world.repos, { email: 'dogrulanmamis@ornek.test', password: 'Guclu-Parola-2026', verified: false });
    const session = await login(world.app, 'dogrulanmamis@ornek.test', 'Guclu-Parola-2026');
    const preferences = await world.app.inject({
      method: 'GET',
      url: '/api/notifications/preferences',
      cookies: { kamuradar_session: session.session },
    });
    const body = preferences.json() as { canReceive: boolean; notice: string | null };
    expect(body.canReceive).toBe(false);
    expect(body.notice).toContain('doğrulamadan');

    const testEmail = await world.app.inject({
      method: 'POST',
      url: '/api/notifications/test-email',
      payload: {},
      cookies: { kamuradar_session: session.session, kamuradar_csrf: session.csrf },
      headers: { 'x-csrf-token': session.csrf },
    });
    expect(testEmail.statusCode).toBe(403);
    expect(userId).toBeTruthy();
  });
});

describe('yetkilendirme ve izolasyon', () => {
  it('kullanıcı yalnızca kendi bildirim geçmişini görür', async () => {
    await createUser(world.repos, { email: 'alice@ornek.test', password: 'Guclu-Parola-2026' });
    const bobId = await createUser(world.repos, { email: 'bob@ornek.test', password: 'Guclu-Parola-2026' });
    const job = await world.repos.jobs.search({}, { pageSize: 1 });
    const jobId = job.items[0]?.id as string;
    await world.repos.notifications.recordEvent({ userId: bobId, jobId, kind: 'new-job', jobVersion: 1, matchedOn: ['şehir: Ankara'] });

    const alice = await login(world.app, 'alice@ornek.test', 'Guclu-Parola-2026');
    const aliceHistory = await world.app.inject({
      method: 'GET',
      url: '/api/notifications/history',
      cookies: { kamuradar_session: alice.session },
    });
    expect(aliceHistory.statusCode).toBe(200);
    expect((aliceHistory.json() as { events: unknown[] }).events).toHaveLength(0);

    const bob = await login(world.app, 'bob@ornek.test', 'Guclu-Parola-2026');
    const bobHistory = await world.app.inject({
      method: 'GET',
      url: '/api/notifications/history',
      cookies: { kamuradar_session: bob.session },
    });
    expect((bobHistory.json() as { events: { jobId: string }[] }).events[0]?.jobId).toBe(jobId);

    // Alice, Bob'un kimliğiyle hiçbir uca erişemez (kimlik parametresi yoktur zaten).
    expect(alice.userId).not.toBe(bob.userId);
  });

  it('yönetici uçları RBAC ile korunur', async () => {
    await createUser(world.repos, { email: 'sade@ornek.test', password: 'Guclu-Parola-2026' });
    const normal = await login(world.app, 'sade@ornek.test', 'Guclu-Parola-2026');
    const forbidden = await world.app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      cookies: { kamuradar_session: normal.session },
    });
    expect(forbidden.statusCode).toBe(403);

    await createUser(world.repos, { email: 'yonetici@ornek.test', password: 'Guclu-Parola-2026', role: 'admin' });
    const admin = await login(world.app, 'yonetici@ornek.test', 'Guclu-Parola-2026');
    const overview = await world.app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      cookies: { kamuradar_session: admin.session },
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json() as { jobs: { total: number }; workers: unknown[]; workerWarning: string | null; auditEntries: number };
    expect(body.jobs.total).toBeGreaterThan(0);
    expect(Array.isArray(body.workers)).toBe(true);
    expect(body.workerWarning).toContain('Worker');
  });
});

describe('inceleme kuyruğu kararı', () => {
  it('tekilleştirme birleştirmesi yalnızca yönetici kararıyla ve kaynaklar korunarak yapılır', async () => {
    await createUser(world.repos, { email: 'yonetici2@ornek.test', password: 'Guclu-Parola-2026', role: 'admin' });
    const admin = await login(world.app, 'yonetici2@ornek.test', 'Guclu-Parola-2026');

    const queue = await world.app.inject({
      method: 'GET',
      url: '/api/admin/review-queue?kind=dedupe',
      cookies: { kamuradar_session: admin.session },
    });
    expect(queue.statusCode).toBe(200);
    const items = (queue.json() as { items: { id: string; candidateJobIds: string[] }[] }).items;
    const item = items.find((candidate) => candidate.candidateJobIds.includes(seeded.firstJobId));
    expect(item).toBeTruthy();
    expect(item?.candidateJobIds).toHaveLength(2);
    const [targetId, duplicateId] = item?.candidateJobIds as string[];
    const linksBefore = await world.repos.jobs.listSourceLinks(duplicateId as string);

    const resolved = await world.app.inject({
      method: 'POST',
      url: `/api/admin/review-queue/${item?.id}/resolve`,
      payload: { action: 'merge', note: 'Aynı ilanın iki kaynak kaydı.' },
      cookies: { kamuradar_session: admin.session, kamuradar_csrf: admin.csrf },
      headers: { 'x-csrf-token': admin.csrf },
    });
    expect(resolved.statusCode).toBe(200);
    const result = resolved.json() as { mergeResult: { mergedJobId: string } | null };
    expect(result.mergeResult?.mergedJobId).toBe(targetId);

    const targetLinks = await world.repos.jobs.listSourceLinks(targetId as string);
    expect(targetLinks.length).toBeGreaterThanOrEqual(linksBefore.length);
    const duplicate = await world.repos.jobs.findById(duplicateId as string);
    expect(duplicate?.status).toBe('closed');
    const revisions = await world.repos.jobs.listRevisions(targetId as string);
    expect(revisions.some((revision) => revision.summary.includes('birleştirildi'))).toBe(true);

    // Denetim kaydı zorunlu.
    const auditLogs = await world.repos.audit.list(20, 'admin.review-resolved');
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(auditLogs[0]?.actorRole).toBe('admin');
  });
});

describe('hız sınırlama', () => {
  it('kimlik uçlarında sınır aşılırsa 429 ve retry-after döner', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '3';
    resetEnvCache();
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuradar-rate-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    const app = await buildApp({ repos, logger: LOGGER });
    await app.ready();

    const attempts = [];
    for (let index = 0; index < 4; index += 1) {
      attempts.push(
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'yok@ornek.test', password: 'Guclu-Parola-2026' },
        }),
      );
    }
    expect(attempts.slice(0, 3).every((response) => response.statusCode === 401)).toBe(true);
    const limited = attempts[3];
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers['retry-after']).toBeTruthy();
    expect((limited?.json() as { error: { code: string } }).error.code).toBe('rate_limited');

    await app.close();
    await store.close();
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '';
    resetEnvCache();
  });
});
