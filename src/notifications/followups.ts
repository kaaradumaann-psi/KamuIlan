/**
 * Takip edilen ilan bildirimleri ve son başvuru hatırlatmaları.
 *
 * 1) Kaydedilen (takip edilen) ilanda değişiklik/düzeltme/iptal → `saved-job-update`.
 *    Eşleşme filtresi uygulanmaz (kullanıcı ilanı kendisi seçti); ama bildirim tercihi
 *    açık ve duraklatılmamış olmalıdır (abonelikten çıkan kullanıcıya gitmez).
 * 2) Son başvuru yaklaşan ilanlar → `deadline-reminder`. Alıcılar: ilanı kaydedenler +
 *    bu ilan için bildirimi gerçekten kuyruğa alınmış (eşleşmiş) kullanıcılar. Filtresiz
 *    "tüm ilanlar" abonesine her ilan için hatırlatma gitmez (bildirim olayı yoksa alıcı değildir).
 *    Gün hesabı İstanbul takvim günüdür; eşikler 3 ve 1 gün (0 = son gün, 1 kovasına düşer).
 *
 * Idempotency: outbox anahtarı (kullanıcı, tür, ilan, sürüm|bitiş tarihi+kova, kanal). Worker her
 * tikte çağırsa da aynı hatırlatma ikinci kez kuyruğa girmez. Bitiş tarihi değişirse (uzatma)
 * yeni tarih için yeniden hatırlatılır — bu bilinçlidir.
 *
 * Kanallar: e-posta (doğrulanmış adres), Telegram (aktif bağlantı), SMS (yalnız SMS_ENABLED +
 * açık rıza + E.164 numara). SMS yalnızca bu iki düşük hacimli türde kullanılır; yeni ilan
 * eşleşmeleri SMS ile gönderilmez (maliyet/istenmeyen ileti riski).
 */
import type { Repos } from '../db/repos';
import { outboxIdempotencyKey } from '../db/repos/outbox';
import type { EmailOutboxDoc, JobDoc, UserDoc } from '../db/schemas';
import { buildJobPayload, renderEmail } from '../email/templates';
import { getEnv } from '../config/env';
import { readSmsConfig } from '../sms/twilio';
import { isProcessNotice } from './matcher';

/** Açıkça verilmezse ortamdan: SMS_ENABLED + eksiksiz Twilio ayarı. Okunamazsa kapalı. */
function resolveSmsEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  try {
    return readSmsConfig(getEnv()) !== null;
  } catch {
    return false;
  }
}

export const REMINDER_BUCKETS = [1, 3] as const;

