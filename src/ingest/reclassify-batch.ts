/**
 * Toplu yeniden sınıflandırma yardımcıları: planlama (saf), rapor, yedek ve geri yükleme.
 *
 * Yazma yalnızca `applyReclassification` ve `restoreJobsFromBackup` ile yapılır; ikisi de
 * betik tarafından açıkça çağrılır (varsayılan kuru çalıştırma). Yedek dosyası, kayıtların
 * değişiklik öncesi tam halidir; geri yükleme bu dosyadan birebir döner.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobDoc } from '../db/schemas';
import type { StoragePort } from '../db/ports';
import { outboxSummaryForJob, suppressPendingOutboxForJob } from '../db/repos/outbox';
import { reclassifyJob, type ReclassifyResult } from './reclassify';

/** Bekleyen bildirimlerin bastırılma nedeni (ilan artık bildirim gerektirmiyor). */
export const RECLASSIFY_NOTIFICATION_SUPPRESSION =
  'yeniden sınıflandırma: ilan artık bildirim gerektirmiyor (süreç duyurusu veya red)';

/** Bu kayıtta bekleyen bildirim bastırılmalı mı? Yalnızca akışta kalan iş ilanları bildirilir. */
export function needsNotificationSuppression(result: ReclassifyResult): boolean {
  return result.decisionTo !== 'accept' || result.kindTo === 'process';
}

export interface PlannedJob {
  job: JobDoc;
  result: ReclassifyResult;
}

export interface ReclassifySummary {
  total: number;
  /** Güncel kurallara göre iş ilanı olarak akışta kalacak kayıtlar. */
  acceptedJobs: number;
  /** Gerçek personel alımının süreç duyuruları: akışta, ayrı kategoride. */
  keptAsProcess: number;
  /** Akışta şu an olan ama artık reddedilecek kayıtlar. */
  rejected: number;
  /** Akışa yeni girecek kayıtlar (normalde 0). */
  newlyAccepted: number;
  titlesCleaned: number;
  statusChanged: number;
  kindChanged: number;
  changed: number;
  acceptedBefore: number;
  acceptedAfter: number;
}

export function planReclassification(
  jobs: JobDoc[],
  now: Date,
): { planned: PlannedJob[]; summary: ReclassifySummary } {
  const planned = jobs.map((job) => ({ job, result: reclassifyJob(job, now) }));
  const summary: ReclassifySummary = {
    total: jobs.length,
    acceptedJobs: 0,
    keptAsProcess: 0,
    rejected: 0,
    newlyAccepted: 0,
    titlesCleaned: 0,
    statusChanged: 0,
    kindChanged: 0,
    changed: 0,
    acceptedBefore: 0,
    acceptedAfter: 0,
  };
  for (const { job, result } of planned) {
    if (job.classification.decision === 'accept') summary.acceptedBefore += 1;
    if (result.decisionTo === 'accept') {
      summary.acceptedAfter += 1;
      if (result.kindTo === 'process') summary.keptAsProcess += 1;
      else summary.acceptedJobs += 1;
    } else if (result.decisionFrom === 'accept') {
      summary.rejected += 1;
    }
    if (result.decisionTo === 'accept' && job.classification.decision !== 'accept')
      summary.newlyAccepted += 1;
    if (result.titleCleaned) summary.titlesCleaned += 1;
    if (result.statusFrom !== result.statusTo) summary.statusChanged += 1;
    if (result.kindFrom !== result.kindTo) summary.kindChanged += 1;
    if (result.changed) summary.changed += 1;
  }
  return { planned, summary };
}

export interface ReclassifyReportRow {
  id: string;
  /** Bu kayıtın bildirim kuyruğu durumu (salt okunur). */
  notifications: { pending: number; sent: number; failed: number; dead: number; suppressed: number };
  /** Uygulandığında bekleyen bildirimler bastırılacak mı? */
  suppressNotifications: boolean;
  title: string;
  institution: string;
  oldDecision: string;
  newDecision: string;
  kind: string;
  kindBefore: string;
  status: { from: string; to: string };
  titleCleaned: boolean;
  changed: boolean;
  rules: string[];
  reasons: string[];
  excerpt: string;
  sourceKeys: string[];
  publishedAt: string | null;
  applicationEndDate: string | null;
}

