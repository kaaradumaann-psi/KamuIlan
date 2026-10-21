/**
 * Ortam değişkeni kataloğu: `env:setup` sihirbazının ve `env:check`
 * yönlendirmelerinin tek kaynağı.
 *
 * Neden ayrı katalog: `envSchema` (zod) değerleri DOĞRULAR; sihirbazın ise
 * her anahtar için "bu nedir, nereden bulunur, hangi koşula bağlı, nasıl
 * doğrulanır, örnek değeri ne" bilgisine ihtiyacı vardır. Bu bilgi şemanın
 * içine gömülemez (zod tanımları insan sorusu üretmez). Katalog burada tutulur
 * ve `src/config/env.ts` içindeki kurallarla birebir hizalıdır:
 *
 *  - `requiredIn` koşulları `collectEnvironmentProblems` ile aynıdır.
 *  - `validate` denetimleri zod dönüşümleriyle aynı sonucu üretir.
 *  - Anahtar listesi şemadaki 82 anahtarın tamamını kapsar
 *    (bkz. `tests/env-setup.test.ts` — eksik anahtar testi kırar).
 *
 * Gizlilik: `secret: true` alanlar hiçbir çıktıda düz metin gösterilmez;
 * çağıran taraf maskeler.
 */
import { existsSync } from 'node:fs';
import { caFilePathCandidates, expandPathTokens } from '../lib/ca-file';
import type { Env } from './env';
import { POSTGRES_URL_FORBIDDEN_TLS_PARAMS, postgresTlsMode } from './env';

export type EnvFieldType = 'string' | 'secret' | 'boolean' | 'number' | 'enum' | 'url' | 'email' | 'csv' | 'path';

export type EnvGroup =
  | 'genel'
  | 'guvenlik'
  | 'veritabani'
  | 'kuyruk'
  | 'tarama'
  | 'eposta'
  | 'telegram'
  | 'llm'
  | 'yonetim';

export const ENV_GROUP_LABELS: Record<EnvGroup, string> = {
  genel: 'Genel',
  guvenlik: 'Güvenlik',
  veritabani: 'Veritabanı (Supabase/Postgres)',
  kuyruk: 'Kuyruk ve zamanlayıcı',
  tarama: 'Kaynak tarama',
  eposta: 'E-posta',
  telegram: 'Telegram',
  llm: 'LLM / yapay zekâ',
  yonetim: 'Yönetim ve ilk hesap',
};

export const ENV_GROUP_ORDER: EnvGroup[] = [
  'genel',
  'guvenlik',
  'veritabani',
  'kuyruk',
  'tarama',
  'eposta',
  'telegram',
  'llm',
  'yonetim',
];

export interface EnvFieldSpec {
  key: string;
  group: EnvGroup;
  /** Kısa soru metni. */
  label: string;
  /** Ne işe yarar, nereden bulunur? */
  help: string;
  type: EnvFieldType;
  options?: string[];
  /**
   * Boş bırakılabilir mi?
   *
   * Katalogda `optional: false` YALNIZCA "şemada varsayılanı yok" anlamına
   * gelir; alanın ZORUNLU olması `required`/`requiredInProduction` ile
   * belirtilir. Boş bırakılan isteğe bağlı alan, şemanın varsayılanını alır.
   */
  optional?: boolean;
  /** Alan applicable olduğunda mutlaka dolu olmalı mı? (env.ts problems ile aynı) */
  required?: boolean;
  /** Değer girilmezse yazılacak değer. */
  defaultValue?: string;
  /**
   * `type: 'path'` alanlarında yolun diskte VAR OLMASI gerekir.
   *
   * Neden: `NODE_EXTRA_CA_CERTS` ya da `POSTGRES_SSL_CA_FILE` yanlış yazıldığında
   * hata süreç BAŞLARKEN çıkar ve mesaj kolayca gözden kaçar. Sihirbaz değeri
   * dosyaya yazmadan önce yakalar. `DATA_DIR` gibi çalışma zamanında oluşturulan
   * dizinler bu kuralın dışındadır.
   */
  mustExist?: boolean;
  /** Örnek değer (ekranda gösterilir; sır alanlarda gösterilmez). */
  example?: string;
  /** Değer ekran çıktısında maskelenir mi? */
  secret?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  pattern?: RegExp;
  /** Üretimde zorunlu mu? (env.ts problems ile aynı kural) */
  requiredInProduction?: boolean;
  /** Bu alan hangi koşula bağlı? (koşul sağlanmazsa sihirbaz soruyu atlar) */
  dependsOn?: (values: Record<string, string>) => boolean;
  /** Bağımlılık sağlanmadığında ekrana yazılan açıklama. */
  skipReason?: string;
  /** Alan bazında ek denetim; hata metni kullanıcıya gösterilir. */
  validate?: (value: string, values: Record<string, string>) => string | null;
  /**
   * Şemada (zod) OLMAYAN ama Node tarafından okunan anahtar.
   * Örnek: NODE_EXTRA_CA_CERTS — Node süreci başlarken okur, `Env` nesnesinde
   * taşınmaz; yine de sihirbazdan doldurulabilmelidir.
   */
  outsideSchema?: boolean;
  /** .env.example içinde bu anahtar için açıklama satırı var mı? (bilgi amaçlı) */
  docs?: string;
}

const truthy = (value: string | undefined): boolean => value === '1' || value?.toLowerCase() === 'true';

const wantsPostgres = (values: Record<string, string>): boolean => {
  const driver = (values['DATABASE_DRIVER'] ?? '').toLowerCase();
  if (driver === 'postgres' || driver === 'supabase') return true;
  if (driver === 'file' || driver === 'mongo') return false;
  return Boolean(values['POSTGRES_URL'] || values['DATABASE_URL']);
};

const resendSelected = (values: Record<string, string>): boolean =>
  (values['EMAIL_PROVIDER'] ?? '').toLowerCase() === 'resend';

const smtpSelected = (values: Record<string, string>): boolean =>
  (values['EMAIL_PROVIDER'] ?? '').toLowerCase() === 'smtp';

/** Bağlantı dizesinde yasak TLS parametresi var mı? (env.ts ile aynı liste) */
export function forbiddenTlsParamsInUrl(value: string): string[] {
  if (!value) return [];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (POSTGRES_URL_FORBIDDEN_TLS_PARAMS.includes(normalized)) found.add(normalized);
  }
  return [...found];
}

/**
 * Şemada varsayılanı olmayan ve boş bırakıldığında uygulamanın davranışını
 * belirsiz kılan alanlar `required: true` taşır. Diğer tüm alanlar boş
 * bırakılabilir: `envSchema` varsayılanı uygular.
 */
