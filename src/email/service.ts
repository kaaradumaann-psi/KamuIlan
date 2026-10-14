/**
 * E-posta gönderim servisi (transactional outbox tüketicisi).
 *
 * Akış: outbox kaydı lease'lenir → e-posta render edilir → taşıyıcıya verilir →
 * sonuç kaydedilir.
 *
 * Kurallar:
 *  - Durum doğru yazılır: sağlayıcı kabul ettiyse `accepted`, etmediyse
 *    `pending` (yeniden deneme) veya deneme sınırı dolduysa `dead` (ölü mektup).
 *  - Yeniden denemeler üstel geri çekilme ile yapılır; aynı e-posta iki kez
 *    gönderilmez (idempotency anahtarı).
 *  - Abonelikten çıkma bağlantısı gönderim anında üretilir ve yalnızca kullanıcı
 *    jetonu ile çalışır; jetonun kendisi e-postada görünür ama veritabanında
 *    yalnızca hash'i saklanır.
 */
import { randomToken } from '../domain/ids';
import { maskEmail } from '../domain/text';
import { getEnv } from '../config/env';
import type { Repos } from '../db/repos';
import type { EmailOutboxDoc } from '../db/schemas';
import { deliverTelegramItem, type TelegramSender } from '../telegram/deliver';
import { renderEmail, type EmailTemplate } from './templates';
import type { EmailTransport } from './transport';

export type OutboxChannel = EmailOutboxDoc['channel'];

export interface SendOutboxBatchOptions {
  repos: Repos;
  /** E-posta kanalı için zorunlu. */
  transport?: EmailTransport;
  /** Telegram kanalı için zorunlu (yapılandırılmamışsa Telegram işleri hiç alınmaz). */
  telegram?: TelegramSender;
  /** Hangi kanalın işleri alınır (varsayılan e-posta). */
  channel?: OutboxChannel;
  workerId: string;
  limit?: number;
  leaseMs?: number;
  /** Testlerde sabit zaman. */
  now?: Date;
}

export interface SendOutboxBatchResult {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  suppressed: number;
  errors: string[];
}

const UNSUBSCRIBE_TOKEN_TTL_MINUTES = 60 * 24 * 365;

/** Kullanıcının abonelikten çıkma bağlantısını üretir (jeton gönderim anında oluşturulur). */
async function buildUnsubscribeUrl(repos: Repos, userId: string, baseUrl: string): Promise<string | null> {
  const env = getEnv();
  const secret = env.EMAIL_VERIFICATION_SECRET || env.APP_SECRET;
  if (!secret) return null;
  const token = randomToken(24);
  await repos.users.createToken({
    userId,
    type: 'unsubscribe',
    token,
    ttlMinutes: UNSUBSCRIBE_TOKEN_TTL_MINUTES,
  });
  // Bağlantı arayüz sayfasına gider (/abonelikten-cik): sayfa jetonu POST ile
  // tüketir. Doğrudan API adresi verilirse GET isteği 404'e düşer.
  return `${baseUrl.replace(/\/$/, '')}/abonelikten-cik?token=${encodeURIComponent(token)}`;
}

function retryDelayMs(attempts: number): number {
  const env = getEnv();
  const base = env.EMAIL_RETRY_BASE_MS;
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, 24 * 3_600_000);
  // Jitter: birden çok worker aynı anda yeniden denemesin.
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

export async function sendOutboxBatch(options: SendOutboxBatchOptions): Promise<SendOutboxBatchResult> {
  const { repos, workerId } = options;
  const channel = options.channel ?? 'email';
  if (channel === 'email' && !options.transport) throw new Error('E-posta gönderimi için taşıyıcı gerekli.');
  if (channel === 'telegram' && !options.telegram) throw new Error('Telegram gönderimi için istemci gerekli.');
  const now = options.now ?? repos.clock.now();
  const batch = await repos.outbox.claimBatch(workerId, options.limit ?? 20, options.leaseMs ?? 120_000, channel);
  const result: SendOutboxBatchResult = { claimed: batch.length, sent: 0, failed: 0, dead: 0, suppressed: 0, errors: [] };

  for (const item of batch) {
    const outcome = await sendOne({
      repos,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.telegram ? { telegram: options.telegram } : {}),
      item,
      workerId,
      now,
    });
    if (outcome.status === 'accepted') result.sent += 1;
    else if (outcome.status === 'dead') result.dead += 1;
    else if (outcome.status === 'suppressed') result.suppressed += 1;
    else {
      result.failed += 1;
      if (outcome.error) {
        const target = item.channel === 'telegram' ? `telegram:${item.userId ?? '?'}` : maskEmail(item.toEmail);
        result.errors.push(`${target}: ${outcome.error}`);
      }
    }
  }

  return result;
}

