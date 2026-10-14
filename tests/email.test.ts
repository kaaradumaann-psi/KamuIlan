/**
 * E-posta hattı testleri: outbox → taşıyıcı → durum kaydı, yeniden deneme,
 * ölü mektup, abonelikten çıkma ve ortam ayrımı (geliştirme/üretim).
 *
 * Hiçbir test gerçek SMTP'ye bağlanmaz; Memory/File taşıyıcıları kullanılır.
 */
import { mkdtempSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { queueNotificationsForJob, unsubscribeByToken } from '../src/notifications/service';
import { createEmailTransport, FileEmailTransport, MemoryEmailTransport } from '../src/email/transport';
import type { EmailMessage, EmailSendResult, EmailTransport } from '../src/email/transport';
import { enqueueTestEmail, sendOutboxBatch } from '../src/email/service';
import { getEnv } from '../src/config/env';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const WORKER = 'worker-email-1';

async function makeRepos(): Promise<{ repos: Repos; advance: (ms: number) => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-email-'));
  const store = new FileStore(dir);
  await store.init();
  const clock = fixedClock(NOW);
  return { repos: createRepos(store, clock), advance: (ms) => clock.advance(ms) };
}

/** İstenen sırayla başarılı/başarısız yanıt veren sahte taşıyıcı. */
function scriptedTransport(results: (EmailSendResult | Error)[]): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  let index = 0;
  return {
    key: 'memory',
    description: 'Test amaçlı sıralı taşıyıcı',
    sent,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      sent.push(message);
      const result = results[Math.min(index, results.length - 1)] ?? rejected('senaryo bitti');
      index += 1;
      if (result instanceof Error) throw result;
      return result;
    },
    async close(): Promise<void> {},
  };
}

const accepted = (id: string): EmailSendResult => ({
  accepted: true,
  providerMessageId: id,
  providerResponse: '250 OK',
});

const rejected = (error: string): EmailSendResult => ({
  accepted: false,
  providerMessageId: null,
  providerResponse: '451 geçici hata',
  error,
});

async function prepareUserWithJob(repos: Repos, email = 'abone@ornek.test') {
  const { user } = await repos.users.create({
    email,
    passwordHash: 'scrypt$test-hash-value',
    passwordSalt: 'test-salt-value',
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, { enabled: true, filters: {} });

  const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
    repos,
    now: NOW,
    workerId: WORKER,
    provenance: 'sample',
  });
  const job = await repos.jobs.findById(outcome.jobId as string);
  if (!job) throw new Error('Test ilanı oluşturulamadı');
  return { user, job };
}

