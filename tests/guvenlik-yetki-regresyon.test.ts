/**
 * Güvenlik denetimi (2026-10-15) — kırık erişim denetimi regresyonları.
 *
 * Bulgu: Fastify (find-my-way) yüzde kodlu yolları çözüp rotayla eşleştirirken
 * `request.url` ham kalır. Yönetici RBAC kancası `request.url.startsWith('/api/admin')`
 * ile karar verdiği için `GET /%61pi/admin/overview` isteği OTURUMSUZ olarak 200 ve
 * yönetici panosunu döndürüyordu (ölçüldü: appVersion/versions/kaynak kapsamları/
 * inceleme kuyruğu/denetim kayıtları sızdı). Aynı sınıf, sıkı kimlik hız sınırı
 * kovasını da atlatıyordu (`/%61pi/auth/login` genel kovaya düşüyordu).
 *
 * Çözüm: ön ek kararları eşleşen ROTADAN (`request.routeOptions.url`) ve gerekirse
 * kodu çözülmüş ham yoldan verilir; ayrıca her yönetici GET işleyicisi kendi
 * `requireAdmin` çağrısını yapar (savunma katmanı).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp, staticDistRoot } from '../src/server/app';
import { resetEnvCache } from '../src/config/env';
import { hashPassword } from '../src/server/passwords';

const NOW = new Date('2026-10-15T09:00:00+03:00');
const LOGGER = createLogger('guvenlik-test', { level: 'silent' });
const CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');
const TOUCHED_ENV = ['AUTH_RATE_LIMIT_MAX_REQUESTS', 'RATE_LIMIT_MAX_REQUESTS', 'TRUST_PROXY'] as const;

/** Yönetici uçlarına giden, rotayla eşleşen ama ham ön ekle eşleşmeyen yollar. */
const ENCODED_ADMIN_PATHS = [
  '/%61pi/admin/overview', // "a" → %61
  '/api%2fadmin/overview', // "/" → %2f
  '/%61pi/admin/sources',
  '/%61pi/admin/audit',
];
const PLAIN_ADMIN_PATHS = ['/api/admin/overview', '/api/admin/sources', '/api/admin/audit'];

let openStores: FileStore[] = [];
let openApps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps) await app.close();
  for (const store of openStores) await store.close();
  openApps = [];
  openStores = [];
  for (const key of TOUCHED_ENV) delete process.env[key];
  resetEnvCache();
});

async function makeWorld(options: { rateLimit?: boolean } = {}): Promise<{ repos: Repos; app: FastifyInstance }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-guvenlik-')));
  await store.init();
  openStores.push(store);
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: options.rateLimit === false });
  openApps.push(app);
  return { repos, app };
}

async function createUser(repos: Repos, email: string, role: 'admin' | 'user'): Promise<void> {
  const { hash, salt } = await hashPassword(CREDENTIAL);
  await repos.users.create({
    email,
    passwordHash: hash,
    passwordSalt: salt,
    displayName: role === 'admin' ? 'Yönetici' : 'Aday',
    role,
    emailVerified: true,
  });
}

async function login(app: FastifyInstance, email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: CREDENTIAL } });
  expect(res.statusCode, res.body).toBe(200);
  const cookies = res.cookies as { name: string; value: string }[];
  const session = cookies.find((item) => item.name === 'kamuilan_session')?.value ?? '';
  const csrf = cookies.find((item) => item.name === 'kamuilan_csrf')?.value ?? '';
  return { cookie: `kamuilan_session=${session}; kamuilan_csrf=${csrf}`, csrf };
}

function leakedAdminPayload(statusCode: number, body: string): boolean {
  return statusCode === 200 && /appVersion|"versions"|coverage|reviewCounts/.test(body);
}

