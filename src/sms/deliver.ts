/**
 * SMS teslimi (outbox tüketicisi; yalnızca `channel: 'sms'`).
 *
 * Gönderim anındaki denetimler (kuyruktan sonra durum değişmiş olabilir):
 *  - Kullanıcının SMS rızası/numarası/tercihi hâlâ geçerli değilse → `suppressed`.
 *  - Twilio kalıcı hata (geçersiz numara, STOP, deneme hesabı doğrulanmamış numara) → ölü mektup.
 *  - 429/5xx/ağ → üstel geri çekilme ile yeniden deneme.
 * Numara outbox'ta tutulmaz; tercih kaydından okunur. Loglarda numara maskelenir.
 */
import type { Repos } from '../db/repos';
import type { EmailOutboxDoc } from '../db/schemas';
import { readJobPayload } from '../telegram/format';
import { renderSmsText } from './format';
import type { SmsClient } from './twilio';

export interface SmsSender {
  client: SmsClient;
  senderName: string;
  baseUrl: string;
}

export type SmsDeliveryStatus = 'accepted' | 'retry' | 'dead' | 'suppressed';

/** Kullanıcının SMS'e uygun numarası (rıza + açık + E.164); değilse null. */
export async function smsTargetFor(repos: Repos, userId: string): Promise<string | null> {
  const preference = await repos.notifications.getPreference(userId);
  const sms = preference?.sms;
  if (!preference || !sms || !sms.enabled || !sms.consentAt || !sms.phoneE164) return null;
  if (!preference.enabled || preference.paused) return null;
  return sms.phoneE164;
}

export async function deliverSmsItem(input: {
  repos: Repos;
  sender: SmsSender;
  item: EmailOutboxDoc;
  now: Date;
  retryDelayMs: (attempts: number) => number;
}): Promise<{ status: SmsDeliveryStatus; error?: string }> {
  const { repos, sender, item, now } = input;
  const phone = item.userId ? await smsTargetFor(repos, item.userId) : null;
  if (!phone) {
    const reason = 'SMS rızası/numarası yok veya bildirimler kapalı';
    await repos.outbox.markSuppressed(item.id, reason);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'suppressed', reason);
    return { status: 'suppressed', error: reason };
  }

  const payload = readJobPayload(item.payload);
  if (!payload) {
    await repos.outbox.markFailed(item.id, 'render hatası: ilan verisi eksik', null);
    return { status: 'dead', error: 'ilan verisi eksik' };
  }
  const body = renderSmsText({
    kind: item.kind,
    payload,
    daysLeft: typeof item.payload['daysLeft'] === 'number' ? item.payload['daysLeft'] : null,
    baseUrl: sender.baseUrl,
    senderName: sender.senderName,
  });

  const result = await sender.client.send({ to: phone, body });
  if (result.ok) {
    await repos.outbox.markAccepted(item.id, result.sid, `twilio: ${result.status}`);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'queued');
    return { status: 'accepted' };
  }

  const error = `twilio ${result.status}${result.code ? `/${result.code}` : ''}: ${result.message}`;
  if (result.retryable) {
    const retryAt = new Date(now.getTime() + input.retryDelayMs(item.attempts + 1)).toISOString();
    const updated = await repos.outbox.markFailed(item.id, error, retryAt);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', error);
    return { status: updated?.status === 'dead' ? 'dead' : 'retry', error };
  }
  await repos.outbox.markFailed(item.id, error, null);
  if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', error);
  return { status: 'dead', error };
}
