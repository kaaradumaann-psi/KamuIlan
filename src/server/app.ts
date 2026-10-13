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
} from './context';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerJobRoutes } from './routes/jobs';
import { registerNotificationRoutes } from './routes/notifications';
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
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/verify-email',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/unsubscribe',
]);

function isCsrfExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return CSRF_EXEMPT_PATHS.has(path);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();
  const repos = options.repos ?? getRepos();
  const logger = options.logger ?? createLogger('api', { level: env.LOG_LEVEL });

  const app = Fastify({
    // pino örneği Fastify'nin beklediği arayüzü karşılar; tip parametresi
    // FastifyBaseLogger'a sabitlenir (aksi halde rota tipleri uyuşmaz).
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 256 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, {
    secret: env.APP_SECRET || undefined,
    parseOptions: {},
  });
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });

  await app.register(swagger, {
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
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  });

  // Global hız sınırlama: her istek sayılır, kimlik gerektiren uçlar daha sıkı sınırlanır.
  app.addHook('preHandler', async (request, reply) => {
    if (options.disableRateLimit) return;
    const isAuthPath = request.url.startsWith('/api/auth/');
    const max = isAuthPath ? env.AUTH_RATE_LIMIT_MAX_REQUESTS : env.RATE_LIMIT_MAX_REQUESTS;
    const decision = await enforceRateLimit(repos.rateLimits, request, reply, {
      bucket: isAuthPath ? 'auth' : 'api',
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
  registerAdminRoutes(app, repos);

  if (options.serveStatic && env.NODE_ENV === 'production') {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: new URL('../../dist', import.meta.url).pathname,
      prefix: '/',
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
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
