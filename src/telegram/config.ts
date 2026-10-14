/**
 * Telegram yapılandırması (tek doğrulama noktası).
 *
 * Kanal yalnızca TELEGRAM_BOT_TOKEN ve geçerli TELEGRAM_BOT_USERNAME birlikte
 * tanımlıysa etkindir; aksi halde Telegram ile ilgili hiçbir işlem yapılmaz ve
 * e-posta akışı etkilenmez.
 */
import { getEnv, TELEGRAM_SECRET_PATTERN, TELEGRAM_USERNAME_PATTERN, type Env } from '../config/env';

export interface TelegramConfig {
  token: string;
  botUsername: string;
  /** Boş olabilir: o durumda webhook uçu devre dışıdır (bağlama yapılamaz). */
  webhookSecret: string;
  apiBaseUrl: string;
}

/** Telegram etkin değilse null. Geçersiz kullanıcı adı da etkisizleştirir. */
export function telegramConfig(env: Env = getEnv()): TelegramConfig | null {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME) return null;
  if (!TELEGRAM_USERNAME_PATTERN.test(env.TELEGRAM_BOT_USERNAME)) return null;
  return {
    token: env.TELEGRAM_BOT_TOKEN,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    webhookSecret: TELEGRAM_SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET)
      ? env.TELEGRAM_WEBHOOK_SECRET
      : '',
    apiBaseUrl: env.TELEGRAM_API_BASE_URL.replace(/\/+$/, ''),
  };
}

/** Webhook yalnızca geçerli bir sır tanımlıysa kabul edilir. */
export function telegramWebhookReady(config: TelegramConfig | null): config is TelegramConfig {
  return config !== null && config.webhookSecret.length > 0;
}

/** Bağlama bağlantısı: https://t.me/<bot>?start=<kod>. */
export function botLinkUrl(config: TelegramConfig, startParameter: string): string {
  return `https://t.me/${config.botUsername}?start=${encodeURIComponent(startParameter)}`;
}

/** Webhook'a yalnızca bu güncelleme türleri gelir (diğerleri Telegram'da gönderilmez). */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'my_chat_member'] as const;
