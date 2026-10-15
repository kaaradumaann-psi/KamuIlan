/**
 * Telegram bot komutları ve bağlama akışı.
 *
 * Bağlama (güvenli, tek kullanımlık):
 *   1. Kullanıcı panelde "Telegram'a bağla" der → 15 dakikalık tek kullanımlık
 *      `telegram-link` jetonu üretilir (yalnızca hash'i saklanır).
 *   2. Bağlantı t.me/<bot>?start=<jeton> açılır; bot `/start <jeton>` alır.
 *   3. Jeton tüketilir, sohbet kullanıcıya bağlanır (durum: active).
 *
 * Komutlar: /start, /dur, /basla, /durum, /cik, /yardim.
 * Bot, webhook üzerinden yalnızca özel (private) sohbetlere yanıt verir; grup
 * sohbetlerindeki komutlar yok sayılır (kişisel veri grup üyelerine sızmaz).
 */
import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { NotificationPreferenceDoc, TelegramLinkDoc } from '../db/schemas';
import { randomToken } from '../domain/ids';
import { botLinkUrl, type TelegramConfig } from './config';
import type { TelegramBotClient } from './client';

export const LINK_CODE_TTL_MINUTES = 15;
const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Telegram Update şemasının kullanılan alt kümesi. Bilinmeyen alanlar yok sayılır.
const chatSchema = z.object({ id: z.union([z.number(), z.string()]), type: z.string() });
const userSchema = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  username: z.string().optional(),
});
const updateSchema = z.object({
  update_id: z.number().optional(),
  message: z
    .object({
      chat: chatSchema,
      from: userSchema.optional(),
      text: z.string().max(4096).optional(),
    })
    .optional(),
  my_chat_member: z
    .object({
      chat: chatSchema,
      from: userSchema.optional(),
      new_chat_member: z.object({ status: z.string(), user: userSchema.optional() }),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;

export function parseTelegramUpdate(body: unknown): TelegramUpdate | null {
  const parsed = updateSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export interface BotDeps {
  repos: Repos;
  client: TelegramBotClient;
  config: TelegramConfig;
  senderName: string;
  now?: Date;
}

export interface CreatedLinkCode {
  deepLink: string;
  expiresAt: string;
  botUsername: string;
  /** Telegram açılmazsa botta elle gönderilecek komut. */
  manualCommand: string;
}

/** Kullanıcı için bağlama jetonu üretir. Eski, kullanılmamış jetonlar süresi dolana kadar geçerli kalır. */
export async function createLinkCode(
  repos: Repos,
  config: TelegramConfig,
  userId: string,
): Promise<CreatedLinkCode> {
  const token = randomToken(24); // base64url, 32 karakter (Telegram sınırı: 64)
  const doc = await repos.users.createToken({
    userId,
    type: 'telegram-link',
    token,
    ttlMinutes: LINK_CODE_TTL_MINUTES,
  });
  return {
    deepLink: botLinkUrl(config, token),
    expiresAt: doc.expiresAt,
    botUsername: config.botUsername,
    manualCommand: `/start ${token}`,
  };
}

function statusLabel(link: TelegramLinkDoc | null): string {
  if (!link || link.status === 'unlinked') return 'Bağlı değil';
  if (link.status === 'active') return 'Bağlı ve açık';
  if (link.status === 'stopped') return 'Bağlı, ancak /dur ile duraklatıldı';
  return 'Telegram botu engellenmiş (botu yeniden başlatın)';
}

function notificationsNote(preference: NotificationPreferenceDoc | null): string {
  if (!preference || !preference.enabled) return 'Bildirim tercihleriniz kapalı: panelden açmanız gerekir.';
  if (preference.paused) return 'Bildirimler panelde duraklatılmış.';
  return 'Eşleşen ilanlar bu sohbete gönderilir.';
}

/** Gelen Telegram güncellemesini işler. Yanıt gönderme hataları yutulur (loglama çağıranda). */
export async function handleTelegramUpdate(
  deps: BotDeps,
  update: TelegramUpdate,
): Promise<{ action: string }> {
  if (update.my_chat_member) return handleMyChatMember(deps, update.my_chat_member);
  if (update.message) return handleMessage(deps, update.message);
  return { action: 'ignored' };
}

async function reply(deps: BotDeps, chatId: string, text: string): Promise<void> {
  await deps.client.sendMessage({ chatId, text });
}

async function handleMyChatMember(
  deps: BotDeps,
  update: NonNullable<TelegramUpdate['my_chat_member']>,
): Promise<{ action: string }> {
  if (update.chat.type !== 'private') return { action: 'ignored' };
  const chatId = String(update.chat.id);
  const status = update.new_chat_member.status;
  const links = await deps.repos.telegram.findByChat(chatId);
  const live = links.filter((link) => link.status !== 'unlinked');
  if (live.length === 0) return { action: 'no-link' };

  if (status === 'kicked' || status === 'left') {
    for (const link of live) {
      if (link.status === 'blocked') continue;
      await deps.repos.telegram.setStatus(
        link.userId,
        'blocked',
        'Kullanıcı botu engelledi veya sohbeti bıraktı.',
      );
      await deps.repos.outbox.suppressPendingForUser(link.userId, 'telegram', 'Telegram botu engellendi');
    }
    return { action: 'blocked' };
  }
  if (status === 'member') {
    for (const link of live) {
      if (link.status === 'blocked') await deps.repos.telegram.setStatus(link.userId, 'active', null);
    }
    return { action: 'unblocked' };
  }
  return { action: 'ignored' };
}

async function handleMessage(
  deps: BotDeps,
  message: NonNullable<TelegramUpdate['message']>,
): Promise<{ action: string }> {
  if (message.chat.type !== 'private') return { action: 'ignored-group' };
  if (message.from?.is_bot) return { action: 'ignored-bot' };
  const chatId = String(message.chat.id);
  const text = (message.text ?? '').trim();
  const command = /^\/([A-Za-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/.exec(text);

  if (!command) {
    // Sohbet ulaşılabilir: engellenmiş bağlantı artık çalışır (kullanıcı botla yazıştı).
    const links = (await deps.repos.telegram.findByChat(chatId)).filter((l) => l.status === 'blocked');
    for (const link of links) await deps.repos.telegram.setStatus(link.userId, 'active', null);
    await reply(deps, chatId, 'Komutları görmek için /yardim yazın.');
    return { action: 'message' };
  }

  const [, rawName = '', mention, argument = ''] = command;
  if (mention && mention.toLowerCase() !== deps.config.botUsername.toLowerCase())
    return { action: 'ignored-mention' };
  const name = rawName.toLowerCase();

  switch (name) {
    case 'start':
      return handleStart(deps, chatId, argument.trim(), message.from?.username ?? null);
    case 'dur':
      return handleStop(deps, chatId);
    case 'basla':
      return handleResume(deps, chatId);
    case 'durum':
      return handleStatus(deps, chatId);
    case 'cik':
      return handleUnlink(deps, chatId);
    case 'yardim':
    case 'help':
      await reply(deps, chatId, helpText());
      return { action: 'help' };
    default:
      await reply(deps, chatId, `Bilinmeyen komut. ${helpText()}`);
      return { action: 'unknown-command' };
  }
}

function helpText(): string {
  return [
    '<b>Kamuİlan bildirim botu</b>',
    '',
    '/durum — bağlantı ve bildirim durumunu gösterir',
    '/dur — bildirimleri geçici olarak durdurur',
    '/basla — durdurulmuş bildirimleri yeniden açar',
    '/cik — Telegram bağlantısını tamamen kaldırır',
    '/yardim — bu listeyi gösterir',
  ].join('\n');
}

async function handleStart(
  deps: BotDeps,
  chatId: string,
  argument: string,
  telegramUsername: string | null,
): Promise<{ action: string }> {
  if (!argument) {
    await reply(
      deps,
      chatId,
      [
        '👋 <b>Kamuİlan bildirim botu</b>',
        '',
        'Bu bot kamu ilan bildirimlerinizi Telegram’a iletir.',
        'Bağlamak için Kamuİlan’da <b>Panelim → Telegram bildirimleri → Telegram’a bağla</b> düğmesini kullanın.',
      ].join('\n'),
    );
    return { action: 'welcome' };
  }

  const invalid = async () => {
    await reply(
      deps,
      chatId,
      '⚠️ Bağlantı kodu geçersiz veya süresi dolmuş. Lütfen Kamuİlan panelinden yeni bir bağlantı başlatın (kodlar 15 dakika geçerlidir).',
    );
    return { action: 'link-invalid' };
  };

  if (!LINK_CODE_PATTERN.test(argument)) return invalid();
  const consumed = await deps.repos.users.consumeToken(argument, 'telegram-link');
  if (!consumed) return invalid();

  const user = await deps.repos.users.findById(consumed.userId);
  if (!user || user.status !== 'active') return invalid();

  const link = await deps.repos.telegram.link({ userId: user.id, chatId, telegramUsername });
  const preference = await deps.repos.notifications.getPreference(user.id);
  await reply(
    deps,
    chatId,
    [
      '✅ <b>Telegram bağlantınız kuruldu.</b>',
      '',
      notificationsNote(preference),
      '',
      'Durdurmak için /dur, yeniden açmak için /basla, bağlantıyı kaldırmak için /cik yazabilirsiniz.',
    ].join('\n'),
  );
  return { action: link.status === 'active' ? 'linked' : 'linked-other' };
}

async function linkFor(deps: BotDeps, chatId: string): Promise<TelegramLinkDoc | null> {
  const links = (await deps.repos.telegram.findByChat(chatId)).filter((l) => l.status !== 'unlinked');
  return links[0] ?? null;
}

async function handleStop(deps: BotDeps, chatId: string): Promise<{ action: string }> {
  const link = await linkFor(deps, chatId);
  if (!link) {
    await reply(deps, chatId, 'Bu sohbet bir Kamuİlan hesabına bağlı değil.');
    return { action: 'not-linked' };
  }
  await deps.repos.telegram.setStatus(link.userId, 'stopped');
  await deps.repos.outbox.suppressPendingForUser(
    link.userId,
    'telegram',
    'Kullanıcı Telegram bildirimlerini durdurdu',
  );
  await reply(deps, chatId, '⏸ Telegram bildirimleri durduruldu. Yeniden açmak için /basla yazın.');
  return { action: 'stopped' };
}

async function handleResume(deps: BotDeps, chatId: string): Promise<{ action: string }> {
  const link = await linkFor(deps, chatId);
  if (!link) {
    await reply(deps, chatId, 'Bu sohbet bir Kamuİlan hesabına bağlı değil.');
    return { action: 'not-linked' };
  }
  await deps.repos.telegram.setStatus(link.userId, 'active');
  await reply(deps, chatId, '▶️ Telegram bildirimleri yeniden açıldı.');
  return { action: 'resumed' };
}

async function handleStatus(deps: BotDeps, chatId: string): Promise<{ action: string }> {
  const link = await linkFor(deps, chatId);
  const preference = link ? await deps.repos.notifications.getPreference(link.userId) : null;
  await reply(
    deps,
    chatId,
    ['<b>Telegram durumu</b>', `Bağlantı: ${statusLabel(link)}`, notificationsNote(preference)].join('\n'),
  );
  return { action: 'status' };
}

async function handleUnlink(deps: BotDeps, chatId: string): Promise<{ action: string }> {
  const links = (await deps.repos.telegram.findByChat(chatId)).filter((l) => l.status !== 'unlinked');
  if (links.length === 0) {
    await reply(deps, chatId, 'Bu sohbet bir Kamuİlan hesabına bağlı değil.');
    return { action: 'not-linked' };
  }
  for (const link of links) {
    await deps.repos.telegram.unlink(link.userId);
    await deps.repos.outbox.suppressPendingForUser(link.userId, 'telegram', 'Telegram bağlantısı kaldırıldı');
  }
  await reply(
    deps,
    chatId,
    '🔌 Telegram bağlantınız kaldırıldı. Yeniden bağlamak için panelden yeni bağlantı başlatın.',
  );
  return { action: 'unlinked' };
}