export const ENV_FIELDS: EnvFieldSpec[] = [
  /* --- Genel --- */
  {
    key: 'NODE_ENV',
    group: 'genel',
    label: 'Çalışma ortamı',
    help: 'development: yerel geliştirme. production: canlı (güvenlik denetimleri sertleşir). test: yalnızca testler.',
    type: 'enum',
    options: ['development', 'production', 'test'],
    defaultValue: 'development',
  },
  {
    key: 'APP_DISPLAY_NAME',
    group: 'genel',
    label: 'Uygulama adı',
    help: 'Arayüzde ve e-postalarda görünen ad.',
    type: 'string',
    defaultValue: 'Kamuİlan',
    optional: true,
  },
  {
    key: 'APP_BASE_URL',
    group: 'genel',
    label: 'Uygulamanın herkese açık adresi',
    help: 'E-posta/Telegram bağlantıları bu adresten üretilir. Sondaki / olmadan yazın.',
    type: 'url',
    example: 'https://kamuilan.example.com',
    requiredInProduction: true,
  },
  {
    key: 'APP_DOMAIN',
    group: 'genel',
    label: 'Uygulama alan adı',
    help: 'Çerez alan adı ve e-posta gönderen alan adı.',
    type: 'string',
    example: 'kamuilan.example.com',
    optional: true,
  },
  {
    key: 'PORT',
    group: 'genel',
    label: 'API portu',
    help: 'Vite geliştirme sunucusu /api isteklerini bu porta iletir.',
    type: 'number',
    integer: true,
    min: 1,
    max: 65535,
    defaultValue: '3000',
    optional: true,
  },
  {
    key: 'HOST',
    group: 'genel',
    label: 'Dinlenecek arayüz adresi',
    help: '0.0.0.0 tüm arayüzler (önizleme/konteyner için gerekir); 127.0.0.1 yalnızca yerel.',
    type: 'string',
    defaultValue: '0.0.0.0',
    optional: true,
  },
  {
    key: 'LOG_LEVEL',
    group: 'genel',
    label: 'Günlük düzeyi',
    help: 'Sorun çözerken debug; üretimde info.',
    type: 'enum',
    options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
    defaultValue: 'info',
    optional: true,
  },
  {
    key: 'DATA_DIR',
    group: 'genel',
    label: 'Veri dizini',
    help: 'Dosya deposu, geliştirme posta kutusu ve raporlar buraya yazılır.',
    type: 'path',
    defaultValue: './data',
    optional: true,
  },

  /* --- Güvenlik --- */
  {
    key: 'APP_SECRET',
    group: 'guvenlik',
    label: 'Uygulama sırrı (oturum/jeton imzası)',
    help: 'En az 32 karakter rastgele metin. Üretimde zorunludur. Örnek üretim: node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'base64url\'))"',
    type: 'secret',
    secret: true,
    required: true,
    requiredInProduction: true,
    validate: (value, values) => {
      if (value.length === 0) {
        // Geliştirmede boş APP_SECRET bir uyarıdır (env.ts ile aynı); üretimde engelleme.
        return values['NODE_ENV'] === 'production'
          ? 'APP_SECRET üretimde zorunludur (en az 32 karakter).'
          : null;
      }
      if (value.length < 32) return 'APP_SECRET en az 32 karakter olmalıdır (oturum/jeton imzası).';
      if (/^(dev-|test|secret|changeme|kamuilan)/i.test(value)) {
        return 'APP_SECRET tahmin edilebilir bir değer olmamalıdır; rastgele üretin.';
      }
      return null;
    },
  },
  {
    key: 'TRUST_PROXY',
    group: 'guvenlik',
    label: 'X-Forwarded-For başlığına güvenilsin mi?',
    help: 'Yalnızca uygulama başlığı KENDİSİ ÜRETEN bir vekilin (Cloudflare/Nginx) arkasındaysa 1. Yanlış açılırsa saldırgan hız sınırını atlar.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'CORS_ORIGINS',
    group: 'guvenlik',
    label: 'İzin verilen arayüz kaynakları (virgülle)',
    help: 'Geliştirmede Vite adresi. Boş bırakılırsa varsayılan liste kullanılır.',
    type: 'csv',
    example: 'http://localhost:5173,https://kamuilan.example.com',
    optional: true,
  },
  {
    key: 'DOCS_ENABLED',
    group: 'guvenlik',
    label: 'OpenAPI dokümanı (/api/docs) açık mı?',
    help: 'Üretimde kapalı olmalıdır; API yüzeyini dışarıya gösterir.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'CSRF_ENABLED',
    group: 'guvenlik',
    label: 'CSRF koruması',
    help: 'Kapatmak yalnızca özel bir entegrasyon gerekiyorsa değerlendirilir.',
    type: 'boolean',
    defaultValue: '1',
    optional: true,
  },
  {
    key: 'SESSION_TTL_HOURS',
    group: 'guvenlik',
    label: 'Oturum ömrü (saat)',
    help: 'Kullanıcı oturumunun geçerlilik süresi.',
    type: 'number',
    integer: true,
    min: 1,
    max: 24 * 365,
    optional: true,
  },
  {
    key: 'RATE_LIMIT_WINDOW_SECONDS',
    group: 'guvenlik',
    label: 'Hız sınırı penceresi (saniye)',
    help: 'Genel API hız sınırı penceresi.',
    type: 'number',
    integer: true,
    min: 1,
    optional: true,
  },
  {
    key: 'RATE_LIMIT_MAX_REQUESTS',
    group: 'guvenlik',
    label: 'Hız sınırı istek hakkı',
    help: 'Pencere başına izin verilen istek sayısı.',
    type: 'number',
    integer: true,
    min: 1,
    optional: true,
  },
  {
    key: 'AUTH_RATE_LIMIT_MAX_REQUESTS',
    group: 'guvenlik',
    label: 'Giriş denemesi sınırı',
    help: 'Oturum açma uçları için daha sıkı sınır (brute-force koruması).',
    type: 'number',
    integer: true,
    min: 1,
    optional: true,
  },
  {
    key: 'ALLOW_PUBLIC_REGISTRATION',
    group: 'guvenlik',
    label: 'Herkese açık kayıt',
    help: 'Kamuİlan politikası: hesaplar yönetici davetiyle açılır; bu ayar kapalı (0) kalmalıdır.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'PUBLIC_LISTINGS_ENABLED',
    group: 'guvenlik',
    label: 'Herkese açık ilan vitrini',
    help: 'Açıkken (1) oturumsuz ziyaretçi ilan listesi, detayı ve kaynakları görür; panel ve yönetim yine giriş ister. Ürün + KVKK kararıdır; varsayılan 0.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },

  /* --- Veritabanı --- */
  {
    key: 'DATABASE_DRIVER',
    group: 'veritabani',
    label: 'Depo sürücüsü',
    help: 'supabase/postgres: üretim. file: yerel geliştirme (tek JSON dosyası). mongo: eski kurulumlar.',
    type: 'enum',
    options: ['supabase', 'postgres', 'file', 'mongo'],
    defaultValue: 'supabase',
  },
  {
    key: 'POSTGRES_URL',
    group: 'veritabani',
    label: 'Supabase/Postgres bağlantı dizesi',
    help: 'Supabase → Project Settings → Database → Connection string. TLS parametresi (sslmode, sslrootcert) YAZMAYIN; bu uygulama TLS kararını POSTGRES_SSL_MODE ile verir.',
    type: 'secret',
    secret: true,
    dependsOn: wantsPostgres,
    skipReason: 'DATABASE_DRIVER=postgres/supabase seçilmedi.',
    validate: (value) => {
      if (!value) return null;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return 'Bağlantı dizesi postgres://user:pass@host:port/db biçiminde olmalıdır.';
      }
      if (!/^postgres(ql)?:$/.test(url.protocol)) return 'Şema postgres:// veya postgresql:// olmalıdır.';
      if (!url.hostname) return 'Bağlantı dizesinde sunucu adı yok.';
      if (!url.username) return 'Bağlantı dizesinde kullanıcı adı yok.';
      const forbidden = forbiddenTlsParamsInUrl(value);
      if (forbidden.length > 0) {
        return `Bağlantı dizesinde TLS parametresi olamaz (${forbidden.join(', ')}): POSTGRES_SSL_MODE kararını sessizce ezer. Parametreyi kaldırın.`;
      }
      return null;
    },
  },
  {
    key: 'DATABASE_URL',
    group: 'veritabani',
    label: 'Alternatif bağlantı dizesi (DATABASE_URL)',
    help: 'Bazı sağlayıcılar bu adı verir. POSTGRES_URL doluysa boş bırakın.',
    type: 'secret',
    secret: true,
    optional: true,
    dependsOn: (values) => wantsPostgres(values) && !values['POSTGRES_URL'],
    skipReason: 'POSTGRES_URL tanımlı.',
  },
  {
    key: 'POSTGRES_SSL',
    group: 'veritabani',
    label: 'Veritabanı TLS kullanılsın mı?',
    help: 'Supabase TLS ister (true). false yalnızca yerel/güvenili ağ Postgres\'inde; üretimde env:check engeller.',
    type: 'boolean',
    defaultValue: 'true',
    dependsOn: wantsPostgres,
    skipReason: 'Postgres seçilmedi.',
    optional: true,
  },
  {
    key: 'POSTGRES_SSL_MODE',
    group: 'veritabani',
    label: 'TLS doğrulama kipi',
    help: 'verify: sertifika doğrulanır (varsayılan ve önerilen). no-verify/disable: doğrulama kapalı — MITM riski; üretimde engellenir. Doğrulamayı kapatmayın.',
    type: 'enum',
    options: ['', 'verify', 'no-verify', 'disable'],
    defaultValue: 'verify',
    dependsOn: wantsPostgres,
    skipReason: 'Postgres seçilmedi.',
    optional: true,
  },
  {
    key: 'POSTGRES_SSL_CA_FILE',
    group: 'veritabani',
    label: 'CA sertifika dosyası yolu (PEM)',
    help: 'SELF_SIGNED_CERT_IN_CHAIN alıyorsanız Supabase → Database Settings → SSL Configuration bölümünden indirdiğiniz CA dosyası. Örnek: ./certs/supabase-ca.crt — boş bırakırsanız sistem kökleri kullanılır. Tanılama: npm run db:tls-doctor',
    type: 'path',
    mustExist: true,
    example: './certs/supabase-ca.crt',
    optional: true,
    dependsOn: wantsPostgres,
    skipReason: 'Postgres seçilmedi.',
  },
  {
    key: 'POSTGRES_SSL_CA_MERGE_SYSTEM',
    group: 'veritabani',
    label: 'CA dosyası sistem kökleriyle birleştirilsin mi?',
    help: '1: dosya kökleri + Node/Windows kökleri + NODE_EXTRA_CA_CERTS birlikte kullanılır (doğrulama açık kalır). Doğrudan bağlantı ile pooler farklı kök sunuyorsa ya da kurumsal TLS denetimi varsa gerekir.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
    dependsOn: (values) => wantsPostgres(values) && Boolean(values['POSTGRES_SSL_CA_FILE']),
    skipReason: 'POSTGRES_SSL_CA_FILE tanımlı değil (zaten sistem kökleri kullanılıyor).',
  },
  {
    key: 'NODE_EXTRA_CA_CERTS',
    group: 'veritabani',
    label: 'Ek kök sertifika dosyası (NODE_EXTRA_CA_CERTS)',
    help:
      'Kurumsal proxy/antivirüs TLS denetimi ya da eksik zincir sunan resmî siteler için. ' +
      'YALNIZCA yöneticinizden/doğrulayabildiğiniz kaynaktan aldığınız kökleri içeren PEM dosyası. ' +
      'Node bu dosyayı süreç BAŞLARKEN okur; bu yüzden süreç çalışırken değiştirilirse yeniden başlatın. ' +
      'Dosya bulunamazsa Node SESSİZCE yok sayar (uygulama çökmez ama kök de yüklenmez) — ' +
      'sihirbaz bu tuzağı engellemek için yolun var olduğunu doğrular. Örnek: C:/certs/kurum-ca.pem',
    type: 'path',
    mustExist: true,
    example: 'C:/certs/kurum-ca.pem',
    optional: true,
    outsideSchema: true,
  },
  {
    key: 'NODE_TLS_REJECT_UNAUTHORIZED',
    group: 'guvenlik',
    label: 'TLS doğrulamasını kapatma anahtarı (KALDIRILMALI)',
    help:
      'Node\'un acil durum anahtarıdır: 0 yazıldığında HTTPS ve Postgres dahil TÜM TLS ' +
      'bağlantılarında sertifika denetimi ATLANIR. Bu proje bunu bir çözüm olarak kabul etmez; ' +
      'doğru karşılık eksik kökü/zinciri tamamlamaktır: POSTGRES_SSL_CA_FILE (Supabase CA), ' +
      'POSTGRES_SSL_CA_MERGE_SYSTEM=1 (dosya + sistem kökleri), NODE_EXTRA_CA_CERTS (kurum kökü), ' +
      'Node 22.15+ (sistem kök deposu) ve npm run db:tls-doctor (kök nedeni otomatik bulur). ' +
      'Bu alanı BOŞALTMAK (:clear) anahtarı .env dosyasından kaldırır; kabukta/kullanıcı ' +
      'değişkenlerinde tanımlıysa ayrıca silinmelidir (Windows: setx NODE_TLS_REJECT_UNAUTHORIZED "").',
    type: 'enum',
    options: ['0', '1'],
    optional: true,
    outsideSchema: true,
  },
  {
    key: 'POSTGRES_MAX_CONNECTIONS',
    group: 'veritabani',
    label: 'En çok bağlantı (havuz boyutu)',
    help: 'Supabase ücretsiz katmanda küçük tutun (5-10). API + worker ayrı havuz açar.',
    type: 'number',
    integer: true,
    min: 1,
    max: 100,
    defaultValue: '5',
    optional: true,
    dependsOn: wantsPostgres,
    skipReason: 'Postgres seçilmedi.',
  },
  {
    key: 'SUPABASE_URL',
    group: 'veritabani',
    label: 'Supabase proje adresi',
    help: 'Supabase → Project Settings → API. Uygulama şu an veritabanı için POSTGRES_URL kullanır; bu alan panelden bilgi almak içindir.',
    type: 'url',
    example: 'https://<proje>.supabase.co',
    optional: true,
  },
  {
    key: 'SUPABASE_ANON_KEY',
    group: 'veritabani',
    label: 'Supabase anon anahtarı',
    help: 'Herkese açık anahtar. Kullanılmıyorsa boş bırakın.',
    type: 'secret',
    secret: true,
    optional: true,
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    group: 'veritabani',
    label: 'Supabase service role anahtarı',
    help: 'YALNIZCA sunucu tarafı; tarayıcıya asla verilmez, repoya yazılmaz.',
    type: 'secret',
    secret: true,
    optional: true,
  },
  {
    key: 'MONGODB_URI',
    group: 'veritabani',
    label: 'MongoDB bağlantı dizesi (eski kurulumlar)',
    help: 'Yalnızca DATABASE_DRIVER=mongo ise gerekir.',
    type: 'secret',
    secret: true,
    optional: true,
    dependsOn: (values) => (values['DATABASE_DRIVER'] ?? '').toLowerCase() === 'mongo',
    skipReason: 'DATABASE_DRIVER=mongo seçilmedi.',
    requiredInProduction: false,
  },
  {
    key: 'MONGODB_DB',
    group: 'veritabani',
    label: 'MongoDB veritabanı adı',
    help: 'Yalnızca MongoDB sürücüsü kullanılıyorsa.',
    type: 'string',
    defaultValue: 'kamuilan',
    optional: true,
    dependsOn: (values) => (values['DATABASE_DRIVER'] ?? '').toLowerCase() === 'mongo',
    skipReason: 'DATABASE_DRIVER=mongo seçilmedi.',
  },
  {
    key: 'REDIS_URL',
    group: 'veritabani',
    label: 'Redis adresi (BullMQ)',
    help: 'Boş bırakılırsa yerleşik (Postgres/dosya tabanlı) kuyruk kullanılır.',
    type: 'secret',
    secret: true,
    optional: true,
  },

  /* --- Kuyruk ve zamanlayıcı --- */
  {
    key: 'SCHEDULER_ENABLED',
    group: 'kuyruk',
    label: 'Zamanlanmış tarama açık mı?',
    help:
      'Worker sürecinde planlı taramaları çalıştırır. Varsayılan KAPALIDIR: ' +
      'start:worker tek başına tüm kaynakları taramaya başlamaz. Üretimde bilinçli olarak 1 yapın.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'SCHEDULER_TICK_MS',
    group: 'kuyruk',
    label: 'Zamanlayıcı adımı (ms)',
    help: 'Planlayıcının ne sıklıkta uyandığı.',
    type: 'number',
    integer: true,
    min: 1000,
    optional: true,
  },
  {
    key: 'SCAN_INTERVAL_MINUTES',
    group: 'kuyruk',
    label: 'Genel tarama aralığı (dakika)',
    help: '0 (önerilen): her kaynak kendi aralığıyla taranır. Pozitif değer tüm kaynakları eşitler; en küçük 15 dakikadır.',
    type: 'number',
    integer: true,
    min: 0,
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'WORKER_NAMESPACE',
    group: 'kuyruk',
    label: 'Worker ad alanı',
    help: 'Aynı veritabanını paylaşan farklı kurulumları ayırır.',
    type: 'string',
    defaultValue: 'kamuilan',
    optional: true,
  },
  {
    key: 'WORKER_CONCURRENCY',
    group: 'kuyruk',
    label: 'Worker eşzamanlılığı',
    help: 'Aynı anda işlenen iş sayısı. Küçük makinelerde 1-2.',
    type: 'number',
    integer: true,
    min: 1,
    optional: true,
  },

  /* --- Tarama --- */
  {
    key: 'SOURCE_LIVE_FETCH',
    group: 'tarama',
    label: 'Gerçek kaynaklara istek atılsın mı?',
    help:
      'Varsayılan 0: worker ağa çıkmaz; tarama "atlandı" kaydedilir, başarı sayılmaz. ' +
      'Gerçek tarama için SOURCE_LIVE_FETCH=1 ve SCHEDULER_ENABLED=1 AYRI AYRI bilinçli açılmalıdır.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'SOURCE_TLS_AIA_COMPLETION',
    group: 'tarama',
    label: 'Eksik sertifika zinciri AIA ile tamamlansın mı?',
    help:
      'Bazı resmî siteler (ilan.gov.tr, BDDK, TMSF) TLS\'te yalnızca yaprak sertifikayı gönderir; ' +
      'Node zinciri tamamlayamadığı için UNABLE_TO_VERIFY_LEAF_SIGNATURE verir. ' +
      '1: eksik ara sertifika, yapraktaki AIA adresinden indirilir; İMZASI, CA durumu ve süresi ' +
      'doğrulanır, zincir GÜVENİLEN bir köke bağlanıyorsa istek doğrulama AÇIKKEN yeniden denenir. ' +
      '0: tamamlama yapılmaz. Doğrulamayı kapatmaz; kapatmak için NODE_TLS_REJECT_UNAUTHORIZED=0 ' +
      'KULLANILMAZ.',
    type: 'boolean',
    defaultValue: '1',
    optional: true,
  },
  {
    key: 'SOURCE_BROWSER_FALLBACK',
    group: 'tarama',
    label: 'Tarayıcı yedeği (Chromium) kullanılsın mı?',
    help:
      'HTTP istemcisi cevap alamadığında (ECONNRESET/zaman aşımı) sayfa başsız Chromium ile okunur. ' +
      '0: tarayıcı hiç başlatılmaz, asıl HTTP hatası bildirilir. Chromium kurulu değilse ' +
      '(npx playwright install chromium) ya da sunucuda tarayıcı istenmiyorsa 0 yazın. ' +
      'Varsayılan 0 (güvenli): açıkça 1 yapılmadıkça tarayıcı başlatılmaz. ' +
      'Testlerde zorunlu olarak 0\'dır: Chromium gerçek ağa çıktığı için sahte istemciyi yanıltır.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'SCRAPE_TIMEOUT_MS',
    group: 'tarama',
    label: 'Tarama zaman bütçesi (ms)',
    help:
      'Tek kaynak taramasının toplam süresi. Resmî siteler yavaştır; çok düşük değer taramaları ' +
      'başarısız kılar. Süre bitmeye yaklaştığında adaptör yeni detay indirmeyi bırakır ve okunan ' +
      'satırları "kısmi" olarak kaydeder. Önerilen: 120000 (PDF ağırlıklı kaynaklarda 180000).',
    type: 'number',
    integer: true,
    // Şemayla aynı sınırlar (env.ts): sihirbazın kabul ettiği değeri şema reddetmesin.
    min: 5000,
    max: 300000,
    defaultValue: '120000',
    optional: true,
  },
  {
    key: 'SCRAPE_MAX_RETRIES',
    group: 'tarama',
    label: 'En çok yeniden deneme',
    help: 'Kaynak hatasında deneme sayısı.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'SCRAPE_USER_AGENT',
    group: 'tarama',
    label: 'Bot kimliği (User-Agent)',
    help: 'Uygulama kendini gizlemez; açık bot kimliği kullanır. Değiştirmeniz gerekmez.',
    type: 'string',
    optional: true,
  },
  {
    key: 'SOURCE_MIN_REQUEST_INTERVAL_MS',
    group: 'tarama',
    label: 'Kaynak başına en az istek aralığı (ms)',
    help: 'Resmî siteleri yıpratmamak için alt sınır.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'SOURCE_ALLOWED_HOSTS',
    group: 'tarama',
    label: 'Ek izinli ana makineler (virgülle)',
    help: 'Kaynak envanterindeki alan adlarına ek olarak izin verilecekler.',
    type: 'csv',
    optional: true,
  },
  {
    key: 'MAX_DOCUMENT_BYTES',
    group: 'tarama',
    label: 'En çok belge boyutu (bayt)',
    help: 'Büyük PDF/HTML indirmelerini sınırlar.',
    type: 'number',
    integer: true,
    min: 1024,
    optional: true,
  },
  {
    key: 'MAX_REDIRECTS',
    group: 'tarama',
    label: 'En çok yönlendirme',
    help: 'Yönlendirme döngülerini keser.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'DOCUMENT_TIMEOUT_MS',
    group: 'tarama',
    label: 'Belge (PDF) zaman aşımı (ms)',
    help: 'PDF indirme/çözümleme süresi.',
    type: 'number',
    integer: true,
    min: 1000,
    optional: true,
  },

  /* --- E-posta --- */
  {
    key: 'EMAIL_PROVIDER',
    group: 'eposta',
    label: 'E-posta sağlayıcısı',
    help: 'resend: üretim. smtp: kendi sunucunuz. file: geliştirme (e-posta data/mail içine yazılır, GERÇEK gönderim olmaz).',
    type: 'enum',
    options: ['resend', 'smtp', 'file'],
    defaultValue: 'file',
  },
  {
    key: 'RESEND_API_KEY',
    group: 'eposta',
    label: 'Resend API anahtarı',
    help: 'Resend → API Keys. Üretimde EMAIL_PROVIDER=resend ise zorunludur.',
    type: 'secret',
    secret: true,
    dependsOn: resendSelected,
    skipReason: 'EMAIL_PROVIDER=resend değil.',
    requiredInProduction: true,
    validate: (value) => (value && !value.startsWith('re_') ? 'Resend anahtarları "re_" ile başlar; değeri kontrol edin.' : null),
  },
  {
    key: 'RESEND_API_BASE_URL',
    group: 'eposta',
    label: 'Resend API adresi',
    help: 'Yalnızca özel bir vekil kullanıyorsanız değiştirin.',
    type: 'url',
    optional: true,
    dependsOn: resendSelected,
    skipReason: 'EMAIL_PROVIDER=resend değil.',
  },
  {
    key: 'SMTP_HOST',
    group: 'eposta',
    label: 'SMTP sunucu adresi',
    help: 'EMAIL_PROVIDER=smtp ise zorunludur. Boş bırakırsanız geliştirmede yerel posta sunucusu kullanılır.',
    type: 'string',
    example: 'smtp.example.com',
    dependsOn: smtpSelected,
    skipReason: 'EMAIL_PROVIDER=smtp değil.',
    requiredInProduction: true,
  },
  {
    key: 'SMTP_PORT',
    group: 'eposta',
    label: 'SMTP portu',
    help: '587 (STARTTLS) ya da 465 (TLS). Yerel geliştirme sunucusu 1025.',
    type: 'number',
    integer: true,
    min: 1,
    max: 65535,
    dependsOn: smtpSelected,
    skipReason: 'EMAIL_PROVIDER=smtp değil.',
    optional: true,
  },
  {
    key: 'SMTP_SECURE',
    group: 'eposta',
    label: 'SMTP doğrudan TLS (465)?',
    help: '465 için 1, 587 (STARTTLS) için 0.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
    dependsOn: smtpSelected,
    skipReason: 'EMAIL_PROVIDER=smtp değil.',
  },
  {
    key: 'SMTP_TLS_INSECURE',
    group: 'eposta',
    label: 'SMTP sertifika doğrulaması kapatılsın mı? (ÖNERİLMEZ)',
    help:
      'Varsayılan 0: SMTP sunucusunun sertifikası doğrulanır. 1 yazmak doğrulamayı KAPATIR; TLS ' +
      'kullanılsa bile sunucu kimliği doğrulanmaz ve SMTP_USER/SMTP_PASS ortadaki adama açık kalır. ' +
      'Sertifika hatasının doğru çözümü eksik kökü eklemektir: NODE_EXTRA_CA_CERTS=./certs/kurum-koku.pem ' +
      '(kendinden imzalı geliştirme sunucusu için bile doğrulamayı kapatmayın; kökü dosyaya koyun).',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
    dependsOn: smtpSelected,
    skipReason: 'EMAIL_PROVIDER=smtp değil.',
  },
  {
    key: 'SMTP_USER',
    group: 'eposta',
    label: 'SMTP kullanıcı adı',
    help: 'Sağlayıcının verdiği kullanıcı.',
    type: 'string',
    optional: true,
    dependsOn: smtpSelected,
    skipReason: 'EMAIL_PROVIDER=smtp değil.',
  },
  {
    key: 'SMTP_PASS',
    group: 'eposta',
    label: 'SMTP parolası',
    help: 'Üretimde "dev-" ile başlayan geliştirme parolası kullanılamaz.',
    type: 'secret',
    secret: true,
    optional: true,
    dependsOn: smtpSelected,
    skipReason: 'EMAIL_PROVIDER=smtp değil.',
    validate: (value) =>
      value.startsWith('dev-') ? 'Üretimde geliştirme SMTP parolası (dev-…) kullanılamaz.' : null,
  },
  {
    key: 'EMAIL_FROM',
    group: 'eposta',
    label: 'Gönderen adresi',
    help: 'Doğrulanmış alan adından olmalıdır; aksi halde gönderim reddedilir.',
    type: 'email',
    example: 'bildirim@kamuilan.example.com',
    dependsOn: (values) => resendSelected(values) || smtpSelected(values),
    skipReason: 'E-posta sağlayıcısı file (geliştirme).',
    requiredInProduction: true,
  },
  {
    key: 'EMAIL_VERIFICATION_SECRET',
    group: 'eposta',
    label: 'E-posta doğrulama sırrı',
    help: 'Doğrulama bağlantılarının imzası. Üretimde en az 32 karakter.',
    type: 'secret',
    secret: true,
    optional: true,
    requiredInProduction: true,
    validate: (value) =>
      value && value.length < 32 ? 'EMAIL_VERIFICATION_SECRET üretimde en az 32 karakter olmalıdır.' : null,
  },
  {
    key: 'EMAIL_DEV_FILE_TRANSPORT',
    group: 'eposta',
    label: 'Geliştirmede dosyaya yazma',
    help: '1: e-postalar data/mail içine yazılır (gerçek gönderim yok).',
    type: 'boolean',
    defaultValue: '1',
    optional: true,
  },
  {
    key: 'EMAIL_MAX_ATTEMPTS',
    group: 'eposta',
    label: 'E-posta deneme sayısı',
    help: 'Teslim başarısız olursa yeniden deneme üst sınırı.',
    type: 'number',
    integer: true,
    min: 1,
    optional: true,
  },
  {
    key: 'EMAIL_RETRY_BASE_MS',
    group: 'eposta',
    label: 'Yeniden deneme taban süresi (ms)',
    help: 'Artan gecikme (backoff) tabanı.',
    type: 'number',
    integer: true,
    min: 100,
    optional: true,
  },
  {
    key: 'DEV_MAIL_VIEWER_PORT',
    group: 'eposta',
    label: 'Geliştirme posta görüntüleyici portu',
    help: 'npm run dev ile açılan yerel posta kutusu arayüzü (http://localhost:1080).',
    type: 'number',
    integer: true,
    min: 1,
    max: 65535,
    defaultValue: '1080',
    optional: true,
  },

  /* --- Telegram --- */
  {
    key: 'TELEGRAM_BOT_TOKEN',
    group: 'telegram',
    label: 'Telegram bot jetonu',
    help: 'BotFather → /token. Boş bırakırsanız Telegram bildirimleri kapalı kalır.',
    type: 'secret',
    secret: true,
    optional: true,
  },
  {
    key: 'TELEGRAM_BOT_USERNAME',
    group: 'telegram',
    label: 'Telegram bot kullanıcı adı',
    help: 'Jeton tanımlıysa zorunludur; "bot" ile biter (ör. KamuIlanBildirim_BOT).',
    type: 'string',
    example: 'KamuIlanBildirim_BOT',
    pattern: /^[A-Za-z0-9_]{3,30}bot$/i,
    dependsOn: (values) => Boolean(values['TELEGRAM_BOT_TOKEN']),
    skipReason: 'TELEGRAM_BOT_TOKEN boş.',
    validate: (value, values) =>
      values['TELEGRAM_BOT_TOKEN'] && !value
        ? 'TELEGRAM_BOT_TOKEN tanımlı ama kullanıcı adı boş; bağlantı üretilemez.'
        : null,
  },
  {
    key: 'TELEGRAM_WEBHOOK_SECRET',
    group: 'telegram',
    label: 'Telegram webhook sırrı',
    help: '1-256 karakter (A-Z a-z 0-9 _ -). Üretimde jeton tanımlıysa zorunludur.',
    type: 'secret',
    secret: true,
    pattern: /^[A-Za-z0-9_-]{1,256}$/,
    dependsOn: (values) => Boolean(values['TELEGRAM_BOT_TOKEN']),
    skipReason: 'TELEGRAM_BOT_TOKEN boş.',
    requiredInProduction: true,
  },
  {
    key: 'TELEGRAM_API_BASE_URL',
    group: 'telegram',
    label: 'Telegram API adresi',
    help: 'Yalnızca vekil kullanıyorsanız değiştirin.',
    type: 'url',
    optional: true,
    dependsOn: (values) => Boolean(values['TELEGRAM_BOT_TOKEN']),
    skipReason: 'TELEGRAM_BOT_TOKEN boş.',
  },

  /* --- LLM --- */
  {
    key: 'AI_ASSISTANT_ENABLED',
    group: 'llm',
    label: 'Kullanıcıya açık yapay zekâ yardımcısı',
    help: 'Açmak için LLM_BASE_URL + LLM_API_KEY + LLM_MODEL zorunludur.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'LLM_CLASSIFIER_ENABLED',
    group: 'llm',
    label: 'LLM sınıflandırma kapısı',
    help: 'Kuralların kararsız kaldığı duyurular için ikinci aşama denetimi. Kanıtı doğrulanamayan karar yayımlanmaz.',
    type: 'boolean',
    defaultValue: '0',
    optional: true,
  },
  {
    key: 'LLM_BASE_URL',
    group: 'llm',
    label: 'LLM sağlayıcı adresi (OpenAI uyumlu)',
    help: 'Üretimde https:// zorunludur (kişisel profil verisi taşınır). Örnek: https://generativelanguage.googleapis.com/v1beta/openai',
    type: 'url',
    example: 'https://generativelanguage.googleapis.com/v1beta/openai',
    dependsOn: (values) => truthy(values['AI_ASSISTANT_ENABLED']) || truthy(values['LLM_CLASSIFIER_ENABLED']),
    skipReason: 'AI_ASSISTANT_ENABLED ve LLM_CLASSIFIER_ENABLED kapalı.',
    validate: (value, values) => {
      if (!value) return null;
      const production = (values['NODE_ENV'] ?? 'development') === 'production';
      if (production && !value.startsWith('https://')) return 'Üretimde LLM_BASE_URL https:// ile başlamalıdır.';
      return null;
    },
  },
  {
    key: 'LLM_API_KEY',
    group: 'llm',
    label: 'LLM API anahtarı',
    help: 'Sağlayıcının anahtarı. Sır değerdir; repoya yazılmaz.',
    type: 'secret',
    secret: true,
    dependsOn: (values) => truthy(values['AI_ASSISTANT_ENABLED']) || truthy(values['LLM_CLASSIFIER_ENABLED']),
    skipReason: 'AI_ASSISTANT_ENABLED ve LLM_CLASSIFIER_ENABLED kapalı.',
  },
  {
    key: 'LLM_MODEL',
    group: 'llm',
    label: 'LLM modeli (yardımcı)',
    help: 'Örnek: gemini-2.5-flash.',
    type: 'string',
    example: 'gemini-2.5-flash',
    dependsOn: (values) => truthy(values['AI_ASSISTANT_ENABLED']) || truthy(values['LLM_CLASSIFIER_ENABLED']),
    skipReason: 'AI_ASSISTANT_ENABLED ve LLM_CLASSIFIER_ENABLED kapalı.',
  },
  {
    key: 'LLM_CLASSIFIER_MODEL',
    group: 'llm',
    label: 'LLM modeli (sınıflandırma)',
    help: 'Boş bırakılırsa LLM_MODEL kullanılır.',
    type: 'string',
    optional: true,
    dependsOn: (values) => truthy(values['LLM_CLASSIFIER_ENABLED']),
    skipReason: 'LLM_CLASSIFIER_ENABLED kapalı.',
  },
  {
    key: 'AI_PROVIDER_LABEL',
    group: 'llm',
    label: 'Sağlayıcı etiketi',
    help: 'Arayüzde gösterilen ad (ör. Gemini).',
    type: 'string',
    optional: true,
  },
  {
    key: 'LLM_TIMEOUT_MS',
    group: 'llm',
    label: 'LLM zaman aşımı (ms)',
    help: 'Sağlayıcı yanıt süresi üst sınırı.',
    type: 'number',
    integer: true,
    min: 1000,
    optional: true,
  },
  {
    key: 'AI_DAILY_LIMIT_PER_USER',
    group: 'llm',
    label: 'Kullanıcı başına günlük yardımcı sınırı',
    help: 'Kötüye kullanımı ve maliyeti sınırlar.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'LLM_MAX_INPUT_CHARS',
    group: 'llm',
    label: 'Sınıflandırmada en çok girdi karakteri',
    help: 'Uzun metinler kırpılır; maliyet kontrolü.',
    type: 'number',
    integer: true,
    min: 100,
    optional: true,
  },
  {
    key: 'LLM_MAX_CALLS_PER_RUN',
    group: 'llm',
    label: 'Tarama başına en çok LLM çağrısı',
    help: 'Bir tarama koşumunda yapılacak çağrı üst sınırı.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'LLM_DAILY_CALL_LIMIT',
    group: 'llm',
    label: 'Günlük LLM çağrı sınırı',
    help: 'Kota/maliyet koruması.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'LLM_MAX_CONCURRENCY',
    group: 'llm',
    label: 'Eşzamanlı LLM çağrısı',
    help: 'Sağlayıcı hız sınırına göre ayarlayın.',
    type: 'number',
    integer: true,
    min: 1,
    optional: true,
  },
  {
    key: 'LLM_RETRY_MAX',
    group: 'llm',
    label: 'LLM yeniden deneme sayısı',
    help: 'Geçici sağlayıcı hatalarında deneme üst sınırı.',
    type: 'number',
    integer: true,
    min: 0,
    optional: true,
  },
  {
    key: 'LLM_COST_USD_PER_MTOK_INPUT',
    group: 'llm',
    label: 'Girdi maliyeti (USD / milyon token)',
    help: 'Boş bırakılırsa maliyet RAPORLANMAZ (uydurulmaz). Sağlayıcı fiyatını doğrulayarak yazın.',
    type: 'string',
    optional: true,
    validate: (value) => validateUsdPerMtok('LLM_COST_USD_PER_MTOK_INPUT', value),
  },
  {
    key: 'LLM_COST_USD_PER_MTOK_OUTPUT',
    group: 'llm',
    label: 'Çıktı maliyeti (USD / milyon token)',
    help: 'Boş bırakılırsa maliyet RAPORLANMAZ (uydurulmaz). Sağlayıcı fiyatını doğrulayarak yazın.',
    type: 'string',
    optional: true,
    validate: (value) => validateUsdPerMtok('LLM_COST_USD_PER_MTOK_OUTPUT', value),
  },
  {
    key: 'LLM_RUN_COST_LIMIT_USD',
    group: 'llm',
    label: 'Tek worker koşusu için tahmini USD tavanı',
    help: 'Maliyet rezervasyonu için pozitif limit. Her iki resmi fiyat varsayımı olmadan LLM çağrısı fail-closed kalır; sağlayıcı faturası garantisi değildir.',
    type: 'number',
    min: 0.000001,
    max: 100000,
    optional: true,
    dependsOn: (values) => truthy(values['AI_ASSISTANT_ENABLED']) || truthy(values['LLM_CLASSIFIER_ENABLED']),
    skipReason: 'AI/LLM özellikleri kapalı.',
    validate: (value) => validateUsdBudgetLimit('LLM_RUN_COST_LIMIT_USD', value),
  },
  {
    key: 'LLM_DAILY_COST_LIMIT_USD',
    group: 'llm',
    label: 'Tüm worker’lar için 24 saatlik tahmini USD tavanı',
    help: 'Atomik ortak maliyet rezervasyonu. Her iki resmi fiyat varsayımı olmadan LLM çağrısı fail-closed kalır; sağlayıcı faturası garantisi değildir.',
    type: 'number',
    min: 0.000001,
    max: 100000,
    optional: true,
    dependsOn: (values) => truthy(values['AI_ASSISTANT_ENABLED']) || truthy(values['LLM_CLASSIFIER_ENABLED']),
    skipReason: 'AI/LLM özellikleri kapalı.',
    validate: (value) => validateUsdBudgetLimit('LLM_DAILY_COST_LIMIT_USD', value),
  },

  /* --- Yönetim --- */
  {
    key: 'ADMIN_EMAIL',
    group: 'yonetim',
    label: 'İlk yönetici e-postası',
    help: 'npm run seed:admin bu değerle ilk yönetici hesabını oluşturur.',
    type: 'email',
    example: 'yonetici@example.com',
    optional: true,
  },
  {
    key: 'ADMIN_PASSWORD',
    group: 'yonetim',
    label: 'İlk yönetici parolası',
    help: 'Uzun ve rastgele seçin. Seed sonrası .env içinden kaldırmanız önerilir.',
    type: 'secret',
    secret: true,
    optional: true,
    validate: (value) => (value && value.length < 12 ? 'ADMIN_PASSWORD en az 12 karakter olmalıdır.' : null),
  },
];

