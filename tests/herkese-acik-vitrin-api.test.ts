/**
 * Herkese açık ilan vitrini (PUBLIC_LISTINGS_ENABLED) — API sözleşmesi.
 *
 * Bayrak yalnızca arayüze erişim modelini bildirir (`/api/auth/session.access`).
 * Kişisel ve yönetim uçlarının yetki denetimi bayraktan BAĞIMSIZDIR; bu dosya
 * bayrak açıkken de oturumsuz isteğin bu uçlara erişemediğini sabitler.
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

const LOGGER = createLogger('vitrin-api-test', { level: 'silent' });

afterEach(() => {
  delete process.env.PUBLIC_LISTINGS_ENABLED;
  resetEnvCache();
});

async function makeApp(flag: string | undefined) {
  if (flag === undefined) delete process.env.PUBLIC_LISTINGS_ENABLED;
  else process.env.PUBLIC_LISTINGS_ENABLED = flag;
  resetEnvCache();
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-vitrin-')));
  await store.init();
  const repos = createRepos(store, fixedClock(new Date('2026-10-21T09:00:00+03:00')));
  const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
  await app.ready();
  return { app, store };
}

describe('PUBLIC_LISTINGS_ENABLED', () => {
  it.each([
    [undefined, false],
    ['0', false],
    ['1', true],
  ])('oturum yanıtı erişim modelini bildirir (PUBLIC_LISTINGS_ENABLED=%s → %s)', async (flag, expected) => {
    const { app, store } = await makeApp(flag);
    const response = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: false, access: { publicListings: expected } });
    await app.close();
    await store.close();
  });

  it('bayrak açıkken de kişisel ve yönetim uçları oturumsuz isteğe kapalıdır', async () => {
    const { app, store } = await makeApp('1');
    for (const url of ['/api/me/saved-jobs', '/api/notifications/preferences', '/api/admin/overview']) {
      const response = await app.inject({ method: 'GET', url });
      expect([401, 403], url).toContain(response.statusCode);
    }
    // İlan listesi oturumsuz okunur (bayraktan bağımsız mevcut sözleşme).
    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    await app.close();
    await store.close();
  });
});
