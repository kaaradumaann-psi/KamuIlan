/**
 * `.env.example` = `renderEnvExample()` (env-spec + şema varsayılanları). Elle düzenleme ya da yeni
 * bir ortam değişkeninin spec'e eklenmemesi bu testte yakalanır: `npm run env:example`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_MINIMUM, renderEnvExample } from '../src/config/env-example';
import { ENV_FIELDS, ENV_FIELD_BY_KEY } from '../src/config/env-spec';
import { getEnv, inspectEnvironment, parseEnvWithoutValidation, resetEnvCache } from '../src/config/env';
import { parseEnvFile } from '../src/config/load-env';

const file = readFileSync(join(process.cwd(), '.env.example'), 'utf8').replace(/\r\n/g, '\n');

describe('.env.example', () => {
  it('env-spec\'ten üretilen içerikle birebir aynı (npm run env:example)', () => {
    expect(file).toBe(renderEnvExample());
  });

  it('şemadaki her anahtar tam bir kez atanır; Node anahtarları yorumdadır', () => {
    for (const field of ENV_FIELDS) {
      const assigned = file.match(new RegExp(`^${field.key}=`, 'gm'))?.length ?? 0;
      expect(assigned, field.key).toBe(field.outsideSchema ? 0 : 1);
    }
    expect(file).not.toMatch(/^#? ?NODE_TLS_REJECT_UNAUTHORIZED=/m);
  });

  it('olduğu gibi kopyalanınca yerel geliştirme yapılandırması geçerlidir ve tarama kapalıdır', () => {
    resetEnvCache();
    const env = getEnv({ ...parseEnvFile(file), NODE_ENV: 'development' });
    expect(inspectEnvironment(env).ok).toBe(true);
    expect(env.SCHEDULER_ENABLED).toBe(false);
    expect(env.SOURCE_LIVE_FETCH).toBe(false);
    expect(env.DATABASE_DRIVER).toBe('file');
    expect(env.APP_BASE_URL).toBe('http://localhost:5173');
    resetEnvCache();
  });

  it('spec\'te sunulan her enum seçeneği şemada geçerlidir', () => {
    for (const field of ENV_FIELDS.filter((f) => f.type === 'enum' && !f.outsideSchema)) {
      for (const option of field.options ?? []) {
        if (option === '') continue;
        const result = parseEnvWithoutValidation({ NODE_ENV: 'test', [field.key]: option });
        expect(result.ok, `${field.key}=${option} → ${result.ok ? '' : result.issues.join('; ')}`).toBe(true);
      }
    }
  });

  it('üretim için en az listesi gerçek anahtarlara işaret eder', () => {
    for (const [key] of PRODUCTION_MINIMUM) expect(ENV_FIELD_BY_KEY.has(key), key).toBe(true);
  });
});

describe('boş değer = tanımsız (withoutBlankValues)', () => {
  it('KEY= satırı canlı taramayı/zamanlayıcıyı AÇMAZ ve sayıları 0 yapmaz', () => {
    resetEnvCache();
    const env = getEnv({
      NODE_ENV: 'development',
      SCHEDULER_ENABLED: '',
      SOURCE_LIVE_FETCH: '  ',
      PORT: '',
      MAX_REDIRECTS: '',
      SOURCE_ALLOWED_HOSTS: '',
    });
    expect(env.SCHEDULER_ENABLED).toBe(false);
    expect(env.SOURCE_LIVE_FETCH).toBe(false);
    expect(env.PORT).toBe(3000);
    expect(env.MAX_REDIRECTS).toBe(3);
    expect(env.SOURCE_ALLOWED_HOSTS.length).toBeGreaterThan(5);
    resetEnvCache();
  });
});

describe('.env.example olduğu gibi süreç ortamına yüklenince', () => {
  it('logger açılışta çökmez (boş LOG_LEVEL= satırı varsayılana düşer)', async () => {
    const values = parseEnvFile(file);
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values, { NODE_ENV: 'test' });
    resetEnvCache();
    try {
      const { createLogger } = await import('../src/lib/logger');
      const logger = createLogger('env-example-test');
      expect(logger.level).toBe('info');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvCache();
    }
  });
});

