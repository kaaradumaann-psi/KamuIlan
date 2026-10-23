/**
 * Onarım: aynı kaynağın (varsayılan İŞKUR e-Şube) FARKLI kaynak-içi kimlikleriyle
 * (ilan numaralarıyla) yanlışlıkla TEK ilana birleşmiş kayıtları ayırır.
 *
 * Üretim bulgusu (23.10.2026): `iskur-esube-kamu` 91 ayrı İŞKUR ilan numarası
 * getirdi, tekilleştirme bunları 10 ilana birleştirdi. Yeni tekilleştirme kuralı
 * (DEDUPE_VERSION 2026.10.2) bunu bundan sonra engeller; bu onarım mevcut yanlış
 * birleşmeleri geri alır.
 *
 * Her ilan için bir "kalan" kaynak kaydı (ilanın kimliğini — originalRefNo/URL —
 * taşıyan kayıt) ilanda bırakılır; diğer İŞKUR kayıtlarının her biri KENDİ ilanına
 * ayrılır. Ayrılan ilan, ebeveyn ilanın sınıflandırmasını ve (satır bazında
 * saklanmayan) son başvuru/istihdam türü gibi ortak alanlarını devralır; kimlik
 * alanları (başlık, kurum, il, ilan no, URL) kaynak kaydından yeniden kurulur.
 *
 * Saf değildir (depoyu okur/yazar) ama planlama (`planIskurSplit`) salt-okunurdur:
 * KURU ÇALIŞTIRMA yalnızca planı üretir. `applyIskurSplit` yazar ve idempotenttir
 * (ikinci koşuda ayrılacak kayıt kalmaz). Sürüm geçmişi tutarlı yazılır.
 */
import { createId, sha256Hex } from '../domain/ids';
import { normalizeUrl } from '../domain/urls';
import { jobContentFingerprint } from '../domain/job-content-fingerprint';
import type { StoragePort } from '../db/ports';
import type { JobDoc, JobRevisionDoc, JobSourceDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import type { ClassificationResult, RawAnnouncement } from '../domain';
import { buildJobDocument } from './jobs-service';

/** İŞKUR e-Şube kaynağının tanım anahtarı (pipeline `ctx.source.key` ile yazar; adapterKey değil). */
export const DEFAULT_SPLIT_SOURCE_KEY = 'iskur-esube-acik-is';

export interface IskurSplitPlanItem {
  jobId: string;
  jobTitle: string;
  /** İlanda bırakılacak kaynak kaydının kaynak-içi kimliği. */
  survivorSourceItemId: string;
  /** Kendi ilanına ayrılacak kaynak kayıtları. */
  splitLinks: JobSourceDoc[];
}

export interface IskurSplitSummary {
  sourceKey: string;
  /** Taranan, bu kaynaktan ≥1 kaydı olan ilan sayısı. */
  jobsWithSource: number;
  /** Ayrılacak (bu kaynaktan ≥2 farklı kimlik taşıyan) ilan sayısı. */
  jobsToSplit: number;
  /** Oluşturulacak yeni ilan (ayrılacak kaynak kaydı) sayısı. */
  newJobs: number;
  /** Ayrılan ilanlar işlendikten sonra bu kümedeki toplam ilan sayısı. */
  resultingJobs: number;
}

export interface IskurSplitPlan {
  plan: IskurSplitPlanItem[];
  summary: IskurSplitSummary;
}

/** Ebeveyn ilanın kimliğini taşıyan "kalan" kaydı seçer (yoksa en eski kayıt). */
function pickSurvivor(job: JobDoc, links: JobSourceDoc[]): JobSourceDoc {
  const byRef = job.originalRefNo
    ? links.find((link) => link.sourceItemId.endsWith(`:${job.originalRefNo}`))
    : undefined;
  if (byRef) return byRef;
  const jobUrl = normalizeUrl(job.normalizedUrl);
  const byUrl = jobUrl ? links.find((link) => normalizeUrl(link.url) === jobUrl) : undefined;
  if (byUrl) return byUrl;
  // En eski kayıt (firstSeenAt artan) ilanı kuran kayıttır.
  return [...links].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))[0] ?? links[0]!;
}

