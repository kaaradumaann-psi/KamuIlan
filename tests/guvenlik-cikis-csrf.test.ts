/**
 * CSRF muafiyeti regresyonu — oturumlu bildirim çıkışı.
 *
 * Bulgu (21.10.2026 denetimi): `/api/auth/unsubscribe` CSRF muafiyet listesindeydi.
 * Ucun jetonlu (oturumsuz) yolu muafiyet gerektirmez, çünkü CSRF denetimi
 * yalnızca bir oturum varsa uygulanır. Buna karşılık aynı uç bir oturumla
 * çağrıldığında `{ all: true }` ile kullanıcının TÜM oturumlarını iptal ediyor;
 * muafiyet, başka bir sayfanın kullanıcı adına aboneliği kapatmasına (ve
 * oturumları sonlandırmasına) kapı bırakıyordu. Muafiyet kaldırıldı; bu test
 * hem oturumlu yolun CSRF istediğini hem jetonlu yolun çalışmaya devam ettiğini
 * kanıtlar.
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

const NOW = new Date('2026-10-21T09:00:00+03:00');
const LOGGER = createLogger('csrf-cikis-test', { level: 'silent' });
const CREDENTIAL = ['Guclu', 'Parola', '2026!'].join('-');

let openStores: FileStore[] = [];
let openApps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of openApps) await app.close();
  for (const store of openStores) await store.close();
  openApps = [];
  openStores = [];
  resetEnvCache();
});

async function makeWorld(): Promise<{ repos: Repos; app: FastifyInstance }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-csrf-')));
  await store.init();
  openStores.push(store);
  const repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
  openApps.push(app);
  return { repos, app };
}

async function createUser(repos: Repos, email: string): Promise<string> {
  const { hash, salt } = await hashPassword(CREDENTIAL);
  const { user } = await repos.users.create({
    email,
    passwordHash: hash,
    passwordSalt: salt,
    displayName: 'Aday',
    role: 'user',
    emailVerified: true,
  });
  return user.id;
}

async function login(app: FastifyInstance, email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: CREDENTIAL },
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookies = res.cookies as { name: string; value: string }[];
  const session = cookies.find((cookie) => cookie.name === 'kamuilan_session');
  const csrf = cookies.find((cookie) => cookie.name === 'kamuilan_csrf');
  return {
    cookie: `${session?.name}=${session?.value}; ${csrf?.name}=${csrf?.value}`,
    csrf: csrf?.value ?? '',
  };
}

describe('CSRF: oturumlu bildirim çıkışı', () => {
  it('x-csrf-token başlığı olmadan oturumlu çıkış 403 döner ve tercih değişmez', async () => {
    const { repos, app } = await makeWorld();
    const userId = await createUser(repos, 'csrf-aday@ornek.test');
    await repos.notifications.upsertPreference(userId, { enabled: true });
    const session = await login(app, 'csrf-aday@ornek.test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/unsubscribe',
      headers: { cookie: session.cookie },
      payload: { all: true },
    });

    expect(res.statusCode).toBe(403);
    const preference = await repos.notifications.getPreference(userId);
    expect(preference?.enabled).toBe(true);
  });

  it('doğru CSRF jetonuyla oturumlu çıkış çalışır', async () => {
    const { repos, app } = await makeWorld();
    const userId = await createUser(repos, 'csrf-aday2@ornek.test');
    await repos.notifications.upsertPreference(userId, { enabled: true });
    const session = await login(app, 'csrf-aday2@ornek.test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/unsubscribe',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: {},
    });

    expect(res.statusCode, res.body).toBe(200);
    const preference = await repos.notifications.getPreference(userId);
    expect(preference?.enabled).toBe(false);
  });

  it('jetonlu (oturumsuz) çıkış CSRF istemez; e-postadaki bağlantı çalışmaya devam eder', async () => {
    const { repos, app } = await makeWorld();
    const userId = await createUser(repos, 'csrf-aday3@ornek.test');
    await repos.notifications.upsertPreference(userId, { enabled: true });
    const token = 'cikis-jetonu-0123456789abcdef';
    await repos.users.createToken({ userId, type: 'unsubscribe', token, ttlMinutes: 60 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/unsubscribe',
      payload: { token },
    });

    expect(res.statusCode, res.body).toBe(200);
    const preference = await repos.notifications.getPreference(userId);
    expect(preference?.enabled).toBe(false);
  });
});
