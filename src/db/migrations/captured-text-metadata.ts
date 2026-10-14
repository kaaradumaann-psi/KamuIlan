import type { StoragePort } from '../ports';
import { makeExcerpt } from '../../domain/text';

const PAGE_SIZE = 500;
const CAPTURE_LIMIT = 100_000;
const EXCERPT_LIMIT = 1_500;
const CAPTURE_STATUSES = new Set(['captured', 'truncated', 'listing-only', 'unavailable']);

export interface CapturedTextMetadataMigrationResult {
  scanned: number;
  updated: number;
  capturedBodiesCleared: number;
  rawExcerptsCleared: number;
  rawContentHashesCleared: number;
  countsBackfilled: number;
  statusesBackfilled: number;
}

/**
 * Retire source-body copies and unused body fingerprints on job-source links.
 *
 * Capture status and bounded character count remain because the serializer
 * exposes those metadata and the ingestion pipeline uses the status to decide
 * whether a detail page needs to be fetched again. Search, matching and detail
 * rendering use the separate bounded/redacted JobDoc.textExcerpt instead.
 * Never log source text or hashes here.
 */
export async function migrateCapturedTextMetadata(
  store: StoragePort,
): Promise<CapturedTextMetadataMigrationResult> {
  const result: CapturedTextMetadataMigrationResult = {
    scanned: 0,
    updated: 0,
    capturedBodiesCleared: 0,
    rawExcerptsCleared: 0,
    rawContentHashesCleared: 0,
    countsBackfilled: 0,
    statusesBackfilled: 0,
  };

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const links = await store.find('jobSources', {}, {
      sort: [['id', 1]],
      skip,
      limit: PAGE_SIZE,
    });
    result.scanned += links.length;
    if (links.length === 0) break;

    for (const link of links) {
      // Older persisted JSON documents can lack metadata and still contain
      // capturedText/rawExcerpt. Treat every legacy value as untrusted.
      const legacy = link as unknown as Record<string, unknown>;
      const capturedText = typeof legacy['capturedText'] === 'string' ? legacy['capturedText'] : '';
      const rawExcerpt = typeof legacy['rawExcerpt'] === 'string' ? legacy['rawExcerpt'] : '';
      const oldCount = legacy['capturedTextCharacterCount'];
      const hasCount = typeof oldCount === 'number' && Number.isSafeInteger(oldCount) && oldCount >= 0;
      const capturedCount = capturedText ? makeExcerpt(capturedText, CAPTURE_LIMIT).length : 0;
      const excerptCount = rawExcerpt ? makeExcerpt(rawExcerpt, EXCERPT_LIMIT).length : 0;
      const countFallback = capturedCount || excerptCount;
      // A positive historic count remains authoritative. A missing/zero count
      // is repaired from stored text before that text is cleared.
      const countNeedsBackfill = !hasCount || (oldCount === 0 && countFallback > 0);
      const characterCount = countNeedsBackfill ? countFallback : oldCount;

      const oldStatus = legacy['capturedTextStatus'];
      const hasValidStatus = typeof oldStatus === 'string' && CAPTURE_STATUSES.has(oldStatus);
      let capturedTextStatus = hasValidStatus ? oldStatus : 'unavailable';
      if (capturedText && capturedTextStatus !== 'captured' && capturedTextStatus !== 'truncated') {
        capturedTextStatus = capturedText.length >= CAPTURE_LIMIT ? 'truncated' : 'captured';
      } else if (
        !capturedText &&
        rawExcerpt &&
        capturedTextStatus !== 'captured' &&
        capturedTextStatus !== 'truncated'
      ) {
        capturedTextStatus = 'listing-only';
      }

      const hadCapturedTextField = Object.hasOwn(legacy, 'capturedText');
      const hadRawExcerptField = Object.hasOwn(legacy, 'rawExcerpt');
      const hadRawContentHashField = Object.hasOwn(legacy, 'rawContentHash');
      const hasRawContentHash =
        hadRawContentHashField && typeof legacy['rawContentHash'] === 'string' && legacy['rawContentHash'] !== '';
      const needsUpdate =
        countNeedsBackfill ||
        !hasValidStatus ||
        (hadCapturedTextField && legacy['capturedText'] !== '') ||
        (hadRawExcerptField && legacy['rawExcerpt'] !== '') ||
        hasRawContentHash;

      if (!needsUpdate) continue;

      const patch: Record<string, unknown> = {
        capturedTextCharacterCount: characterCount,
        capturedTextStatus,
      };
      if (hadCapturedTextField) patch['capturedText'] = '';
      if (hadRawExcerptField) patch['rawExcerpt'] = '';
      if (hadRawContentHashField) patch['rawContentHash'] = '';
      await store.updateOne('jobSources', { id: link.id }, patch);

      result.updated += 1;
      if (capturedText.length > 0) result.capturedBodiesCleared += 1;
      if (rawExcerpt.length > 0) result.rawExcerptsCleared += 1;
      if (hasRawContentHash) result.rawContentHashesCleared += 1;
      if (countNeedsBackfill) result.countsBackfilled += 1;
      if (!hasValidStatus) result.statusesBackfilled += 1;
    }

    if (links.length < PAGE_SIZE) break;
  }

  return result;
}