/** Salt-okunur: hangi ilanların ayrılacağını ve sonuçtaki sayıyı üretir. */
export async function planIskurSplit(
  store: StoragePort,
  sourceKey: string = DEFAULT_SPLIT_SOURCE_KEY,
): Promise<IskurSplitPlan> {
  const links = await store.find('jobSources', { sourceKey }, { limit: 100_000 });
  const byJob = new Map<string, Map<string, JobSourceDoc>>();
  for (const link of links) {
    const group = byJob.get(link.jobId) ?? new Map<string, JobSourceDoc>();
    // (sourceKey, sourceItemId) tekildir; yine de aynı kimlikten yalnız biri tutulur.
    if (!group.has(link.sourceItemId)) group.set(link.sourceItemId, link);
    byJob.set(link.jobId, group);
  }

  const plan: IskurSplitPlanItem[] = [];
  for (const [jobId, group] of byJob) {
    if (group.size < 2) continue;
    const job = await store.findOne('jobs', { id: jobId });
    if (!job) continue;
    const groupLinks = [...group.values()];
    const survivor = pickSurvivor(job, groupLinks);
    const splitLinks = groupLinks.filter((link) => link.sourceItemId !== survivor.sourceItemId);
    if (splitLinks.length === 0) continue;
    plan.push({ jobId, jobTitle: job.title, survivorSourceItemId: survivor.sourceItemId, splitLinks });
  }
  plan.sort((a, b) => b.splitLinks.length - a.splitLinks.length);

  const newJobs = plan.reduce((total, item) => total + item.splitLinks.length, 0);
  return {
    plan,
    summary: {
      sourceKey,
      jobsWithSource: byJob.size,
      jobsToSplit: plan.length,
      newJobs,
      resultingJobs: byJob.size + newJobs,
    },
  };
}

/** Ayrılan İŞKUR kaydının başlığından il/ilçe okur: "… (İŞKUR, İl/İlçe)". */
function parseCityDistrict(title: string): { city: string | null; district: string | null } {
  const match = /\(İŞKUR(?:,\s*([^)]+))?\)\s*$/u.exec(title);
  const where = match?.[1]?.trim();
  if (!where) return { city: null, district: null };
  const [city, district] = where.split('/').map((part) => part.trim());
  return { city: city || null, district: district || null };
}

/** İŞKUR kaynak-içi kimliğinden ilan numarası ("iskur-esube:00009862271" → "00009862271"). */
function referenceFromSourceItemId(sourceItemId: string): string | null {
  const index = sourceItemId.indexOf(':');
  const value = index >= 0 ? sourceItemId.slice(index + 1) : sourceItemId;
  return value.trim() || null;
}

/**
 * Ayrılacak kaynak kaydından yeni ilan dokümanını kurar. Ebeveynin
 * sınıflandırması ve ortak alanları (son başvuru, başlangıç, istihdam türü)
 * devralınır; kimlik alanları kayıttan gelir.
 */
function buildSplitJobDocument(
  parent: JobDoc,
  link: JobSourceDoc,
  now: Date,
): Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'> {
  const { city, district } = parseCityDistrict(link.title);
  const raw: RawAnnouncement = {
    sourceKey: link.sourceKey,
    sourceItemId: link.sourceItemId,
    url: link.url,
    title: link.title,
    bodyTextSource: 'listing',
    rawExcerpt: link.title,
    ...(link.institution ? { institution: link.institution } : {}),
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
    ...(referenceFromSourceItemId(link.sourceItemId) ? { referenceNo: referenceFromSourceItemId(link.sourceItemId)! } : {}),
    ...(link.publishedAt ?? parent.publishedAt ? { publishedAt: link.publishedAt ?? parent.publishedAt ?? undefined } : {}),
    // Satır bazında son başvuru/başlangıç saklanmaz; aynı birleşmedeki satırlar
    // genelde aynı dönemi paylaştığı için ebeveynden devralınır.
    ...(parent.applicationEndAt ? { applicationEndAt: parent.applicationEndAt } : {}),
    ...(parent.applicationStartAt ? { applicationStartAt: parent.applicationStartAt } : {}),
    ...(parent.quota !== null ? { quota: parent.quota } : {}),
    ...(link.sourceCategory ? { sourceCategory: link.sourceCategory } : {}),
    attachments: link.attachments,
    extractionConfidence: parent.extractionConfidence,
    notes: [],
  };
  const classification: ClassificationResult = { ...parent.classification };
  const document = buildJobDocument(raw, classification, { now, provenance: parent.provenance });
  // İlk görülme kaydın kendi zamanıdır; içerik parmak izi/dedupe kimliği yeniden üretilir.
  return {
    ...document,
    contentHash: jobContentFingerprint({
      title: document.title,
      textExcerpt: document.textExcerpt,
      applicationEndAt: document.applicationEndAt,
      quota: document.quota,
    }),
    dedupeKey: sha256Hex(`${link.sourceKey}|${link.sourceItemId}`),
  };
}

