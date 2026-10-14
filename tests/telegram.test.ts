/**
 * Telegram bildirimleri testleri (ağa çıkmadan; Bot API sahte fetch ile taklit edilir).
 *
 * Kapsam:
 *  - Yapılandırma: kanal yalnızca token + geçerli bot adıyla açılır.
 *  - Biçim: HTML kaçışı (ilan başlığı enjeksiyonu yok), https düğmeleri, 4096 sınırı.
 *  - İstemci: token hata metinlerinde görünmez; hata sınıflandırması (blocked/retry/permanent).
 *  - Bağlama: tek kullanımlık, süresi dolan ve yanlış botu hedefleyen kodlar; komutlar; engelleme.
 *  - Fan-out: e-posta ve Telegram bağımsız kanallar; e-posta anahtarı değişmez.
 *  - Teslim: başarı, durdurulmuş bağlantı, engelleme (403), 429 retry_after, kanal ayrımı.
 *  - KVKK: hesap silinince Telegram bağlantısı kaldırılır.
 *  - Webhook: sır doğrulaması, kapalı uç, geçersiz güncelleme.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { outboxIdempotencyKey } from '../src/db/repos/outbox';
import type { EmailOutboxDoc, JobDoc } from '../src/db/schemas';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { queueNotificationsForJob } from '../src/notifications/service';
import { sendOutboxBatch } from '../src/email/service';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { buildApp } from '../src/server/app';
import { describeEnv, getEnv, resetEnvCache } from '../src/config/env';
import { hashPassword } from '../src/server/passwords';
import type { SourceDefinition } from '../src/config/sources';
import { TEST_SOURCE_KEY, sozlesmeliPersonelIlani } from './fixtures/announcements';
import { telegramConfig, type TelegramConfig } from '../src/telegram/config';
import { TelegramBotClient, classifyTelegramFailure, type TelegramFetch } from '../src/telegram/client';
import { renderJobMessage, readJobPayload, TELEGRAM_MESSAGE_LIMIT } from '../src/telegram/format';
import { createLinkCode, handleTelegramUpdate, parseTelegramUpdate } from '../src/telegram/bot';
import { deliverTelegramItem } from '../src/telegram/deliver';
import { buildJobPayload } from '../src/email/templates';

const NOW = new Date('2026-10-14T09:00:00+03:00');
const BASE_URL = 'https://kamuilan.test';
const LOGGER = createLogger('telegram-test', { level: 'silent' });
const CONFIG: TelegramConfig = {
  token: '123456:TEST-TOKEN-ABCDEFGH',
  botUsername: 'KamuIlanTestBot',
  webhookSecret: 'test_sir-0123456789',
  apiBaseUrl: 'https://api.telegram.test',
};
const CHAT_ID = '7001';

const TEST_DEFINITION: SourceDefinition = {
  key: TEST_SOURCE_KEY,
  name: 'Test Kaynağı',
  group: 'kurum',
  sourceType: 'institution-page',
  institution: 'Test Kurumu',
  homepageUrl: 'https://ornek.test/',
  listingUrl: 'https://ornek.test/ilanlar',
  adapterKey: 'test-liste',
  method: 'html-list',
  status: 'method-defined',
  statusNote: 'Yalnızca testler için sahte kaynak tanımı.',
  lastVerifiedAt: null,
  verificationEvidence: 'Testlerde canlı erişim yapılmaz.',
  coverageNote: 'Test kapsamı.',
  enabled: true,
  intervalMinutes: 60,
  minRequestIntervalMs: 0,
  maxConcurrency: 1,
  allowedHosts: ['ornek.test'],
  tags: ['test'],
};

afterEach(() => {
  delete process.env['TELEGRAM_BOT_TOKEN'];
  delete process.env['TELEGRAM_BOT_USERNAME'];
  delete process.env['TELEGRAM_WEBHOOK_SECRET'];
  delete process.env['TELEGRAM_API_BASE_URL'];
  resetEnvCache();
});

interface SentCall {
  url: string;
  body: Record<string, unknown>;
}

/** Sahte Bot API: çağrıları kaydeder; `respond` yanıtı belirler. */
function fakeTelegram(
  respond?: (method: string, body: Record<string, unknown>) => { status: number; body: unknown } | 'throw',
): {
  fetch: TelegramFetch;
  calls: SentCall[];
} {
  const calls: SentCall[] = [];
  const fetchImpl: TelegramFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const method = url.split('/').pop() ?? '';
    const scripted = respond?.(method, body);
    if (scripted === 'throw') throw new Error(`ağ hatası ${CONFIG.token}`);
    const reply = scripted ?? { status: 200, body: { ok: true, result: { message_id: 555 } } };
    return { status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  return { fetch: fetchImpl, calls };
}

async function makeRepos(clockDate = NOW): Promise<{ repos: Repos; store: FileStore }> {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-telegram-')));
  await store.init();
  const repos = createRepos(store, fixedClock(clockDate));
  return { repos, store };
}

async function seedUser(repos: Repos, options: { verified: boolean; email?: string }): Promise<string> {
  const password = await hashPassword('CokGuvenliSifre123');
  const { user } = await repos.users.create({
    email: options.email ?? 'telegram@ornek.test',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    emailVerified: options.verified,
  });
  return user.id;
}

async function seedJob(repos: Repos): Promise<JobDoc> {
  await repos.sources.seed([TEST_DEFINITION]);
  const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
    repos,
    now: NOW,
    workerId: 'worker-test',
    provenance: 'scraped',
  });
  const job = await repos.jobs.findById(outcome.jobId as string);
  if (!job) throw new Error('İlan oluşturulamadı');
  return job;
}

