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
import { invalidTrustProxyEntries, parseTrustProxy } from './trust-proxy';
import { inspectCaFile } from '../lib/ca-file';
import { effectiveDriver } from '../db/store';
import { describeTlsVerificationOverride, systemCaStoreAvailable, tlsVerificationDisabled } from '../lib/tls-trust';
import { describeLlmEndpointRisk } from '../ai/llm';
import { existsSync, readFileSync } from 'node:fs';
import { envFileSource, loadEnvFile, parseEnvFile } from './load-env';

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

/**
 * Maliyet varsayımı alanı: boş → `null` (hiç tahmin üretme), sayı → USD/Mtok.
 * Geçersiz değer sessizce yok sayılmaz; yapılandırma hatası olarak patlar.
 */
function usdPerMtokField(name: string) {
  return z.string().default('').transform((value): number | null => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
      throw new Error(`${name} 0 ile 10000 arasında bir sayı ya da boş olmalıdır (USD / milyon token).`);
    }
    return parsed;
  });
}

/** Hard estimate limit: empty means unconfigured; zero cannot be used as a paid-call budget. */
function usdBudgetLimitField(name: string) {
  return z.string().default('').transform((value): number | null => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000) {
      throw new Error(`${name} 0'dan büyük ve 100000 USD veya daha az olmalıdır (ya da boş bırakılmalıdır).`);
    }
    return parsed;
  });
}

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
   *
   * Daha güvenli biçim: güvenilen vekil adreslerini listeleyin (`cloudflare`,
   * `10.0.0.0/8`, `uniquelocal` …). O zaman başlık yalnızca bu adreslerden gelen
   * isteklerde değerlendirilir; kökene doğrudan gelen istek sahte IP yazamaz.
   * Ayrıntı: `src/config/trust-proxy.ts`.
   */
  TRUST_PROXY: z
    .string()
    .default('0')
    .superRefine((value, ctx) => {
      const invalid = invalidTrustProxyEntries(value);
      if (invalid.length > 0) {
        ctx.addIssue({ code: 'custom', message: `TRUST_PROXY geçersiz öğe içeriyor: ${invalid.join(', ')}` });
      }
    })
    .transform((value) => parseTrustProxy(value)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Kalıcı JSON log dosyası (boş = yalnız standart çıktı). Her süreç ayrı dosya kullanmalı. */
  LOG_FILE: z.string().default(''),
  LOG_FILE_MAX_MB: z.coerce.number().int().min(1).max(1_024).default(20),
  LOG_FILE_MAX_FILES: z.coerce.number().int().min(1).max(50).default(5),
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
  /**
   * Veritabanı TLS sertifika zinciri (PEM dosyasının yolu). Tanımlanırsa sunucu sertifikası
   * YALNIZCA bu CA ile doğrulanır. Tanımlı değilse doğrulama Node'un varsayılan + işletim
   * sisteminin kök depolarıyla yapılır (Supabase genel CA ile imzalı olduğu için ek dosya
   * gerekmez). Doğrulamayı kapatmanın tek yolu POSTGRES_SSL_MODE'dur.
   */
  POSTGRES_SSL_CA_FILE: z.string().default(''),
  /**
   * CA dosyası sistem kökleriyle BİRLEŞTİRİLSİN mi? (varsayılan: 0)
   *
   *  - `0` (varsayılan): sunucu sertifikası YALNIZCA `POSTGRES_SSL_CA_FILE`
   *    içindeki köklerle doğrulanır (pinning). Dosya yanlış/eksikse bağlantı
   *    `SELF_SIGNED_CERT_IN_CHAIN` ile reddedilir.
   *  - `1`: dosya kökleri Node'un gömülü Mozilla kökleri + işletim sistemi
   *    deposu + `NODE_EXTRA_CA_CERTS` ile birleştirilir. Doğrulama AÇIK kalır;
   *    yalnızca güven kümesi genişler. Ne zaman gerekir: aynı anda hem Supabase
   *    proje CA'sına hem kurumsal TLS denetimi köküne güvenmek gerektiğinde,
   *    ya da doğrudan bağlantı ile pooler farklı kök sunduğunda.
   */
  POSTGRES_SSL_CA_MERGE_SYSTEM: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
  /**
   * TLS doğrulama kipi. Boş bırakılırsa `POSTGRES_SSL` ile geriye dönük uyum korunur:
   *  - `''` (varsayılan): `POSTGRES_SSL=1` → `verify`, `POSTGRES_SSL=0` → `disable`.
   *  - `verify`   : sunucu sertifikası doğrulanır (CA verilmişse o CA, yoksa sistem depoları).
   *  - `no-verify`: TLS kullanılır ama sertifika doğrulanmaz — açık risk kabulü; üretimde
   *                 `env:check` bunu ENGELLEME sayar, geliştirme/testte uyarı verir.
   *  - `disable`  : TLS hiç kullanılmaz (yalnızca yerel/güvenili ağ Postgres'i).
   * `disable` ve `no-verify` sessiz varsayılan DEĞİLDİR. Bağlantı dizesi (URL) içinde
   * TLS parametresi (`sslmode`, `ssl`, `sslrootcert`…) KULLANILAMAZ: pg, URL'yi açık
   * `ssl` nesnesinin ÜZERİNE yazar; `sslmode=disable` yazan bir URL, buradaki `verify`
   * kararını sessizce ezip TLS'i kapatabilirdi. Bu parametreler `postgresUrl()` içinde
   * REDDEDİLİR (bkz. `postgresUrlTlsConflicts`); tek yetkili `POSTGRES_SSL_MODE` ve
   * `POSTGRES_SSL_CA_FILE`dir.
   */
  POSTGRES_SSL_MODE: z.enum(['', 'verify', 'no-verify', 'disable']).default(''),

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
    // GÜVENLİ VARSAYILAN: start:worker tek başına tüm kaynakları taramaz.
    // Üretimde canlı tarama için SOURCE_LIVE_FETCH ile AYRI AYRI açılmalıdır.
    .default('0')
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
  /**
   * Tek kaynak taramasının TOPLAM zaman bütçesi (ms).
   *
   * 120 sn'ye yükseltildi (önceki 60 sn): PDF ağırlıklı kaynaklar (Resmî Gazete)
   * ve tarayıcı yedeği kullanan kurum siteleri tek koşumda 60 sn'yi aşıyordu;
   * bütçe dolunca koşum TAMAMEN başarısız sayılıyor ve o ana kadar okunan
   * satırlar çöpe gidiyordu (canlı döküm: resmigazete 21 ardışık başarısızlık,
   * "zaman aşımına uğradı (60000 ms)"). Artık adaptörler bütçeden pay düşerek
   * çalışır (`src/sources/scan-budget.ts`): süre bitmeye yakınsa yeni detay/PDF
   * indirilmez, okunanlar "kısmi" kapsamla kaydedilir.
   */
  SCRAPE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(120_000),
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
  /**
   * Kaynak kullanım şartları kapısı (`config/source-terms.json`). `blocked` kararlı kaynak HER ZAMAN
   * atlanır. `warn` (varsayılan): incelenmemiş kaynak taranır, tarama notunda görünür. `enforce`:
   * yalnız incelenmiş + `allowed` + saklama izni doğrulanmış kaynak taranır.
   */
  SOURCE_TERMS_POLICY: z.enum(['warn', 'enforce']).default('warn'),
  /** Canlı kaynak erişimi kapalıysa adaptörler yalnızca doğrulama yapar (test/lint). */
  SOURCE_LIVE_FETCH: z
    .string()
    // GÜVENLİ VARSAYILAN: ağa çıkmadan önce operatör bilinçli opt-in yapar.
    .default('0')
    .transform((value) => value !== '0' && value.toLowerCase() !== 'false'),
  /**
   * HTTP istemcisi cevap alamadığında başsız tarayıcı (Chromium) yedeği kullanılsın mı?
   *
   * `0`: tarayıcı hiç başlatılmaz. Testlerde ZORUNLU kapalıdır (bkz. tests/setup.ts),
   * çünkü Chromium gerçek ağa çıkar ve sahte HTTP istemcisinin yerine canlı siteyi
   * okuyarak testi yanıltır. Üretimde Chromium kurulu olmayan makinelerde de
   * kapatılabilir; adaptör o zaman asıl HTTP hatasını olduğu gibi bildirir.
   */
  SOURCE_BROWSER_FALLBACK: flag('0'),
  /**
   * Sunucu ara sertifikayı göndermediğinde zincir AIA adresinden tamamlansın mı?
   *
   * `1` (varsayılan): eksik halka indirilir, İMZASI ve CA durumu doğrulanır,
   * zincir güvenilen bir köke bağlanıyorsa kabul edilir ve istek doğrulama
   * AÇIKKEN yeniden denenir. `0`: tamamlama yapılmaz; eksik zincirli siteler
   * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` ile reddedilir (doğrulama yine açıktır).
   * Bu anahtar hiçbir durumda doğrulamayı KAPATMAZ.
   */
  SOURCE_TLS_AIA_COMPLETION: flag('1'),
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
   * SMTP TLS sertifika doğrulamasını KAPATIR (varsayılan 0 = doğrulama açık).
   *
   * Eski davranış doğrulamayı yalnızca üretimde açıyordu; geliştirmede kapalı
   * kalması SMTP kullanıcı adı/parolasını ortadaki adama açık bırakıyordu
   * (Postgres için kabul edilmeyen `no-verify` davranışının e-posta karşılığı).
   * Doğru çözüm sunucunun kök zincirini tamamlamaktır (NODE_EXTRA_CA_CERTS).
   */
  SMTP_TLS_INSECURE: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
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

  // --- LLM sınıflandırma kapısı (ingest hattı; varsayılan KAPALI) ---
  /**
   * Deterministik motorun `review` (belirsiz) dediği kayıtlarda LLM ikinci aşama
   * sınıflandırması çalışsın mı? Yalnızca sunucu tarafında (worker) kullanılır.
   * Kapalıyken veya sağlayıcı hatasında belirsiz kayıtlar inceleme kuyruğunda kalır;
   * LLM hiçbir zaman tek başına ilan YAYIMLAMAZ (kanıt doğrulaması zorunludur).
   */
  LLM_CLASSIFIER_ENABLED: flag('0'),
  /**
   * Taranmış (metin katmanı olmayan) PDF ilanlar için OCR (tesseract.js, Türkçe).
   * Varsayılan KAPALI. Güveni OCR_MIN_CONFIDENCE altındaki metin kullanılmaz.
   */
  OCR_ENABLED: flag('0'),
  /** Türkçe dil verisinin (tur.traineddata) yerel dizini ya da adresi. Boşsa tesseract.js'in varsayılan dağıtımı. */
  OCR_LANG_PATH: z.string().default(''),
  /** Bu ortalama güvenin (0–100) altındaki OCR metni kullanılmaz; kayıt incelemeye gider. */
  OCR_MIN_CONFIDENCE: z.coerce.number().int().min(0).max(100).default(70),
  /** Belge başına OCR yapılacak azami sayfa. */
  OCR_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(4),
  /** Tek tarama koşusunda OCR yapılacak azami belge (CPU ve tarama süresi freni). */
  OCR_MAX_DOCS_PER_RUN: z.coerce.number().int().min(0).max(50).default(3),
  /** İstem sürümüyle birlikte önbellek anahtarını belirleyen model adı. Boşsa LLM_MODEL kullanılır. */
  LLM_CLASSIFIER_MODEL: z.string().default(''),
  // Virgülle ayrılmış yedek modeller (aynı sağlayıcı/uç nokta); sıra = deneme sırası.
  LLM_CLASSIFIER_FALLBACK_MODELS: z.string().default(''),
  LLM_REASONING_EFFORT: z.enum(['', 'low', 'medium', 'high']).default(''),
  /** Sağlayıcıya gönderilecek azami ilan metni uzunluğu (karakter). Fazlası kırpılır. */
  LLM_MAX_INPUT_CHARS: z.coerce.number().int().min(1_000).max(40_000).default(12_000),
  /** Tek kaynak taramasında yapılacak azami LLM çağrısı (maliyet freni). 0 = kapı bu koşuda çalışmaz. */
  LLM_MAX_CALLS_PER_RUN: z.coerce.number().int().min(0).max(500).default(12),
  /** Tüm worker'larda günlük toplam LLM çağrısı sınırı. */
  LLM_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).max(100_000).default(400),
  /** Aynı anda sürebilecek LLM isteği sayısı (worker içi eşzamanlılık sınırı). */
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Geçici sağlayıcı hatalarında (429/5xx/zaman aşımı) ek deneme sayısı. */
  LLM_RETRY_MAX: z.coerce.number().int().min(0).max(3).default(1),
  /**
   * MALİYET TAHMİNİ İÇİN OPERATÖR GİRDİSİ — sağladığımız fiyat DEĞİLDİR.
   *
   * Milyon token başına USD. Boş bırakılırsa (varsayılan) sistem hiçbir maliyet rakamı
   * üretmez; yalnızca ölçülen token/gecikme raporlanır. Sağlayıcı fiyatları canlı
   * doğrulanmadan buraya yazılan değer varsayımdır ve rapor "tahmin" etiketiyle çıkar.
   */
  LLM_COST_USD_PER_MTOK_INPUT: usdPerMtokField('LLM_COST_USD_PER_MTOK_INPUT'),
  LLM_COST_USD_PER_MTOK_OUTPUT: usdPerMtokField('LLM_COST_USD_PER_MTOK_OUTPUT'),
  /** Operatörün fiyat varsayımıyla hesaplanan koşu maliyeti için üst rezervasyon. */
  LLM_RUN_COST_LIMIT_USD: usdBudgetLimitField('LLM_RUN_COST_LIMIT_USD'),
  /** Bütün worker/provider akışlarının ortak 24 saatlik tahmini maliyet rezervasyonu. */
  LLM_DAILY_COST_LIMIT_USD: usdBudgetLimitField('LLM_DAILY_COST_LIMIT_USD'),

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
  /**
   * Herkese açık ilan vitrini: KAPALI (varsayılan). Açıkken oturumsuz ziyaretçi
   * ilan listesi, ilan detayı ve kaynaklar sayfalarını görür; panel, kayıtlı
   * ilanlar, bildirimler ve yönetim yine oturum ister. Kayıt politikasını
   * (`ALLOW_PUBLIC_REGISTRATION`) DEĞİŞTİRMEZ. API ilan uçları bu bayraktan
   * bağımsız olarak zaten yalnızca onaylı ilanları oturumsuz döndürür.
   * Açmak ürün + KVKK kararıdır (docs/audit/03 R-01).
   */
  PUBLIC_LISTINGS_ENABLED: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Hiçbir değişken verilmediğinde şemanın ürettiği değerler (yalnız şema; süreç ortamı ve `.env`
 * OKUNMAZ). `.env.example` üreteci "varsayılan" sütununu buradan alır; kopya değer bayatlamaz.
 */
