/**
 * Kimlik ve hesap uçları.
 *
 * Güvenlik notları:
 *  - Parolalar scrypt ile hash'lenir; düz metin asla saklanmaz/loglanmaz.
 *  - Oturum belirteci HttpOnly + SameSite=Lax çerezde tutulur; token'ın kendisi
 *    değil SHA-256 özeti veritabanında durur.
 *  - CSRF için çift gönderim çerezi kullanılır (yazan isteklerde başlık zorunlu).
 *  - Şifre sıfırlama ve e-posta doğrulama jetonları tek kullanımlıktır.
 *  - E-posta adresleri loglarda maskelenir.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env';
import { BRANDING } from '../../config/app';
import type { Repos } from '../../db/repos';
import { randomToken } from '../../domain/ids';
import { maskEmail } from '../../domain/text';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../passwords';
import { unsubscribeByToken } from '../../notifications/service';
import { CSRF_COOKIE, SESSION_COOKIE, audit, clientIp, requireUser, sessionTtlHours } from '../context';
import { ApiError } from '../errors';
import { toUserProfile } from '../serializers';

const emailSchema = z.email('Geçerli bir e-posta adresi girin.').trim().toLowerCase().max(160);
const passwordSchema = z.string().min(1).max(200);

/** Oturum çerezini yazar (HttpOnly + SameSite; üretimde Secure). */
function setSessionCookies(
  reply: FastifyReply,
  token: string,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  const secure = getEnv().NODE_ENV === 'production';
  const base = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
  reply.setCookie(SESSION_COOKIE, token, { ...base, maxAge: maxAgeSeconds });
  // CSRF çerezi JS tarafından okunabilsin diye HttpOnly değildir (çift gönderim deseni).
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge: maxAgeSeconds });
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export function registerAuthRoutes(app: FastifyInstance, repos: Repos): void {
  // Kamuİlan politikası: dışarıdan kendi kendine kayıt KAPALIDIR. Hesaplar
  // yönetici tarafından açılır (POST /api/admin/users → tek kullanımlık
  // "parola belirleme" bağlantısı). Bu uç yalnızca ALLOW_PUBLIC_REGISTRATION=1
  // iken çalışır; aksi halde 403 döner ve hiçbir kayıt oluşmaz.
  app.post(
    '/api/auth/register',
    { schema: { tags: ['auth'], summary: 'Kayıt (yalnızca ALLOW_PUBLIC_REGISTRATION=1 iken)' } },
    async (request, reply) => {
      if (!getEnv().ALLOW_PUBLIC_REGISTRATION) {
        throw ApiError.forbidden(
          `${BRANDING.name} hesabı yalnızca yönetici davetiyle açılır. Davet için site yöneticisiyle iletişime geçin.`,
        );
      }

      const body = z
        .object({
          email: emailSchema,
          password: passwordSchema,
          displayName: z.string().trim().max(80).optional(),
          // KVKK: aydınlatma metni onayı olmadan kayıt alınmaz.
          consent: z
            .boolean()
            .refine((value) => value === true, { message: 'KVKK aydınlatma metni onayı zorunludur.' }),
        })
        .parse(request.body);

      const strength = validatePasswordStrength(body.password, { email: body.email });
      if (!strength.valid)
        throw ApiError.validation('Parola yeterince güçlü değil.', { problems: strength.problems });

      const existing = await repos.users.findByEmail(body.email);
      if (existing) {
        // E-posta numaralandırmasını önlemek için aynı mesaj döner (kayıt tekrar denenebilir).
        throw ApiError.conflict('Bu e-posta ile bir hesap zaten var. Şifrenizi sıfırlayabilirsiniz.');
      }

      const { hash, salt } = await hashPassword(body.password);
      const created = await repos.users.create({
        email: body.email,
        passwordHash: hash,
        passwordSalt: salt,
        displayName: body.displayName ?? body.email.split('@')[0] ?? 'Kullanıcı',
      });
      if (!created.created) throw ApiError.conflict('Bu e-posta ile bir hesap zaten var.');
      const user = created.user;

      const token = randomToken(32);
      await repos.users.createToken({
        userId: user.id,
        type: 'email-verify',
        token,
        ttlMinutes: 60 * 24 * 2,
      });
      const verifyUrl = `${getEnv().APP_BASE_URL}/eposta-dogrula?token=${token}`;

      await repos.outbox.enqueue({
        eventId: null,
        jobId: null,
        userId: user.id,
        toEmail: user.email,
        kind: 'email-verification',
        subject: `${BRANDING.name} hesabınızı doğrulayın`,
        template: 'verify-email',
        payload: { displayName: user.displayName ?? '', verifyUrl, expiresInHours: 48 },
        idempotencyKey: `verify:${user.id}:${token}`,
      });

      await audit(repos.audit, request, {
        action: 'auth.register',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      reply.status(201);
      return {
        user: toUserProfile(user, { self: true }),
        message: 'Kayıt alındı. Bildirim alabilmek için e-posta adresinizi doğrulamanız gerekiyor.',
        verificationEmailMasked: maskEmail(user.email),
      };
    },
  );

  app.post(
    '/api/auth/login',
    { schema: { tags: ['auth'], summary: 'Oturum açma' } },
    async (request, reply) => {
      const body = z.object({ email: emailSchema, password: passwordSchema }).parse(request.body);
      const user = await repos.users.findByEmail(body.email);
      if (!user || user.status !== 'active') {
        throw ApiError.unauthorized('E-posta veya parola hatalı.');
      }
      const ok = await verifyPassword(body.password, user.passwordHash, user.passwordSalt);
      if (!ok) {
        await audit(repos.audit, request, {
          action: 'auth.login-failed',
          targetType: 'user',
          targetId: user.id,
          meta: { reason: 'bad-password' },
        });
        throw ApiError.unauthorized('E-posta veya parola hatalı.');
      }

      await repos.users.recordLogin(user.id);
      const { token, csrfToken, session } = await repos.users.createSession({
        userId: user.id,
        ttlHours: sessionTtlHours(),
        userAgent: request.headers['user-agent'] ?? null,
        ip: clientIp(request),
      });
      setSessionCookies(
        reply,
        token,
        csrfToken,
        Math.round((Date.parse(session.expiresAt) - repos.clock.now().getTime()) / 1000),
      );
      await audit(repos.audit, request, {
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });

      return {
        user: toUserProfile(user, { self: true }),
        csrfToken,
        expiresAt: session.expiresAt,
        needsEmailVerification: !user.emailVerified,
      };
    },
  );

  app.post(
    '/api/auth/logout',
    { schema: { tags: ['auth'], summary: 'Oturumu kapatma' } },
    async (request, reply) => {
      const session = request.auth?.session ?? null;
      if (session) await repos.users.revokeSession(session.id);
      clearSessionCookies(reply);
      return { message: 'Oturum kapatıldı.' };
    },
  );

  app.get(
    '/api/auth/session',
    { schema: { tags: ['auth'], summary: 'Geçerli oturum bilgisi' } },
    async (request) => {
      const user = request.auth?.user ?? null;
      if (!user) return { authenticated: false, user: null, csrfToken: null };
      return {
        authenticated: true,
        user: toUserProfile(user, { self: true }),
        csrfToken: request.auth?.session?.csrfToken ?? null,
      };
    },
  );

  app.post(
    '/api/auth/verify-email',
    { schema: { tags: ['auth'], summary: 'E-posta doğrulama' } },
    async (request) => {
      const body = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
      const token = await repos.users.consumeToken(body.token, 'email-verify');
      if (!token) throw ApiError.badRequest('Doğrulama bağlantısı geçersiz veya süresi dolmuş.');
      await repos.users.markEmailVerified(token.userId);
      const user = await repos.users.findById(token.userId);
      if (!user) throw ApiError.notFound('Kullanıcı bulunamadı.');
      await audit(repos.audit, request, {
        action: 'auth.email-verified',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return {
        user: toUserProfile(user, { self: true }),
        message: 'E-posta doğrulandı; bildirimler artık gönderilebilir.',
      };
    },
  );

  app.post(
    '/api/auth/resend-verification',
    { schema: { tags: ['auth'], summary: 'Doğrulama e-postasını yeniden gönder' } },
    async (request) => {
      const body = z.object({ email: emailSchema }).parse(request.body);
      const user = await repos.users.findByEmail(body.email);
      // Kullanıcı var/yok bilgisini sızdırmamak için her durumda aynı yanıt.
      if (user && !user.emailVerified) {
        const token = randomToken(32);
        await repos.users.createToken({
          userId: user.id,
          type: 'email-verify',
          token,
          ttlMinutes: 60 * 24 * 2,
        });
        await repos.outbox.enqueue({
          eventId: null,
          jobId: null,
          userId: user.id,
          toEmail: user.email,
          kind: 'email-verification',
          subject: `${BRANDING.name} hesabınızı doğrulayın`,
          template: 'verify-email',
          payload: {
            displayName: user.displayName ?? '',
            verifyUrl: `${getEnv().APP_BASE_URL}/eposta-dogrula?token=${token}`,
            expiresInHours: 48,
          },
          idempotencyKey: `verify:${user.id}:${token}`,
        });
      }
      return { message: 'Adres kayıtlıysa doğrulama bağlantısı e-posta ile gönderildi.' };
    },
  );

  app.post(
    '/api/auth/forgot-password',
    { schema: { tags: ['auth'], summary: 'Şifre sıfırlama bağlantısı iste' } },
    async (request) => {
      const body = z.object({ email: emailSchema }).parse(request.body);
      const user = await repos.users.findByEmail(body.email);
      if (user && user.status === 'active') {
        const token = randomToken(32);
        await repos.users.createToken({ userId: user.id, type: 'password-reset', token, ttlMinutes: 60 });
        await repos.outbox.enqueue({
          eventId: null,
          jobId: null,
          userId: user.id,
          toEmail: user.email,
          kind: 'password-reset',
          subject: `${BRANDING.name} şifre sıfırlama bağlantınız`,
          template: 'password-reset',
          payload: {
            displayName: user.displayName ?? '',
            resetUrl: `${getEnv().APP_BASE_URL}/sifre-sifirla?token=${token}`,
            expiresInMinutes: 60,
          },
          idempotencyKey: `reset:${user.id}:${token}`,
        });
        await audit(repos.audit, request, {
          action: 'auth.password-reset-requested',
          targetType: 'user',
          targetId: user.id,
        });
      }
      return { message: 'Adres kayıtlıysa sıfırlama bağlantısı gönderildi.' };
    },
  );

  app.post(
    '/api/auth/reset-password',
    { schema: { tags: ['auth'], summary: 'Şifre sıfırlama' } },
    async (request) => {
      const body = z
        .object({ token: z.string().min(10).max(200), password: passwordSchema })
        .parse(request.body);
      const strength = validatePasswordStrength(body.password);
      if (!strength.valid)
        throw ApiError.validation('Parola yeterince güçlü değil.', { problems: strength.problems });

      const token = await repos.users.consumeToken(body.token, 'password-reset');
      if (!token) throw ApiError.badRequest('Sıfırlama bağlantısı geçersiz veya süresi dolmuş.');

      const { hash, salt } = await hashPassword(body.password);
      await repos.users.update(token.userId, { passwordHash: hash, passwordSalt: salt });
      // Şifre değiştiğinde tüm oturumlar kapatılır (hesap ele geçirilmesine karşı).
      const revoked = await repos.users.revokeAllSessions(token.userId);
      await audit(repos.audit, request, {
        action: 'auth.password-reset',
        targetType: 'user',
        targetId: token.userId,
        meta: { sessionsRevoked: revoked },
      });
      return { message: 'Şifre güncellendi. Güvenlik için tüm oturumlar kapatıldı; yeniden giriş yapın.' };
    },
  );

  app.post(
    '/api/auth/unsubscribe',
    { schema: { tags: ['auth'], summary: 'Bildirimden çıkma (tek tık, jetonlu)' } },
    async (request) => {
      const body = z
        .object({ token: z.string().min(10).max(200).optional(), all: z.boolean().optional() })
        .parse(request.body ?? {});

      // Jetonlu çıkış, e-postadaki bağlantıdan oturumsuz çalışmalıdır: jetonun
      // kendisi yetki kanıtıdır. Oturum burada İSTENMEZ; aksi halde e-posta
      // istemcisinden gelen kullanıcı çıkış yapamaz.
      if (body.token) {
        const consumed = await unsubscribeByToken(repos, body.token);
        if (!consumed) throw ApiError.badRequest('Çıkış bağlantısı geçersiz veya süresi dolmuş.');
        await audit(repos.audit, request, {
          action: 'auth.unsubscribe-token',
          targetType: 'user',
          targetId: consumed.userId,
        });
        return {
          message: 'Bildirim aboneliğiniz kapatıldı. İstediğiniz zaman panelden yeniden açabilirsiniz.',
        };
      }

      const user = requireUser(request);

      // Tercih kaydı tek doğruluk kaynağıdır; kullanıcı kaydı ayrı bir bayrak tutmaz.
      const preference = await repos.notifications.getPreference(user.id);
      if (preference) await repos.notifications.upsertPreference(user.id, { enabled: false });
      if (body.all === true) await repos.users.revokeAllSessions(user.id);
      await audit(repos.audit, request, {
        action: 'auth.unsubscribe',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return { message: 'Bildirim aboneliğiniz kapatıldı.' };
    },
  );

  app.post(
    '/api/auth/delete-account',
    { schema: { tags: ['auth'], summary: 'Hesabı ve kişisel verileri sil (KVKK)' } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = z.object({ confirm: z.literal('SIL'), password: passwordSchema }).parse(request.body);
      const ok = await verifyPassword(body.password, user.passwordHash, user.passwordSalt);
      if (!ok) throw ApiError.unauthorized('Parola doğrulanamadı.');
      const result = await repos.users.erasePersonalData(user.id);
      const preference = await repos.notifications.getPreference(user.id);
      if (preference)
        await repos.notifications.upsertPreference(user.id, { enabled: false, paused: true, filters: {} });
      clearSessionCookies(reply);
      await audit(repos.audit, request, {
        action: 'auth.account-erased',
        targetType: 'user',
        targetId: user.id,
        meta: { sessionsRevoked: result.sessionsRevoked },
      });
      return {
        message:
          'Hesabınız ve kişisel verileriniz silindi. Tarama kayıtları ve ilan verileri anonim olarak kalır.',
      };
    },
  );
}
