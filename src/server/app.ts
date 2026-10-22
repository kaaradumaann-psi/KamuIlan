/**
 * Fastify uygulaması.
 *
 * Sorumluluklar:
 *  - Güvenlik başlıkları, çerez yönetimi (HttpOnly + SameSite), CSRF double-submit.
 *  - Standart hata gövdesi ve istek kimliği.
 *  - Zod ile şema doğrulaması (fastify-type-provider-zod) ve OpenAPI dokümanı.
 *  - Global hız sınırlama.
 *  - İş mantığı ROTALARDA DEĞİL, servis/depo katmanında; rotalar ince kalır.
 *
 * Not: Bu dosya iş kuralı içermez; yalnızca taşıma katmanıdır.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { getEnv, type Env } from '../config/env';
import { APP_VERSION, BRANDING } from '../config/app';
import { getRepos, type Repos } from '../db/repos';
import { createLogger } from '../lib/logger';
import { ApiError, toErrorBody } from './errors';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SECURITY_HEADERS,
  SESSION_COOKIE,
  enforceRateLimit,
  safeEqual,
  staticCacheHeaders,
  requestPathname,
} from './context';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerSitemapRoutes } from './routes/sitemap';
import { registerJobRoutes } from './routes/jobs';
import { registerNotificationRoutes } from './routes/notifications';
import { registerTelegramRoutes, TELEGRAM_WEBHOOK_PATH } from './routes/telegram';
import { registerAiRoutes } from './routes/ai';
import { registerSourceRoutes } from './routes/sources';

export interface BuildAppOptions {
  repos?: Repos;
  logger?: ReturnType<typeof createLogger>;
  /** Testlerde hız sınırı kapatılabilir (E2E senaryoları hızlı kalsın). */
  disableRateLimit?: boolean;
  /**
   * Derlenmiş arayüzü (dist/) aynı süreçten sun + SPA geri dönüşü. `main.ts` yalnız üretimde açar.
   * `dist/index.html` yoksa (arayüz Cloudflare/Nginx'ten sunuluyorsa) yalnız API çalışır.
   */
  serveStatic?: boolean;
  /** Testler için statik kök (varsayılan: `staticDistRoot()`). */
  staticRoot?: string;
}

/**
 * CSRF muafiyeti YALNIZCA jeton/kimlik bilgisinin kendisi yetki kanıtı olan
 * halka açık kimlik uçlarına tanınır (tam yol eşleşmesi). Önek muafiyeti
 * YOKTUR: `/api/jobs/:id/save` gibi oturumla çalışan değiştiren uçlar,
 * `/api/jobs` detayı halka açık olsa bile CSRF denetiminden geçer.
 *
 * `/api/auth/logout` bu listede DEĞİLDİR: oturum çereziyle çalışır, jeton
 * kanıtı yoktur. Muaf olsaydı saldırgan bir sayfa, kullanıcının tarayıcısına
 * sessizce çıkış yaptırabilirdi (zorla çıkış). Arayüz `x-csrf-token` başlığını
 * zaten gönderir; bu yüzden kullanıcı açısından fark yoktur.
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/verify-email',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  // DİKKAT: `/api/auth/unsubscribe` bu listede DEĞİLDİR. Uç, jetonlu (oturumsuz)
  // yolu desteklediği için muaf tutulmuştu; ama aynı uç bir oturumla da
  // çalışıyor ve `{ all: true }` gönderildiğinde kullanıcının TÜM oturumlarını
  // iptal ediyor. Oturumsuz istekte CSRF denetimi zaten uygulanmaz
  // (`if (changing && session && ...)`), yani e-postadaki bağlantı akışı
  // muafiyet olmadan da çalışır. Muafiyet kaldırıldı: zorla çıkış/abonelik
  // kapatma (forced logout) yüzeyi kapanır.
  // Telegram webhook'u oturumsuzdur; doğrulaması sır başlığıyla yapılır.
  TELEGRAM_WEBHOOK_PATH,
]);

function isCsrfExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return CSRF_EXEMPT_PATHS.has(path);
}

/**
 * Üretimde arayüzün derlenmiş varlıklarının kök dizini.
 *
 * `new URL(...).pathname` Windows'ta "/C:/Users/..." üretir ve `@fastify/static`
 * bu yolu bulamaz (arayüz 404'e düşer); `fileURLToPath` platforma göre çözer.
 */