describe('yönetici uçları URL kodlamasıyla atlatılamaz', () => {
  it('oturumsuz istek hiçbir yoldan yönetici verisi alamaz', async () => {
    const { app } = await makeWorld({ rateLimit: false });
    for (const url of [...PLAIN_ADMIN_PATHS, ...ENCODED_ADMIN_PATHS]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} → ${res.body}`).toBe(401);
      expect(leakedAdminPayload(res.statusCode, res.body), url).toBe(false);
    }
  });

  it('yönetici olmayan kullanıcı kodlanmış yolda da 403 alır', async () => {
    const { repos, app } = await makeWorld({ rateLimit: false });
    await createUser(repos, 'aday@ornek.test', 'user');
    const { cookie } = await login(app, 'aday@ornek.test');
    for (const url of [...PLAIN_ADMIN_PATHS, ...ENCODED_ADMIN_PATHS]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, `${url} → ${res.body}`).toBe(403);
      expect(leakedAdminPayload(res.statusCode, res.body), url).toBe(false);
    }
  });

  it('yönetici düz yolda erişir (kural meşru erişimi bozmaz)', async () => {
    const { repos, app } = await makeWorld({ rateLimit: false });
    await createUser(repos, 'yonetici@ornek.test', 'admin');
    const { cookie } = await login(app, 'yonetici@ornek.test');
    const res = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { appVersion: string }).appVersion).toBeTruthy();
  });

  it('yönetici uçları işleyici düzeyinde de korunur (savunma katmanı)', async () => {
    const { repos, app } = await makeWorld({ rateLimit: false });
    await createUser(repos, 'aday2@ornek.test', 'user');
    const { cookie } = await login(app, 'aday2@ornek.test');
    // Değiştiren uçlar zaten requireAdmin çağırıyordu; okuma uçları da çağırmalı.
    for (const url of ['/api/admin/overview', '/%61pi/admin/overview']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, `${url} → ${res.body}`).toBe(403);
    }
  });
});

describe('sıkı kimlik hız sınırı kodlanmış yolda da uygulanır', () => {
  it('/%61pi/auth/login genel kovaya düşmez, sıkı kovada sınırlanır', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_MAX_REQUESTS = '50';
    resetEnvCache();
    const { app } = await makeWorld();

    const codes: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/%61pi/auth/login',
        payload: { email: `deneme${attempt}@ornek.test`, password: 'Yanlis-Parola-1!' },
      });
      codes.push(res.statusCode);
    }
    expect(codes[0]).toBe(401);
    expect(codes[1]).toBe(401);
    expect(codes[2]).toBe(429);
    expect(codes[3]).toBe(429);
  });
});

describe('CSRF muafiyeti kodlamayla genişlemez', () => {
  it('oturumlu kullanıcı kodlanmış logout yolunda jetonsuz istek atamaz', async () => {
    const { repos, app } = await makeWorld({ rateLimit: false });
    await createUser(repos, 'aday3@ornek.test', 'user');
    const { cookie, csrf } = await login(app, 'aday3@ornek.test');

    const withoutToken = await app.inject({
      method: 'POST',
      url: '/%61pi/auth/logout',
      headers: { cookie },
    });
    expect(withoutToken.statusCode, withoutToken.body).toBe(403);

    const withToken = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(withToken.statusCode, withToken.body).toBe(200);
  });
});

describe('sağlık uçlarında bilgi sızıntısı', () => {
  it('ortam özeti anonim ziyaretçiye kapalı, yöneticiye açıktır', async () => {
    const { repos, app } = await makeWorld({ rateLimit: false });
    const anonymous = await app.inject({ method: 'GET', url: '/api/health/config' });
    expect(anonymous.statusCode, anonymous.body).toBe(401);
    expect(anonymous.body).not.toContain('baseUrl');

    await createUser(repos, 'aday4@ornek.test', 'user');
    const userCookie = (await login(app, 'aday4@ornek.test')).cookie;
    const asUser = await app.inject({ method: 'GET', url: '/api/health/config', headers: { cookie: userCookie } });
    expect(asUser.statusCode, asUser.body).toBe(403);

    await createUser(repos, 'yonetici2@ornek.test', 'admin');
    const adminCookie = (await login(app, 'yonetici2@ornek.test')).cookie;
    const asAdmin = await app.inject({ method: 'GET', url: '/api/health/config', headers: { cookie: adminCookie } });
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
  });

  it('veritabanı hata ayrıntısı (host/yol) anonim ziyaretçiye sızmaz', async () => {
    const { repos, app } = await makeWorld({ rateLimit: false });
    const leakyDetail = 'connect ETIMEDOUT 10.0.0.5:5432 — CA dosyası: /srv/kamuradar/certs/supabase-ca.crt';
    (repos.store as unknown as { health: () => Promise<unknown> }).health = async () => ({
      ok: false,
      driver: 'postgres',
      detail: leakyDetail,
    });

    const anonymous = await app.inject({ method: 'GET', url: '/api/health' });
    expect(anonymous.statusCode).toBe(200); // arayüzün ana sayfası bu ucu kullanır
    expect(anonymous.body).not.toContain('10.0.0.5');
    expect(anonymous.body).not.toContain('supabase-ca.crt');
    const body = JSON.parse(anonymous.body) as { database: { healthy: boolean; detail: string | null } };
    expect(body.database.healthy).toBe(false);
    expect(body.database.detail).toBeNull();

    await createUser(repos, 'yonetici3@ornek.test', 'admin');
    const adminCookie = (await login(app, 'yonetici3@ornek.test')).cookie;
    const asAdmin = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: adminCookie } });
    expect(asAdmin.statusCode).toBe(200);
    expect((JSON.parse(asAdmin.body) as { database: { detail: string | null } }).database.detail).toBe(leakyDetail);
  });
});

describe('üretim statik kökü ve istek kimliği', () => {
  it('statik kök platformdan bağımsız mutlak yoldur (Windows "/C:/..." üretmez)', () => {
    const root = staticDistRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(root).not.toMatch(/^\/[A-Za-z]:/);
    expect(root.endsWith('dist')).toBe(true);
  });

  it('istek kimliği rastgele ve tek biçimlidir', async () => {
    const { app } = await makeWorld({ rateLimit: false });
    const first = await app.inject({ method: 'GET', url: '/api/olmayan-yol' });
    const second = await app.inject({ method: 'GET', url: '/api/olmayan-yol-2' });
    const idOf = (body: string): string =>
      (JSON.parse(body) as { error?: { requestId?: string } }).error?.requestId ?? '';
    expect(idOf(first.body)).toMatch(/^req_[0-9a-f]{20}$/);
    expect(idOf(second.body)).toMatch(/^req_[0-9a-f]{20}$/);
    expect(idOf(first.body)).not.toBe(idOf(second.body));
  });
});
