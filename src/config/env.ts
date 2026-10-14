/**
 * Ortam değişkenleri — tek doğrulama noktası.
 *
 * İlkeler:
 *  - Eksik/yanlış yapılandırma sessizce çalışmaz; açık hata mesajı verir.
 *  - Gizli değerler loglanmaz; `describeEnv()` yalnızca maskeli özet döner.
 *  - Testler `getEnv()` çağırmadan önce process.env'i ayarlar (bkz. tests/setup.ts).
 */
import { toHeaderSafeAscii } from '../lib/headerSafe';
import { z } from 'zod';
import { envFileSource, loadEnvFile } from './load-env';

/**
 * `.env` dosyası (varsa) ortam değişkenlerine yüklenir.
 *
 * Bu çağrı modül yüklenirken bir kez çalışır; böylece `npm start`,
 * `npm run start:worker`, `npm run dev:*` ve `scripts/*` komutlarının hepsi
 * aynı yapılandırmayı görür. Gerçek ortam değişkenleri her zaman önceliklidir.
 */
loadEnvFile();

/** 0/1 (veya true/false) bayrağı; öntanımlı değer verilir. */
const flag = (fallback: '0' | '1') =>
  z
    .string()
    .default(fallback)
    .transform((value) => value === '1' || value.toLowerCase() === 'true');