function filtersFor(job: JobDoc) {
  return {
    keywords: [],
    titles: [],
    institutions: [],
    cities: [],
    employmentTypes: [job.employmentType],
    educationLevels: [],
    departments: [],
    kpssScoreTypes: [],
    kpssMinScore: null,
    minDaysUntilDeadline: null,
  };
}

async function linkChat(repos: Repos, userId: string, chatId = CHAT_ID): Promise<void> {
  await repos.telegram.link({ userId, chatId, telegramUsername: 'aday_test' });
}

function message(text: string, chatId = CHAT_ID, extra: Record<string, unknown> = {}) {
  return parseTelegramUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), username: 'aday_test' },
      text,
      ...extra,
    },
  });
}

async function queueTelegramItem(repos: Repos, userId: string, job: JobDoc) {
  const payload = buildJobPayload(job, { matchedOn: ['test'], baseUrl: BASE_URL });
  return repos.outbox.enqueue(
    {
      channel: 'telegram',
      eventId: null,
      jobId: job.id,
      userId,
      kind: 'job-notification',
      toEmail: `telegram:${userId}`,
      subject: job.title,
      template: 'new-job',
      payload: { ...payload },
      idempotencyKey: outboxIdempotencyKey({
        userId,
        kind: 'job-notification',
        reference: `${job.id}:tg:${Math.random()}`,
      }),
    },
    5,
  );
}

function sender(fetchImpl: TelegramFetch) {
  return {
    client: new TelegramBotClient({ token: CONFIG.token, apiBaseUrl: CONFIG.apiBaseUrl, fetchImpl }),
    config: CONFIG,
    senderName: 'Kamuİlan',
    baseUrl: BASE_URL,
  };
}

