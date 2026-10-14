/**
 * Süreç duyuruları (kura, sınav yeri/tarihi, sonuç) yeni ilan değildir: akışta ve filtrelerde
 * görünür, ama hiçbir kullanıcıya bildirim olayı, e-posta veya Telegram kuyruğu üretmez.
 * Bu testler ayrıca tekrar bildirim korumalarını (idempotency) ve mevcut bekleyen bildirimlerin
 * yeniden sınıflandırmada bastırılmasını doğrular.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import {
  planReclassification,
  applyReclassification,
  RECLASSIFY_NOTIFICATION_SUPPRESSION,
} from '../src/ingest/reclassify-batch';
import {
  isProcessNotice,
  matchPreferenceToJob,
  PROCESS_NOTICE_SUPPRESSION,
} from '../src/notifications/matcher';
import { queueNotificationsForJob } from '../src/notifications/service';
import { hashPassword } from '../src/server/passwords';
import { fixedClock } from '../src/lib/clock';
import { sonucDuyurusu, sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-12T09:00:00+03:00');
const BASE_URL = 'http://localhost:5173';
const SENDER_NAME = 'Kamuİlan';

let dir: string;
let store: FileStore;
let repos: Repos;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kamuilan-process-notice-'));
  store = new FileStore(dir);
  await store.init();
  repos = createRepos(store, fixedClock(NOW));
  await repos.sources.seed();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Tüm ilanlara abone, e-postası doğrulanmış bir kullanıcı. */
async function subscribedUser(): Promise<string> {
  const password = await hashPassword('CokGuvenliSifre123');
  const { user } = await repos.users.create({
    email: 'aday@ornek.test',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    emailVerified: true,
  });
  await repos.notifications.upsertPreference(user.id, {
    enabled: true,
    onlyNewJobs: false,
    notifyOnChanges: true,
    filters: {
      keywords: [],
      titles: [],
      institutions: [],
      cities: [],
      employmentTypes: [],
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      minDaysUntilDeadline: null,
    },
  });
  return user.id;
}

async function ingest(raw: Parameters<typeof applyRawAnnouncement>[0]) {
  const outcome = await applyRawAnnouncement(raw, {
    repos,
    now: NOW,
    workerId: 'worker-process-notice',
    provenance: 'scraped',
  });
  const job = await repos.jobs.findById(outcome.jobId as string);
  if (!job) throw new Error('İlan kaydedilmedi');
  return { outcome, job };
}

function notify(job: JobDoc, kind: 'new-job' | 'job-changed') {
  return queueNotificationsForJob({ repos, job, kind, baseUrl: BASE_URL, senderName: SENDER_NAME, now: NOW });
}

describe('süreç duyurusu bildirimleri', () => {
  it('süreç duyurusu akışa girer ama yeni ilan bildirimi üretmez', async () => {
    const userId = await subscribedUser();
    const { outcome, job } = await ingest(sonucDuyurusu());

    expect(outcome.action).toBe('created');
    expect(job.classification.kind).toBe('process');
    expect(isProcessNotice(job)).toBe(true);

    const result = await notify(job, 'new-job');
    expect(result.queued).toBe(0);
    expect(result.evaluated).toBe(0);
    expect(result.suppressedReason).toBe(PROCESS_NOTICE_SUPPRESSION);

    expect(await repos.outbox.list({ userId }, 10)).toEqual([]);
    expect(await store.count('notificationEvents', {})).toBe(0);
  });

  it('süreç duyurusu güncellendiğinde de (job-changed) bildirim üretmez', async () => {
    const userId = await subscribedUser();
    const { job } = await ingest(sonucDuyurusu());

    // Aynı kaynak, değişmiş metin: yeni sürüm.
    const updated = await ingest(
      sonucDuyurusu({
        title: 'Örnek Belediye Başkanlığından: Personel Alımı Sonuçları Açıklandı (düzeltme)',
        bodyText:
          'Örnek Belediye Başkanlığından: sonuç listesi güncellenmiştir. Kazanan adaylar ek listede yer alır.',
      }),
    );
    expect(updated.job.id).toBe(job.id);
    expect(['updated', 'merged']).toContain(updated.outcome.action);

    // Sürüm artışı alan bazlı değişikliğe bağlıdır; burada yeni sürüm kontrollü olarak
    // simüle edilir ki job-changed yolu kesin olarak denenmiş olsun.
    await store.updateOne('jobs', { id: job.id }, { version: updated.job.version + 1 });
    const bumped = (await repos.jobs.findById(job.id)) as JobDoc;

    const result = await notify(bumped, 'job-changed');
    expect(result.queued).toBe(0);
    expect(result.suppressedReason).toBe(PROCESS_NOTICE_SUPPRESSION);
    expect(await repos.outbox.list({ userId }, 10)).toEqual([]);
  });

  it('aynı süreç duyurusu tekrar taransa da hiçbir bildirim kuyruğa girmez', async () => {
    const userId = await subscribedUser();
    const { job } = await ingest(sonucDuyurusu());
    for (let i = 0; i < 3; i += 1) {
      await notify(job, 'new-job');
      await notify(job, 'job-changed');
    }
    expect(await repos.outbox.list({ userId }, 10)).toEqual([]);
    expect(await store.count('notificationEvents', {})).toBe(0);
  });

  it('eşleştirici de süreç duyurusunu bastırır (ikinci savunma hattı)', async () => {
    const userId = await subscribedUser();
    const { job } = await ingest(sonucDuyurusu());
    const preference = await repos.notifications.getPreference(userId);
    if (!preference) throw new Error('tercih bulunamadı');
    const match = matchPreferenceToJob({ preference, job, kind: 'new-job', now: NOW });
    expect(match.matched).toBe(false);
    expect(match.suppressedReason).toBe(PROCESS_NOTICE_SUPPRESSION);
  });

  it('gerçek iş ilanı yine yeni ilan bildirimi alır ve tekrar bildirilmez (regresyon)', async () => {
    const userId = await subscribedUser();
    const { job } = await ingest(sozlesmeliPersonelIlani());
    expect(job.classification.kind).toBe('job');

    const first = await notify(job, 'new-job');
    expect(first.queued).toBe(1);
    const second = await notify(job, 'new-job');
    expect(second.queued).toBe(0);
    expect(second.alreadyExists).toBe(1);
    expect(await repos.outbox.list({ userId }, 10)).toHaveLength(1);
  });

  it('eski kayıt (kind alanı yok) iş ilanı sayılır ve bildirim alır', async () => {
    await subscribedUser();
    const { job } = await ingest(sozlesmeliPersonelIlani());
    const legacy = { ...job, classification: { ...job.classification } } as Partial<JobDoc>;
    delete (legacy.classification as { kind?: string }).kind;
    expect(isProcessNotice(legacy as JobDoc)).toBe(false);
    expect((await notify(legacy as JobDoc, 'new-job')).queued).toBe(1);
  });
});

