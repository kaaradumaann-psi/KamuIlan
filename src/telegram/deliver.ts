/**
 * Telegram teslimi (outbox tüketicisi). E-posta gönderiminden ayrıdır; yalnızca
 * `channel: 'telegram'` kayıtlarını işler.
 *
 * Gönderim anındaki denetimler (kuyruğa alındıktan sonra durum değişmiş olabilir):
 *  - Bağlantı hâlâ `active` değilse → `suppressed` (durdurulmuş/kaldırılmış kullanıcıya mesaj gitmez).
 *  - Telegram 403 / "chat not found" → bağlantı `blocked`, bekleyen tüm Telegram işleri bastırılır.
 *  - 429 / 5xx / ağ hatası → `retry_after` (varsa) veya üstel geri çekilme ile yeniden deneme.
 *  - 400 (biçim) → kalıcı hata, ölü mektup.
 */
import type { Repos } from '../db/repos';
import type { EmailOutboxDoc } from '../db/schemas';
import { classifyTelegramFailure, type TelegramBotClient } from './client';
import type { TelegramConfig } from './config';
import { readJobPayload, renderJobMessage, renderTestMessage, type RenderedTelegramMessage } from './format';

export interface TelegramSender {
  client: TelegramBotClient;
  config: TelegramConfig;
  /** Mesajlarda görünen uygulama adı (APP_DISPLAY_NAME). */
  senderName: string;
  /** Panel ve ilan bağlantıları için taban adres (APP_BASE_URL). */
  baseUrl: string;
}

export type TelegramDeliveryStatus = 'accepted' | 'retry' | 'dead' | 'suppressed';

export async function deliverTelegramItem(input: {
  repos: Repos;
  sender: TelegramSender;
  item: EmailOutboxDoc;
  now: Date;
  retryDelayMs: (attempts: number) => number;
}): Promise<{ status: TelegramDeliveryStatus; error?: string }> {
  const { repos, sender, item, now } = input;

  const link = item.userId ? await repos.telegram.findByUser(item.userId) : null;
  if (!link || link.status !== 'active') {
    const reason = !link
      ? 'Telegram bağlantısı yok'
      : link.status === 'stopped'
        ? 'Telegram bildirimleri durduruldu'
        : link.status === 'blocked'
          ? 'Telegram botu engellenmiş'
          : 'Telegram bağlantısı kaldırıldı';
    await repos.outbox.markSuppressed(item.id, reason);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'suppressed', reason);
    return { status: 'suppressed', error: reason };
  }

  let message: RenderedTelegramMessage;
  try {
    message = renderMessage(item, sender);
  } catch (error) {
    // Veri eksik/bozuk: yeniden denemek anlamsız.
    const text = error instanceof Error ? error.message : String(error);
    await repos.outbox.markFailed(item.id, `render hatası: ${text}`, null);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', text);
    return { status: 'dead', error: text };
  }

  const result = await sender.client.sendMessage({
    chatId: link.chatId,
    text: message.text,
    buttons: message.buttons,
  });
  if (result.ok) {
    await repos.outbox.markAccepted(item.id, String(result.result.message_id), 'telegram sendMessage: ok');
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'queued');
    return { status: 'accepted' };
  }

  const error = result.description;
  const verdict = classifyTelegramFailure(result);
  if (verdict === 'blocked') {
    await repos.telegram.setStatus(link.userId, 'blocked', error);
    await repos.outbox.suppressPendingForUser(link.userId, 'telegram', 'Telegram botu engellendi');
    await repos.outbox.markSuppressed(item.id, `Telegram botu engellenmiş: ${error}`);
    if (item.eventId)
      await repos.notifications.markEvent(item.eventId, 'suppressed', 'Telegram botu engellenmiş');
    return { status: 'suppressed', error };
  }

  if (verdict === 'retry') {
    const attempts = item.attempts + 1;
    const backoff = input.retryDelayMs(attempts);
    const honored = result.ok === false && result.retryAfterSec ? result.retryAfterSec * 1000 : 0;
    const retryAt = new Date(now.getTime() + Math.max(backoff, honored)).toISOString();
    const updated = await repos.outbox.markFailed(item.id, error, retryAt);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', error);
    return { status: updated?.status === 'dead' ? 'dead' : 'retry', error };
  }

  await repos.outbox.markFailed(item.id, error, null);
  if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', error);
  return { status: 'dead', error };
}

function renderMessage(item: EmailOutboxDoc, sender: TelegramSender): RenderedTelegramMessage {
  if (item.kind === 'test') return renderTestMessage(sender.senderName);
  if (item.kind !== 'job-notification') throw new Error(`Telegram için desteklenmeyen tür: ${item.kind}`);
  const payload = readJobPayload(item.payload);
  if (!payload) throw new Error('İlan verisi eksik veya bozuk.');
  const kind = item.template === 'job-changed' ? 'job-changed' : 'new-job';
  return renderJobMessage({ kind, payload, baseUrl: sender.baseUrl, senderName: sender.senderName });
}