describe('yapılandırma', () => {
  it('kanal yalnızca token ve geçerli bot adıyla açılır', () => {
    const base = getEnv({ NODE_ENV: 'test' });
    expect(
      telegramConfig({ ...base, TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_USERNAME: 'KamuIlanTestBot' }),
    ).toBeNull();
    expect(telegramConfig({ ...base, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_BOT_USERNAME: '' })).toBeNull();
    expect(
      telegramConfig({ ...base, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_BOT_USERNAME: 'kamu ilan' }),
    ).toBeNull();
    // Şema dönüşümü (baştaki @ temizliği) yalnızca getEnv üzerinden çalışır.
    const config = telegramConfig(
      getEnv({
        TELEGRAM_BOT_TOKEN: 'x:y',
        TELEGRAM_BOT_USERNAME: '@KamuIlanTestBot',
        TELEGRAM_WEBHOOK_SECRET: '',
      }),
    );
    expect(config?.botUsername).toBe('KamuIlanTestBot');
    // Boş sır: kanal açılır ama webhook kabul etmez (uyarı olarak bildirilir).
    expect(config?.webhookSecret).toBe('');
    // Geçersiz karakterli sır ise ortam doğrulamasında hata verir (başlangıçta yakalanır).
    expect(() =>
      getEnv({
        TELEGRAM_BOT_TOKEN: 'x:y',
        TELEGRAM_BOT_USERNAME: 'KamuIlanTestBot',
        TELEGRAM_WEBHOOK_SECRET: 'gecersiz sir!',
      }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });
});

describe('mesaj biçimi', () => {
  const base = { matchedOn: [] as string[], applicationEndDate: null, quota: null, city: null };

  it('ilan başlığındaki HTML enjekte edilmez', () => {
    const payload = readJobPayload({
      ...base,
      jobId: 'job_x',
      title: '<img src=x onerror=alert(1)> Personel alımı',
      institution: 'Test & <b>Kurumu</b>',
      employmentType: 'contract',
      detailUrl: 'https://ornek.test/ilan/1',
      applicationUrl: 'javascript:alert(1)',
    } as unknown as Record<string, unknown>);
    expect(payload).not.toBeNull();
    const rendered = renderJobMessage({
      kind: 'new-job',
      payload: payload!,
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
    });
    expect(rendered.text).not.toContain('<img');
    expect(rendered.text).toContain('&lt;img');
    expect(rendered.text).toContain('Test &amp; &lt;b&gt;Kurumu&lt;/b&gt;');
    // javascript: bağlantısı düğme olmaz; ilan portalı https olduğu için kalır.
    expect(rendered.buttons.every((button) => button.url.startsWith('https://'))).toBe(true);
  });

  it('Telegram sınırını aşan metin kırpılır', () => {
    const payload = readJobPayload({
      jobId: 'job_y',
      title: 'Uzun ilan',
      institution: 'Kurum',
      employmentType: 'contract',
      detailUrl: 'https://ornek.test/ilan/2',
      matchedOn: [],
      changeSummary: 'değişiklik '.repeat(2000),
    } as unknown as Record<string, unknown>);
    const rendered = renderJobMessage({
      kind: 'job-changed',
      payload: payload!,
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
    });
    expect(rendered.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(rendered.text).toContain('İlanda değişiklik');
  });

  it('eksik ilan verisi okunamaz (ölü mektup yolu için)', () => {
    expect(readJobPayload({ title: 'x' })).toBeNull();
  });
});

describe('Bot API istemcisi', () => {
  it('ağ hatası metninde token görünmez', async () => {
    const fake = fakeTelegram(() => 'throw');
    const client = new TelegramBotClient({
      token: CONFIG.token,
      apiBaseUrl: CONFIG.apiBaseUrl,
      fetchImpl: fake.fetch,
    });
    const result = await client.getMe();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.description).not.toContain(CONFIG.token);
    expect(result.description).toContain('***');
  });

  it('sendMessage HTML kipi ve satır içi düğmeyle çağrılır', async () => {
    const fake = fakeTelegram();
    const client = new TelegramBotClient({
      token: CONFIG.token,
      apiBaseUrl: CONFIG.apiBaseUrl,
      fetchImpl: fake.fetch,
    });
    await client.sendMessage({
      chatId: CHAT_ID,
      text: '<b>x</b>',
      buttons: [{ text: 'Aç', url: 'https://ornek.test' }],
    });
    expect(fake.calls[0]?.url).toBe(`${CONFIG.apiBaseUrl}/bot${CONFIG.token}/sendMessage`);
    expect(fake.calls[0]?.body['parse_mode']).toBe('HTML');
    expect(fake.calls[0]?.body['reply_markup']).toEqual({
      inline_keyboard: [[{ text: 'Aç', url: 'https://ornek.test' }]],
    });
  });

  it('hata sınıflandırması: engel, yeniden deneme, kalıcı', () => {
    const fail = (errorCode: number | null, description: string, kind: 'api' | 'network' = 'api') => ({
      ok: false as const,
      kind,
      errorCode,
      description,
      retryAfterSec: null,
    });
    expect(classifyTelegramFailure(fail(403, 'Forbidden: bot was blocked by the user'))).toBe('blocked');
    expect(classifyTelegramFailure(fail(400, 'Bad Request: chat not found'))).toBe('blocked');
    expect(classifyTelegramFailure(fail(429, 'Too Many Requests'))).toBe('retry');
    expect(classifyTelegramFailure(fail(502, 'Bad Gateway'))).toBe('retry');
    expect(classifyTelegramFailure(fail(null, 'timeout', 'network'))).toBe('retry');
    expect(classifyTelegramFailure(fail(400, "Bad Request: can't parse entities"))).toBe('permanent');
  });
});

describe('bağlama ve komutlar', () => {
  it('bağlantı kodu t.me bağlantısı üretir; jeton tek kullanımlıktır', async () => {
    const { repos } = await makeRepos();
    const userId = await seedUser(repos, { verified: true });
    const code = await createLinkCode(repos, CONFIG, userId);
    const token = new URL(code.deepLink).searchParams.get('start') ?? '';
    expect(code.deepLink.startsWith('https://t.me/KamuIlanTestBot?start=')).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

    const fake = fakeTelegram();
    const deps = {
      repos,
      client: new TelegramBotClient({
        token: CONFIG.token,
        apiBaseUrl: CONFIG.apiBaseUrl,
        fetchImpl: fake.fetch,
      }),
      config: CONFIG,
      senderName: 'Kamuİlan',
    };
    const first = await handleTelegramUpdate(deps, message(`/start ${token}`)!);
    expect(first.action).toBe('linked');
    expect((await repos.telegram.findByUser(userId))?.status).toBe('active');

    const second = await handleTelegramUpdate(deps, message(`/start ${token}`)!);
    expect(second.action).toBe('link-invalid');
  });

  it('süresi dolmuş kod reddedilir', async () => {
    const { repos, store } = await makeRepos();
    const userId = await seedUser(repos, { verified: true });
    const code = await createLinkCode(repos, CONFIG, userId);
    const token = new URL(code.deepLink).searchParams.get('start') ?? '';
    const later = createRepos(store, fixedClock(new Date(NOW.getTime() + 16 * 60_000)));
    const fake = fakeTelegram();
    const deps = {
      repos: later,
      client: new TelegramBotClient({
        token: CONFIG.token,
        apiBaseUrl: CONFIG.apiBaseUrl,
        fetchImpl: fake.fetch,
      }),
      config: CONFIG,
      senderName: 'Kamuİlan',
    };
    expect((await handleTelegramUpdate(deps, message(`/start ${token}`)!)).action).toBe('link-invalid');
    expect(await later.telegram.findByUser(userId)).toBeNull();
  });

  it('başka bota yazılmış komut ve grup sohbeti yok sayılır', async () => {
    const { repos } = await makeRepos();
    const fake = fakeTelegram();
    const deps = {
      repos,
      client: new TelegramBotClient({
        token: CONFIG.token,
        apiBaseUrl: CONFIG.apiBaseUrl,
        fetchImpl: fake.fetch,
      }),
      config: CONFIG,
      senderName: 'Kamuİlan',
    };
    expect((await handleTelegramUpdate(deps, message('/dur@BaskaBot')!)).action).toBe('ignored-mention');
    const group = parseTelegramUpdate({
      message: {
        message_id: 2,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 7, username: 'x' },
        text: '/dur',
      },
    });
    expect((await handleTelegramUpdate(deps, group!)).action).toBe('ignored-group');
    expect(fake.calls).toHaveLength(0);
  });

  it('/dur bekleyen Telegram işlerini bastırır, /basla yeniden açar, /cik bağlantıyı kaldırır', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: true });
    await linkChat(repos, userId);
    const pending = await queueTelegramItem(repos, userId, job);
    const fake = fakeTelegram();
    const deps = {
      repos,
      client: new TelegramBotClient({
        token: CONFIG.token,
        apiBaseUrl: CONFIG.apiBaseUrl,
        fetchImpl: fake.fetch,
      }),
      config: CONFIG,
      senderName: 'Kamuİlan',
    };

    expect((await handleTelegramUpdate(deps, message('/dur')!)).action).toBe('stopped');
    expect((await repos.telegram.findByUser(userId))?.status).toBe('stopped');
    expect((await repos.outbox.findById(pending.item.id))?.status).toBe('suppressed');

    expect((await handleTelegramUpdate(deps, message('/basla')!)).action).toBe('resumed');
    expect((await repos.telegram.findByUser(userId))?.status).toBe('active');

    expect((await handleTelegramUpdate(deps, message('/cik')!)).action).toBe('unlinked');
    expect((await repos.telegram.findByUser(userId))?.status).toBe('unlinked');
    expect(await repos.telegram.findByChat(CHAT_ID)).toHaveLength(1);
  });

  it('botu engelleyen kullanıcının bağlantısı engellenir; yeniden başlatınca açılır', async () => {
    const { repos } = await makeRepos();
    const userId = await seedUser(repos, { verified: true });
    await linkChat(repos, userId);
    const fake = fakeTelegram();
    const deps = {
      repos,
      client: new TelegramBotClient({
        token: CONFIG.token,
        apiBaseUrl: CONFIG.apiBaseUrl,
        fetchImpl: fake.fetch,
      }),
      config: CONFIG,
      senderName: 'Kamuİlan',
    };
    const blocked = parseTelegramUpdate({
      my_chat_member: {
        chat: { id: Number(CHAT_ID), type: 'private' },
        from: { id: Number(CHAT_ID) },
        new_chat_member: { status: 'kicked' },
      },
    });
    expect((await handleTelegramUpdate(deps, blocked!)).action).toBe('blocked');
    expect((await repos.telegram.findByUser(userId))?.status).toBe('blocked');

    // Kullanıcı botla yeniden yazışırsa bağlantı yeniden etkinleşir.
    await handleTelegramUpdate(deps, message('merhaba')!);
    expect((await repos.telegram.findByUser(userId))?.status).toBe('active');
  });
});

