/**
 * R-09 — vekil güven sınırı (TRUST_PROXY adres listesi).
 *
 * Sorun: `TRUST_PROXY=1` her kaynaktan gelen `X-Forwarded-For` başlığına güvenir.
 * Cloudflare vekili istemci başlığını artık taşımıyor (functions/api), ancak API
 * kökeni doğrudan internetten erişilebiliyorsa saldırgan vekili atlayıp her
 * istekte farklı bir IP uydurabilir → hız sınırı ve denetim kaydı atlatılır.
 *
 * Çözüm: `TRUST_PROXY` güvenilen vekil adres listesi (CIDR / `cloudflare`)
 * kabul eder; başlık yalnızca bu adreslerden gelen istekte değerlendirilir.
 * Testler gerçek Fastify uygulaması üzerinde soket adresini (`remoteAddress`)
 * değiştirerek koşulur.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { getEnv, resetEnvCache } from '../src/config/env';
import { CLOUDFLARE_IP_RANGES, invalidTrustProxyEntries, parseTrustProxy } from '../src/config/trust-proxy';
import { ENV_FIELDS, validateFieldValue } from '../src/config/env-spec';

const NOW = new Date('2026-10-21T09:00:00+03:00');
const LOGGER = createLogger('vekil-guven-test', { level: 'silent' });
const CLOUDFLARE_EDGE = '162.158.10.20';
const DIRECT_ATTACKER = '198.51.100.77';
const TOUCHED_ENV = ['TRUST_PROXY', 'AUTH_RATE_LIMIT_MAX_REQUESTS'] as const;

afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
  resetEnvCache();
});

async function makeApp(
  trustProxy: string,
  maxRequests = 2,
): Promise<{ app: FastifyInstance; store: FileStore }> {
  process.env.TRUST_PROXY = trustProxy;
  process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = String(maxRequests);
  resetEnvCache();
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-vekil-')));
  await store.init();
  const repos = createRepos(store, fixedClock(NOW));
  const app = await buildApp({ repos, logger: LOGGER });
  await app.ready();
  return { app, store };
}

function login(app: FastifyInstance, remoteAddress: string, forwardedFor: string, index: number) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
    payload: { email: `vekil-${index}@ornek.test`, password: 'Yanlis-Parola-2026' },
  });
}

describe('TRUST_PROXY ayrıştırma', () => {
  it('eski boolean değerleri korur', () => {
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
  });

  it('cloudflare anahtar sözcüğünü yayımlanmış aralıklara açar ve tekrarları atar', () => {
    const parsed = parseTrustProxy('cloudflare, 10.0.0.0/8, cloudflare');
    expect(parsed).toEqual([...CLOUDFLARE_IP_RANGES, '10.0.0.0/8']);
  });

  it('geçersiz öğeleri reddeder (yanlış yazım sessizce "hiçbirine güvenme"ye düşmez)', () => {
    expect(invalidTrustProxyEntries('10.0.0.0/33, cloudflre, 2400:cb00::/32')).toEqual([
      '10.0.0.0/33',
      'cloudflre',
    ]);
    expect(() => parseTrustProxy('evet')).toThrow(/geçersiz öğe/);
    process.env.TRUST_PROXY = '256.1.1.1';
    resetEnvCache();
    expect(() => getEnv()).toThrow(/TRUST_PROXY/);
  });

  it('ortam denetimi (env:check) liste biçimini kabul eder, hatalı öğeyi bildirir', () => {
    const field = ENV_FIELDS.find((entry) => entry.key === 'TRUST_PROXY');
    if (!field) throw new Error('TRUST_PROXY ortam tanımı bulunamadı');
    expect(validateFieldValue(field, 'cloudflare,uniquelocal').ok).toBe(true);
    expect(validateFieldValue(field, '1').ok).toBe(true);
    expect(validateFieldValue(field, '10.0.0.0/99').ok).toBe(false);
  });
});

describe('TRUST_PROXY=cloudflare — uçtan uca hız sınırı', () => {
  it('vekili atlayan istemci sahte X-Forwarded-For ile yeni kova açamaz', async () => {
    const { app, store } = await makeApp('cloudflare');
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      // Her istekte farklı uydurma IP; soket adresi güvenilmeyen saldırgan.
      const response = await login(app, DIRECT_ATTACKER, `203.0.113.${index + 1}`, index);
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 429]);
    await app.close();
    await store.close();
  });

  it('güvenilen vekil arkasındaki farklı gerçek istemciler ayrı kovalara düşer', async () => {
    const { app, store } = await makeApp('cloudflare');
    const first = await login(app, CLOUDFLARE_EDGE, '203.0.113.10', 0);
    const second = await login(app, CLOUDFLARE_EDGE, '203.0.113.10', 1);
    const third = await login(app, CLOUDFLARE_EDGE, '203.0.113.10', 2);
    const other = await login(app, CLOUDFLARE_EDGE, '203.0.113.11', 3);
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([401, 401, 429]);
    expect(other.statusCode).toBe(401);
    await app.close();
    await store.close();
  });

  it('vekile ulaşan istemcinin sola eklediği sahte değer yok sayılır (zincir sağdan okunur)', async () => {
    const { app, store } = await makeApp('cloudflare');
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      // Cloudflare gerçek istemciyi zincirin SONUNA ekler; soldaki değer istemcinin uydurmasıdır.
      const response = await login(app, CLOUDFLARE_EDGE, `10.9.9.${index + 1}, 203.0.113.20`, index);
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 429]);
    await app.close();
    await store.close();
  });
});