describe('yeniden sınıflandırma: bekleyen bildirimlerin bastırılması', () => {
  it('süreç duyurusuna dönüşen kaydın bekleyen bildirimi bastırılır; iş ilanınınki kalır', async () => {
    const userId = await subscribedUser();
    const processJob = (await ingest(sonucDuyurusu())).job;
    const normalJob = (await ingest(sozlesmeliPersonelIlani())).job;

    // Eski ingest'ten kalan durum: süreç kaydı iş ilanı olarak kayıtlı ve bildirimi bekliyor.
    await store.updateOne('jobs', { id: processJob.id }, { 'classification.kind': 'job' });
    const pendingProcess = await repos.outbox.enqueue(
      {
        channel: 'email',
        eventId: null,
        jobId: processJob.id,
        userId,
        kind: 'job-notification',
        toEmail: 'aday@ornek.test',
        subject: 'eski bildirim',
        template: 'new-job',
        payload: {},
        idempotencyKey: `test:process:${processJob.id}`,
      },
      5,
    );
    const pendingNormal = await repos.outbox.enqueue(
      {
        channel: 'email',
        eventId: null,
        jobId: normalJob.id,
        userId,
        kind: 'job-notification',
        toEmail: 'aday@ornek.test',
        subject: 'iş ilanı bildirimi',
        template: 'new-job',
        payload: {},
        idempotencyKey: `test:normal:${normalJob.id}`,
      },
      5,
    );

    const fresh = (await store.find('jobs', {}, { limit: 100 })) as JobDoc[];
    const { planned, summary } = planReclassification(fresh, NOW);
    expect(summary.keptAsProcess).toBe(1);

    const { notificationsSuppressed } = await applyReclassification(store, planned, NOW);
    expect(notificationsSuppressed).toBe(1);

    expect((await repos.outbox.findById(pendingProcess.item.id))?.status).toBe('suppressed');
    expect((await repos.outbox.findById(pendingProcess.item.id))?.lastError).toBe(
      RECLASSIFY_NOTIFICATION_SUPPRESSION.slice(0, 500),
    );
    expect((await repos.outbox.findById(pendingNormal.item.id))?.status).toBe('pending');
  });
});

describe('AI önerileri süreç duyurularını öneri olarak göstermez', () => {
  it('aday havuzu yalnızca iş ilanlarını içerir', async () => {
    const { selectCandidates } = await import('../src/ai/candidates');
    await ingest(sonucDuyurusu());
    await ingest(sozlesmeliPersonelIlani());
    const profile = {
      profession: 'Sözleşmeli personel',
      educationLevel: null,
      departments: [],
      skills: [],
      experienceYears: null,
    };
    const candidates = await selectCandidates(repos, profile, NOW);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.job.classification.kind !== 'process')).toBe(true);
  });
});
