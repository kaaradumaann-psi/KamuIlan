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
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { getEnv } from '../config/env';
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
  /** Statik dosya servisi (üretimde derlenmiş arayüz). */
  serveStatic?: boolean;
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
  '/api/auth/unsubscribe',
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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();
  const repos = options.repos ?? getRepos();
  const logger = options.logger ?? createLogger('api', { level: env.LOG_LEVEL });

  const app = Fastify({
    // pino örneği Fastify'nin beklediği arayüzü karşılar; tip parametresi
    // FastifyBaseLogger'a sabitlenir (aksi halde rota tipleri uyuşmaz).
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // X-Forwarded-For'a yalnızca TRUST_PROXY=1 iken güvenilir (bkz. env.ts).
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

  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
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

  app.setNotFoundHandler((request, reply) => {
    const { statusCode, body } = toErrorBody(
      ApiError.notFound(`Kayıt bulunamadı: ${request.method} ${request.url.split('?')[0]}`),
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

  if (options.serveStatic && env.NODE_ENV === 'production') {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: staticDistRoot(),
      prefix: '/',
      // Derlenmiş varlıklar içerik damgalıdır: uzun ömürlü önbellek + tazelik
      // gerektiren dosyalar için no-cache (bkz. context.ts).
      setHeaders: (reply, path) => {
        for (const [name, value] of Object.entries(staticCacheHeaders(path))) {
          reply.header(name, value);
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (requestPathname(request).startsWith('/api/')) {
        const { statusCode, body } = toErrorBody(ApiError.notFound('API yolu bulunamadı.'), request.id);
        void reply.status(statusCode).send(body);
        return;
      }
      // Tek sayfa uygulaması: bilinmeyen yollar arayüze bırakılır.
      void reply.sendFile('index.html');
    });
  }

  return app;
}

// Yetkilendirme yardımcıları context.ts içinde tanımlıdır (rota döngüsünü önlemek için).
export { requireAdmin, requireUser, requestIp } from './context';