/** Okunabilir ve sınırlı büyüklükte rapor satırları. Yalnızca okur; veritabanına yazmaz. */
export async function buildReport(store: StoragePort, planned: PlannedJob[]): Promise<ReclassifyReportRow[]> {
  const rows: ReclassifyReportRow[] = [];
  for (const { job, result } of planned) {
    rows.push({
      id: job.id,
      notifications: await outboxSummaryForJob(store, job.id),
      suppressNotifications: needsNotificationSuppression(result),
      title: job.title,
      institution: job.institution,
      oldDecision: job.classification.decision,
      newDecision: result.decisionTo,
      kind: result.kindTo,
      kindBefore: result.kindFrom,
      status: { from: result.statusFrom, to: result.statusTo },
      titleCleaned: result.titleCleaned,
      changed: result.changed,
      rules: result.classification.rules,
      reasons: result.classification.reasons,
      excerpt: (job.textExcerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
      sourceKeys: job.sourceKeys,
      publishedAt: job.publishedAt ?? null,
      applicationEndDate: job.applicationEndDate ?? null,
    });
  }
  return rows;
}

/** Değişiklik öncesi tam yedek. `wx` bayrağıyla var olan dosyanın üzerine yazmaz. */
export function writeJobsBackup(dataDir: string, jobs: JobDoc[], now: Date, label: string): string {
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `jobs-${label}-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backupPath, JSON.stringify(jobs, null, 2), { encoding: 'utf8', flag: 'wx' });
  return backupPath;
}

export function readJobsBackup(path: string): JobDoc[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Yedek dosyası bir kayıt dizisi değil.');
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') {
      throw new Error('Yedek dosyasında kimliği (id) olmayan bir kayıt var.');
    }
  }
  return parsed as JobDoc[];
}

/**
 * Yalnızca değişen kayıtlara yazar. Akışta kalmayan ya da süreç duyurusuna dönüşen kayıtların
 * bekleyen bildirimlerini bastırır (gönderilmiş bildirimler geri alınamaz; raporda sayılır).
 */
export async function applyReclassification(
  store: StoragePort,
  planned: PlannedJob[],
  now: Date,
): Promise<{ written: number; notificationsSuppressed: number }> {
  let written = 0;
  let notificationsSuppressed = 0;
  for (const { job, result } of planned) {
    if (result.changed) {
      const updated = await store.updateOne('jobs', { id: job.id }, result.patch as Record<string, unknown>);
      if (updated) written += 1;
    }
    if (needsNotificationSuppression(result)) {
      notificationsSuppressed += await suppressPendingOutboxForJob(
        store,
        job.id,
        RECLASSIFY_NOTIFICATION_SUPPRESSION,
        now,
      );
    }
  }
  return { written, notificationsSuppressed };
}

/** Anahtar sırasından bağımsız, undefined alanları düşen kanonik JSON karşılaştırması. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return val;
  });
}

export function sameJobDoc(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export interface RestoreSummary {
  inBackup: number;
  wouldRestore: number;
  alreadyEqual: number;
  missingInStore: string[];
  restored: number;
}

/**
 * Yedekteki kayıtları birebir geri yükler. Yedekte olmayan üst düzey alanlar `undefined`
 * ile temizlenir (JSON yazımında düşer). `apply=false` ise yalnızca hesaplar.
 */
export async function restoreJobsFromBackup(
  store: StoragePort,
  backup: JobDoc[],
  options: { apply: boolean },
): Promise<RestoreSummary> {
  const summary: RestoreSummary = {
    inBackup: backup.length,
    wouldRestore: 0,
    alreadyEqual: 0,
    missingInStore: [],
    restored: 0,
  };
  for (const saved of backup) {
    const current = (await store.findOne('jobs', { id: saved.id })) as JobDoc | null;
    if (!current) {
      summary.missingInStore.push(saved.id);
      continue;
    }
    if (sameJobDoc(current, saved)) {
      summary.alreadyEqual += 1;
      continue;
    }
    summary.wouldRestore += 1;
    if (!options.apply) continue;
    const patch: Record<string, unknown> = { ...(saved as unknown as Record<string, unknown>) };
    for (const key of Object.keys(current)) {
      if (!(key in patch)) patch[key] = undefined;
    }
    const updated = await store.updateOne('jobs', { id: saved.id }, patch);
    if (updated) summary.restored += 1;
  }
  return summary;
}
