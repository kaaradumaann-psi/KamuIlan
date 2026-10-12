/**
 * Ortam değişkenleri — tek doğrulama noktası.
 *
 * Kurallar:
 *  - Eksik/yanlış değer uygulamayı sessizce çalıştırmaz; anlaşılır hata verir
 *    (üretimde APP_SECRET zorunlu, üretimde dosya deposu yasak).
 *  - Gizli değerler loglanmaz; `describeEnv()` yalnızca maskeli özet üretir.
 */
import { z } from 'zod';

const boolish = z
  .string()
  .optional()
  .transform((value) => value === '1' || value?.toLowerCase() === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  APP_SECRET: z.string().default(''),
  APP_DISPLAY_NAME: z.string().default('KamuRadar'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().default(''),
  MONGODB_DB: z.string().default('kamuradar'),
  DATA_DIR: z.string().default('./data'),

  REDIS_URL: z.string().default(''),

  SCRAPE_DEFAULT_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  SCRAPE_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(120_000).default(30_000),
  SCRAPE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  SCRAPE_DEADLINE_REFRESH_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  COVERAGE_AUDIT_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  SOURCE_LIVE_FETCH: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  SCRAPER_USER_AGENT: z
    .string()
    .default(
      'KamuRadarBot/0.1 (+https://github.com/kaaradumaann-psi/kamuradar; kamu personel ilanı toplayıcı)',
    ),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: boolish,
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().default('KamuRadar <bildirim@example.com>'),
  EMAIL_VERIFICATION_SECRET: z.string().default(''),
  EMAIL_DEV_FILE_TRANSPORT: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  DEV_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  EMAIL_RETRY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),

  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(336),
  CSRF_ENABLED: boolish,
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(120),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1_000).default(10),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),

  SOURCE_ALLOWED_HOSTS: z
    .string()
    .default(
      [
        'resmigazete.gov.tr',
        'ilan.gov.tr',
        'osym.gov.tr',
        'dokuman.osym.gov.tr',
        'kariyerkapisi.gov.tr',
        'iskur.gov.tr',
        'esube.iskur.gov.tr',
        'personel.meb.gov.tr',
      ].join(','),
    ),
  SOURCE_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_500),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1_024).max(104_857_600).default(15_728_640),
  MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(overrides: Record<string, string | undefined> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Ortam değişkenleri geçersiz: ${issues}`);
  }
  const env = parsed.data;
  if (Object.keys(overrides).length === 0) cached = env;
  return env;
}

/** Testlerde farklı ortam ile yeniden yüklemek için. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'production';
}

export function isTest(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'test';
}

export function allowedHosts(env: Env = getEnv()): string[] {
  return env.SOURCE_ALLOWED_HOSTS.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

const SECRET_KEYS = ['APP_SECRET', 'SMTP_PASS', 'SMTP_USER', 'MONGODB_URI', 'REDIS_URL', 'EMAIL_VERIFICATION_SECRET', 'ADMIN_PASSWORD'] as const;

/** Log ve sağlık uçları için maskeli ortam özeti. */
export function describeEnv(env: Env = getEnv()): Record<string, string | number | boolean> {
  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    APP_BASE_URL: env.APP_BASE_URL,
    LOG_LEVEL: env.LOG_LEVEL,
    storage: env.MONGODB_URI ? 'mongodb' : `file:${env.DATA_DIR}`,
    queue: env.REDIS_URL ? 'redis(bullmq)' : 'persistent-in-db(builtin)',
    emailTransport: env.SMTP_HOST ? 'smtp' : env.EMAIL_DEV_FILE_TRANSPORT ? 'dev-file' : 'disabled',
    liveFetchEnabled: env.SOURCE_LIVE_FETCH,
    secretsConfigured: SECRET_KEYS.filter((key) => Boolean(env[key])).length,
  };
}

/**
 * Üretim güvenliği kontrolleri. Hatalı yapılandırmada uygulama başlamaz.
 */
export function assertProductionSafety(env: Env = getEnv()): string[] {
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return warnings;

  if (env.APP_SECRET.length < 32) {
    throw new Error('Üretimde APP_SECRET en az 32 karakter olmalıdır.');
  }
  if (!env.MONGODB_URI) {
    throw new Error(
      'Üretimde kalıcı veritabanı zorunludur: MONGODB_URI tanımlayın (dosya deposu sunucu uykuya geçtiğinde veri kaybeder).',
    );
  }
  if (!env.SMTP_HOST) {
    warnings.push('SMTP_HOST tanımlı değil: gerçek e-posta gönderimi devre dışı, bildirimler dosyaya yazılır.');
  }
  if (env.EMAIL_DEV_FILE_TRANSPORT && env.SMTP_HOST) {
    warnings.push('EMAIL_DEV_FILE_TRANSPORT=1 iken SMTP kullanılmaz; üretimde 0 yapın.');
  }
  if (env.APP_BASE_URL.startsWith('http://')) {
    warnings.push('APP_BASE_URL https olmalı; e-posta bağlantıları güvensiz adres gösteriyor.');
  }
  return warnings;
}