function validateUsdPerMtok(name: string, value: string): string | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
    return `${name} 0 ile 10000 arasında bir sayı ya da boş olmalıdır (USD / milyon token).`;
  }
  return null;
}

function validateUsdBudgetLimit(name: string, value: string): string | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000) {
    return `${name} 0'dan büyük ve 100000 USD veya daha az olmalıdır.`;
  }
  return null;
}

/** Şemada olmayan ama sihirbazdan doldurulabilen anahtarlar. */
export function outsideSchemaKeys(): string[] {
  return ENV_FIELDS.filter((field) => field.outsideSchema).map((field) => field.key);
}

/** Anahtar → katalog kaydı. */
export const ENV_FIELD_BY_KEY: Map<string, EnvFieldSpec> = new Map(ENV_FIELDS.map((field) => [field.key, field]));

/** Katalogdaki tüm anahtarlar (şema kapsamı denetimi için). */
export function envFieldKeys(): string[] {
  return ENV_FIELDS.map((field) => field.key);
}

/** Bir grup içindeki alanlar (katalog sırasıyla). */
export function envFieldsForGroup(group: EnvGroup): EnvFieldSpec[] {
  return ENV_FIELDS.filter((field) => field.group === group);
}

/**
 * Alanın sorulup sorulmayacağı. Bağımlılık koşulu sağlanmazsa atlanır ve
 * nedeni kullanıcıya gösterilir (sessiz atlama yok).
 */
