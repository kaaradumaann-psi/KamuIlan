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
import { matchPreferenceToJob } from './matcher';

export interface QueueNotificationsOptions {
  repos: Repos;
  job: JobDoc;
  kind: 'new-job' | 'job-changed';
  baseUrl: string;
  senderName: string;
  changeSummary?: string;
  /** Test/geliştirme kolaylığı; üretimde değiştirilmez. */
  now?: Date;
}

export interface QueueNotificationsResult {
  evaluated: number;
  matched: number;
  queued: number;
  alreadyExists: number;
  skippedUnverified: number;
  skippedPaused: number;
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
    alreadyExists: 0,
    skippedUnverified: 0,
    skippedPaused: 0,
  };

  const preferences = await repos.notifications.listNotifiable();
  for (const preference of preferences) {
    result.evaluated += 1;

    const user = await repos.users.findById(preference.userId);
    if (!user || user.status !== 'active') continue;
    // Doğrulanmamış adrese bildirim gönderilmez (yanlış adres riski).
    if (!user.emailVerified || user.emailVerifiedAt === null) {
      result.skippedUnverified += 1;
      continue;
    }

    const match = matchPreferenceToJob({ preference, job, kind, now });
    if (!match.matched) {
      if (match.suppressedReason) result.skippedPaused += 1;
      continue;
    }
    result.matched += 1;

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
    const rendered = renderEmail(kind === 'new-job' ? 'new-job' : 'job-changed', { ...payload }, {
      baseUrl: options.baseUrl,
      senderName: options.senderName,
      preferencesUrl: `${options.baseUrl.replace(/\/$/, '')}/panel`,
    });

    const enqueued = await repos.outbox.enqueue(
      {
        eventId: event.event.id,
        jobId: job.id,
        userId: user.id,
        kind: 'job-notification',
        toEmail: user.email,
        subject: rendered.subject,
        template: kind === 'new-job' ? 'new-job' : 'job-changed',
        payload: { ...payload },
        idempotencyKey: outboxIdempotencyKey({
          userId: user.id,
          kind: 'job-notification',
          reference: `${job.id}:${kind}:${job.version}`,
        }),
      },
      5,
    );

    if (enqueued.created) {
      await repos.notifications.markEvent(event.event.id, 'queued');
      result.queued += 1;
    } else {
      result.alreadyExists += 1;
    }
  }

  return result;
}

/**
 * Abonelikten çıkma bağlantısıyla gelen jetonu tüketir ve tüm ilan
 * bildirimlerini durdurur. Jeton tek kullanımlıktır.
 *
 * Not: Hesap silinmez; kullanıcı panelden bildirimleri yeniden açabilir.
 */
export async function unsubscribeByToken(
  repos: Repos,
  token: string,
): Promise<{ userId: string } | null> {
  const consumed = await repos.users.consumeToken(token, 'unsubscribe');
  if (!consumed) return null;
  const preference = await repos.notifications.upsertPreference(consumed.userId, {
    enabled: false,
    paused: true,
  });
  if (!preference) return null;
  return { userId: consumed.userId };
}