export function envSchemaDefaults(): Env {
  return envSchema.parse({});
}

/**
 * Boş ya da yalnız boşluktan oluşan değer → TANIMSIZ (şema varsayılanı uygulanır).
 *
 * Neden: `.env`'de `KEY=` satırı süreç ortamına boş metin olarak girer. Doğrudan şemaya verildiğinde
 * `SCHEDULER_ENABLED=` ve `SOURCE_LIVE_FETCH=` `true` (boş metin '0' değil), `PORT=` gibi sayılar 0
 * (başlangıç hatası), `SOURCE_ALLOWED_HOSTS=` boş izin listesi oluyordu (22.10.2026). Belgelenen
 * sözleşme (env-spec: "boş bırakılan isteğe bağlı alan şemanın varsayılanını alır") budur.
 */
export function withoutBlankValues(values: Record<string, string | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] = typeof value === 'string' && value.trim() === '' ? undefined : value;
  }
  return result;
}

export interface GetEnvOptions {
  /** Göreli CA dosya yolu bu köke göre çözülsün (bkz. EnvironmentInspectionOptions). */
  caFileRoot?: string;
  /** Yalnızca bu `.env` dosyası doğrulansın (proje `.env`'i ve süreç ortamı değil). */
  envFile?: string;
}

export function getEnv(
  overrides: Record<string, string | undefined> = {},
  options?: GetEnvOptions,
): Env {
  const hasOverrides = Object.keys(overrides).length > 0;
  if (cachedEnv && !hasOverrides && !options) return cachedEnv;
  const base: Record<string, string | undefined> = options?.envFile
    ? parseEnvFileScoped(options.envFile)
    : { ...process.env };
  const parsed = envSchema.safeParse(withoutBlankValues({ ...base, ...overrides }));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Ortam değişkenleri geçersiz: ${details}`);
  }
  const env = parsed.data;
  validateEnvironment(env, options);
  if (!hasOverrides && !options) cachedEnv = env;
  return env;
}

/** Testlerde ortam değişikliği sonrası yeniden okumak için. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

export type ParseEnvResult =
  | { ok: true; env: Env }
  | { ok: false; issues: string[]; partial: Record<string, string | undefined> };

/**
 * Ortamı DOĞRULAMADAN ayrıştırır (`env:setup` sihirbazı için).
 *
 * Neden ayrı: `getEnv()` fail-closed'tur ve sorunlu yapılandırmada fırlar.
 * Sihirbazın amacı tam olarak bu sorunları KULLANICIYLA BİRLİKTE düzeltmektir;
 * bu yüzden mevcut değerleri (maskelenmiş) gösterebilmek için ayrıştırılmış ama
 * doğrulanmamış görünüme ihtiyacı vardır. Yazma işleminden sonra sihirbaz
 * `getEnv()` + `inspectEnvironment()` ile asıl denetimi çalıştırır.
 *
 * Bu fonksiyon sır DEĞERLERİ döndürür; çağıran taraf maskeler (bkz.
 * `maskValue` ve `describeEnv`). Üretim kodunda karar vermek için KULLANILMAZ.
 */
export function parseEnvWithoutValidation(
  overrides: Record<string, string | undefined> = {},
  options?: EnvironmentInspectionOptions,
): ParseEnvResult {
  // `envFile` verildiğinde YALNIZCA o dosya + açık overrides incelenir: süreç
  // ortamı (özellikle modül yüklenirken okunan proje `.env`'i) sonucu
  // kirletmemelidir. `env:setup --file başka/.env` bunun için var.
  const base: Record<string, string | undefined> = options?.envFile
    ? { ...(loadEnvFile({ envFile: options.envFile }) ? parseEnvFileScoped(options.envFile) : {}) }
    : { ...process.env };
  const merged = { ...base, ...overrides } as Record<string, string | undefined>;
  const parsed = envSchema.safeParse(withoutBlankValues(merged));
  if (parsed.success) return { ok: true, env: parsed.data };
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  const partial: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') partial[key] = value;
  }
  return { ok: false, issues, partial };
}

/**
 * Bir `.env` dosyasını DOĞRUDAN okur (`process.env`'e dokunmadan).
 *
 * `loadEnvFile()` süreç başına bir kez çalışır ve değerleri `process.env`'e
 * yazar; `env:setup` aynı süreçte birden çok hedef dosyayı denetlediği için
 * orada bu salt-okunur yol kullanılır. Dosya yoksa boş küme döner (şema
 * varsayılanları devreye girer).
 */
function parseEnvFileScoped(filePath: string): Record<string, string | undefined> {
  if (!existsSync(filePath)) return {};
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  return { ...parseEnvFile(contents) };
}

/** Supabase/Postgres bağlantı dizesi tanımlı mı? (POSTGRES_URL veya DATABASE_URL) */
export function hasPostgresConfig(env: Env): boolean {
  return Boolean(env.POSTGRES_URL || env.DATABASE_URL);
}

/**
 * Bağlantı dizesinde bulunmasına İZİN VERİLMEYEN TLS parametreleri.
 *
 * Gerekçe (canlı kanıt, pg 8.x): `pg`'nin `ConnectionParameters`'ı, havuza verilen
 * açık `ssl` nesnesini `parse(connectionString)` sonucuyla EZER. Yani
 * `POSTGRES_URL=...?sslmode=disable` + `POSTGRES_SSL_MODE=verify` birleşimi,
 * doğrulama AÇIK sanılırken TLS'i tamamen kapatır; `sslrootcert` de
 * `POSTGRES_SSL_CA_FILE` ile verilen CA'yı sessizce değiştirir. Sessiz güvenlik
 * düşüşü yerine açık ret: operatör parametreyi URL'den kaldırır, TLS kararını
 * yalnızca `POSTGRES_SSL_MODE` / `POSTGRES_SSL_CA_FILE` ile verir.
 */
export const POSTGRES_URL_FORBIDDEN_TLS_PARAMS: readonly string[] = [
  'sslmode',
  'ssl',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslnegotiation',
  'uselibpqcompat',
];

/**
 * Bağlantı aynı makineye mi (loopback: localhost, 127.0.0.0/8, ::1 ya da Unix soketi)?
 * Bu durumda trafik ağa çıkmaz; TLS'in kapalı olması MITM riski taşımaz (ör. Postgres'in
 * API ile aynı sunucuda çalıştığı systemd kurulumu). URL ayrıştırılamazsa false.
 */
export function postgresUrlIsLoopback(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = decodeURIComponent(parsed.hostname).replace(/^\[|\]$/g, '').toLowerCase();
  const socketHost = parsed.searchParams.get('host') ?? '';
  if (!host && socketHost.startsWith('/')) return true;
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * URL'deki yasak TLS parametrelerinin adlarını döner (değerleri ASLA dönmez;
 * bağlantı dizesi sırdır). URL ayrıştırılamazsa boş döner — biçim hatasını
 * pg'nin kendi açık hatası verir, burada gizlenmez.
 */
export function postgresUrlTlsConflicts(url: string): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (POSTGRES_URL_FORBIDDEN_TLS_PARAMS.includes(normalized)) found.add(normalized);
  }
  return [...found];
}

/**
 * Etkin Postgres bağlantı dizesi.
 *
 * URL içinde yasak TLS parametresi varsa HATA fırlatır (fail-closed): sessizce
 * yoksaymak, yukarıda açıklanan ezme davranışını canlı bırakırdı. Hata metni
 * parametre ADLARINI içerir, URL'nin kendisini/değerleri içermez.
 */
export function postgresUrl(env: Env): string {
  const url = env.POSTGRES_URL || env.DATABASE_URL;
  const conflicts = postgresUrlTlsConflicts(url);
  if (conflicts.length > 0) {
    throw new Error(
      `Postgres bağlantı dizesinde TLS parametresi kullanılamaz (${conflicts.join(', ')}): ` +
        'bu parametreler POSTGRES_SSL_MODE/POSTGRES_SSL_CA_FILE kararını sessizce ezer. ' +
        'Parametreyi bağlantı dizesinden kaldırın; TLS kararını POSTGRES_SSL_MODE ile verin.',
    );
  }
  return url;
}

/**
 * Etkin TLS doğrulama kipi (tek karar noktası; hem depo hem `env:check` bunu kullanır).
 *
 * `POSTGRES_SSL_MODE` yazıldıysa o geçerlidir. Yoksa eski `POSTGRES_SSL` bayrağı
 * geriye dönük olarak yorumlanır: `POSTGRES_SSL=0` → `no-verify` (eski davranışın
 * bilinçli kabulü), aksi hâlde `verify` — yani doğrulama artık AÇIK varsayılandır.
 */
export function postgresTlsMode(env: Env): 'verify' | 'no-verify' | 'disable' {
  if (env.POSTGRES_SSL_MODE) return env.POSTGRES_SSL_MODE;
  // POSTGRES_SSL=0 eski kurulumlarda "TLS hiç kullanılmasın" demekti; anlamı korunur.
  // Doğrulama yapıp TLS kullanmamak isteniyorsa açıkça POSTGRES_SSL_MODE=no-verify yazılır.
  return env.POSTGRES_SSL ? 'verify' : 'disable';
}

/**
 * CA dosyası sistem kökleriyle birleştirilecek mi? (tek karar noktası)
 *
 * Birleştirme YALNIZCA bir CA dosyası tanımlıyken anlam taşır; dosya yokken
 * zaten sistem kökleri kullanılır.
 */
export function postgresCaMergeSystem(env: Env): boolean {
  return Boolean(env.POSTGRES_SSL_CA_FILE) && env.POSTGRES_SSL_CA_MERGE_SYSTEM;
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
export function inspectEnvironment(
  env: Env = getEnv(),
  options?: EnvironmentInspectionOptions,
): EnvironmentInspection {
  const { problems, warnings } = collectEnvironmentProblems(env, options);
  return { ok: problems.length === 0, problems, warnings };
}

export interface EnvironmentInspectionOptions {
  /**
   * Göreli CA dosya yolunun çözüleceği kök dizin.
   *
   * Varsayılan: `.env` dosyasının bulunduğu proje kökü. `env:setup --file`
   * başka bir dizindeki dosyayı yazdığında denetimin O dosyanın kökünü
   * kullanması gerekir; aksi halde doğru yol "bulunamadı" diye reddedilir.
   */
  caFileRoot?: string;
  /** Yalnızca bu `.env` dosyası denetlensin (proje `.env`'i ve süreç ortamı değil). */
  envFile?: string;
}

function collectEnvironmentProblems(
  env: Env,
  options?: EnvironmentInspectionOptions,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  // NODE_TLS_REJECT_UNAUTHORIZED şemada değildir (Node'un kendi anahtarıdır) ama
  // tüm TLS kararlarını geçersiz kılar: üretimde başlangıcı durdurur, diğer
  // ortamlarda yüksek sesli uyarıdır. Kaldırma adımları metnin içindedir.
  if (tlsVerificationDisabled()) {
    const override = describeTlsVerificationOverride() ?? 'NODE_TLS_REJECT_UNAUTHORIZED=0 kaldırılmalıdır.';
    if (env.NODE_ENV === 'production') problems.push(override);
    else warnings.push(override);
  }
  // SMTP sertifika doğrulaması kapatıldıysa: üretimde başlangıcı durdurur, diğer
  // ortamlarda yüksek sesli uyarı (NODE_TLS_REJECT_UNAUTHORIZED ile aynı politika).
  if (env.SMTP_TLS_INSECURE) {
    const message =
      'SMTP_TLS_INSECURE=1: SMTP sertifika doğrulaması KAPALI — gönderim TLS olsa bile sunucu ' +
      'kimliği doğrulanmaz ve SMTP kullanıcı adı/parolası ortadaki adama açık kalır. Doğru karşılık ' +
      'eksik kökü tamamlamaktır (NODE_EXTRA_CA_CERTS=./certs/kurum-koku.pem). Kapatmak için anahtarı ' +
      '.env dosyasından silin: npm run env:setup -- --only SMTP_TLS_INSECURE';
    if (env.NODE_ENV === 'production') problems.push(message);
    else warnings.push(message);
  }
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
    if (
      (env.AI_ASSISTANT_ENABLED || env.LLM_CLASSIFIER_ENABLED) &&
      env.LLM_BASE_URL &&
      !env.LLM_BASE_URL.startsWith('https://')
    ) {
      problems.push('Üretimde LLM_BASE_URL https:// ile başlamalıdır (kişisel profil verisi taşınır).');
    }
  }
  const postgresConfigured = hasPostgresConfig(env);
  if (postgresConfigured) {
    // URL'deki TLS parametresi, aşağıdaki kip denetiminin tamamını anlamsız kılar
    // (pg URL'yi açık ssl nesnesinin üzerine yazar). env:check'te de görünür olmalı;
    // bağlantı kurulurken postgresUrl() aynı nedenle hata fırlatır.
    const urlConflicts = postgresUrlTlsConflicts(env.POSTGRES_URL || env.DATABASE_URL);
    if (urlConflicts.length > 0) {
      problems.push(
        `Postgres bağlantı dizesinde TLS parametresi var (${urlConflicts.join(', ')}): ` +
          'POSTGRES_SSL_MODE kararını sessizce ezer. Parametreyi URL\'den kaldırın; ' +
          'TLS kararını yalnızca POSTGRES_SSL_MODE/POSTGRES_SSL_CA_FILE ile verin.',
      );
    }
    const tlsMode = postgresTlsMode(env);
    if (tlsMode === 'verify') {
      if (!env.POSTGRES_SSL_CA_FILE && !systemCaStoreAvailable()) {
        warnings.push(
          'Veritabanı TLS doğrulaması Node\'un gömülü kökleriyle yapılıyor ama sistem sertifika deposu okunamıyor ' +
            `(Node ${process.version}); özel/ulusal CA kullanan bir Supabase sertifikasında bağlantı reddedilebilir. ` +
            'Kök CA dosyasını POSTGRES_SSL_CA_FILE ile gösterin.',
        );
      }
      // CA dosyası tanımlıysa İÇERİĞİ burada denetlenir: `db:migrate`/`start`
      // çalışmadan önce yanlış dosya (HTML, DER, özel anahtar, leaf, süresi
      // dolmuş, eksik yol) görünür olmalıdır. Aksi halde kullanıcı aynı
      // SELF_SIGNED_CERT_IN_CHAIN hatasını nedenini bilmeden alır.
      //
      // Denetim YALNIZCA etkin sürücü Postgres iken yapılır: DATABASE_DRIVER=file
      // ile yerel çalışan bir geliştirici, `.env`'de unutulmuş bir CA yolu yüzünden
      // uygulama başlatamaz duruma düşmemelidir.
      if (env.POSTGRES_SSL_CA_FILE && effectiveDriver(env) === 'postgres') {
        const report = inspectCaFile(env.POSTGRES_SSL_CA_FILE, { root: options?.caFileRoot });
        if (!report.exists) {
          problems.push(
            `POSTGRES_SSL_CA_FILE bulunamadı: ${env.POSTGRES_SSL_CA_FILE} (denenen: ${report.candidates.join(', ')}). ` +
              'Göreli yol `.env` dosyasının bulunduğu klasöre ve çalışma dizinine göre çözülür; doğrulamasız bağlantıya DÜŞÜLMEZ. ' +
              'Tanılama: npm run db:tls-doctor — kurulum: docs/database-tls.md',
          );
        } else {
          // Dosya bulunmuşsa aynı sorunu iki kez raporlamamak için yalnızca
          // içerik denetiminin (blocking) sonuçları yazılır.
          for (const entry of report.issues) {
            if (!entry.blocking) continue;
            problems.push(
              `POSTGRES_SSL_CA_FILE kullanılamaz (${entry.code}): ${entry.message.replace(/\n\s*/g, ' ')} ` +
                '— Tanılama: npm run db:tls-doctor, kurulum: docs/database-tls.md',
            );
          }
        }
        for (const entry of report.warnings) {
          warnings.push(`POSTGRES_SSL_CA_FILE: ${entry.message.replace(/\n\s*/g, ' ')}`);
        }
        const caCount = report.certificates.length;
        const rootCount = report.certificates.filter((cert) => cert.selfSigned && cert.isCa).length;
        if (report.usable && caCount > 0 && rootCount === 0 && !postgresCaMergeSystem(env)) {
          warnings.push(
            `POSTGRES_SSL_CA_FILE içinde kök (kendi kendini imzalayan) CA yok; ${caCount} sertifika listelendi. ` +
              'Sunucu zinciri bu dosyayla doğrulanamayabilir: tam zinciri (leaf → intermediate → root) ekleyin ya da ' +
              'POSTGRES_SSL_CA_MERGE_SYSTEM=1 ile sistem köklerini birleştirin.',
          );
        }
        if (report.usable && !postgresCaMergeSystem(env)) {
          warnings.push(
            'CA dosyası tanımlı: sunucu sertifikası YALNIZCA bu dosyadaki köklerle doğrulanır (sistem kökleri birleştirilmez). ' +
              'Hem dosya hem sistem/kurum kökleri gerekiyorsa POSTGRES_SSL_CA_MERGE_SYSTEM=1 yazın.',
          );
        }
      }
    } else {
      const reason =
        tlsMode === 'disable'
          ? 'TLS tamamen kapalı (POSTGRES_SSL=0 ya da POSTGRES_SSL_MODE=disable): veritabanı trafiği şifrelenmiyor'
          : 'sunucu sertifikası doğrulanmıyor (POSTGRES_SSL_MODE=no-verify)';
      const message =
        `Veritabanı bağlantısında ${reason}. Bu, ağ üzerindekilerin şifrelenmemiş trafiği ya da ` +
        'kimlik doğrulama bilgilerini ele geçirebildiği bir aracı-orta (MITM) riskidir; Supabase için ' +
        'ek dosya gerekmez — POSTGRES_SSL_MODE=verify (varsayılan) bırakın ya da CA yolunu ' +
        'POSTGRES_SSL_CA_FILE ile gösterin.';
      const loopbackPlaintext = tlsMode === 'disable' && postgresUrlIsLoopback(env.POSTGRES_URL || env.DATABASE_URL);
      if (loopbackPlaintext) {
        // Aynı makinedeki Postgres: trafik ağa çıkmaz; üretimde de yalnız uyarı.
        warnings.push(
          'Veritabanı bağlantısında TLS kapalı; bağlantı aynı makineye (loopback) olduğu için kabul edildi. ' +
            'Veritabanı başka bir makineye taşınırsa POSTGRES_SSL_MODE=verify yapın.',
        );
      } else if (env.NODE_ENV === 'production') problems.push(`Üretimde ${message}`);
      else warnings.push(message);
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
  if (
    env.LLM_CLASSIFIER_ENABLED &&
    (!env.LLM_BASE_URL || !env.LLM_API_KEY || (!env.LLM_CLASSIFIER_MODEL && !env.LLM_MODEL))
  ) {
    problems.push(
      'LLM_CLASSIFIER_ENABLED=1 için LLM_BASE_URL, LLM_API_KEY ve LLM_CLASSIFIER_MODEL (veya LLM_MODEL) zorunludur.',
    );
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
  // LLM kapısı açıksa uç nokta/model uyumu denetlenir. Yanlış eşleşme istekte
  // 404 döndürür ve inceleme kuyruğundaki HER kayıt insan onayına kalır
  // (2026-10-16 paneli: 2 çağrı / 2 hata / %100 hata oranı). Engelleyici değil:
  // yanlış pozitif olasılığı vardır, bu yüzden uyarı + `npm run llm:doctor`.
  if ((env.AI_ASSISTANT_ENABLED || env.LLM_CLASSIFIER_ENABLED) && env.LLM_BASE_URL) {
    const llmModel = env.LLM_CLASSIFIER_MODEL.trim() || env.LLM_MODEL.trim();
    const risk = describeLlmEndpointRisk(env.LLM_BASE_URL, llmModel);
    if (risk) warnings.push(`${risk} Doğrulamak için: npm run llm:doctor`);
  }
  const anyLlmEnabled = env.AI_ASSISTANT_ENABLED || env.LLM_CLASSIFIER_ENABLED;
  const bothCostRatesConfigured =
    env.LLM_COST_USD_PER_MTOK_INPUT !== null &&
    env.LLM_COST_USD_PER_MTOK_OUTPUT !== null &&
    env.LLM_COST_USD_PER_MTOK_INPUT > 0 &&
    env.LLM_COST_USD_PER_MTOK_OUTPUT > 0;
  const anyCostCapConfigured =
    env.LLM_RUN_COST_LIMIT_USD !== null || env.LLM_DAILY_COST_LIMIT_USD !== null;
  if (anyCostCapConfigured && !bothCostRatesConfigured) {
    problems.push(
      'LLM USD maliyet sınırı tanımlı ancak LLM_COST_USD_PER_MTOK_INPUT/OUTPUT eksik veya sıfır. ' +
        'Fiyat doğrulanana kadar fail-closed bütçe hiçbir sağlayıcı çağrısına izin vermez.',
    );
  }
  if (anyLlmEnabled && !bothCostRatesConfigured) {
    warnings.push(
      'LLM_COST_USD_PER_MTOK_INPUT/OUTPUT sağlayıcı fiyatı varsayımı değildir: eksik/sıfırsa maliyet raporlanmaz. ' +
        'Bu varsayımlar doğrulanmış resmi fiyat olmadan doldurulmamalıdır.',
    );
  }
  if (env.NODE_ENV === 'production' && anyLlmEnabled) {
    if (env.LLM_RUN_COST_LIMIT_USD === null || env.LLM_DAILY_COST_LIMIT_USD === null) {
      problems.push(
        'Üretimde AI/LLM etkinleştirildiğinde LLM_RUN_COST_LIMIT_USD ve LLM_DAILY_COST_LIMIT_USD ' +
          'zorunludur; tahmini maliyet için iki LLM_COST_USD_PER_MTOK_* fiyat varsayımı da gerekir.',
      );
    }
    if (!bothCostRatesConfigured) {
      problems.push('Üretimde LLM etkinleştirilmişken iki pozitif LLM_COST_USD_PER_MTOK_* varsayımı zorunludur.');
    }
  } else if (anyLlmEnabled && (env.LLM_RUN_COST_LIMIT_USD === null || env.LLM_DAILY_COST_LIMIT_USD === null)) {
    warnings.push(
      'LLM koşu/gün USD rezervasyon tavanı tam yapılandırılmamış; üretimde AI etkinleştirmek env:check tarafından engellenir.',
    );
  }
  if (env.ADMIN_EMAIL === '' || env.ADMIN_PASSWORD === '') {
    warnings.push(
      'İlk yönetici hesabı için ADMIN_EMAIL/ADMIN_PASSWORD tanımlanmamış (seed:admin çalıştırılamaz).',
    );
  }
  return { problems, warnings };
}

function validateEnvironment(env: Env, options?: EnvironmentInspectionOptions): void {
  const { problems } = collectEnvironmentProblems(env, options);
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
    // Veritabanı TLS doğrulaması: 'verify' varsayılandır; kapatmak açık tercihtir.
    dbTls: hasPostgresConfig(env)
      ? `${postgresTlsMode(env)}${
          env.POSTGRES_SSL_CA_FILE
            ? postgresCaMergeSystem(env)
              ? ' (CA dosyası + sistem kökleri)'
              : ' (yalnızca CA dosyası)'
            : ''
        }`
      : 'yok (postgres tanımlı değil)',
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
    publicListings: env.PUBLIC_LISTINGS_ENABLED,
    liveFetch: env.SOURCE_LIVE_FETCH,
    scheduler: env.SCHEDULER_ENABLED,
    dataDir: env.DATA_DIR,
    rateLimit: `${env.RATE_LIMIT_MAX_REQUESTS}/${env.RATE_LIMIT_WINDOW_SECONDS}s`,
    appSecretSet: env.APP_SECRET.length >= 32,
    // TLS doğrulaması Node anahtarıyla kapatılmış mı? Kapatıldıysa tarama/test
    // sonuçları güvenilmezdir; bu satır onu her özet görünümünde söyler
    // (env:check, env:setup, worker başlangıcı, /health).
    tlsVerification: tlsVerificationDisabled() ? 'KAPALI (NODE_TLS_REJECT_UNAUTHORIZED=0)' : 'açık',
    browserFallback: env.SOURCE_BROWSER_FALLBACK ? 'açık (Chromium)' : 'kapalı',
    // Hangi dosyadan okunduğu (içerik değil) — ".env okunmadı" sorunlarını
    // ayıklamak için görünür tutulur.
    envFile: envFileSource() ?? 'yok (yalnızca ortam değişkenleri)',
    // Telegram: yalnızca token VE kullanıcı adı varsa etkin; sır değerleri gösterilmez.
    telegram:
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME
        ? `@${env.TELEGRAM_BOT_USERNAME} (webhook sırrı ${env.TELEGRAM_WEBHOOK_SECRET ? 'tanımlı' : 'yok'})`
        : 'kapalı',
    aiAssistant: env.AI_ASSISTANT_ENABLED ? `açık (${env.LLM_MODEL || 'model yok'})` : 'kapalı',
    llmClassifier: env.LLM_CLASSIFIER_ENABLED
      ? `açık (${env.LLM_CLASSIFIER_MODEL || env.LLM_MODEL}, günlük sınır ${env.LLM_DAILY_CALL_LIMIT})`
      : 'kapalı',
  };
}