export interface IskurSplitApplyResult {
  jobsSplit: number;
  newJobs: number;
  movedLinks: number;
}

/** Planı uygular: yeni ilanları oluşturur, kayıtları taşır, sürüm geçmişini yazar. İdempotenttir. */
export async function applyIskurSplit(
  repos: Repos,
  plan: IskurSplitPlanItem[],
  now: Date,
): Promise<IskurSplitApplyResult> {
  const nowIso = now.toISOString();
  let jobsSplit = 0;
  let newJobs = 0;
  let movedLinks = 0;

  for (const item of plan) {
    const parent = await repos.jobs.findById(item.jobId);
    if (!parent) continue;

    const splitRefs: string[] = [];
    for (const link of item.splitLinks) {
      const document = buildSplitJobDocument(parent, link, now);
      const seenAt = link.firstSeenAt;
      const job: JobDoc = {
        ...document,
        id: createId('job'),
        version: 1,
        firstSeenAt: seenAt,
        lastSeenAt: link.lastSeenAt,
        createdAt: seenAt,
        updatedAt: nowIso,
      };
      const inserted = await repos.jobs.insertJob(job);
      if (!inserted.created) continue;
      // Kaynak kaydını yeni ilana taşı (kimlik aynı, yalnız jobId değişir).
      await repos.store.updateOne('jobSources', { id: link.id }, { jobId: job.id });
      movedLinks += 1;
      newJobs += 1;
      splitRefs.push(referenceFromSourceItemId(link.sourceItemId) ?? link.sourceItemId);

      const revision: JobRevisionDoc = {
        id: createId('rev'),
        jobId: job.id,
        version: 1,
        changeTypes: ['new'],
        changedFields: ['*'],
        previous: {},
        current: { title: job.title, applicationEndDate: job.applicationEndDate, quota: job.quota },
        summary: `İŞKUR ilanı yanlış birleşmeden ayrıştırıldı (onarım; önceki ilan ${parent.id}).`,
        sourceKey: link.sourceKey,
        createdAt: nowIso,
      };
      await repos.jobs.addRevision(revision);
    }

    if (splitRefs.length === 0) continue;
    jobsSplit += 1;

    // Ebeveyn ilanın kaynak kümesi kalan kayıtlardan yeniden hesaplanır.
    const remaining = await repos.jobs.listSourceLinks(parent.id);
    const remainingSourceKeys = [...new Set(remaining.map((link) => link.sourceKey))];
    const nextVersion = parent.version + 1;
    await repos.jobs.updateJob(parent.id, {
      sourceKeys: remainingSourceKeys.length > 0 ? remainingSourceKeys : parent.sourceKeys,
      version: nextVersion,
    });
    const parentRevision: JobRevisionDoc = {
      id: createId('rev'),
      jobId: parent.id,
      version: nextVersion,
      changeTypes: ['content'],
      changedFields: ['sourceKeys'],
      previous: { sourceKeys: parent.sourceKeys },
      current: { sourceKeys: remainingSourceKeys },
      summary: `Yanlış birleşen ${splitRefs.length} İŞKUR ilanı ayrı ilanlara taşındı (onarım): ${splitRefs.join(', ')}.`,
      sourceKey: item.splitLinks[0]?.sourceKey ?? DEFAULT_SPLIT_SOURCE_KEY,
      createdAt: nowIso,
    };
    await repos.jobs.addRevision(parentRevision);
  }

  return { jobsSplit, newJobs, movedLinks };
}