export function staticDistRoot(): string {
  return fileURLToPath(new URL('../../dist', import.meta.url));
}

/** Strict-Transport-Security değeri: yalnız üretim + HTTPS taban adres; aksi halde null. */
export function hstsHeaderFor(env: Pick<Env, 'NODE_ENV' | 'APP_BASE_URL'>): string | null {
  return env.NODE_ENV === 'production' && env.APP_BASE_URL.startsWith('https://') ? 'max-age=31536000' : null;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();
  const repos = options.repos ?? getRepos();
  const logger = options.logger ?? createLogger('api', { level: env.LOG_LEVEL });

  const app = Fastify({
    // pino örneği Fastify'nin beklediği arayüzü karşılar; tip parametresi
    // FastifyBaseLogger'a sabitlenir (aksi halde rota tipleri uyuşmaz).
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // X-Forwarded-For'a yalnızca TRUST_PROXY açıkken ve (liste verildiyse) yalnızca
    // güvenilen vekillerden gelince güvenilir (bkz. src/config/trust-proxy.ts).
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    // İstek kimliğilogları için bile tahmin edilebilir olmamalı: Math.random yerine CSPRNG.
    genReqId: () => `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, {
    secret: env.APP_SECRET || undefined,
    parseOptions: {},
  });
  // CORS: tarayıcı uygulaması API ile AYNI kaynaktan konuşur (geliştirmede Vite
  // vekili, üretimde tek sunucu). Bu yüzden üretimde CORS kapalıdır. Yalnızca
  // CORS_ORIGINS listesi verilirse açılır; "her kaynağa izin" verilmez çünkü
  // kimlik doğrulaması çerezle yapılır.
  const corsOrigins = env.CORS_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  });

  const docsEnabled = env.DOCS_ENABLED || env.NODE_ENV !== 'production';
  if (docsEnabled) await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: `${BRANDING.name} API`,
        description:
          'Kamu personel alım ilanı toplama servisi. Toplanan içerik güvenilmeyen veridir; API bunu yalnızca düz metin/JSON olarak döner.',
        version: APP_VERSION,
      },
      servers: [{ url: env.APP_BASE_URL }],
      tags: [
        { name: 'health', description: 'Sağlık ve sistem durumu' },
        { name: 'jobs', description: 'İlanlar' },
        { name: 'sources', description: 'Kaynaklar ve kapsam' },
        { name: 'auth', description: 'Kayıt, oturum, doğrulama' },
        { name: 'notifications', description: 'Bildirim tercihleri' },
        { name: 'admin', description: 'Yönetici işlemleri (RBAC)' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  if (docsEnabled) {
    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }

  // HSTS yalnız üretimde ve site HTTPS ise: tarayıcı sonraki ziyaretlerde HTTP'ye hiç düşmez.
  // includeSubDomains/preload bilinçli olarak YOK (alan adının diğer alt alanlarını bağlamasın).
  const hsts = hstsHeaderFor(env);
  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (hsts) reply.header('strict-transport-security', hsts);
  });

  // Global hız sınırlama: her istek sayılır, kimlik işlemleri daha sıkı sınırlanır.
  // Sıkı kova YALNIZCA kimlik denemesi içeren POST uçlarınındır (giriş, parola
  // sıfırlama vb.). Oturum OKUMA (GET /api/auth/session) bu kovaya girmez:
  // uygulama her sayfada oturumu sorar; okuma da sayılırsa normal kullanıcı
  // birkaç sayfa sonra kilitlenir (429) ve giriş ekranına düşer.
  const STRICT_AUTH_PATHS = new Set([
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/verify-email',
    '/api/auth/resend-verification',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
  ]);
  app.addHook('preHandler', async (request, reply) => {
    if (options.disableRateLimit) return;
    const pathname = requestPathname(request);
    // Yalnız API sayılır. Aynı süreçten sunulan derlenmiş arayüz (HTML/JS/CSS/ikon) ve SPA
    // sayfa yolları sayılırsa tek sayfa yüklemesi kotanın onda birini yiyor ve sınır aşılınca
    // tarayıcıya sayfa yerine ham JSON gösteriliyordu (22.10.2026 üretim provası).
    if (!pathname.startsWith('/api/')) return;
    // Telegram sunucuları tek IP'den çok sayıda güncelleme yollar; kimlik sırla doğrulanır.
    if (pathname === TELEGRAM_WEBHOOK_PATH) return;
    const isStrictAuth = request.method === 'POST' && STRICT_AUTH_PATHS.has(pathname);
    const max = isStrictAuth ? env.AUTH_RATE_LIMIT_MAX_REQUESTS : env.RATE_LIMIT_MAX_REQUESTS;
    const decision = await enforceRateLimit(repos.rateLimits, request, reply, {
      bucket: isStrictAuth ? 'auth' : 'api',
      max,
    });
    if (!decision.allowed) {
      reply.header(
        'retry-after',
        String(Math.max(1, Math.round((Date.parse(decision.resetAt) - Date.now()) / 1000))),
      );
      throw ApiError.rateLimited('Çok fazla istek gönderdiniz; lütfen bir süre bekleyin.', {
        resetAt: decision.resetAt,
      });
    }
  });

  /** Oturum + CSRF denetimi. Rotalar `request.auth` üzerinden kullanıcıya erişir. */
  app.decorateRequest('auth', null);
  app.addHook('preHandler', async (request) => {
    const rawToken = request.cookies[SESSION_COOKIE];
    const session = rawToken ? await repos.users.findSessionByToken(rawToken) : null;
    let user = session ? await repos.users.findById(session.userId) : null;
    if (user && user.status !== 'active') user = null;

    if (session) await repos.users.touchSession(session.id);

    const csrfCookie = request.cookies[CSRF_COOKIE];
    const method = request.method.toUpperCase();
    const changing = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    if (changing && session && env.CSRF_ENABLED && !isCsrfExempt(request.url)) {
      const header = request.headers[CSRF_HEADER];
      const provided = Array.isArray(header) ? header[0] : header;
      if (
        !provided ||
        !csrfCookie ||
        !safeEqual(provided, csrfCookie) ||
        !safeEqual(csrfCookie, session.csrfToken)
      ) {
        throw ApiError.forbidden('CSRF doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.');
      }
    }

    request.auth = { repos, user, session, csrfRequired: env.CSRF_ENABLED };
  });

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toErrorBody(error, request.id);
    if (statusCode >= 500) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          url: request.url,
          requestId: request.id,
        },
        'API hatası',
      );
    }
    void reply.status(statusCode).send(body);
  });

  // Statik servis kararı 404 işleyicisinden ÖNCE verilir: Fastify önek başına tek bir
  // setNotFoundHandler kabul eder; ikinci çağrı üretimde API'nin açılışını çökertiyordu.
  // Kök yalnız statik servis istenirse çözülür: jsdom ortamında import.meta.url file: değildir.
  const staticRoot = options.serveStatic ? (options.staticRoot ?? staticDistRoot()) : '';
  const spaFallback = Boolean(options.serveStatic) && existsSync(join(staticRoot, 'index.html'));
  if (options.serveStatic && !spaFallback) {
    logger.warn(
      { staticRoot },
      'dist/index.html bulunamadı: yalnız API sunuluyor (arayüz ayrı sunucudan servis ediliyorsa doğrudur; değilse önce npm run build)',
    );
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = requestPathname(request);
    if (spaFallback && !pathname.startsWith('/api/') && (request.method === 'GET' || request.method === 'HEAD')) {
      // Tek sayfa uygulaması: bilinmeyen sayfa yolları arayüze bırakılır.
      void reply.sendFile('index.html');
      return;
    }
    const { statusCode, body } = toErrorBody(
      ApiError.notFound(`Kayıt bulunamadı: ${request.method} ${pathname}`),
      request.id,
    );
    void reply.status(statusCode).send(body);
  });

  registerHealthRoutes(app, repos);
  registerJobRoutes(app, repos);
  registerSourceRoutes(app, repos);
  registerAuthRoutes(app, repos);
  registerNotificationRoutes(app, repos);
  registerTelegramRoutes(app, repos);
  registerAiRoutes(app, repos);
  registerAdminRoutes(app, repos);
  registerSitemapRoutes(app, repos);

  if (spaFallback) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      // Derlenmiş varlıklar içerik damgalıdır: uzun ömürlü önbellek + tazelik
      // gerektiren dosyalar için no-cache (bkz. context.ts).
      setHeaders: (reply, path) => {
        for (const [name, value] of Object.entries(staticCacheHeaders(path))) {
          reply.header(name, value);
        }
      },
    });
  }

  return app;
}

// Yetkilendirme yardımcıları context.ts içinde tanımlıdır (rota döngüsünü önlemek için).
export { requireAdmin, requireUser, requestIp } from './context';
