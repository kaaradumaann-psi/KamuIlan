/**
 * Bildirim doğruluğu (denetim 27.10.2026, madde 7-11, 14):
 *  - Eşleştirici gerçek vakalar (psikolog tercihi ↔ İETT kamu işçisi ilanı vb.) ve bastırma nedenleri.
 *  - E-posta/Telegram doğru kullanıcıya, doğru ilan için kuyruğa girer.
 *  - Kaydedilen (takip edilen) ilanda değişiklik/iptal bildirimi.
 *  - Son başvuru hatırlatmaları (3 ve 1 gün; İstanbul günü; idempotent).
 *  - Twilio SMS kanalı (enjekte fetch; gerçek ağ YOK), rıza ve E.164 denetimi.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { EMPTY_FILTERS } from '../src/db/repos/notifications';
import type { EmailOutboxDoc, JobDoc, NotificationPreferenceDoc } from '../src/db/schemas';
import { sendOne } from '../src/email/service';
import { fixedClock } from '../src/lib/clock';
import {
  calendarDaysLeft,
  istanbulDateOnly,
  queueDeadlineReminders,
  reminderBucket,
} from '../src/notifications/followups';
import { matchJobFilters } from '../src/notifications/matcher';
import { queueNotificationsForJob } from '../src/notifications/service';
import { createTwilioClient, maskPhone, normalizePhoneE164, readSmsConfig, type FetchLike, type SmsClient } from '../src/sms/twilio';
import { renderSmsText } from '../src/sms/format';
import { renderJobMessage, readJobPayload } from '../src/telegram/format';

const NOW = new Date('2026-10-27T09:00:00+03:00');
const BASE_URL = 'https://kamuilan.test';
const SENDER = 'Kamuİlan';

let seq = 0;
function makeJob(overrides: Partial<JobDoc> = {}): JobDoc {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  const base = {
    id: `job_takip${n}`,
    title: 'Örnek Kurum - Sözleşmeli Personel Alım İlanı',
    titleNormalized: 'ornek kurum sozlesmeli personel alim ilani',
    institution: 'Örnek Kurum',
    institutionNormalized: 'ornek kurum',
    unit: null,
    employmentType: 'sozlesmeli',
    status: 'active',
    statusReason: '',
    city: null,
    cityNormalized: '',
    district: null,
    quota: 5,
    applicationStartAt: null,
    applicationEndAt: null,
    applicationEndDate: '2026-11-20',
    publishedAt: null,
    detailUrl: `https://ornek.test/ilan/${n}`,
    normalizedUrl: `https://ornek.test/ilan/${n}`,
    applicationUrl: null,
    applicationMethod: null,
    attachments: [],
    requirements: {
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      kpssYear: null,
      qualificationCodes: [],
      minAge: null,
      maxAge: null,
      certificates: [],
      minExperienceYears: null,
      foreignLanguages: [],
      specialConditions: [],
    },
    titles: [],
    openings: [],
    textExcerpt: 'Kurumumuz emrinde istihdam edilmek üzere personel alınacaktır.',
    textNormalized: '',
    originalRefNo: null,
    sourceKeys: ['ornek-kaynak'],
    primarySourceKey: 'ornek-kaynak',
    classification: {
      decision: 'accept' as const,
      kind: 'job' as const,
      employmentType: 'sozlesmeli' as const,
      confidence: 0.8,
      reasons: [],
      rules: [],
      negativeSignals: [],
      version: '2026.10.1',
      classifiedAt: '2026-10-15T09:00:00.000Z',
    },
    extractionConfidence: 0.8,
    fieldSources: {},
    evidence: {},
    uncertainties: [],
    provenance: 'scraped' as const,
    contentHash: `hash-takip-${n}`,
    dedupeKey: `dedupe-takip-${n}`,
    version: 1,
    firstSeenAt: '2026-10-15T09:00:00.000Z',
    lastSeenAt: '2026-10-15T09:00:00.000Z',
    lastVerifiedAt: null,
    createdAt: '2026-10-15T09:00:00.000Z',
    updatedAt: '2026-10-15T09:00:00.000Z',
  };
  return { ...base, ...overrides } as JobDoc;
}

const SCOPE_ALL = { includeWorkerJobs: true, includeAcademicJobs: true };

/* ------------------------------------------------------------------ */
describe('eşleştirici: gerçek vakalar', () => {
  const ietf = makeJob({
    title: 'İETT Genel Müdürlüğü Otobüs Şoförü Alımı',
    institution: 'İETT Genel Müdürlüğü',
    employmentType: 'kamu-isci',
    city: 'İstanbul',
    titles: ['Otobüs Şoförü'],
    textExcerpt: 'İŞKUR aracılığıyla 300 sürekli işçi (otobüs şoförü) alınacaktır.',
  });
  const psikologIlani = makeJob({
    title: 'Sağlık Bakanlığı Sözleşmeli Psikolog Alımı',
    institution: 'Sağlık Bakanlığı',
    employmentType: 'sozlesmeli',
    city: 'İstanbul',
    titles: ['Psikolog'],
    requirements: { ...makeJob().requirements, educationLevels: ['lisans'], departments: ['Psikoloji'] },
  });

  it('psikolog tercihi İETT kamu işçisi (şoför) ilanıyla EŞLEŞMEZ — neden: unvan', () => {
    const result = matchJobFilters({ ...EMPTY_FILTERS, titles: ['Psikolog'] }, ietf, NOW, SCOPE_ALL);
    expect(result.matched).toBe(false);
    expect(result.suppressedReason).toBe('unvan filtresi eşleşmedi');
  });

  it('işçi ilanlarını hariç tutan kullanıcıya İETT ilanı gitmez — neden: kamu işçisi', () => {
    const result = matchJobFilters(EMPTY_FILTERS, ietf, NOW, { includeWorkerJobs: false, includeAcademicJobs: true });
    expect(result).toEqual({ matched: false, reasons: [], suppressedReason: 'kamu işçisi ilanları hariç tutuldu' });
  });

  it('psikolog + İstanbul + lisans + Psikoloji bölümü → eşleşir, gerekçeler yazılır', () => {
    const result = matchJobFilters(
      {
        ...EMPTY_FILTERS,
        titles: ['psikolog'],
        cities: ['istanbul'],
        educationLevels: ['lisans'],
        departments: ['Psikoloji'],
        employmentTypes: ['sozlesmeli'],
      },
      psikologIlani,
      NOW,
      SCOPE_ALL,
    );
    expect(result.matched).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['unvan: psikolog', 'il: İstanbul', 'bölüm: Psikoloji']),
    );
    expect(result.reasons.some((reason) => reason.startsWith('öğrenim:'))).toBe(true);
  });

  it('il, çalışma biçimi, öğrenim, bölüm uyuşmazlıkları ayrı nedenle bastırılır', () => {
    const f = { ...EMPTY_FILTERS, titles: ['psikolog'] };
    expect(matchJobFilters({ ...f, cities: ['Ankara'] }, psikologIlani, NOW, SCOPE_ALL).suppressedReason).toBe(
      'il filtresi eşleşmedi',
    );
    expect(
      matchJobFilters({ ...f, employmentTypes: ['kadrolu'] }, psikologIlani, NOW, SCOPE_ALL).suppressedReason,
    ).toBe('çalışma biçimi filtresi eşleşmedi');
    expect(
      matchJobFilters({ ...f, educationLevels: ['ortaogretim'] }, psikologIlani, NOW, SCOPE_ALL).suppressedReason,
    ).toBe('öğrenim düzeyi filtresi eşleşmedi');
    expect(
      matchJobFilters({ ...f, departments: ['Hemşirelik'] }, psikologIlani, NOW, SCOPE_ALL).suppressedReason,
    ).toBe('bölüm filtresi eşleşmedi');
  });

  it('ilanda il/öğrenim belirtilmemişse elemez, gerekçede "belirtilmemiş" yazar', () => {
    const job = makeJob({ title: 'Psikolog Alımı', city: null });
    const result = matchJobFilters(
      { ...EMPTY_FILTERS, titles: ['Psikolog'], cities: ['İzmir'], educationLevels: ['lisans'] },
      job,
      NOW,
      SCOPE_ALL,
    );
    expect(result.matched).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining(['il belirtilmemiş', 'öğrenim düzeyi belirtilmemiş']));
  });

  it('unvan kadro tablosunda (openings) geçiyorsa başlık genel olsa da eşleşir', () => {
    const job = makeJob({
      title: 'Sözleşmeli Personel Alımı',
      openings: [{ title: 'Psikolog' } as JobDoc['openings'][number]],
    });
    expect(matchJobFilters({ ...EMPTY_FILTERS, titles: ['Psikolog'] }, job, NOW, SCOPE_ALL).matched).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-takip-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function user(
  email: string,
  options: {
    filters?: Partial<typeof EMPTY_FILTERS>;
    telegramChat?: string;
    paused?: boolean;
    sms?: { enabled: boolean; phoneE164: string | null; consentAt: string | null };
    deadlineReminders?: boolean;
    includeWorkerJobs?: boolean;
  } = {},
): Promise<string> {
  const { user: created } = await repos.users.create({
    email,
    passwordHash: 'h'.repeat(64),
    passwordSalt: 's'.repeat(32),
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(created.id, {
    enabled: true,
    paused: options.paused ?? false,
    onlyNewJobs: true,
    notifyOnChanges: true,
    includeWorkerJobs: options.includeWorkerJobs ?? true,
    filters: { ...EMPTY_FILTERS, ...(options.filters ?? {}) },
    ...(options.sms ? { sms: options.sms } : {}),
    ...(options.deadlineReminders !== undefined ? { deadlineReminders: options.deadlineReminders } : {}),
  });
  if (options.telegramChat) {
    await repos.telegram.link({ userId: created.id, chatId: options.telegramChat, telegramUsername: 'aday' });
  }
  return created.id;
}

async function outbox(): Promise<EmailOutboxDoc[]> {
  return store.find('emailOutbox', {}, { limit: 1000 });
}

describe('doğru kullanıcıya doğru ilan (e-posta + Telegram)', () => {
  it('psikolog ilanı yalnız psikolog tercihli kullanıcıya; şoför tercihliye hiçbir kanal gitmez', async () => {
    const psikolog = await user('psikolog@ornek.test', { filters: { titles: ['Psikolog'] }, telegramChat: '111' });
    const sofor = await user('sofor@ornek.test', { filters: { titles: ['Şoför'] }, telegramChat: '222' });
    const job = makeJob({ title: 'Sözleşmeli Psikolog Alımı', titles: ['Psikolog'] });
    await repos.jobs.insertJob(job);

    const result = await queueNotificationsForJob({ repos, job, kind: 'new-job', baseUrl: BASE_URL, senderName: SENDER, now: NOW });
    expect(result.queuedEmail).toBe(1);
    expect(result.queuedTelegram).toBe(1);

    const items = await outbox();
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.userId === psikolog && item.jobId === job.id)).toBe(true);
    expect(items.find((item) => item.channel === 'email')?.toEmail).toBe('psikolog@ornek.test');
    expect(items.find((item) => item.channel === 'telegram')?.toEmail).toBe(`telegram:${psikolog}`);
    expect(items.some((item) => item.userId === sofor)).toBe(false);

    // Telegram teslimi kullanıcının KENDİ sohbetine gider.
    const sent: string[] = [];
    const telegramItem = items.find((item) => item.channel === 'telegram') as EmailOutboxDoc;
    const outcome = await sendOne({
      repos,
      item: telegramItem,
      workerId: 'w',
      now: NOW,
      telegram: {
        client: {
          sendMessage: async (input: { chatId: string }) => {
            sent.push(input.chatId);
            return { ok: true, result: { message_id: 7 } };
          },
        } as never,
        config: {} as never,
        senderName: SENDER,
        baseUrl: BASE_URL,
      },
    });
    expect(outcome.status).toBe('accepted');
    expect(sent).toEqual(['111']);
  });

  it('aynı ilan ikinci kez işlendiğinde kuyruk tekrarlanmaz', async () => {
    await user('a@ornek.test');
    const job = makeJob();
    await repos.jobs.insertJob(job);
    await queueNotificationsForJob({ repos, job, kind: 'new-job', baseUrl: BASE_URL, senderName: SENDER, now: NOW });
    const again = await queueNotificationsForJob({ repos, job, kind: 'new-job', baseUrl: BASE_URL, senderName: SENDER, now: NOW });
    expect(again.queued).toBe(0);
    expect(await outbox()).toHaveLength(1);
  });
});

describe('takip edilen (kaydedilen) ilanda değişiklik', () => {
  it('filtresi uymayan ama ilanı kaydeden kullanıcı değişiklik/iptal bildirimini alır; eşleşen kullanıcıya çift mesaj gitmez', async () => {
    const takipci = await user('takip@ornek.test', { filters: { titles: ['Mühendis'] }, telegramChat: '333' });
    const eslesen = await user('eslesen@ornek.test', { filters: { titles: ['Psikolog'] } });
    const disarida = await user('baska@ornek.test', { filters: { titles: ['Mühendis'] } });
    const job = makeJob({ title: 'Psikolog Alımı', titles: ['Psikolog'], version: 2, status: 'cancelled' });
    await repos.jobs.insertJob(job);
    await repos.savedJobs.toggle(takipci, job.id);
    await repos.savedJobs.toggle(eslesen, job.id);

    const result = await queueNotificationsForJob({
      repos,
      job,
      kind: 'job-changed',
      changeSummary: 'İlan resmî olarak iptal edildi.',
      baseUrl: BASE_URL,
      senderName: SENDER,
      now: NOW,
      smsEnabled: false,
    });
    expect(result.savedJobUpdates?.recipients).toBe(1);

    const items = await outbox();
    const saved = items.filter((item) => item.kind === 'saved-job-update');
    expect(saved.map((item) => [item.userId, item.channel]).sort()).toEqual(
      [
        [takipci, 'email'],
        [takipci, 'telegram'],
      ].sort(),
    );
    expect(saved[0]?.payload['changeSummary']).toBe('İlan resmî olarak iptal edildi.');
    expect(items.filter((item) => item.userId === eslesen)).toHaveLength(1); // yalnız eşleşme bildirimi
    expect(items.some((item) => item.userId === disarida)).toBe(false);

    // Tekrar işlenirse yeni kayıt yok.
    await queueNotificationsForJob({ repos, job, kind: 'job-changed', baseUrl: BASE_URL, senderName: SENDER, now: NOW, smsEnabled: false });
    expect((await outbox()).length).toBe(items.length);
  });

  it('duraklatılmış kullanıcıya takip bildirimi gitmez', async () => {
    const id = await user('dur@ornek.test', { paused: true });
    const job = makeJob({ version: 2 });
    await repos.jobs.insertJob(job);
    await repos.savedJobs.toggle(id, job.id);
    const result = await queueNotificationsForJob({ repos, job, kind: 'job-changed', baseUrl: BASE_URL, senderName: SENDER, now: NOW, smsEnabled: false });
    expect(result.savedJobUpdates?.recipients).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('Telegram mesajı "takip ettiğiniz ilan" başlığı ve değişiklik özetiyle oluşur', () => {
    const payload = readJobPayload({
      jobId: 'job_x1',
      title: 'Psikolog Alımı',
      institution: 'Kurum',
      changeSummary: 'Son başvuru tarihi uzatıldı.',
      matchedOn: ['takip ettiğiniz ilan'],
    });
    const message = renderJobMessage({ kind: 'saved-job-update', payload: payload!, baseUrl: BASE_URL, senderName: SENDER });
    expect(message.text).toContain('Takip ettiğiniz ilanda değişiklik');
    expect(message.text).toContain('Son başvuru tarihi uzatıldı.');
  });
});

describe('son başvuru hatırlatmaları', () => {
  it('İstanbul günü: UTC 22:30 ertesi gündür', () => {
    expect(istanbulDateOnly(new Date('2026-10-27T22:30:00Z'))).toBe('2026-10-28');
    expect(calendarDaysLeft('2026-10-30', new Date('2026-10-27T22:30:00Z'))).toBe(2);
    expect(calendarDaysLeft('2026-10-30', new Date('2026-10-27T20:30:00Z'))).toBe(3);
  });

  it('kova: 3→3, 2→3, 1→1, 0→1, 4→yok, geçmiş→yok', () => {
    expect([3, 2, 1, 0, 4, -1].map((d) => reminderBucket(d))).toEqual([3, 3, 1, 1, null, null]);
  });

  it('kaydeden ve bildirimi gönderilen kullanıcıya 3 ve 1 gün kala bir kez hatırlatır; kapatan kullanıcıya göndermez', async () => {
    const takipci = await user('takip@ornek.test', { telegramChat: '444', filters: { titles: ['Mühendis'] } });
    const eslesen = await user('eslesen@ornek.test', { filters: { titles: ['Psikolog'] } });
    const herkes = await user('herkes@ornek.test'); // filtresiz abone; bu ilan için bildirim olayı yok
    const kapali = await user('kapali@ornek.test', { deadlineReminders: false });
    const job = makeJob({ title: 'Psikolog Alımı', titles: ['Psikolog'], applicationEndDate: '2026-10-30' });
    await repos.jobs.insertJob(job);
    await repos.savedJobs.toggle(takipci, job.id);
    await repos.savedJobs.toggle(kapali, job.id);
    // eşleşen kullanıcıya önce yeni ilan bildirimi gitmiş olsun (olay 'queued').
    await queueNotificationsForJob({ repos, job, kind: 'new-job', baseUrl: BASE_URL, senderName: SENDER, now: NOW });
    const before = (await outbox()).length;
    // "herkes" filtresiz olduğu için o da yeni ilan bildirimi aldı → olayı var; bu bilinçli.
    const notifiedUsers = new Set((await outbox()).map((item) => item.userId));
    expect(notifiedUsers.has(herkes)).toBe(true);

    const first = await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: false, now: NOW });
    expect(first.jobs).toBe(1);
    const reminders = (await outbox()).filter((item) => item.kind === 'deadline-reminder');
    expect(reminders.length).toBe((await outbox()).length - before);
    const users = new Set(reminders.map((item) => item.userId));
    expect(users.has(takipci)).toBe(true);
    expect(users.has(eslesen)).toBe(true);
    expect(users.has(kapali)).toBe(false);
    expect(reminders.find((item) => item.userId === takipci && item.channel === 'telegram')).toBeDefined();
    expect(reminders.every((item) => item.payload['daysLeft'] === 3)).toBe(true);

    // Aynı gün tekrar: kopya yok.
    const again = await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: false, now: NOW });
    expect(again.queuedEmail + again.queuedTelegram).toBe(0);

    // 2 gün sonra (1 gün kala): yeni kova → bir hatırlatma daha.
    const later = new Date('2026-10-29T09:00:00+03:00');
    const second = await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: false, now: later });
    expect(second.queuedEmail).toBeGreaterThan(0);
    // Son gün (0): aynı 1-kovası → kopya yok.
    const lastDay = await queueDeadlineReminders({
      repos,
      baseUrl: BASE_URL,
      senderName: SENDER,
      smsEnabled: false,
      now: new Date('2026-10-30T09:00:00+03:00'),
    });
    expect(lastDay.queuedEmail + lastDay.queuedTelegram).toBe(0);
  });

  it('tercihi eşleşen (daha önce bildirim almamış) kullanıcıya ve kaydedene Telegram hatırlatması gider; filtresiz/eşleşmeyen almaz', async () => {
    // İlan, kullanıcılar tercih kaydetmeden ÖNCE gelmiş: hiçbir yeni ilan bildirimi yok.
    const job = makeJob({ title: 'Sağlık Bakanlığı Sözleşmeli Psikolog Alımı', titles: ['Psikolog'], applicationEndDate: '2026-10-30' });
    await repos.jobs.insertJob(job);
    const psikolog = await user('psikolog@ornek.test', { filters: { titles: ['Psikolog'] }, telegramChat: '901' });
    const kaydeden = await user('kaydeden@ornek.test', { filters: { titles: ['Mühendis'] }, telegramChat: '902' });
    const sofor = await user('sofor@ornek.test', { filters: { titles: ['Şoför'] }, telegramChat: '903' });
    const filtresiz = await user('filtresiz@ornek.test', { telegramChat: '904' });
    await repos.savedJobs.toggle(kaydeden, job.id);

    await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: false, now: NOW });
    const telegram = (await outbox()).filter((item) => item.kind === 'deadline-reminder' && item.channel === 'telegram');
    const users = new Set(telegram.map((item) => item.userId));
    expect(users).toEqual(new Set([psikolog, kaydeden]));
    expect(users.has(sofor)).toBe(false);
    expect(users.has(filtresiz)).toBe(false);
    expect(telegram.every((item) => item.jobId === job.id && item.toEmail === `telegram:${item.userId}`)).toBe(true);
  });

  it('kapanmış/iptal ilan ve uzak tarihli ilan için hatırlatma yok', async () => {
    const id = await user('k@ornek.test');
    const cancelled = makeJob({ status: 'cancelled', applicationEndDate: '2026-10-29' });
    const far = makeJob({ applicationEndDate: '2026-11-15' });
    await repos.jobs.insertJob(cancelled);
    await repos.jobs.insertJob(far);
    await repos.savedJobs.toggle(id, cancelled.id);
    await repos.savedJobs.toggle(id, far.id);
    const result = await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: false, now: NOW });
    expect(result.jobs).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