export function isFieldApplicable(field: EnvFieldSpec, values: Record<string, string>): boolean {
  return field.dependsOn ? field.dependsOn(values) : true;
}

export interface FieldValidation {
  ok: boolean;
  message: string | null;
}

/**
 * E-posta adresi denetimi.
 *
 * `EMAIL_FROM` "Görünen Ad <adres@alan>" biçimini de kabul eder (nodemailer ve
 * Resend bu biçimi kullanır); bu yüzden önce basit adres, sonra ad+adres
 * kalıbı denenir. Görünen ad Unicode (Türkçe) karakter içerebilir.
 */
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const NAMED_EMAIL_PATTERN = /^[^<>@\n]+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/;

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  return EMAIL_PATTERN.test(trimmed) || NAMED_EMAIL_PATTERN.test(trimmed);
}

/** Tür + kural denetimi (zod'dan bağımsız, sihirbaz anında geri bildirim verir). */
export interface FieldValueOptions {
  /** Göreli yolların çözüleceği kök (varsayılan: süreç çalışma dizini). */
  pathRoot?: string;
}

export function validateFieldValue(
  field: EnvFieldSpec,
  rawValue: string,
  values: Record<string, string> = {},
  options: FieldValueOptions = {},
): FieldValidation {
  const value = rawValue.trim();

  if (value === '') {
    // Boş değer, şemanın varsayılanına düşer. Yalnızca alan ÖRTÜK olarak
    // zorunlu işaretlenmişse (ör. APP_SECRET) alan bazında denetim yapılır.
    if (field.validate) {
      const message = field.validate('', values);
      if (message) return { ok: false, message };
    }
    return { ok: true, message: null };
  }

  switch (field.type) {
    case 'boolean': {
      if (!['0', '1', 'true', 'false'].includes(value.toLowerCase())) {
        return { ok: false, message: `${field.key} için 1/0 (true/false) yazın.` };
      }
      break;
    }
    case 'number': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { ok: false, message: `${field.key} sayı olmalıdır.` };
      if (field.integer && !Number.isInteger(parsed)) {
        return { ok: false, message: `${field.key} tam sayı olmalıdır.` };
      }
      if (field.min !== undefined && parsed < field.min) {
        return { ok: false, message: `${field.key} en az ${field.min} olmalıdır.` };
      }
      if (field.max !== undefined && parsed > field.max) {
        return { ok: false, message: `${field.key} en çok ${field.max} olmalıdır.` };
      }
      break;
    }
    case 'enum': {
      if (field.options && !field.options.includes(value)) {
        return { ok: false, message: `${field.key} şu değerlerden biri olmalıdır: ${field.options.join(', ')}` };
      }
      break;
    }
    case 'url': {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { ok: false, message: `${field.key} geçerli bir adres olmalıdır (https:// ile başlayan).` };
      }
      if (!/^https?:$/.test(url.protocol)) {
        return { ok: false, message: `${field.key} http(s) adresi olmalıdır.` };
      }
      break;
    }
    case 'email': {
      if (!isValidEmail(value)) {
        return {
          ok: false,
          message: `${field.key} geçerli bir e-posta adresi olmalıdır (ör. adres@alan.tr ya da "Ad <adres@alan.tr>").`,
        };
      }
      break;
    }
    case 'csv': {
      const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) return { ok: false, message: `${field.key} en az bir değer içermelidir.` };
      break;
    }
    case 'path': {
      if (field.mustExist) {
        const root = options.pathRoot ?? process.cwd();
        const candidates = caFilePathCandidates(expandPathTokens(value), root);
        if (!candidates.some((candidate) => existsSync(candidate))) {
          return {
            ok: false,
            message: `${field.key} dosyası bulunamadı: ${candidates.join(' · ')}`,
          };
        }
      }
      break;
    }
    default:
      break;
  }

  if (field.pattern && !field.pattern.test(value)) {
    return { ok: false, message: `${field.key} biçimi geçersiz: ${field.pattern}` };
  }
  if (field.validate) {
    const message = field.validate(value, values);
    if (message) return { ok: false, message };
  }
  return { ok: true, message: null };
}