describe('bildirim kuyruğu (kanal fan-out)', () => {
  it('e-postası doğrulanmamış ama Telegram bağlı kullanıcıya yalnızca Telegram işi girer', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: false, email: 'tg-only@ornek.test' });
    await linkChat(repos, userId);
    await repos.notifications.upsertPreference(userId, { enabled: true, filters: filtersFor(job) });

    const result = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
      now: NOW,
    });
    expect(result.queuedTelegram).toBe(1);
    expect(result.queuedEmail).toBe(0);
    const items = await repos.outbox.list({ userId }, 10);
    expect(items.map((item) => item.channel)).toEqual(['telegram']);
  });

  it('iki kanal da açıksa iki ayrı iş oluşur; e-posta anahtarı değişmez', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: true });
    await linkChat(repos, userId);
    await repos.notifications.upsertPreference(userId, { enabled: true, filters: filtersFor(job) });

    const result = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
      now: NOW,
    });
    expect(result.queued).toBe(1);
    expect(result.queuedEmail).toBe(1);
    expect(result.queuedTelegram).toBe(1);

    const items = await repos.outbox.list({ userId }, 10);
    const email = items.find((item) => item.channel === 'email') as EmailOutboxDoc;
    const telegram = items.find((item) => item.channel === 'telegram') as EmailOutboxDoc;
    expect(email.idempotencyKey).toBe(
      outboxIdempotencyKey({
        userId,
        kind: 'job-notification',
        reference: `${job.id}:new-job:${job.version}`,
      }),
    );
    expect(telegram.idempotencyKey).not.toBe(email.idempotencyKey);

    // İkinci çağrı çift iş üretmez.
    const again = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
      now: NOW,
    });
    expect(again.queuedTelegram).toBe(0);
    expect(await repos.outbox.list({ userId }, 10)).toHaveLength(2);
  });

  it('Telegram bağlantısı durdurulmuşsa Telegram işi kuyruğa girmez', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: true });
    await linkChat(repos, userId);
    await repos.telegram.setStatus(userId, 'stopped');
    await repos.notifications.upsertPreference(userId, { enabled: true, filters: filtersFor(job) });
    const result = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
      now: NOW,
    });
    expect(result.queuedTelegram).toBe(0);
    expect(result.queuedEmail).toBe(1);
  });
});