describe('SMS (Twilio)', () => {
  const ENV = {
    SMS_ENABLED: true,
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'gizli-token-123',
    TWILIO_FROM: '+15005550006',
    TWILIO_MESSAGING_SERVICE_SID: '',
    TWILIO_API_BASE_URL: 'https://api.twilio.test',
  };

  it('varsayılan kapalı; eksik kimlikte null', () => {
    expect(readSmsConfig({ ...ENV, SMS_ENABLED: false })).toBeNull();
    expect(readSmsConfig({ ...ENV, TWILIO_AUTH_TOKEN: '' })).toBeNull();
    expect(readSmsConfig({ ...ENV, TWILIO_FROM: '' })).toBeNull();
    expect(readSmsConfig({ ...ENV, TWILIO_FROM: '', TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}` })).not.toBeNull();
  });

  it('E.164 normalizasyonu ve maskeleme', () => {
    expect(normalizePhoneE164('0532 123 45 67')).toBe('+905321234567');
    expect(normalizePhoneE164('5321234567')).toBe('+905321234567');
    expect(normalizePhoneE164('+90 (532) 123-45-67')).toBe('+905321234567');
    expect(normalizePhoneE164('00905321234567')).toBe('+905321234567');
    expect(normalizePhoneE164('12345')).toBeNull();
    expect(normalizePhoneE164('+0123456789')).toBeNull();
    expect(maskPhone('+905321234567')).toBe('+90******4567');
  });

  it('REST çağrısı: doğru URL, Basic auth, form gövdesi; hata metninde sır yok', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchOk: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 201, json: async () => ({ sid: 'SM123', status: 'queued' }) };
    };
    const client = createTwilioClient(readSmsConfig(ENV)!, fetchOk);
    const ok = await client.send({ to: '+905321234567', body: 'Merhaba' });
    expect(ok).toEqual({ ok: true, sid: 'SM123', status: 'queued' });
    expect(calls[0]?.url).toBe(`https://api.twilio.test/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`);
    expect(calls[0]?.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
    );
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get('To')).toBe('+905321234567');
    expect(form.get('From')).toBe('+15005550006');
    expect(form.get('Body')).toBe('Merhaba');

    const fetchTrial: FetchLike = async () => ({
      status: 400,
      json: async () => ({ code: 21608, message: 'The number is unverified. Trial accounts cannot send messages to unverified numbers' }),
    });
    const trial = await createTwilioClient(readSmsConfig(ENV)!, fetchTrial).send({ to: '+905321234567', body: 'x' });
    expect(trial.ok).toBe(false);
    if (!trial.ok) {
      expect(trial.retryable).toBe(false);
      expect(trial.code).toBe(21608);
      expect(JSON.stringify(trial)).not.toContain(ENV.TWILIO_AUTH_TOKEN);
    }

    const fetch503: FetchLike = async () => ({ status: 503, json: async () => ({}) });
    const busy = await createTwilioClient(readSmsConfig(ENV)!, fetch503).send({ to: '+905321234567', body: 'x' });
    expect(busy.ok === false && busy.retryable).toBe(true);
  });

  it('SMS kısa ve bağlantılı; hatırlatma metni gün sayısını içerir', () => {
    const payload = readJobPayload({ jobId: 'job_s1', title: 'Psikolog Alımı', institution: 'Kurum', applicationEndDate: '2026-10-30' })!;
    const text = renderSmsText({ kind: 'deadline-reminder', payload, daysLeft: 3, baseUrl: BASE_URL, senderName: SENDER });
    expect(text).toContain('Son başvuruya 3 gün');
    expect(text).toContain(`${BASE_URL}/ilanlar/job_s1`);
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it('rıza + numara varsa SMS kuyruğa girer ve kendi numarasına gider; rıza yoksa bastırılır', async () => {
    const onayli = await user('sms@ornek.test', {
      sms: { enabled: true, phoneE164: '+905321234567', consentAt: NOW.toISOString() },
    });
    const rizasiz = await user('rizasiz@ornek.test', {
      sms: { enabled: true, phoneE164: '+905329999999', consentAt: null },
    });
    const job = makeJob({ applicationEndDate: '2026-10-28' });
    await repos.jobs.insertJob(job);
    await repos.savedJobs.toggle(onayli, job.id);
    await repos.savedJobs.toggle(rizasiz, job.id);

    // SMS kapalıyken hiç SMS kuyruğu yok.
    const off = await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: false, now: NOW });
    expect(off.queuedSms).toBe(0);

    const on = await queueDeadlineReminders({ repos, baseUrl: BASE_URL, senderName: SENDER, smsEnabled: true, now: NOW });
    expect(on.queuedSms).toBe(1);
    const smsItem = (await outbox()).find((item) => item.channel === 'sms')!;
    expect(smsItem.userId).toBe(onayli);
    expect(smsItem.toEmail).toBe(`sms:${onayli}`); // numara outbox'a yazılmaz

    const sent: { to: string; body: string }[] = [];
    const client: SmsClient = {
      send: async (input) => {
        sent.push(input);
        return { ok: true, sid: 'SM1', status: 'queued' };
      },
    };
    const outcome = await sendOne({ repos, item: smsItem, workerId: 'w', now: NOW, sms: { client, senderName: SENDER, baseUrl: BASE_URL } });
    expect(outcome.status).toBe('accepted');
    expect(sent[0]?.to).toBe('+905321234567');
    expect(sent[0]?.body).toContain('Son başvuruya 1 gün');

    // Rıza sonradan geri alınırsa bekleyen SMS bastırılır.
    await repos.notifications.upsertPreference(onayli, { sms: { enabled: false, phoneE164: '+905321234567', consentAt: null } });
    const fake = { ...smsItem, id: smsItem.id, status: 'sending' as const };
    const suppressed = await sendOne({ repos, item: fake, workerId: 'w', now: NOW, sms: { client, senderName: SENDER, baseUrl: BASE_URL } });
    expect(suppressed.status).toBe('suppressed');
    expect(sent).toHaveLength(1);
  });
});

describe('abone sayfalama', () => {
  it('200 üstü aboneler de değerlendirilir (önceden ilk 200 ile sınırlıydı)', async () => {
    const calls: (string | undefined)[] = [];
    const fake = (id: number) => ({ userId: `usr_${String(id).padStart(24, '0')}` }) as unknown as NotificationPreferenceDoc;
    repos.notifications.listNotifiable = async (cursor?: string) => {
      calls.push(cursor);
      return calls.length === 1 ? Array.from({ length: 200 }, (_, i) => fake(i)) : [fake(200), fake(201), fake(202)];
    };
    const result = await queueNotificationsForJob({ repos, job: makeJob(), kind: 'new-job', baseUrl: BASE_URL, senderName: SENDER, now: NOW });
    expect(result.evaluated).toBe(203);
    expect(calls).toEqual([undefined, fake(199).userId]);
  });
});
