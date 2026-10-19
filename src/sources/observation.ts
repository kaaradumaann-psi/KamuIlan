/**
 * Kaynak gözlem sınıflandırması (saf fonksiyon).
 *
 * Panelde "200 döndü" veya "envanterde var" ifadesi "çalışıyor" diye
 * okunmamalıdır. Bu modül yalnızca kayıtlı kanıttan türetilebilen durumu
 * söyler; kanıt yoksa `not-run`, 0 sonuç varsa nedeni ayrı verilir.
 *
 * `confirmed-empty` BİLİNÇLİ OLARAK burada üretilmez: boşluğun doğrulanmış
 * sayılması insan onayı (staging `--confirmed-empty`) gerektirir.
 */

export type SourceZeroResultReason = 'not-run' | 'not-observed' | 'blocked' | 'parse-failure' | 'unknown';

export interface SourceObservationInput {
  lastRunAt: string | null;
  discoveredCount: number;
  lastErrorType: 'unavailable' | 'structure' | 'fetch' | 'item' | 'other' | null;
  lastHttpStatus: number | null;
  lastRunStatus: string | null;
  coverageStatus: 'complete' | 'partial' | 'unknown' | null;
}

function isBlockingStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/** 0 sonucun nedenini döndürür; sonuç varsa null. */
export function deriveZeroResultReason(input: SourceObservationInput): SourceZeroResultReason | null {
  if (!input.lastRunAt) return 'not-run';
  if (input.discoveredCount > 0) return null;
  if (input.lastErrorType === 'structure') return 'parse-failure';
  if (input.lastHttpStatus !== null && isBlockingStatus(input.lastHttpStatus)) return 'blocked';
  if (
    input.lastRunStatus !== null &&
    (input.lastRunStatus === 'failed' || input.lastRunStatus === 'skipped' || input.lastRunStatus === 'locked')
  ) {
    return 'unknown';
  }
  return 'not-observed';
}

/**
 * Panelin ayrı göstermesi gereken katmanlar. Hiçbiri tek başına "kaynak
 * çalışıyor" anlamına gelmez; `disclaimer` bunu açıkça söyler.
 */
export interface SourceObservation {
  inventoryStatus: string;
  adapterRegistered: boolean;
  lastHttpStatus: number | null;
  lastErrorType: SourceObservationInput['lastErrorType'];
  discoveredCount: number;
  acceptedCount: number;
  coverage: 'complete' | 'partial' | 'unknown';
  zeroResultReason: SourceZeroResultReason | null;
  lastFullSuccessAt: string | null;
  unexpectedZero: boolean;
  /** 0 sonuç insan onayı olmadan "boş" sayılmaz. */
  confirmedEmpty: false;
  disclaimer: string;
}

export function buildSourceObservation(input: {
  inventoryStatus: string;
  adapterRegistered: boolean;
  health: {
    lastRunAt: string | null;
    lastDiscoveredCount: number;
    lastAcceptedCount: number;
    lastErrorType: SourceObservationInput['lastErrorType'];
    lastHttpStatus: number | null;
    lastSuccessAt: string | null;
    unexpectedZero: boolean;
  };
  lastRun: { status: string; coverageStatus: 'complete' | 'partial' | 'unknown' } | null;
}): SourceObservation {
  const zeroResultReason = deriveZeroResultReason({
    lastRunAt: input.health.lastRunAt,
    discoveredCount: input.health.lastDiscoveredCount,
    lastErrorType: input.health.lastErrorType,
    lastHttpStatus: input.health.lastHttpStatus,
    lastRunStatus: input.lastRun?.status ?? null,
    coverageStatus: input.lastRun?.coverageStatus ?? null,
  });
  return {
    inventoryStatus: input.inventoryStatus,
    adapterRegistered: input.adapterRegistered,
    lastHttpStatus: input.health.lastHttpStatus,
    lastErrorType: input.health.lastErrorType,
    discoveredCount: input.health.lastDiscoveredCount,
    acceptedCount: input.health.lastAcceptedCount,
    coverage: input.lastRun?.coverageStatus ?? 'unknown',
    zeroResultReason,
    lastFullSuccessAt: input.health.lastSuccessAt,
    unexpectedZero: input.health.unexpectedZero,
    confirmedEmpty: false,
    disclaimer:
      'Envanter/adaptör/HTTP kaydı tek başına "kaynak çalışıyor" kanıtı değildir; ' +
      '0 sonuç yalnızca insan onaylı staging koşumunda "doğrulanmış boş" sayılır.',
  };
}