describe('teslim ve kanal ayrımı', () => {
  it('başarılı gönderim kabul kaydı ve olay durumu yazar', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: false });
    await linkChat(repos, userId);
    await repos.notifications.upsertPreference(userId, { enabled: true, filters: filtersFor(job) });
    await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
      now: NOW,
    });
    const item = (await repos.outbox.list({ userId }, 10))[0] as EmailOutboxDoc;

    const fake = fakeTelegram();
    const outcome = await deliverTelegramItem({
      repos,
      sender: sender(fake.fetch),
      item,
      now: NOW,
      retryDelayMs: () => 1000,
    });
    expect(outcome.status).toBe('accepted');
    expect(fake.calls[0]?.body['chat_id']).toBe(CHAT_ID);
    expect((await repos.outbox.findById(item.id))?.status).toBe('accepted');
  });

  it('durdurulmuş bağlantıya ağ çağrısı yapılmaz', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: false });
    await linkChat(repos, userId);
    const queued = await queueTelegramItem(repos, userId, job);
    await repos.telegram.setStatus(userId, 'stopped');
    const fake = fakeTelegram();
    const outcome = await deliverTelegramItem({
      repos,
      sender: sender(fake.fetch),
      item: queued.item,
      now: NOW,
      retryDelayMs: () => 1000,
    });
    expect(outcome.status).toBe('suppressed');
    expect(fake.calls).toHaveLength(0);
  });

  it('403 yanıtı bağlantıyı engellenmiş yapar ve bekleyen işleri bastırır', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: false });
    await linkChat(repos, userId);
    const first = await queueTelegramItem(repos, userId, job);
    const second = await queueTelegramItem(repos, userId, job);
    const fake = fakeTelegram(() => ({
      status: 403,
      body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    }));
    const outcome = await deliverTelegramItem({
      repos,
      sender: sender(fake.fetch),
      item: first.item,
      now: NOW,
      retryDelayMs: () => 1000,
    });
    expect(outcome.status).toBe('suppressed');
    expect((await repos.telegram.findByUser(userId))?.status).toBe('blocked');
    expect((await repos.outbox.findById(second.item.id))?.status).toBe('suppressed');
    expect((await repos.outbox.findById(first.item.id))?.status).toBe('suppressed');
  });

  it('429 yanıtı retry_after kadar sonrasına ertelenir', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: false });
    await linkChat(repos, userId);
    const queued = await queueTelegramItem(repos, userId, job);
    const fake = fakeTelegram(() => ({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 120 },
      },
    }));
    const outcome = await deliverTelegramItem({
      repos,
      sender: sender(fake.fetch),
      item: queued.item,
      now: NOW,
      retryDelayMs: () => 1000,
    });
    expect(outcome.status).toBe('retry');
    const updated = await repos.outbox.findById(queued.item.id);
    expect(updated?.status).toBe('pending');
    expect(Date.parse(updated?.nextAttemptAt ?? '')).toBeGreaterThanOrEqual(NOW.getTime() + 120_000);
  });

  it('sendOutboxBatch yalnızca istenen kanalın işlerini alır', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: true });
    await linkChat(repos, userId);
    await repos.notifications.upsertPreference(userId, { enabled: true, filters: filtersFor(job) });
    await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: 'Kamuİlan',
      now: NOW,
    });

    const fake = fakeTelegram();
    const telegramBatch = await sendOutboxBatch({
      repos,
      channel: 'telegram',
      telegram: sender(fake.fetch),
      workerId: 'w-tg',
      now: NOW,
    });
    expect(telegramBatch.claimed).toBe(1);
    expect(telegramBatch.sent).toBe(1);

    const emailItem = (await repos.outbox.list({ userId }, 10)).find((item) => item.channel === 'email');
    expect(emailItem?.status).toBe('pending');
  });

  it('Telegram kanalı yapılandırılmadan e-posta yolu Telegram işlerini almaz', async () => {
    const { repos } = await makeRepos();
    const job = await seedJob(repos);
    const userId = await seedUser(repos, { verified: false });
    await linkChat(repos, userId);
    await queueTelegramItem(repos, userId, job);
    const claimed = await repos.outbox.claimBatch('w-email', 10, 60_000, 'email');
    expect(claimed).toHaveLength(0);
  });

  it('e-posta kanalı taşıyıcısız çağrılamaz', async () => {
    const { repos } = await makeRepos();
    await expect(sendOutboxBatch({ repos, workerId: 'w' })).rejects.toThrow(/taşıyıcı/);
  });
});

