import type { StoragePort } from '../ports';
import { jobContentFingerprint } from '../../domain/job-content-fingerprint';
import { makeExcerpt, normalizeTr } from '../../domain/text';

const PAGE_SIZE = 500;
const JOB_EXCERPT_LIMIT = 2_500;
const REVIEW_EXCERPT_LIMIT = 1_500;
const FIELD_SNIPPET_LIMIT = 240;

export interface JobTextMinimizationMigrationResult {
  jobsScanned: number;
  jobsUpdated: number;
  excerptsSanitized: number;
  searchCopiesRebuilt: number;
  fieldSnippetsSanitized: number;
  hashesRebuilt: number;
  reviewItemsScanned: number;
  reviewExcerptsSanitized: number;
  revisionsScanned: number;
  revisionSnapshotsSanitized: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeStringRecord(value: unknown, maxLength: number): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, text]) =>
      typeof text === 'string' ? [[key, makeExcerpt(text, maxLength)] as const] : [],
    ),
  );
}

function sanitizeFieldSources(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, source]) => {
      if (!isRecord(source)) return [];
      const snippet = typeof source['snippet'] === 'string'
        ? makeExcerpt(source['snippet'], FIELD_SNIPPET_LIMIT)
        : null;
      return [[field, { ...source, snippet }] as const];
    }),
  );
}

function sanitizeRevisionSnapshot(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const snapshot = { ...value };
  const excerpt = typeof snapshot['textExcerpt'] === 'string'
    ? makeExcerpt(snapshot['textExcerpt'], JOB_EXCERPT_LIMIT)
    : '';

  if (typeof snapshot['textExcerpt'] === 'string') snapshot['textExcerpt'] = excerpt;
  if (typeof snapshot['textNormalized'] === 'string') snapshot['textNormalized'] = normalizeTr(excerpt);
  if (isRecord(snapshot['evidence'])) {
    snapshot['evidence'] = sanitizeStringRecord(snapshot['evidence'], FIELD_SNIPPET_LIMIT);
  }
  if (isRecord(snapshot['fieldSources'])) {
    snapshot['fieldSources'] = sanitizeFieldSources(snapshot['fieldSources']);
  }
  return snapshot;
}

/**
 * Sanitize historic job text before treating data minimization as complete.
 *
 * `JobDoc.textExcerpt` remains because search, matching, extraction and detail
 * UI consume it; it stays bounded and redacted. The normalized search copy is
 * rebuilt from that safe excerpt, and the old body-derived content hash is
 * replaced with a fingerprint of the retained fields. Bounded review excerpts
 * remain because the admin accept/review flow consumes them. Historical
 * revision snapshots are sanitized without logging their contents.
 */
export async function migrateJobTextMinimization(
  store: StoragePort,
): Promise<JobTextMinimizationMigrationResult> {
  const result: JobTextMinimizationMigrationResult = {
    jobsScanned: 0,
    jobsUpdated: 0,
    excerptsSanitized: 0,
    searchCopiesRebuilt: 0,
    fieldSnippetsSanitized: 0,
    hashesRebuilt: 0,
    reviewItemsScanned: 0,
    reviewExcerptsSanitized: 0,
    revisionsScanned: 0,
    revisionSnapshotsSanitized: 0,
  };

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const jobs = await store.find('jobs', {}, {
      sort: [['id', 1]],
      skip,
      limit: PAGE_SIZE,
    });
    result.jobsScanned += jobs.length;
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const legacy = job as unknown as Record<string, unknown>;
      const textExcerpt = makeExcerpt(
        typeof legacy['textExcerpt'] === 'string' ? legacy['textExcerpt'] : '',
        JOB_EXCERPT_LIMIT,
      );
      const textNormalized = normalizeTr(textExcerpt);
      const evidence = sanitizeStringRecord(legacy['evidence'], FIELD_SNIPPET_LIMIT);
      const fieldSources = sanitizeFieldSources(legacy['fieldSources']);
      const title = typeof legacy['title'] === 'string' ? legacy['title'] : '';
      const applicationEndAt = typeof legacy['applicationEndAt'] === 'string'
        ? legacy['applicationEndAt']
        : null;
      const quota = typeof legacy['quota'] === 'number' ? legacy['quota'] : null;
      const contentHash = jobContentFingerprint({ title, textExcerpt, applicationEndAt, quota });

      const excerptChanged = legacy['textExcerpt'] !== textExcerpt;
      const searchCopyChanged = legacy['textNormalized'] !== textNormalized;
      const evidenceChanged = JSON.stringify(legacy['evidence'] ?? {}) !== JSON.stringify(evidence);
      const fieldSourcesChanged =
        JSON.stringify(legacy['fieldSources'] ?? {}) !== JSON.stringify(fieldSources);
      const hashChanged = legacy['contentHash'] !== contentHash;
      const patch: Record<string, unknown> = {};

      if (excerptChanged) {
        patch['textExcerpt'] = textExcerpt;
        result.excerptsSanitized += 1;
      }
      if (searchCopyChanged) {
        patch['textNormalized'] = textNormalized;
        result.searchCopiesRebuilt += 1;
      }
      if (evidenceChanged) patch['evidence'] = evidence;
      if (fieldSourcesChanged) {
        patch['fieldSources'] = fieldSources;
        result.fieldSnippetsSanitized += 1;
      }
      if (hashChanged) {
        patch['contentHash'] = contentHash;
        result.hashesRebuilt += 1;
      }

      if (Object.keys(patch).length > 0) {
        await store.updateOne('jobs', { id: job.id }, patch);
        result.jobsUpdated += 1;
      }
    }

    if (jobs.length < PAGE_SIZE) break;
  }

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const items = await store.find('reviewQueue', {}, {
      sort: [['id', 1]],
      skip,
      limit: PAGE_SIZE,
    });
    result.reviewItemsScanned += items.length;
    if (items.length === 0) break;

    for (const item of items) {
      const payload = isRecord(item.payload) ? item.payload : {};
      if (typeof payload['excerpt'] !== 'string') continue;
      const excerpt = makeExcerpt(payload['excerpt'], REVIEW_EXCERPT_LIMIT);
      if (excerpt === payload['excerpt']) continue;
      await store.updateOne('reviewQueue', { id: item.id }, { 'payload.excerpt': excerpt });
      result.reviewExcerptsSanitized += 1;
    }

    if (items.length < PAGE_SIZE) break;
  }

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const revisions = await store.find('jobRevisions', {}, {
      sort: [['id', 1]],
      skip,
      limit: PAGE_SIZE,
    });
    result.revisionsScanned += revisions.length;
    if (revisions.length === 0) break;

    for (const revision of revisions) {
      const legacy = revision as unknown as Record<string, unknown>;
      const previous = sanitizeRevisionSnapshot(legacy['previous']);
      const current = sanitizeRevisionSnapshot(legacy['current']);
      const previousChanged = JSON.stringify(legacy['previous'] ?? {}) !== JSON.stringify(previous);
      const currentChanged = JSON.stringify(legacy['current'] ?? {}) !== JSON.stringify(current);
      if (!previousChanged && !currentChanged) continue;

      const patch: Record<string, unknown> = {};
      if (previousChanged) patch['previous'] = previous;
      if (currentChanged) patch['current'] = current;
      await store.updateOne('jobRevisions', { id: revision.id }, patch);
      result.revisionSnapshotsSanitized += Number(previousChanged) + Number(currentChanged);
    }

    if (revisions.length < PAGE_SIZE) break;
  }

  return result;
}
