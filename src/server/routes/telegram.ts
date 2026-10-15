/**
 * Telegram bildirim uçları.
 *
 *  - Oturumlu uçlar (yalnızca kendi bağlantın): durum, bağlantı kodu, test, durdur/başlat, kaldır.
 *  - Webhook (oturumsuz, Telegram'dan gelir): `X-Telegram-Bot-Api-Secret-Token` sırrıyla
 *    doğrulanır. Geçersiz sır 401 döner; geçerli ama işlenemeyen güncelleme 200 döner
 *    (Telegram'ın gereksiz yeniden denemesini önlemek için). Beklenmeyen hata 500 döner
 *    ki Telegram güncellemeyi yeniden göndersin.
 *
 * Güvenlik: Telegram sohbet kimliği yanıtlara ASLA konmaz (yalnızca sunucuda kullanılır).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env';
import type { Repos } from '../../db/repos';
import type { TelegramLinkDoc } from '../../db/schemas';
import { outboxIdempotencyKey } from '../../db/repos/outbox';
import { createLogger } from '../../lib/logger';
import { handleTelegramUpdate, createLinkCode, parseTelegramUpdate } from '../../telegram/bot';
import { TelegramBotClient } from '../../telegram/client';
import { telegramConfig, telegramWebhookReady, type TelegramConfig } from '../../telegram/config';
import { audit, requireUser, safeEqual } from '../context';
import { ApiError } from '../errors';

export const TELEGRAM_WEBHOOK_PATH = '/api/telegram/webhook';
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function linkView(link: TelegramLinkDoc | null) {
  if (!link || link.status === 'unlinked') return null;
  return {
    status: link.status,
    telegramUsername: link.telegramUsername,
    linkedAt: link.linkedAt,
    statusChangedAt: link.statusChangedAt,
    lastError: link.lastError,
  };
}

function requireConfig(): TelegramConfig {
  const config = telegramConfig(getEnv());
  if (!config) throw ApiError.unavailable('Telegram bildirimleri bu kurulumda etkin değil.');
  return config;
}

export function registerTelegramRoutes(app: FastifyInstance, repos: Repos): void {
  const logger = createLogger('telegram');

  app.get(
    '/api/telegram/status',
    { schema: { tags: ['telegram'], summary: 'Telegram bağlantı durumum' } },
    async (request) => {
      const user = requireUser(request);
      const config = telegramConfig(getEnv());
      const link = await repos.telegram.findByUser(user.id);
      const preference = await repos.notifications.getPreference(user.id);
      const notificationsOn = Boolean(preference?.enabled) && !preference?.paused;
      const active = link?.status === 'active';
      return {
        configured: config !== null,
        botUsername: config?.botUsername ?? null,
        link: linkView(link),
        notificationsOn,
        canReceive: active && notificationsOn,
        notice: !config
          ? 'Telegram bildirimleri bu kurulumda etkin değil.'
          : !link || link.status === 'unlinked'
            ? 'Telegram’a bağlanmak için aşağıdaki düğmeyi kullanın.'
            : link.status === 'blocked'
              ? 'Telegram botu engellenmiş. Telegram’da botu açıp /basla yazarak yeniden etkinleştirebilirsiniz.'
              : link.status === 'stopped'
                ? 'Telegram bildirimleri duraklatıldı.'
                : notificationsOn
                  ? 'Eşleşen ilanlar Telegram’a da gönderilir.'
                  : 'Telegram bağlı, ancak bildirim tercihleriniz kapalı: “Bildirim tercihleri” bölümünden açın.',
      };
    },
  );

  app.post(
    '/api/telegram/link-code',
    { schema: { tags: ['telegram'], summary: 'Telegram bağlantı kodu üret (15 dk)' } },
    async (request) => {
      const user = requireUser(request);
      const config = requireConfig();
      const code = await createLinkCode(repos, config, user.id);
      await audit(repos.audit, request, {
        action: 'telegram.link-code-issued',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return {
        ...code,
        message:
          'Bağlantı kodu üretildi. Telegram açılmazsa botu açıp aşağıdaki komutu gönderin. Kod 15 dakika geçerlidir.',
      };
    },
  );

  app.post(
    '/api/telegram/test',
    { schema: { tags: ['telegram'], summary: 'Telegram test mesajı gönder' } },
    async (request) => {
      const user = requireUser(request);
      requireConfig();
      const link = await repos.telegram.findByUser(user.id);
      if (!link || link.status !== 'active') {
        throw ApiError.conflict(
          link?.status === 'stopped'
            ? 'Bildirimler duraklatılmış. Önce “Telegram bildirimleri” anahtarını açın.'
            : link?.status === 'blocked'
              ? 'Telegram botu engellenmiş. Telegram’da botu yeniden başlatın.'
              : 'Önce Telegram hesabınızı bağlayın.',
        );
      }
      // Dakikada en çok bir test: tekrar basılırsa çift mesaj gitmesin.
      const minuteBucket = Math.floor(Date.now() / 60_000);
      const queued = await repos.outbox.enqueue(
        {
          channel: 'telegram',
          eventId: null,
          jobId: null,
          userId: user.id,
          kind: 'test',
          toEmail: `telegram:${user.id}`,
          subject: 'Telegram bağlantı testi',
          template: 'telegram-test',
          payload: {},
          idempotencyKey: outboxIdempotencyKey({
            userId: user.id,
            kind: 'test',
            reference: `telegram:${minuteBucket}`,
          }),
        },
        3,
      );
      return {
        queued: queued.created,
        message: queued.created
          ? 'Test mesajı kuyruğa alındı; birkaç saniye içinde Telegram’a gelir.'
          : 'Az önce bir test mesajı gönderildi. Bir dakika sonra tekrar deneyebilirsiniz.',
      };
    },
  );

  app.post(
    '/api/telegram/pause',
    { schema: { tags: ['telegram'], summary: 'Telegram bildirimlerini duraklat / sürdür' } },
    async (request) => {
      const user = requireUser(request);
      requireConfig();
      const body = z
        .object({ paused: z.boolean() })
        .strict()
        .parse(request.body ?? {});
      const link = await repos.telegram.findByUser(user.id);
      if (!link || link.status === 'unlinked') {
        throw ApiError.conflict('Önce Telegram hesabınızı bağlayın.');
      }
      if (link.status === 'blocked') {
        throw ApiError.conflict('Telegram botu engellenmiş. Telegram’da botu yeniden başlatın (/basla).');
      }
      const nextStatus = body.paused ? 'stopped' : 'active';
      await repos.telegram.setStatus(user.id, nextStatus);
      if (body.paused) {
        await repos.outbox.suppressPendingForUser(
          user.id,
          'telegram',
          'Kullanıcı Telegram bildirimlerini duraklattı',
        );
      }
      await audit(repos.audit, request, {
        action: body.paused ? 'telegram.paused' : 'telegram.resumed',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return {
        link: linkView(await repos.telegram.findByUser(user.id)),
        message: body.paused
          ? 'Telegram bildirimleri duraklatıldı.'
          : 'Telegram bildirimleri yeniden açıldı.',
      };
    },
  );

  app.delete(
    '/api/telegram/link',
    { schema: { tags: ['telegram'], summary: 'Telegram bağlantısını kaldır' } },
    async (request) => {
      const user = requireUser(request);
      const link = await repos.telegram.findByUser(user.id);
      if (!link || link.status === 'unlinked') {
        throw ApiError.conflict('Telegram bağlantınız zaten yok.');
      }
      await repos.telegram.unlink(user.id);
      await repos.outbox.suppressPendingForUser(user.id, 'telegram', 'Telegram bağlantısı kaldırıldı');
      await audit(repos.audit, request, {
        action: 'telegram.unlinked',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return {
        link: null,
        message: 'Telegram bağlantısı kaldırıldı. Bekleyen Telegram bildirimleri iptal edildi.',
      };
    },
  );

  // Webhook: oturumsuz; sır başlığıyla doğrulanır. Sır yapılandırılmamışsa uç kapalıdır.
  app.post(TELEGRAM_WEBHOOK_PATH, { schema: { hide: true } }, async (request) => {
    const config = telegramConfig(getEnv());
    if (!telegramWebhookReady(config)) throw ApiError.notFound();
    const header = request.headers[TELEGRAM_SECRET_HEADER];
    const provided = (Array.isArray(header) ? header[0] : header) ?? '';
    if (!safeEqual(provided, config.webhookSecret)) {
      throw ApiError.unauthorized('Geçersiz webhook sırrı.');
    }
    const update = parseTelegramUpdate(request.body);
    if (!update) return { ok: true, action: 'ignored' };
    const env = getEnv();
    try {
      const outcome = await handleTelegramUpdate(
        {
          repos,
          client: new TelegramBotClient({ token: config.token, apiBaseUrl: config.apiBaseUrl }),
          config,
          senderName: env.APP_DISPLAY_NAME,
        },
        update,
      );
      return { ok: true, action: outcome.action };
    } catch (error) {
      // 500: Telegram güncellemeyi yeniden gönderir (işlenmemiş kalmaz).
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'webhook işlenemedi');
      throw ApiError.internal();
    }
  });
}
