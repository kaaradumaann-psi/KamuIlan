/**
 * E-posta teslim hattı entegrasyon testi (uçtan uca, ağa çıkmadan).
 *
 * Akış: örnek ilan (fixture) → kabul hattı → veritabanı → tercih eşleştirme →
 * benzersiz bildirim olayı → outbox → GERÇEK SMTP taşıyıcı (nodemailer) →
 * süreç içi test posta sunucusu (smtp-server) → teslim kaydı (outbox 'accepted').
 *
 * Neden gerçek SMTP: "kuyruğa yazıldı" ile "sağlayıcı kabul etti" farklı
 * şeylerdir. Burada ileti gerçekten kablo üzerinden gönderilir; MIME başlığı ve
 * gövdesi ham metinden çözülerek doğrulanır. Hiçbir dış servis kullanılmaz.
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { describe, expect, it } from 'vitest';
import { createRepos, type Repos } from '../src/db/repos';
import { FileStore } from '../src/db/file-store';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { queueNotificationsForJob } from '../src/notifications/service';
import { sendOutboxBatch } from '../src/email/service';
import { SmtpEmailTransport } from '../src/email/transport';
import { hashPassword } from '../src/server/passwords';
import { fixedClock } from '../src/lib/clock';
import { decodeMimeWords, decodeQuotedPrintable, parseMessage } from '../src/lib/mime';
import type { JobDoc } from '../src/db/schemas';
import type { SourceDefinition } from '../src/config/sources';
import { TEST_SOURCE_KEY, sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const BASE_URL = 'http://localhost:5173';
const SENDER_NAME = 'Kamuİlan';

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

interface CapturedMail {
  raw: string;
  subject: string;
  to: string;
  html: string;
  text: string;
}

/** Süreç içi SMTP sunucusu: kabloya çıkan iletiyi yakalar. */
async function startSmtpCapture(): Promise<{ port: number; mails: CapturedMail[]; close: () => Promise<void> }> {
  const mails: CapturedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', callback);
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = parseMessage(raw);
        mails.push({
          raw,
          subject: decodeMimeWords(parsed.headers['subject'] ?? ''),
          to: decodeMimeWords(parsed.headers['to'] ?? ''),
          html: parsed.html,
          text: parsed.text,
        });
        callback();
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.server.address() as AddressInfo;

  return {
    port: address.port,
    mails,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function makeRepos(): Promise<Repos> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-delivery-'));
  const store = new FileStore(dir);
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function seedVerifiedUser(repos: Repos, email = 'bildirim@ornek.test'): Promise<string> {
  const password = await hashPassword('CokGuvenliSifre123');
  const { user } = await repos.users.create({
    email,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    emailVerified: true,
  });
  return user.id;
}

function preferencesFor(job: JobDoc): {
  keywords: string[];
  titles: string[];
  institutions: string[];
  cities: string[];
  employmentTypes: JobDoc['employmentType'][];
  educationLevels: JobDoc['requirements']['educationLevels'];
  departments: string[];
  kpssScoreTypes: JobDoc['requirements']['kpssScoreTypes'];
  kpssMinScore: null;
  minDaysUntilDeadline: null;
} {
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

describe('MIME başlık çözümlemesi (regresyon)', () => {
  it('yan yana kodlanmış kelimeleri tek boşlukla birleştirir', () => {
    const encoded = '=?UTF-8?Q?Mu=C5=9F=27ta_s=C3=B6zle=C5=9Fmeli?= =?UTF-8?Q?_personel_al=C4=B1m_ilan=C4=B1?=';
    expect(decodeMimeWords(encoded)).toBe("Muş'ta sözleşmeli personel alım ilanı");
  });

  it('quoted-printable gövdeyi bayt bazında UTF-8 olarak çözer', () => {
    // Eskiden karakter bazlı çözülüyordu: "Ãrnek" gibi bozuk çıktı üretiyordu.
    expect(decodeQuotedPrintable('G=C3=B6rev yeri =C5=9Eanl=C4=B1urfa')).toBe('Görev yeri Şanlıurfa');
  });
});

describe('e-posta teslim hattı — fixture → DB → eşleşme → outbox → SMTP → kayıt', () => {
  it('eşleşen ilan için gerçek SMTP üzerinden Türkçe bildirim gönderir ve teslimi kaydeder', async () => {
    const repos = await makeRepos();
    await repos.sources.seed([TEST_DEFINITION]);

    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'worker-test',
      provenance: 'scraped',
    });
    expect(outcome.action).toBe('created');
    const job = await repos.jobs.findById(outcome.jobId as string);
    expect(job).not.toBeNull();
    if (!job) throw new Error('İlan oluşturulamadı');

    const userId = await seedVerifiedUser(repos);
    await repos.notifications.upsertPreference(userId, { filters: preferencesFor(job) });

    const queued = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: SENDER_NAME,
      now: NOW,
    });
    expect(queued.queued).toBe(1);

    // Idempotency: aynı ilan/sürüm için ikinci olay üretilmez.
    const again = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: SENDER_NAME,
      now: NOW,
    });
    expect(again.queued).toBe(0);
    expect(again.alreadyExists).toBe(1);

    const pending = await repos.outbox.list({ userId }, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');

    const capture = await startSmtpCapture();
    const transport = new SmtpEmailTransport({
      host: '127.0.0.1',
      port: capture.port,
      secure: false,
      user: '',
      pass: '',
      from: `${SENDER_NAME} <bildirim@kamuilan.test>`,
    });

    try {
      const result = await sendOutboxBatch({ repos, transport, workerId: 'worker-test', now: NOW });
      expect(result.claimed).toBe(1);
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);

      await waitFor(() => capture.mails.length > 0);
      expect(capture.mails).toHaveLength(1);
      const mail = capture.mails[0] as CapturedMail;

      // Başlık RFC 2047 ile kodlanır; çözüldüğünde okunabilir Türkçe olmalı.
      expect(mail.subject).toContain('Örnek Üniversitesi');
      expect(mail.to).toContain('bildirim@ornek.test');
      expect(mail.raw).toContain('=?UTF-8?'); // kodlanmış başlık gerçekten kabloda
      expect(mail.html.length).toBeGreaterThan(0);
      expect(mail.text.length).toBeGreaterThan(0);

      const body = `${mail.html}\n${mail.text}`;
      expect(body).toContain('Örnek Üniversitesi');
      // Son başvuru tarihi okunabilir Türkçe biçimde yazılır (Europe/Istanbul).
      expect(body).toMatch(/30 Ekim 2026/);
      // İl bilgisi ilanda YOK; uydurulmaz. (Eski hata: "doldurmuş" → "Muş".)
      expect(body).not.toContain('Muş');
      expect(body).toContain('https://ornek.test/ilanlar/ORNEK-2026-0001'); // resmî ilan bağlantısı
      expect(body).toContain('/panel'); // tercih bağlantısı
      expect(body).toContain('/abonelikten-cik?token='); // abonelikten çıkma bağlantısı
      expect(body).toContain('çalışma biçimi'); // eşleşme gerekçesi

      // Teslim kaydı: sağlayıcı kabulü zamanı ve mesaj kimliği yazılır.
      const stored = await repos.outbox.findById(pending[0]?.id as string);
      expect(stored?.status).toBe('accepted');
      expect(stored?.acceptedAt).not.toBeNull();
      expect(stored?.providerMessageId).toBeTruthy();
      expect(stored?.providerResponse).toContain('250');

      const events = await repos.notifications.listEventsForUser(userId, 10);
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe('queued');
      expect(events[0]?.matchedOn.length).toBeGreaterThan(0);
    } finally {
      await transport.close();
      await capture.close();
    }
  });

  it('tercihe uymayan ilan için e-posta kuyruklamaz (SMTP çağrısı yapılmaz)', async () => {
    const repos = await makeRepos();
    await repos.sources.seed([TEST_DEFINITION]);

    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'worker-test',
      provenance: 'scraped',
    });
    const job = await repos.jobs.findById(outcome.jobId as string);
    if (!job) throw new Error('İlan oluşturulamadı');

    const userId = await seedVerifiedUser(repos, 'baska@ornek.test');
    await repos.notifications.upsertPreference(userId, {
      filters: { ...preferencesFor(job), institutions: ['Hiçbir İlanda Olmayan Kurum'] },
    });

    const queued = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: SENDER_NAME,
      now: NOW,
    });

    expect(queued.queued).toBe(0);
    expect(await repos.outbox.list({ userId }, 10)).toHaveLength(0);

    const capture = await startSmtpCapture();
    const transport = new SmtpEmailTransport({
      host: '127.0.0.1',
      port: capture.port,
      secure: false,
      user: '',
      pass: '',
      from: `${SENDER_NAME} <bildirim@kamuilan.test>`,
    });
    try {
      const result = await sendOutboxBatch({ repos, transport, workerId: 'worker-test', now: NOW });
      expect(result.claimed).toBe(0);
      await waitFor(() => capture.mails.length > 0, 300);
      expect(capture.mails).toHaveLength(0);
    } finally {
      await transport.close();
      await capture.close();
    }
  });

  it('abonelikten çıkan kullanıcıya yeni e-posta gönderilmez', async () => {
    const repos = await makeRepos();
    await repos.sources.seed([TEST_DEFINITION]);

    const outcome = await applyRawAnnouncement(sozlesmeliPersonelIlani(), {
      repos,
      now: NOW,
      workerId: 'worker-test',
      provenance: 'scraped',
    });
    const job = await repos.jobs.findById(outcome.jobId as string);
    if (!job) throw new Error('İlan oluşturulamadı');

    const userId = await seedVerifiedUser(repos, 'cikmis@ornek.test');
    await repos.notifications.upsertPreference(userId, { filters: preferencesFor(job) });
    await repos.notifications.upsertPreference(userId, { enabled: false, paused: true });

    const queued = await queueNotificationsForJob({
      repos,
      job,
      kind: 'new-job',
      baseUrl: BASE_URL,
      senderName: SENDER_NAME,
      now: NOW,
    });

    expect(queued.queued).toBe(0);
    expect(await repos.outbox.list({ userId }, 10)).toHaveLength(0);
  });
});