describe('KVKK silme', () => {
  it('hesap silinince Telegram bağlantısı tamamen kaldırılır', async () => {
    const { repos } = await makeRepos();
    const userId = await seedUser(repos, { verified: true });
    await linkChat(repos, userId);
    await repos.users.erasePersonalData(userId);
    await repos.telegram.erase(userId);
    expect(await repos.telegram.findByUser(userId)).toBeNull();
    expect(await repos.telegram.findByChat(CHAT_ID)).toHaveLength(0);
  });

  it('bir sohbeti yeni hesap bağlarsa önceki hesabın bağlantısı kaldırılır', async () => {
    const { repos } = await makeRepos();
    const first = await seedUser(repos, { verified: true, email: 'ilk@ornek.test' });
    const second = await seedUser(repos, { verified: true, email: 'ikinci@ornek.test' });
    await linkChat(repos, first);
    await linkChat(repos, second);
    expect((await repos.telegram.findByUser(first))?.status).toBe('unlinked');
    expect((await repos.telegram.findByUser(second))?.status).toBe('active');
  });
});

describe('webhook ve panel uçları', () => {
  async function appWith(
    env: Record<string, string>,
  ): Promise<{ app: FastifyInstance; repos: Repos; store: FileStore }> {
    Object.assign(process.env, env);
    resetEnvCache();
    const { repos, store } = await makeRepos();
    await repos.sources.seed();
    const app = await buildApp({ repos, logger: LOGGER, disableRateLimit: true });
    return { app, repos, store };
  }

  const TOKEN_ENV = {
    TELEGRAM_BOT_TOKEN: CONFIG.token,
    TELEGRAM_BOT_USERNAME: CONFIG.botUsername,
    TELEGRAM_WEBHOOK_SECRET: CONFIG.webhookSecret,
    // Ağa çıkılmaz: yanıt gönderimi başarısız olsa da webhook 200 döner.
    TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9',
  };

  it('yanlış sır 401 döner; sır yapılandırılmamışsa uç yoktur (404)', async () => {
    const { app } = await appWith(TOKEN_ENV);
    const update = { message: { message_id: 1, chat: { id: 7, type: 'private' }, text: '/yardim' } };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/telegram/webhook',
      payload: update,
      headers: { 'x-telegram-bot-api-secret-token': 'yanlis' },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();

    const closed = await appWith({ ...TOKEN_ENV, TELEGRAM_WEBHOOK_SECRET: '' });
    const notFound = await closed.app.inject({
      method: 'POST',
      url: '/api/telegram/webhook',
      payload: update,
    });
    expect(notFound.statusCode).toBe(404);
    await closed.app.close();
  });

  it('doğru sırla gelen güncelleme işlenir ve 200 döner', async () => {
    const { app } = await appWith(TOKEN_ENV);
    const response = await app.inject({
      method: 'POST',
      url: '/api/telegram/webhook',
      payload: {
        update_id: 9,
        message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/durum' },
      },
      headers: { 'x-telegram-bot-api-secret-token': CONFIG.webhookSecret },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: 'status' });
    await app.close();
  });

  it('oturumsuz panel uçları 401 döner', async () => {
    const { app } = await appWith(TOKEN_ENV);
    const status = await app.inject({ method: 'GET', url: '/api/telegram/status' });
    expect(status.statusCode).toBe(401);
    await app.close();
  });

  it("ortam özeti (describeEnv) bot token'ını ve webhook sırrını göstermez", () => {
    const summary = JSON.stringify(describeEnv(getEnv({ ...TOKEN_ENV, NODE_ENV: 'test' })));
    expect(summary).not.toContain(CONFIG.token);
    expect(summary).not.toContain(CONFIG.webhookSecret);
    expect(summary).toContain('@KamuIlanTestBot');
  });
});
