/**
 * API bağlamı ve güvenlik yardımcıları.
 *
 * - Oturum: HttpOnly + SameSite=Lax çerez, veritabanında yalnızca token HASH'i.
 * - CSRF: double-submit — oturumla birlikte üretilen `csrfToken` çerezde ve
 *   `x-csrf-token` başlığında eşleşmelidir (değiştiren isteklerde).
 * - Hız sınırlama: veritabanı tabanlı pencere sayacı (IP/e-posta hash'lenir).
 * - Yetkilendirme: kullanıcı yalnızca kendi verisini görür; admin ayrı kapıdan.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors';
import { getEnv } from '../config/env';
import { BRANDING } from '../config/app';
import type { Repos } from '../db/repos';
import type { SessionDoc, UserDoc } from '../db/schemas';
import type { AuditRepo, RateLimitRepo } from '../db/repos/system';

export const SESSION_COOKIE = 'kamuilan_session';
export const CSRF_COOKIE = 'kamuilan_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface RequestContext {
  repos: Repos;
  user: UserDoc | null;
  session: SessionDoc | null;
  csrfRequired: boolean;
}

/** Sabit süreli karşılaştırma (CSRF ve jeton doğrulamaları için). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** İmzalı bağlantı (e-posta doğrulama/şifre sıfırlama) — süreli HMAC. */
export function signTokenPayload(payload: { userId: string; purpose: string; expiresAt: number }): string {
  const env = getEnv();
  const secret = env.EMAIL_VERIFICATION_SECRET || env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET tanımlı değil; imzalı bağlantı üretilemez.');
  const body = `${payload.userId}.${payload.purpose}.${payload.expiresAt}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifySignedToken(
  token: string,
  purpose: string,
): { userId: string; expiresAt: number } | null {
  const env = getEnv();
  const secret = env.EMAIL_VERIFICATION_SECRET || env.APP_SECRET;
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [userId, tokenPurpose, expiresAtRaw, signature] = parts as [string, string, string, string];
  if (tokenPurpose !== purpose) return null;
  const expected = createHmac('sha256', secret).update(`${userId}.${tokenPurpose}.${expiresAtRaw}`).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { userId, expiresAt };
}

export function sessionTtlHours(): number {
  return getEnv().SESSION_TTL_HOURS;
}

/**
 * İstemci IP'si.
 *
 * X-Forwarded-For'a YALNIZCA `TRUST_PROXY=1` iken bakılır: başlığı istemci
 * serbestçe yazabildiği için (aksi hâlde) her istekte farklı bir IP uydurulup
 * hız sınırı atlanır ve denetim kaydı zehirlenir. Vekil arkasında ilk değer
 * gerçek istemcidir.
 */
export function clientIp(request: FastifyRequest): string {
  if (getEnv().TRUST_PROXY) {
    const forwarded = request.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof raw === 'string' && raw.length > 0) {
      const first = raw.split(',')[0]?.trim();
      if (first && first.length > 0) return first;
    }
  }
  return request.ip ?? 'bilinmiyor';
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

export async function enforceRateLimit(
  rateLimits: RateLimitRepo,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { bucket: string; max: number; windowSeconds?: number; keySuffix?: string },
): Promise<RateLimitDecision> {
  const env = getEnv();
  const windowSeconds = options.windowSeconds ?? env.RATE_LIMIT_WINDOW_SECONDS;
  // `keySuffix` (ör. e-posta) IP dışında bir boyutla sınırlar: saldırgan IP
  // değiştirse bile aynı hesaba yapılan denemeler sayılır. Değer hash'lenir.
  const key = `${options.bucket}:${clientIp(request)}${options.keySuffix ? `:${options.keySuffix}` : ''}`;
  const hit = await rateLimits.hit(key, windowSeconds);
  const remaining = Math.max(0, options.max - hit.count);
  const decision: RateLimitDecision = { allowed: hit.count <= options.max, remaining, resetAt: hit.resetAt };
  reply.header('x-ratelimit-limit', String(options.max));
  reply.header('x-ratelimit-remaining', String(remaining));
  reply.header('x-ratelimit-reset', hit.resetAt);
  return decision;
}

/** Denetim kaydı: yönetici işlemleri ve güvenlik olayları. */
export async function audit(
  auditRepo: AuditRepo,
  request: FastifyRequest,
  input: {
    action: string;
    targetType: string;
    targetId?: string | null;
    actorUserId?: string | null;
    actorRole?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await auditRepo.append({
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    meta: input.meta ?? {},
    ip: clientIp(request),
  });
}

export function staticCacheHeaders(path: string): Record<string, string> {
  if (/\.(?:js|css|woff2?|png|jpg|svg)$/.test(path)) {
    return { 'cache-control': 'public, max-age=31536000, immutable' };
  }
  return { 'cache-control': 'no-cache' };
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin',
  // Toplanan içerik HTML olarak render edilmez; yine de katı bir politika uygulanır.
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

export function appBranding() {
  return BRANDING;
}

/**
 * Oturum açmış kullanıcıyı zorunlu kılar (401). Rotalar bunu kullanır.
 * (app.ts içindeki istek kancası `request.auth` alanını doldurur.)
 */
export function requireUser(request: FastifyRequest): UserDoc {
  const auth = request.auth;
  if (!auth?.user) throw ApiError.unauthorized();
  return auth.user;
}

/** Yönetici yetkisi (403). RBAC: role='admin'. */
export function requireAdmin(request: FastifyRequest): UserDoc {
  const user = requireUser(request);
  if (user.role !== 'admin') throw ApiError.forbidden('Bu işlem yalnızca yöneticiler içindir.');
  return user;
}

export function requestIp(request: FastifyRequest): string {
  return clientIp(request);
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: {
      repos: Repos;
      user: UserDoc | null;
      session: SessionDoc | null;
      csrfRequired: boolean;
    } | null;
  }
}