/**
 * Bir alan için zorunluluk durumu.
 *
 * Üretim kuralları `src/config/env.ts` içindeki `collectEnvironmentProblems`
 * ile aynıdır; sihirbaz yalnızca erken uyarı verir, son karar her zaman
 * `getEnv()` doğrulamasınındır.
 */
export function isFieldRequired(field: EnvFieldSpec, values: Record<string, string>): boolean {
  const production = (values['NODE_ENV'] ?? 'development') === 'production';
  if (field.required && !(field.key === 'APP_SECRET' && !production)) return true;
  if (field.requiredInProduction && production) return true;
  if (field.key === 'POSTGRES_URL' && wantsPostgres(values) && !values['DATABASE_URL']) return true;
  if (field.key === 'MONGODB_URI' && (values['DATABASE_DRIVER'] ?? '').toLowerCase() === 'mongo') return true;
  if (field.key === 'LLM_BASE_URL' || field.key === 'LLM_API_KEY' || field.key === 'LLM_MODEL') {
    if (truthy(values['AI_ASSISTANT_ENABLED'])) return true;
  }
  if (field.key === 'SMTP_HOST' && smtpSelected(values)) return true;
  return false;
}

/** Sihirbazın ekranda göstereceği maskeli değer. */
export function maskValue(field: EnvFieldSpec, value: string): string {
  if (!value) return '(boş)';
  if (!field.secret) return value;
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}••••${value.slice(-3)} (${value.length} karakter)`;
}

/**
 * Sihirbaz sonrası özet: eksik/uyarı veren alanlar.
 *
 * `env.ts` doğrulaması çalıştırılamadığında (ör. değerler henüz yazılmadı)
 * kullanıcıya hangi anahtarın doldurulması gerektiğini söyler.
 */
export function summarizeMissingFields(values: Record<string, string>): { missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];
  for (const field of ENV_FIELDS) {
    if (!isFieldApplicable(field, values)) continue;
    const value = values[field.key] ?? '';
    if (isFieldRequired(field, values) && !value) missing.push(field.key);
    if (field.key === 'APP_SECRET' && value && value.length < 32) {
      warnings.push('APP_SECRET kısa: üretimde en az 32 karakter kullanın.');
    }
  }
  return { missing, warnings };
}

/** Veritabanı TLS kararı özeti (sihirbazın son adımı ve env:check ile aynı dil). */
export function summarizeTlsDecision(values: Record<string, string>, env?: Env): string {
  if (!wantsPostgres(values)) return 'Veritabanı: Postgres seçilmedi; TLS denetimi yapılmadı.';
  const mode = env ? postgresTlsMode(env) : (values['POSTGRES_SSL_MODE'] || 'verify');
  const caFile = values['POSTGRES_SSL_CA_FILE'] ?? '';
  const merge = truthy(values['POSTGRES_SSL_CA_MERGE_SYSTEM']);
  if (mode !== 'verify') {
    return `Veritabanı TLS: ${mode} — DOĞRULAMA KAPALI. MITM riski; üretimde env:check engeller. Önerilen: verify.`;
  }
  if (!caFile) {
    return 'Veritabanı TLS: verify — Node gömülü kökleri + sistem deposu + NODE_EXTRA_CA_CERTS kullanılıyor (ek dosya yok).';
  }
  return merge
    ? `Veritabanı TLS: verify — CA dosyası (${caFile}) + sistem kökleri BİRLEŞTİRİLİYOR.`
    : `Veritabanı TLS: verify — YALNIZCA CA dosyası (${caFile}); sistem kökleri birleştirilmiyor. Gerekirse POSTGRES_SSL_CA_MERGE_SYSTEM=1.`;
}
