/**
 * Oturum ucunun kurulum tanılaması.
 *
 * Neden: kullanıcı hesabı Supabase panosuna eklediğinde (ya da başka bir
 * veritabanına) uygulama onu göremez ve giriş her seferinde 401 döner.
 * `/api/auth/session` bu yüzden "hiç hesap yok" durumunu ve ETKİN depoyu
 * bildirir; giriş ekranı da bunu gösterir. Bilgi yalnızca kullanıcı tablosu
 * tamamen boşken verilir (tek hesap varsa "oturum yok" demekle kalır).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/server/passwords';
import { buildApp } from '../src/server/app';

const LOGGER = createLogger('session-setup-test', { level: 'silent' });

interface World {
  store: FileStore;
  repos: Repos;
  app: FastifyInstance;
}

let world: World;

beforeAll(async () => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-session-')));
  await store.init();
  const repos = createRepos(store);
  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
  await app.ready();
  world = { store, repos, app };
});

afterAll(async () => {
  await world.app.close();
  await world.store.close();
});

describe('GET /api/auth/session — kurulum tanılaması', () => {
  it('hiç kullanıcı yokken setup.required true ve depo adı bildirilir', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      authenticated: boolean;
      user: null;
      setup: { required: boolean; driver: string; label: string };
    };
    expect(body.authenticated).toBe(false);
    expect(body.user).toBeNull();
    expect(body.setup.required).toBe(true);
    expect(body.setup.driver).toBe('file');
    expect(body.setup.label).toContain('dosya');
  });

  it('bir hesap açıldıktan sonra setup.required false olur (bilgi sızmaz)', async () => {
    const { hash, salt } = await hashPassword('Guclu-Parola-2026');
    await world.repos.users.create({
      email: 'ilk@kamuilan.test',
      passwordHash: hash,
      passwordSalt: salt,
      displayName: 'İlk Hesap',
      emailVerified: true,
    });

    const response = await world.app.inject({ method: 'GET', url: '/api/auth/session' });
    const body = response.json() as { setup: { required: boolean } };
    expect(body.setup.required).toBe(false);
  });

  it('hatalı parola 401 döner ve sunucu nedenini yazar', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ilk@kamuilan.test', password: 'Yanlis-Parola-1' },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('E-posta veya parola hatalı.');
  });
});