export async function sendOne(input: {
  repos: Repos;
  transport?: EmailTransport;
  telegram?: TelegramSender;
  item: EmailOutboxDoc;
  workerId: string;
  /** Yeniden deneme zamanı bu ana göre hesaplanır (testlerde sabit saat). */
  now?: Date;
}): Promise<{ status: 'accepted' | 'retry' | 'dead' | 'suppressed'; error?: string }> {
  const { repos, item } = input;
  const env = getEnv();
  const now = input.now ?? repos.clock.now();

  // Kanal dallanması: Telegram işleri e-posta yolundan geçmez.
  if (item.channel === 'telegram') {
    if (!input.telegram) {
      // Yapılandırma eksik: yeniden denemeyle bekletilir (deneme sınırı dolunca ölü mektup).
      const retryAt = new Date(now.getTime() + 15 * 60_000).toISOString();
      const updated = await repos.outbox.markFailed(item.id, 'Telegram yapılandırılmamış.', retryAt);
      if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', 'Telegram yapılandırılmamış.');
      return { status: updated?.status === 'dead' ? 'dead' : 'retry', error: 'Telegram yapılandırılmamış.' };
    }
    return deliverTelegramItem({
      repos,
      sender: input.telegram,
      item,
      now,
      retryDelayMs: retryDelayMs,
    });
  }

  if (!input.transport) throw new Error('E-posta gönderimi için taşıyıcı gerekli.');
  const transport = input.transport;

  try {
    const unsubscribeUrl = item.userId
      ? await buildUnsubscribeUrl(repos, item.userId, env.APP_BASE_URL)
      : null;
    const rendered = renderEmail(item.template as EmailTemplate, item.payload, {
      baseUrl: env.APP_BASE_URL,
      senderName: env.APP_DISPLAY_NAME,
      preferencesUrl: `${env.APP_BASE_URL.replace(/\/$/, '')}/panel`,
      ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
    });

    const sendResult = await transport.send({
      to: item.toEmail,
      subject: rendered.subject || item.subject,
      html: rendered.html,
      text: rendered.text,
      template: item.template,
    });

    if (sendResult.accepted) {
      await repos.outbox.markAccepted(item.id, sendResult.providerMessageId, sendResult.providerResponse);
      if (item.eventId) await repos.notifications.markEvent(item.eventId, 'queued');
      return { status: 'accepted' };
    }

    const error = sendResult.error ?? 'Sağlayıcı mesajı kabul etmedi.';
    const retryAt = new Date(now.getTime() + retryDelayMs(item.attempts + 1)).toISOString();
    const updated = await repos.outbox.markFailed(item.id, error, retryAt);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', error);
    return { status: updated?.status === 'dead' ? 'dead' : 'retry', error };
  } catch (error) {
    // Şablon/veri hatası: yeniden denemek durumu değiştirmez, ölü mektup sayılır.
    const message = error instanceof Error ? error.message : String(error);
    const updated = await repos.outbox.markFailed(item.id, `render/send hatası: ${message}`, null);
    if (item.eventId) await repos.notifications.markEvent(item.eventId, 'failed', message);
    return { status: updated?.status === 'dead' ? 'dead' : 'retry', error: message };
  }
}

/**
 * Kurulum doğrulaması için test e-postası kuyruğa ekler (gerçek gönderim worker'a aittir).
 */
export async function enqueueTestEmail(input: {
  repos: Repos;
  toEmail: string;
  transportKey: string;
  idempotencyKey: string;
}): Promise<{ queued: boolean; reason?: string }> {
  const env = getEnv();
  const queued = await input.repos.outbox.enqueue(
    {
      eventId: null,
      jobId: null,
      userId: null,
      kind: 'test',
      toEmail: input.toEmail,
      subject: `${env.APP_DISPLAY_NAME}: test e-postası`,
      template: 'test',
      payload: { provider: input.transportKey },
      idempotencyKey: input.idempotencyKey,
    },
    3,
  );
  return {
    queued: queued.created,
    ...(queued.created ? {} : { reason: 'Aynı test e-postası zaten kuyrukta.' }),
  };
}