/** Telegram webhook sırrı biçimi (Telegram belgesi: 1–256 karakter, A-Z a-z 0-9 _ -). */
export const TELEGRAM_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** Telegram bot kullanıcı adı: 5–32 karakter, harf/rakam/_ ve "bot" ile biter. */
export const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,30}bot$/i;

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_DISPLAY_NAME: z.string().min(1).default('Kamuİlan'),
  APP_BASE_URL: z.string().url().default('https://kamuilan.halilkaraduman.com.tr'),
  /** Kamuİlan alan adı (Cloudflare özel alan adı + e-posta gönderen alan adı). */
  APP_DOMAIN: z.string().default('kamuilan.halilkaraduman.com.tr'),
  APP_SECRET: z.string().default(''),
  /** API portu (vite proxy varsayılanı 3000'e bakar). */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /**
   * X-Forwarded-For başlığına GÜVENİLİR Mİ?
   *
   * Varsayılan KAPALI: başlık istemci tarafından serbestçe yazılabilir; açıkken
   * saldırgan her istekte farklı bir IP uydurup hız sınırını atlar ve denetim
   * kaydına yalan IP yazdırır. Yalnızca uygulama, başlığı KENDİSİ ÜRETEN bir
   * vekil sunucunun (Cloudflare/Nginx) arkasındayken 1 yapın.
   */
  TRUST_PROXY: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * OpenAPI arayüzü (/api/docs). Varsayılan: yalnızca üretim dışı ortamlarda açık.
   * Üretimde API yüzeyini ve şemayı dışarıya göstermemek için KAPALIDIR;
   * bilinçli olarak açmak isterseniz DOCS_ENABLED=1 verin.
   */
  DOCS_ENABLED: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
  /**
   * Geliştirmede CORS: yalnızca bu liste (virgülle ayrılmış) vekil/arayüz
   * kaynaklarına izin verilir. `origin: true` (her kaynağa izin) KULLANILMAZ:
   * oturum çerezleriyle birlikte her siteden istek kabul etmek gereksiz risk.
   */
  CORS_ORIGINS: z.string().default(''),

  DATA_DIR: z.string().default('./data'),
  /**
   * Depo sürücüsü:
   *  - postgres/supabase : ÜRETİM. Supabase (Postgres) bağlantısı.
   *  - mongo             : alternatif kalıcı sürücü (eski kurulumlar).
   *  - file              : yalnızca geliştirme/test (tek dosya).
   * 'supabase' bir takma addır; ikisi de POSTGRES_URL kullanır.
   */
  /** Boşsa otomatik: POSTGRES_URL/DATABASE_URL varsa Postgres, MONGODB_URI varsa Mongo, yoksa dosya. */
  DATABASE_DRIVER: z.enum(['postgres', 'supabase', 'mongo', 'file']).optional(),
  /** Supabase bağlantı dizesi (Connection pooling / IPv4 uyumlu uç). */
  POSTGRES_URL: z.string().default(''),
  DATABASE_URL: z.string().default(''),
  POSTGRES_SSL: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  POSTGRES_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  /** Supabase proje bilgileri (migration/edge işleri ve panel bağlantıları için). */
  SUPABASE_URL: z.string().default(''),
  SUPABASE_ANON_KEY: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  MONGODB_URI: z.string().default(''),
  MONGODB_DB: z.string().default('kamuilan'),
  REDIS_URL: z.string().default(''),

  // --- Tarama ---
  SCHEDULER_ENABLED: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  /**
   * TÜM etkin kaynaklar için tarama aralığı (dakika).
   *
   * 0: her kaynak kendi aralığıyla taranır (src/config/sources.ts) — önerilen değer.
   * 15'ten küçük değerler 15'e yükseltilir (kaynakları yıpratmamak için taban).
   * Kaynak başına aralık yerine tüm kaynakları aynı aralıkla taramak için kullanılır.
   */
  SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1_440).default(0),
  WORKER_NAMESPACE: z.string().default('kamuilan'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  SCRAPE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  SCRAPE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  // Standart bot biçimi (Googlebot/Bingbot düzeni): kimlik gizlenmez, ad ve
  // iletişim adresi açıkça yazılır. Bazı resmî sunucular "Mozilla" ile
  // başlamayan istekleri yavaşlattığı (tarpit) için bu düzen kullanılır;
  // HTTP başlıkları ASCII ister, Türkçe karakter çevrilir.
  SCRAPE_USER_AGENT: z
    .string()
    .default('Mozilla/5.0 (compatible; KamuIlanBot/0.2; +https://kamuilan.halilkaraduman.com.tr)')
    .transform(toHeaderSafeAscii),
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
  /**
   * Gönderim sağlayıcısı:
   *  - resend : ÜRETİM. Resend HTTP API (RESEND_API_KEY + doğrulanmış alan adı).
   *  - smtp   : Sunucu SMTP'si veya geliştirme posta sunucusu.
   *  - file   : Yalnızca geliştirme; postalar data/mailbox altına yazılır.
   */
  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'file']).default('smtp'),
  RESEND_API_KEY: z.string().default(''),
  /** Resend uç noktası (kurumsal vekil sunucu arkasında değiştirilebilir). */
  RESEND_API_BASE_URL: z.string().default('https://api.resend.com'),
  EMAIL_FROM: z.string().default('Kamuİlan <bildirim@kamuilan.halilkaraduman.com.tr>'),
  EMAIL_DEV_FILE_TRANSPORT: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  EMAIL_RETRY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  EMAIL_VERIFICATION_SECRET: z.string().default(''),

  // --- Telegram bildirimleri (kullanıcı başına hesap bağlama) ---
  /** BotFather token'ı. Boşsa Telegram kanalı kapalıdır; e-posta etkilenmez. */
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  /** Bot kullanıcı adı (@ olmadan). Bağlantı bağlantıları (t.me/<ad>?start=...) için gerekir. */
  TELEGRAM_BOT_USERNAME: z
    .string()
    .default('')
    .transform((value) => value.trim().replace(/^@/, '')),
  /** Webhook sırrı: Telegram her istekte X-Telegram-Bot-Api-Secret-Token başlığıyla gönderir. */
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  /** Bot API taban adresi (test için değiştirilebilir; üretimde öntanımlı kalır). */
  TELEGRAM_API_BASE_URL: z.string().default('https://api.telegram.org'),

  // --- Yapay zekâ destekli öneriler (açık rıza ile; varsayılan KAPALI) ---
  AI_ASSISTANT_ENABLED: flag('0'),
  /** Rıza metninde gösterilen sağlayıcı adı (ör. "Groq"). Hangi hizmete gittiğini kullanıcı görür. */
  AI_PROVIDER_LABEL: z.string().default('harici bir yapay zekâ hizmeti'),
  /** OpenAI uyumlu sohbet tamamlama tabanı (ör. https://api.groq.com/openai/v1). */
  LLM_BASE_URL: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default(''),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  /** Kullanıcı başına günlük öneri isteği sınırı (maliyet ve kötüye kullanım koruması). */
  AI_DAILY_LIMIT_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
  /** Geliştirme posta görüntüleyicisinin portu (scripts/dev-smtp-server.ts). */
  DEV_MAIL_VIEWER_PORT: z.coerce.number().int().min(1).max(65_535).default(1080),

  // --- Güvenlik ---
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(8_760)
    .default(24 * 14),
  CSRF_ENABLED: z
    .string()
    .default('1')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(120),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1_000).default(10),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
  /**
   * Dışarıdan kayıt: KAPALI (varsayılan). Kamuİlan'da hesaplar yalnızca yönetici
   * tarafından açılır (yönetim paneli → Kullanıcılar). Test/geliştirme için
   * bilinçli olarak 1 yapılabilir; üretimde açık bırakmak istenmez.
   */
  ALLOW_PUBLIC_REGISTRATION: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(overrides: Record<string, string | undefined> = {}): Env {
  const hasOverrides = Object.keys(overrides).length > 0;
  if (cachedEnv && !hasOverrides) return cachedEnv;
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
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

/** Supabase/Postgres bağlantı dizesi tanımlı mı? (POSTGRES_URL veya DATABASE_URL) */
export function hasPostgresConfig(env: Env): boolean {
  return Boolean(env.POSTGRES_URL || env.DATABASE_URL);
}

/** Etkin Postgres bağlantı dizesi. */
export function postgresUrl(env: Env): string {
  return env.POSTGRES_URL || env.DATABASE_URL;
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
    if (!hasPostgresConfig(env) && !env.MONGODB_URI && env.DATABASE_DRIVER !== 'mongo') {
      problems.push(
        'Üretimde kalıcı veritabanı zorunludur: POSTGRES_URL (Supabase) veya MONGODB_URI tanımlayın.',
      );
    }
    if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
      problems.push('EMAIL_PROVIDER=resend için RESEND_API_KEY zorunludur.');
    }
    if (env.EMAIL_PROVIDER === 'file') {
      problems.push('Üretimde EMAIL_PROVIDER=file kullanılamaz; resend veya smtp seçin.');
    }
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
      problems.push('EMAIL_PROVIDER=smtp için SMTP_HOST zorunludur; aksi halde e-postalar gönderilemez.');
    }
    if (env.NODE_ENV === 'production' && process.env['SMTP_PASS']?.startsWith('dev-')) {
      problems.push('Üretimde geliştirme SMTP şifresi kullanılamaz.');
    }
    if (env.TELEGRAM_BOT_TOKEN && !TELEGRAM_SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      problems.push(
        'Üretimde Telegram için TELEGRAM_WEBHOOK_SECRET zorunludur (1–256 karakter: A-Z a-z 0-9 _ -).',
      );
    }
    if (env.AI_ASSISTANT_ENABLED && env.LLM_BASE_URL && !env.LLM_BASE_URL.startsWith('https://')) {
      problems.push('Üretimde LLM_BASE_URL https:// ile başlamalıdır (kişisel profil verisi taşınır).');
    }
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    if (!env.TELEGRAM_BOT_USERNAME) {
      problems.push('TELEGRAM_BOT_TOKEN tanımlı ama TELEGRAM_BOT_USERNAME boş (bağlantı bağlantıları üretilemez).');
    } else if (!TELEGRAM_USERNAME_PATTERN.test(env.TELEGRAM_BOT_USERNAME)) {
      problems.push('TELEGRAM_BOT_USERNAME biçimi geçersiz (5–32 karakter, harf/rakam/_, "bot" ile biter).');
    }
    if (env.TELEGRAM_WEBHOOK_SECRET && !TELEGRAM_SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      problems.push('TELEGRAM_WEBHOOK_SECRET yalnızca A-Z a-z 0-9 _ - karakterlerini içerebilir (1–256).');
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      warnings.push('TELEGRAM_WEBHOOK_SECRET boş: webhook uçu kapalı kalır; bağlantı kurulamaz.');
    }
  }
  if (env.AI_ASSISTANT_ENABLED && (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL)) {
    problems.push('AI_ASSISTANT_ENABLED=1 için LLM_BASE_URL, LLM_API_KEY ve LLM_MODEL zorunludur.');
  }
  if (env.DATABASE_DRIVER === 'mongo' && !env.MONGODB_URI) {
    problems.push('DATABASE_DRIVER=mongo için MONGODB_URI gereklidir.');
  }
  if ((env.DATABASE_DRIVER === 'postgres' || env.DATABASE_DRIVER === 'supabase') && !hasPostgresConfig(env)) {
    problems.push('DATABASE_DRIVER=postgres/supabase için POSTGRES_URL (veya DATABASE_URL) gereklidir.');
  }
  if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
    problems.push('EMAIL_PROVIDER=resend seçildi ama RESEND_API_KEY boş.');
  }
  if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST && env.NODE_ENV !== 'production') {
    warnings.push(
      'E-posta sağlayıcısı tanımlı değil (RESEND_API_KEY ya da SMTP_HOST); geliştirmede e-postalar ' +
        'data/mail/ klasörüne yazılacak, GERÇEK gönderim yapılmayacak.',
    );
  }
  if (env.ALLOW_PUBLIC_REGISTRATION) {
    warnings.push(
      'ALLOW_PUBLIC_REGISTRATION açık: dışarıdan kayıt alınıyor. Kamuİlan politikası gereği üretimde kapalı olmalıdır.',
    );
  }
  if (env.SCAN_INTERVAL_MINUTES > 0 && env.SCAN_INTERVAL_MINUTES < 15) {
    warnings.push(
      `SCAN_INTERVAL_MINUTES=${env.SCAN_INTERVAL_MINUTES}: 15 dakikanın altı kaynakları yıpratır; ` +
        'tarama aralığı 15 dakikaya yükseltilir. Kaynak başına aralık için 0 bırakın.',
    );
  }
  if (env.APP_SECRET.length < 32) {
    warnings.push('APP_SECRET kısa: üretimde oturum imzası için en az 32 karakter kullanın.');
  }
  if (env.NODE_ENV === 'production' && !env.SOURCE_LIVE_FETCH) {
    warnings.push('Üretimde SOURCE_LIVE_FETCH=1 olmadan kaynaklar taranmaz.');
  }
  if (env.ADMIN_EMAIL === '' || env.ADMIN_PASSWORD === '') {
    warnings.push(
      'İlk yönetici hesabı için ADMIN_EMAIL/ADMIN_PASSWORD tanımlanmamış (seed:admin çalıştırılamaz).',
    );
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
    database:
      env.DATABASE_DRIVER === 'postgres' || env.DATABASE_DRIVER === 'supabase'
        ? 'supabase/postgres'
        : env.MONGODB_URI
          ? 'mongodb'
          : `file:${env.DATA_DIR}`,
    redis: env.REDIS_URL ? 'tanımlı' : 'yok (yerleşik kuyruk)',
    // E-posta yolu: hangi taşıyıcının seçileceğini maskeli olarak özetler.
    email:
      env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY
        ? 'resend'
        : env.SMTP_HOST
          ? `smtp:${env.SMTP_HOST}:${env.SMTP_PORT}`
          : 'dosya (geliştirme; e-posta gönderilmez)',
    // Test aşamasında 1; üretimde 0 ya da 30–360 önerilir.
    scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES === 0 ? 'kaynak başına' : env.SCAN_INTERVAL_MINUTES,
    publicRegistration: env.ALLOW_PUBLIC_REGISTRATION,
    liveFetch: env.SOURCE_LIVE_FETCH,
    scheduler: env.SCHEDULER_ENABLED,
    dataDir: env.DATA_DIR,
    rateLimit: `${env.RATE_LIMIT_MAX_REQUESTS}/${env.RATE_LIMIT_WINDOW_SECONDS}s`,
    appSecretSet: env.APP_SECRET.length >= 32,
    // Hangi dosyadan okunduğu (içerik değil) — ".env okunmadı" sorunlarını
    // ayıklamak için görünür tutulur.
    envFile: envFileSource() ?? 'yok (yalnızca ortam değişkenleri)',
    // Telegram: yalnızca token VE kullanıcı adı varsa etkin; sır değerleri gösterilmez.
    telegram:
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME
        ? `@${env.TELEGRAM_BOT_USERNAME} (webhook sırrı ${env.TELEGRAM_WEBHOOK_SECRET ? 'tanımlı' : 'yok'})`
        : 'kapalı',
    aiAssistant: env.AI_ASSISTANT_ENABLED ? `açık (${env.LLM_MODEL || 'model yok'})` : 'kapalı',
  };
}
