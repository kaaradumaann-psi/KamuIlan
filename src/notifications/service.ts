/**
 * Bildirim servisi: kaydedilen ilan için kullanıcı tercihlerini eşleştirir,
 * benzersiz bildirim olayı üretir ve e-posta outbox'ına yazar.
 *
 * Bu adım TARAMA akışının içinde çalışır ama e-posta GÖNDERİMİNDEN ayrıdır:
 * yalnızca veritabanına yazılır, gönderim worker'ın işidir. Tarama bu yüzden
 * SMTP hızına bağlı değildir; SMTP çökse bile ilanlar kaydedilmiş olur.
 *
 * Idempotency: (kullanıcı, ilan, tür, sürüm) benzersiz anahtarı sayesinde aynı
 * ilan için ikinci kez e-posta kuyruğa girmez.
 */
import type { JobDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import { outboxIdempotencyKey } from '../db/repos/outbox';
import { buildJobPayload, renderEmail } from '../email/templates';
import { queueSavedJobUpdates, type FollowupResult } from './followups';
import { isProcessNotice, matchPreferenceToJob, PROCESS_NOTICE_SUPPRESSION } from './matcher';

export interface QueueNotificationsOptions {
  repos: Repos;
  job: JobDoc;
  kind: 'new-job' | 'job-changed';
  baseUrl: string;
  senderName: string;
  changeSummary?: string;
  /** SMS kanalı yapılandırılmış mı (yalnız takip edilen ilan bildirimlerinde kullanılır). */
  smsEnabled?: boolean;
  /** Test/geliştirme kolaylığı; üretimde değiştirilmez. */
  now?: Date;
}

export interface QueueNotificationsResult {
  evaluated: number;
  matched: number;
  queued: number;
  /** Kanal bazında kuyruğa alınan işler (aynı olay e-posta + Telegram olabilir). */
  queuedEmail: number;
  queuedTelegram: number;
  alreadyExists: number;
  skippedUnverified: number;
  skippedPaused: number;
  /** Tüm kanallar bastırıldıysa neden (ör. süreç duyurusu). Yoksa null. */
  suppressedReason: string | null;
  /** Değişiklikte: ilanı kaydeden (takip eden) kullanıcılara giden bildirimler. */
  savedJobUpdates?: FollowupResult;
}

/**
 * Kanal uygunluğu (bildirim için): e-posta yalnızca doğrulanmış adrese;
 * Telegram yalnızca `active` bağlantıya. İkisi de yoksa kullanıcı atlanır.
 */
export interface DeliveryChannels {
  email: boolean;
  telegram: boolean;
}

export async function queueNotificationsForJob(
  options: QueueNotificationsOptions,
): Promise<QueueNotificationsResult> {
  const { repos, job, kind } = options;
  const now = options.now ?? repos.clock.now();
  const result: QueueNotificationsResult = {
    evaluated: 0,
    matched: 0,
    queued: 0,
    queuedEmail: 0,
    queuedTelegram: 0,
    alreadyExists: 0,
    skippedUnverified: 0,
    skippedPaused: 0,
    suppressedReason: null,
  };

  // Süreç duyuruları (kura, sınav, sonuç) yeni ilan değildir: hiçbir kullanıcıya olay, e-posta
  // veya Telegram kuyruğu üretilmez. Akış ve filtreler bu kayıtları yine gösterir.
  if (isProcessNotice(job)) {
    result.suppressedReason = PROCESS_NOTICE_SUPPRESSION;
    return result;
  }

  // Tüm aboneler sayfalanarak okunur (önceden ilk 200 kullanıcıdan sonrası bildirim almıyordu).
  const preferences = [];
  for (let cursor: string | undefined; ; ) {
    const page = await repos.notifications.listNotifiable(cursor, 200);
    preferences.push(...page);
    if (page.length < 200) break;
    cursor = page.at(-1)?.userId;
  }
  // Bu sürüm için eşleşme bildirimi alan kullanıcılar: takip bildirimi ikinci kez gönderilmez.
  const matchedUserIds = new Set<string>();
  for (const preference of preferences) {
    result.evaluated += 1;

    const user = await repos.users.findById(preference.userId);
    if (!user || user.status !== 'active') continue;

    const channels = await deliveryChannelsFor(
      repos,
      user.id,
      user.emailVerified && user.emailVerifiedAt !== null,
    );
    if (!channels.email && !channels.telegram) {
      // Doğrulanmamış adrese e-posta gitmez (yanlış adres riski); Telegram da bağlı değil.
      if (!user.emailVerified || user.emailVerifiedAt === null) result.skippedUnverified += 1;
      continue;
    }

    const match = matchPreferenceToJob({ preference, job, kind, now });
    if (!match.matched) {
      if (match.suppressedReason) result.skippedPaused += 1;
      continue;
    }
    result.matched += 1;
    matchedUserIds.add(user.id);

    const event = await repos.notifications.recordEvent({
      userId: user.id,
      jobId: job.id,
      kind,
      jobVersion: job.version,
      matchedOn: match.reasons,
    });
    if (!event.created) {
      result.alreadyExists += 1;
      continue;
    }

    const payload = buildJobPayload(job, {
      matchedOn: match.reasons,
      baseUrl: options.baseUrl,
      ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
    });
    const template = kind === 'new-job' ? 'new-job' : 'job-changed';
    const reference = `${job.id}:${kind}:${job.version}`;
    let queuedAny = false;

    if (channels.email) {
      const rendered = renderEmail(
        template,
        { ...payload },
        {
          baseUrl: options.baseUrl,
          senderName: options.senderName,
          preferencesUrl: `${options.baseUrl.replace(/\/$/, '')}/panel`,
        },
      );
      const enqueued = await repos.outbox.enqueue(
        {
          channel: 'email',
          eventId: event.event.id,
          jobId: job.id,
          userId: user.id,
          kind: 'job-notification',
          toEmail: user.email,
          subject: rendered.subject,
          template,
          payload: { ...payload },
          // E-posta anahtarı değişmez: önceki sürümlerle aynı kuyruk kaydını tanır.
          idempotencyKey: outboxIdempotencyKey({ userId: user.id, kind: 'job-notification', reference }),
        },
        5,
      );
      if (enqueued.created) {
        result.queuedEmail += 1;
        queuedAny = true;
      } else {
        result.alreadyExists += 1;
      }
    }

    if (channels.telegram) {
      // Telegram işinin hedefi bağlı sohbettir; `toEmail` alanı zorunlu olduğundan
      // e-posta adresi yerine hesap kimliği yazılır (adres Telegram kuyruğuna girmez).
      const enqueued = await repos.outbox.enqueue(
        {
          channel: 'telegram',
          eventId: event.event.id,
          jobId: job.id,
          userId: user.id,
          kind: 'job-notification',
          toEmail: `telegram:${user.id}`,
          subject: payload.title.slice(0, 200),
          template,
          payload: { ...payload },
          idempotencyKey: outboxIdempotencyKey({
            userId: user.id,
            kind: 'job-notification',
            reference: `${reference}:telegram`,
          }),
        },
        5,
      );
      if (enqueued.created) {
        result.queuedTelegram += 1;
        queuedAny = true;
      }
    }

    if (queuedAny) {
      await repos.notifications.markEvent(event.event.id, 'queued');
      result.queued += 1;
    }
  }

  if (kind === 'job-changed') {
    // Kaydedilen ilanda değişiklik/düzeltme/iptal: filtreden bağımsız olarak takip edene bildirilir.
    result.savedJobUpdates = await queueSavedJobUpdates({
      repos,
      job,
      baseUrl: options.baseUrl,
      senderName: options.senderName,
      ...(options.smsEnabled !== undefined ? { smsEnabled: options.smsEnabled } : {}),
      skipUserIds: matchedUserIds,
      now,
      ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
    });
  }

  return result;
}

/** Kullanıcının o anda hangi kanallara teslim edilebileceği. */
export async function deliveryChannelsFor(
  repos: Repos,
  userId: string,
  emailVerified: boolean,
): Promise<DeliveryChannels> {
  const link = await repos.telegram.findByUser(userId);
  return { email: emailVerified, telegram: link?.status === 'active' };
}

/**
 * Abonelikten çıkma bağlantısıyla gelen jetonu tüketir ve tüm ilan
 * bildirimlerini durdurur. Jeton tek kullanımlıktır.
 *
 * Not: Hesap silinmez; kullanıcı panelden bildirimleri yeniden açabilir.
 */
export async function unsubscribeByToken(repos: Repos, token: string): Promise<{ userId: string } | null> {
  const consumed = await repos.users.consumeToken(token, 'unsubscribe');
  if (!consumed) return null;
  const preference = await repos.notifications.upsertPreference(consumed.userId, {
    enabled: false,
    paused: true,
  });
  if (!preference) return null;
  return { userId: consumed.userId };
}
