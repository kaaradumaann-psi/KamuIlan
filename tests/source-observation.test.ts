import { describe, expect, it } from 'vitest';
import { buildSourceObservation, deriveZeroResultReason } from '../src/sources/observation';

const base = {
  lastRunAt: '2026-10-17T10:00:00.000Z',
  discoveredCount: 0,
  lastErrorType: null,
  lastHttpStatus: 200,
  lastRunStatus: 'success',
  coverageStatus: 'complete' as const,
};

describe('deriveZeroResultReason', () => {
  it('hiç koşmadıysa not-run der', () => {
    expect(deriveZeroResultReason({ ...base, lastRunAt: null })).toBe('not-run');
  });

  it('sonuç varsa neden üretmez', () => {
    expect(deriveZeroResultReason({ ...base, discoveredCount: 3 })).toBeNull();
  });

  it('yapı hatasını parse-failure sayar', () => {
    expect(deriveZeroResultReason({ ...base, lastErrorType: 'structure' })).toBe('parse-failure');
  });

  it('403/429/5xx engel sayar', () => {
    expect(deriveZeroResultReason({ ...base, lastHttpStatus: 403 })).toBe('blocked');
    expect(deriveZeroResultReason({ ...base, lastHttpStatus: 503 })).toBe('blocked');
  });

  it('hatalı/atlanmış koşumu unknown sayar, başarıyı boş saymaz', () => {
    expect(deriveZeroResultReason({ ...base, lastRunStatus: 'failed' })).toBe('unknown');
    expect(deriveZeroResultReason({ ...base, lastRunStatus: 'success' })).toBe('not-observed');
  });

  it('insan onayı olmadan confirmed-empty üretmez', () => {
    const observation = buildSourceObservation({
      inventoryStatus: 'verified',
      adapterRegistered: true,
      health: {
        lastRunAt: base.lastRunAt,
        lastDiscoveredCount: 0,
        lastAcceptedCount: 0,
        lastErrorType: null,
        lastHttpStatus: 200,
        lastSuccessAt: base.lastRunAt,
        unexpectedZero: false,
      },
      lastRun: { status: 'success', coverageStatus: 'complete' },
    });
    expect(observation.confirmedEmpty).toBe(false);
    expect(observation.zeroResultReason).toBe('not-observed');
    expect(observation.disclaimer).toMatch(/insan onaylı/i);
  });
});