describe('e-posta gönderimi', () => {
  it('sağlayıcı kabul edince kaydı "accepted" yapar ve teslim iddiası kurmaz', async () => {
    const { repos } = await makeRepos();
    const { job } = await prepareUserWithJob(repos);
    await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'Kamuİlan',
      now: NOW,
    });

    const transport = new MemoryEmailTransport();
    const result = await sendOutboxBatch({ repos, transport, workerId: WORKER, now: NOW });
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, dead: 0 });

    const outbox = await repos.outbox.list({}, 10);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.status).toBe('accepted');
    expect(outbox[0]?.providerMessageId).toBeTruthy();
    expect(outbox[0]?.acceptedAt).toBe(NOW.toISOString());

    // E-posta içeriği: ilan alanları, resmî bağlantı ve abonelikten çıkma bağlantısı.
    const message = transport.sent[0];
    expect(message?.subject).toContain('Örnek Üniversitesi');
    expect(message?.html).toContain('Son başvuru');
    expect(message?.html).toContain('/abonelikten-cik?token=');
    expect(message?.text.length).toBeGreaterThan(50);

    // Bildirim olayı "queued" olarak işaretlenir (gönderim değil, kuyruk durumu).
    const events = await repos.notifications.listEventsForJob(job.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('queued');
  });

  it('geçici hatada yeniden denemeye bırakır, sonraki turda gönderir', async () => {
    const { repos, advance } = await makeRepos();
    const { job } = await prepareUserWithJob(repos);
    await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'Kamuİlan',
      now: NOW,
    });

    const transport = scriptedTransport([rejected('451 4.7.1 geçici hata'), accepted('msg-2')]);
    const first = await sendOutboxBatch({ repos, transport, workerId: WORKER, now: NOW });
    expect(first.failed).toBe(1);

    const afterFirst = await repos.outbox.list({}, 10);
    expect(afterFirst[0]?.status).toBe('pending');
    expect(afterFirst[0]?.attempts).toBe(1);
    expect(afterFirst[0]?.lastError).toContain('451');
    // Geri çekilme: hemen tekrar denenmez.
    expect(Date.parse(afterFirst[0]?.nextAttemptAt ?? '')).toBeGreaterThan(NOW.getTime());

    // Deneme zamanı gelene kadar kuyruk boş kalır.
    const early = await sendOutboxBatch({ repos, transport, workerId: WORKER, now: NOW });
    expect(early.claimed).toBe(0);

    advance(2 * 3_600_000);
    const second = await sendOutboxBatch({ repos, transport, workerId: WORKER });
    expect(second.sent).toBe(1);
    expect(transport.sent).toHaveLength(2);

    const afterSecond = await repos.outbox.list({}, 10);
    expect(afterSecond[0]?.status).toBe('accepted');
    expect(afterSecond[0]?.attempts).toBe(2);
  });

  it('deneme sınırı dolunca ölü mektup olur ve yönetici yeniden kuyruğa alabilir', async () => {
    const { repos, advance } = await makeRepos();
    const { job } = await prepareUserWithJob(repos);
    const enqueued = await repos.outbox.enqueue(
      {
        eventId: null,
        jobId: job.id,
        userId: null,
        kind: 'job-notification',
        toEmail: 'abone@ornek.test',
        subject: 'Deneme',
        template: 'new-job',
        payload: { ...job, matchedOn: [] },
        idempotencyKey: 'test-kalan-deneme',
        maxAttempts: 2,
      },
      2,
    );

    const transport = scriptedTransport([
      rejected('550 kalıcı hata'),
      rejected('550 kalıcı hata'),
      accepted('msg-late'),
    ]);

    await sendOutboxBatch({ repos, transport, workerId: WORKER, now: NOW });
    advance(48 * 3_600_000);
    const second = await sendOutboxBatch({ repos, transport, workerId: WORKER });
    expect(second.dead).toBe(1);

    const dead = await repos.outbox.listDead(10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.status).toBe('dead');
    expect(dead[0]?.lastError).toContain('550');

    const requeued = await repos.outbox.requeue(enqueued.item.id);
    expect(requeued?.status).toBe('pending');
    expect(requeued?.attempts).toBe(0);

    const final = await sendOutboxBatch({ repos, transport, workerId: WORKER });
    expect(final.sent).toBe(1);
  });

  it('şablon hatasında sonsuz döngüye girmez, ölü mektup yazar', async () => {
    const { repos } = await makeRepos();
    const { item } = await repos.outbox.enqueue(
      {
        eventId: null,
        jobId: null,
        userId: null,
        kind: 'job-notification',
        toEmail: 'abone@ornek.test',
        subject: 'Bozuk',
        // Bilinmeyen şablon: render sırasında hata verir.
        template: 'bilinmeyen-sablon',
        payload: {},
        idempotencyKey: 'test-bozuk-sablon',
      },
      3,
    );

    const transport = new MemoryEmailTransport();
    const result = await sendOutboxBatch({ repos, transport, workerId: WORKER, now: NOW });
    expect(result.dead).toBe(1);
    expect(transport.sent).toHaveLength(0);

    const stored = await repos.outbox.findById(item.id);
    expect(stored?.status).toBe('dead');
    expect(stored?.nextAttemptAt).toBe(NOW.toISOString());
    expect(stored?.lastError).toContain('render');
  });

  it('aynı idempotency anahtarıyla ikinci kez kuyruğa girmez', async () => {
    const { repos } = await makeRepos();
    const first = await enqueueTestEmail({
      repos,
      toEmail: 'yonetici@ornek.test',
      transportKey: 'memory',
      idempotencyKey: 'kurulum-testi-1',
    });
    const second = await enqueueTestEmail({
      repos,
      toEmail: 'yonetici@ornek.test',
      transportKey: 'memory',
      idempotencyKey: 'kurulum-testi-1',
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(await repos.outbox.list({}, 10)).toHaveLength(1);
  });
});