/** İstanbul takvim günü (YYYY-MM-DD). */
export function istanbulDateOnly(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(dateOnly: string, days: number): string {
  const base = Date.parse(`${dateOnly}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Bitiş tarihine kalan İstanbul takvim günü (0 = bugün son gün; geçmişse negatif). */
export function calendarDaysLeft(applicationEndDate: string | null, now: Date): number | null {
  if (!applicationEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(applicationEndDate)) return null;
  const end = Date.parse(`${applicationEndDate}T00:00:00Z`);
  const today = Date.parse(`${istanbulDateOnly(now)}T00:00:00Z`);
  if (!Number.isFinite(end)) return null;
  return Math.round((end - today) / 86_400_000);
}

/** Hatırlatma kovası: ≤1 gün → 1, ≤3 gün → 3, aksi hâlde yok. Geçmiş tarih → yok. */
export function reminderBucket(daysLeft: number | null): number | null {
  if (daysLeft === null || daysLeft < 0) return null;
  for (const bucket of REMINDER_BUCKETS) if (daysLeft <= bucket) return bucket;
  return null;
}

export interface FollowupChannels {
  email: boolean;
  telegram: boolean;
  sms: boolean;
}

export interface FollowupOptions {
  repos: Repos;
  baseUrl: string;
  senderName: string;
  /** SMS kanalı yapılandırılmış mı (SMS_ENABLED + Twilio). Varsayılan: kapalı. */
  smsEnabled?: boolean;
  now?: Date;
}

export interface FollowupResult {
  recipients: number;
  queuedEmail: number;
  queuedTelegram: number;
  queuedSms: number;
  alreadyExists: number;
  skipped: number;
}

function emptyResult(): FollowupResult {
  return { recipients: 0, queuedEmail: 0, queuedTelegram: 0, queuedSms: 0, alreadyExists: 0, skipped: 0 };
}

/**
 * Kullanıcının bu takip bildirimi için kanalları. Tercih kapalı/duraklatılmış veya hesap
 * aktif değilse hiçbir kanal yoktur.
 */
async function followupChannels(
  repos: Repos,
  user: UserDoc,
  smsEnabled: boolean,
  kind: 'saved-job-update' | 'deadline-reminder',
): Promise<FollowupChannels | null> {
  if (user.status !== 'active') return null;
  const preference = await repos.notifications.getPreference(user.id);
  if (!preference || !preference.enabled || preference.paused) return null;
  if (kind === 'deadline-reminder' && preference.deadlineReminders === false) return null;
  const link = await repos.telegram.findByUser(user.id);
  const sms = preference.sms;
  return {
    email: user.emailVerified && user.emailVerifiedAt !== null,
    telegram: link?.status === 'active',
    sms: smsEnabled && Boolean(sms?.enabled && sms.consentAt && sms.phoneE164),
  };
}

async function enqueueFollowup(input: {
  repos: Repos;
  user: UserDoc;
  job: JobDoc;
  kind: 'saved-job-update' | 'deadline-reminder';
  reference: string;
  channels: FollowupChannels;
  payload: Record<string, unknown>;
  baseUrl: string;
  senderName: string;
  result: FollowupResult;
}): Promise<void> {
  const { repos, user, job, kind, channels, payload, result } = input;
  const template = kind;
  const targets: { channel: EmailOutboxDoc['channel']; toEmail: string; subject: string }[] = [];
  if (channels.email) {
    const rendered = renderEmail(template, payload, {
      baseUrl: input.baseUrl,
      senderName: input.senderName,
      preferencesUrl: `${input.baseUrl.replace(/\/$/, '')}/panel`,
    });
    targets.push({ channel: 'email', toEmail: user.email, subject: rendered.subject });
  }
  // Telegram/SMS hedefi gönderim anında bağlantı/tercih kaydından çözülür; adres kuyruğa girmez.
  if (channels.telegram) targets.push({ channel: 'telegram', toEmail: `telegram:${user.id}`, subject: job.title.slice(0, 200) });
  if (channels.sms) targets.push({ channel: 'sms', toEmail: `sms:${user.id}`, subject: job.title.slice(0, 200) });

  if (targets.length === 0) {
    result.skipped += 1;
    return;
  }
  result.recipients += 1;
  for (const target of targets) {
    const enqueued = await repos.outbox.enqueue(
      {
        channel: target.channel,
        eventId: null,
        jobId: job.id,
        userId: user.id,
        kind,
        toEmail: target.toEmail,
        subject: target.subject,
        template,
        payload,
        idempotencyKey: outboxIdempotencyKey({
          userId: user.id,
          kind,
          reference: `${input.reference}:${target.channel}`,
        }),
      },
      target.channel === 'sms' ? 3 : 5,
    );
    if (!enqueued.created) result.alreadyExists += 1;
    else if (target.channel === 'email') result.queuedEmail += 1;
    else if (target.channel === 'telegram') result.queuedTelegram += 1;
    else result.queuedSms += 1;
  }
}

async function savedUserIds(repos: Repos, jobId: string): Promise<string[]> {
  const saved = await repos.store.find('savedJobs', { jobId }, { limit: 5_000 });
  return [...new Set(saved.map((doc) => doc.userId))];
}

/**
 * Kaydedilen ilandaki değişikliği takip edenlere kuyruğa alır. `skipUserIds`: aynı sürüm için
 * eşleşme bildirimi zaten alan kullanıcılar (çift mesaj olmasın).
 */
export async function queueSavedJobUpdates(
  options: FollowupOptions & { job: JobDoc; changeSummary?: string; skipUserIds?: ReadonlySet<string> },
): Promise<FollowupResult> {
  const { repos, job } = options;
  const result = emptyResult();
  if (isProcessNotice(job)) return result;
  for (const userId of await savedUserIds(repos, job.id)) {
    if (options.skipUserIds?.has(userId)) {
      result.skipped += 1;
      continue;
    }
    const user = await repos.users.findById(userId);
    if (!user) continue;
    const channels = await followupChannels(repos, user, resolveSmsEnabled(options.smsEnabled), 'saved-job-update');
    if (!channels) {
      result.skipped += 1;
      continue;
    }
    const payload = {
      ...buildJobPayload(job, {
        matchedOn: ['takip ettiğiniz ilan'],
        baseUrl: options.baseUrl,
        ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
      }),
      jobStatus: job.status,
    };
    await enqueueFollowup({
      repos,
      user,
      job,
      kind: 'saved-job-update',
      reference: `${job.id}:v${job.version}`,
      channels,
      payload,
      baseUrl: options.baseUrl,
      senderName: options.senderName,
      result,
    });
  }
  return result;
}

/** Son başvurusu yaklaşan ilanlar için hatırlatmaları kuyruğa alır (idempotent; her tikte çağrılabilir). */
export async function queueDeadlineReminders(options: FollowupOptions & { jobLimit?: number }): Promise<FollowupResult & { jobs: number }> {
  const { repos } = options;
  const now = options.now ?? repos.clock.now();
  const result = { ...emptyResult(), jobs: 0 };
  const today = istanbulDateOnly(now);
  const maxBucket = REMINDER_BUCKETS[REMINDER_BUCKETS.length - 1] ?? 3;
  const jobs = await repos.store.find(
    'jobs',
    {
      status: { $in: ['active', 'upcoming'] },
      applicationEndDate: { $gte: today, $lte: addDays(today, maxBucket) },
    },
    { limit: options.jobLimit ?? 2_000 },
  );

  for (const job of jobs) {
    if (isProcessNotice(job)) continue;
    const daysLeft = calendarDaysLeft(job.applicationEndDate, now);
    const bucket = reminderBucket(daysLeft);
    if (bucket === null || daysLeft === null) continue;
    result.jobs += 1;

    const saved = new Set(await savedUserIds(repos, job.id));
    // Bildirimi gerçekten kuyruğa alınmış (eşleşmiş) kullanıcılar; bastırılan/başarısız olanlar değil.
    const notified = (await repos.notifications.listEventsForJob(job.id))
      .filter((event) => event.status === 'queued')
      .map((event) => event.userId);
    const recipients = new Set([...saved, ...notified]);

    for (const userId of recipients) {
      const user = await repos.users.findById(userId);
      if (!user) continue;
      const channels = await followupChannels(repos, user, resolveSmsEnabled(options.smsEnabled), 'deadline-reminder');
      if (!channels) {
        result.skipped += 1;
        continue;
      }
      const payload = {
        ...buildJobPayload(job, {
          matchedOn: [saved.has(userId) ? 'takip ettiğiniz ilan' : 'size bildirilen ilan'],
          baseUrl: options.baseUrl,
        }),
        daysLeft,
      };
      await enqueueFollowup({
        repos,
        user,
        job,
        kind: 'deadline-reminder',
        reference: `${job.id}:${job.applicationEndDate}:d${bucket}`,
        channels,
        payload,
        baseUrl: options.baseUrl,
        senderName: options.senderName,
        result,
      });
    }
  }
  return result;
}
