/**
 * Ortam değişkenleri — tek doğrulama noktası.
 *
 * İlkeler:
 *  - Eksik/yanlış yapılandırma sessizce çalışmaz; açık hata mesajı verir.
 *  - Gizli değerler loglanmaz; `describeEnv()` yalnızca maskeli özet döner.
 *  - Testler `getEnv()` çağırmadan önce process.env'i ayarlar (bkz. tests/setup.ts).
 */
import { z } from 'zod';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_DISPLAY_NAME: z.string().min(1).default('KamuRadar'),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  APP_SECRET: z.string().default(''),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATA_DIR: z.string().default('./data'),
  DATABASE_DRIVER: z.enum(['mongo', 'file']).default('file'),
  MONGODB_URI: z.string().default(''),
  MONGODB_DB: z.string().default('kamuradar'),
  REDIS_URL: z.string().default(''),

  // --- Tarama ---
  SCHEDULER_ENABLED: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  WORKER_NAMESPACE: z.string().default('kamuradar'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  SCRAPE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  SCRAPE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  SCRAPE_USER_AGENT: z.string().default('KamuRadarBot/0.1 (+https://github.com/kaaradumaann-psi/kamuradar)'),
  SOURCE_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_500),
  /** Kaynak alan adı beyaz listesi dışına çıkan yönlendirmeler engellenir (SSRF). */
  SOURCE_ALLOWED_HOSTS: z
    .string()
    .default(
      [
        'resmigazete.gov.tr',
        'www.resmigazete.gov.tr',
        'ilan.gov.tr',
        'www.ilan.gov.tr',
        'medya.ilan.gov.tr',
        'osym.gov.tr',
        'www.osym.gov.tr',
        'dokuman.osym.gov.tr',
        'iskur.gov.tr',
        'www.iskur.gov.tr',
        'esube.iskur.gov.tr',
        'kariyerkapisi.gov.tr',
        'www.kariyerkapisi.gov.tr',
        'personel.meb.gov.tr',
        'kamuilan.sbb.gov.tr',
      ].join(','),
    )
    .transform(csv),
  /** Canlı kaynak erişimi kapalıysa adaptörler yalnızca doğrulama yapar (test/lint). */
  SOURCE_LIVE_FETCH: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1_024).max(52_428_800).default(15_728_640),
  MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  DOCUMENT_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(120_000).default(20_000),

  // --- E-posta ---
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_SECURE: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().default('KamuRadar <kamuradar@localhost>'),
  EMAIL_DEV_FILE_TRANSPORT: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  EMAIL_RETRY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  EMAIL_VERIFICATION_SECRET: z.string().default(''),

  // --- Güvenlik ---
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(24 * 14),
  CSRF_ENABLED: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(120),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1_000).default(10),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(overrides: Record<string, string | undefined> = {}): Env {
  const hasOverrides = Object.keys(overrides).length > 0;
  if (cachedEnv && !hasOverrides) return cachedEnv;
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Ortam değişkenleri geçersiz: ${details}`);
  }
  const env = parsed.data;
  validateEnvironment(env);
  if (!hasOverrides) cachedEnv = env;
  return env;
}

/** Testlerde ortam değişikliği sonrası yeniden okumak için. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

export interface EnvironmentInspection {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Ayarları çalıştırmadan denetler: `npm run env:check` ve süreç başlangıcı
 * bu sonucu kullanır. `getEnv()` sorun varsa hata fırlatır.
 */
export function inspectEnvironment(env: Env = getEnv()): EnvironmentInspection {
  const { problems, warnings } = collectEnvironmentProblems(env);
  return { ok: problems.length === 0, problems, warnings };
}

function collectEnvironmentProblems(env: Env): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (!env.APP_SECRET || env.APP_SECRET.length < 32) {
      problems.push('APP_SECRET üretimde en az 32 karakter olmalıdır (oturum/jeton imzası).');
    }
    if (env.DATABASE_DRIVER !== 'mongo' && !env.MONGODB_URI) {
      problems.push('Üretimde kalıcı veritabanı zorunludur: MONGODB_URI veya DATABASE_DRIVER=mongo.');
    }
    if (!env.SMTP_HOST) {
      problems.push('Üretimde SMTP_HOST zorunludur; aksi halde e-postalar gönderilemez.');
    }
    if (env.NODE_ENV === 'production' && process.env['SMTP_PASS']?.startsWith('dev-')) {
      problems.push('Üretimde geliştirme SMTP şifresi kullanılamaz.');
    }
  }
  if (env.DATABASE_DRIVER === 'mongo' && !env.MONGODB_URI) {
    problems.push('DATABASE_DRIVER=mongo için MONGODB_URI gereklidir.');
  }
  if (env.APP_SECRET.length < 32) {
    warnings.push('APP_SECRET kısa: üretimde oturum imzası için en az 32 karakter kullanın.');
  }
  if (env.NODE_ENV === 'production' && !env.SOURCE_LIVE_FETCH) {
    warnings.push('Üretimde SOURCE_LIVE_FETCH=1 olmadan kaynaklar taranmaz.');
  }
  if (env.ADMIN_EMAIL === '' || env.ADMIN_PASSWORD === '') {
    warnings.push('İlk yönetici hesabı için ADMIN_EMAIL/ADMIN_PASSWORD tanımlanmamış (seed:admin çalıştırılamaz).');
  }
  return { problems, warnings };
}

function validateEnvironment(env: Env): void {
  const { problems } = collectEnvironmentProblems(env);
  if (problems.length > 0) {
    throw new Error(`Ortam yapılandırması güvenli değil:\n- ${problems.join('\n- ')}`);
  }
}

export function isProduction(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'production';
}

export function isTest(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'test';
}

/** Loglarda/health endpoint'inde gösterilecek maskeli özet. Gizli değer içermez. */
export function describeEnv(env: Env = getEnv()): Record<string, string | boolean | number> {
  return {
    environment: env.NODE_ENV,
    appName: env.APP_DISPLAY_NAME,
    baseUrl: env.APP_BASE_URL,
    database: env.MONGODB_URI ? 'mongodb' : `file:${env.DATA_DIR}`,
    redis: env.REDIS_URL ? 'tanımlı' : 'yok (yerleşik kuyruk)',
    smtp: env.SMTP_HOST ? `${env.SMTP_HOST}:${env.SMTP_PORT}` : 'tanımlı değil',
    liveFetch: env.SOURCE_LIVE_FETCH,
    scheduler: env.SCHEDULER_ENABLED,
    dataDir: env.DATA_DIR,
    rateLimit: `${env.RATE_LIMIT_MAX_REQUESTS}/${env.RATE_LIMIT_WINDOW_SECONDS}s`,
    appSecretSet: env.APP_SECRET.length >= 32,
  };
}