describe('abonelikten çıkma', () => {
  it('jetonu tek kullanımlık tüketir ve bildirimleri durdurur', async () => {
    const { repos } = await makeRepos();
    const { user, job } = await prepareUserWithJob(repos);
    await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'Kamuİlan',
      now: NOW,
    });

    const transport = new MemoryEmailTransport();
    await sendOutboxBatch({ repos, transport, workerId: WORKER, now: NOW });
    const html = transport.sent[0]?.html ?? '';
    const token = /token=([A-Za-z0-9._-]+)/.exec(html)?.[1];
    expect(token).toBeTruthy();

    // Jeton düz metin olarak saklanmaz; yalnızca hash'i tutulur.
    const tokens = await repos.store.find('tokens', { userId: user.id, type: 'unsubscribe' }, { limit: 5 });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenHash).not.toBe(token);
    expect(tokens[0]?.tokenHash.length).toBeGreaterThan(16);

    const result = await unsubscribeByToken(repos, token as string);
    expect(result?.userId).toBe(user.id);

    const preference = await repos.notifications.getPreference(user.id);
    expect(preference?.paused).toBe(true);
    expect(preference?.enabled).toBe(false);

    // Jeton yeniden kullanılamaz.
    expect(await unsubscribeByToken(repos, token as string)).toBeNull();

    // Abonelikten çıkmış kullanıcıya yeni ilan için e-posta üretilmez.
    const other = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({ title: 'Yeni Sözleşmeli Personel Alım İlanı' }),
      { repos, now: NOW, workerId: WORKER, provenance: 'sample' },
    );
    const newJob = await repos.jobs.findById(other.jobId as string);
    const queued = await queueNotificationsForJob({
      repos,
      job: newJob!,
      kind: 'new-job',
      baseUrl: 'http://localhost:5173',
      senderName: 'Kamuİlan',
      now: NOW,
    });
    expect(queued.queued).toBe(0);
    expect(queued.matched).toBe(0);
  });
});

describe('taşıyıcı seçimi ve ortam ayrımı', () => {
  it('test ortamında dosya taşıyıcısına düşer ve notu açıkça yazar', () => {
    const env = getEnv();
    const choice = createEmailTransport(env);
    expect(choice.mode).toBe('file');
    expect(choice.note.length).toBeGreaterThan(10);
  });

  it('üretimde SMTP yoksa sessizce kaybetmek yerine hata verir', () => {
    const env = { ...getEnv(), NODE_ENV: 'production' as const, SMTP_HOST: '' };
    expect(() => createEmailTransport(env)).toThrow(/SMTP_HOST/);
  });

  it('SMTP yapılandırılmışsa SMTP taşıyıcısını seçer', () => {
    const env = { ...getEnv(), SMTP_HOST: 'smtp.ornek.test', SMTP_PORT: 587, SMTP_SECURE: false };
    const choice = createEmailTransport(env);
    expect(choice.mode).toBe('smtp');
    expect(choice.note).toContain('smtp.ornek.test');
  });

  it('geliştirme dosya taşıyıcısı e-postayı diskten okunabilir biçimde yazar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-mail-'));
    const transport = new FileEmailTransport(dir);
    const result = await transport.send({
      to: 'dev@ornek.test',
      subject: 'Test konusu',
      html: '<p>merhaba</p>',
      text: 'merhaba',
      template: 'test',
    });

    expect(result.accepted).toBe(true);
    const files = readdirSync(dir);
    const htmlFile = files.find((file) => file.endsWith('.html'));
    const textFile = files.find((file) => file.endsWith('.txt'));
    expect(htmlFile).toBeTruthy();
    expect(textFile).toBeTruthy();

    const htmlContent = readFileSync(join(dir, htmlFile as string), 'utf8');
    const textContent = readFileSync(join(dir, textFile as string), 'utf8');
    expect(htmlContent).toContain('merhaba');
    // Konu bilgisi okunabilir metin dosyasında saklanır (geliştirme kolaylığı).
    expect(textContent).toContain('Test konusu');
    expect(result.providerMessageId).toContain('file:');
  });
});
