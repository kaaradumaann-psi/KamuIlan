/**
 * Staging koşum raporu (saf fonksiyonlar).
 *
 * Sözleşme:
 *  - 0 ilan ASLA otomatik "başarı" değildir; neden ayrı sınıflandırılır.
 *  - `confirmed-empty` yalnızca adaptörün `coverage: complete` kanıtı ve
 *    operatörün açık `--confirmed-empty` beyanı birlikte varsa seçilir.
 *  - URL'ler yalnızca host + yol hash'i olarak raporlanır; query/fragment ve
 *    ham sayfa metni yazılmaz.
 */
import { createHash } from 'node:crypto';
import type { RunSourceResult } from '../ingest/pipeline';
import type { SourceTermsAssessment } from '../sources/terms';

export type StagingZeroResultReason =
  | 'dry-run'
  | 'not-observed'
  | 'confirmed-empty'
  | 'blocked'
  | 'parse-failure'
  | 'unknown';

export interface StagingHttpCounters {
  requestsMade: number;
  textFetchesMade: number;
  redirectsMade: number;
  binaryFetchesMade: number;
}

export interface StagingReportInput {
  sourceKey: string;
  sourceName: string;
  adapterKey: string;
  listingUrl: string;
  generatedAt: string;
  dataDir: string;
  live: boolean;
  confirmedEmpty: boolean;
  budgets: {
    maxRequests: number;
    maxPages: number;
    maxDetails: number;
    minDelayMs: number;
  };
  terms: SourceTermsAssessment;
  http: StagingHttpCounters;
  run: RunSourceResult | null;
  runError: string | null;
}

export interface MaskedSourceUrl {
  host: string;
  pathHash: string;
}

export function maskSourceUrl(rawUrl: string): MaskedSourceUrl {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.host.toLowerCase(),
      pathHash: createHash('sha256').update(url.pathname).digest('hex').slice(0, 16),
    };
  } catch {
    return { host: '[INVALID-URL]', pathHash: '0000000000000000' };
  }
}

/** HTTP durum kodlarında erişim engeli/geçici sunucu hatası var mı? */
export function hasBlockingHttpStatus(statuses: readonly number[]): boolean {
  return statuses.some(
    (status) => status === 401 || status === 403 || status === 429 || status >= 500,
  );
}

export function classifyZeroResult(input: {
  live: boolean;
  itemsFound: number;
  runStatus: RunSourceResult['status'] | null;
  coverageStatus: 'complete' | 'partial' | 'unknown';
  errorType: RunSourceResult['errorType'];
  httpStatuses: readonly number[];
  httpStatus: number | null;
  confirmedEmpty: boolean;
}): StagingZeroResultReason | null {
  if (!input.live) return 'dry-run';
  if (input.itemsFound > 0) return null;
  if (input.errorType === 'structure') return 'parse-failure';
  if (hasBlockingHttpStatus(input.httpStatuses)) return 'blocked';
  if (input.httpStatus !== null && hasBlockingHttpStatus([input.httpStatus])) return 'blocked';
  if (input.runStatus === 'skipped') return 'unknown';
  if (input.runStatus === 'failed' || input.runStatus === 'locked') return 'unknown';
  if (input.coverageStatus === 'complete' && input.confirmedEmpty) return 'confirmed-empty';
  return 'not-observed';
}

/**
 * Canlı staging koşumunun çıkış kodunu tek yerden belirler.
 *
 * 0 yalnızca gerçekten ilan bulunduğunda veya operatör `--confirmed-empty`
 * verdiğinde döner. 0 ilanın diğer tüm nedenleri (not-observed, blocked,
 * parse-failure, unknown) **başarı değildir** ve 6 döndürür; böylece CI/otomasyon
 * boş sonucu yeşil saymaz. 1 koşum hatası, 2/3/4/5 komut kapıları içindir.
 */
export function stagingExitCode(input: {
  live: boolean;
  runError: boolean;
  runStatus: RunSourceResult['status'] | 'dry-run' | null;
  zeroResultReason: StagingZeroResultReason | null;
}): number {
  if (!input.live || input.runStatus === 'dry-run') return 0;
  if (input.runError || input.runStatus === 'failed' || input.runStatus === 'locked') return 1;
  if (input.zeroResultReason !== null && input.zeroResultReason !== 'confirmed-empty') return 6;
  return 0;
}

export interface StagingReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: 'live' | 'dry-run';
  sourceKey: string;
  sourceName: string;
  adapterKey: string;
  source: MaskedSourceUrl;
  dataDir: string;
  isolation: {
    databaseDriver: 'file';
    productionDatabase: 'NOT USED';
    scheduler: 'DISABLED';
    email: 'DISABLED';
    telegram: 'DISABLED';
    ai: 'DISABLED';
    browserFallback: 'DISABLED';
    tlsVerification: 'ON';
  };
  terms: {
    status: 'allowed' | 'blocked' | 'unknown';
    reason: string;
    reviewedAt: string | null;
    reviewedBy: string | null;
    allowsStorage: boolean | null;
  };
  budgets: StagingReportInput['budgets'];
  http: StagingHttpCounters;
  run: {
    status: RunSourceResult['status'] | 'dry-run';
    completion: 'complete' | 'partial' | 'unknown';
    errorType: RunSourceResult['errorType'];
    durationMs: number;
    httpStatuses: number[];
    itemsFound: number;
    itemsAccepted: number;
    itemsRejected: number;
    itemsReview: number;
    jobsCreated: number;
    jobsUpdated: number;
    itemsMerged: number;
    errors: number;
    notes: number;
    coverageStatus: 'complete' | 'partial' | 'unknown';
    coverageNote: string;
    locked: boolean;
  } | null;
  zeroResultReason: StagingZeroResultReason | null;
  runErrorHash: string | null;
}

function hash(value: string | null): string | null {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;
}

export function buildStagingReport(input: StagingReportInput): StagingReport {
  const run = input.run;
  const coverageStatus = run?.coverageStatus ?? 'unknown';
  const completion: 'complete' | 'partial' | 'unknown' =
    coverageStatus === 'complete' ? 'complete' : coverageStatus === 'partial' ? 'partial' : 'unknown';
  const zeroResultReason =
    input.live && !run && input.runError
      ? ('unknown' as const)
      : classifyZeroResult({
          live: input.live,
          itemsFound: run?.itemsFound ?? 0,
          runStatus: run?.status ?? null,
          coverageStatus,
          errorType: run?.errorType ?? null,
          httpStatuses: run?.httpStatuses ?? [],
          httpStatus: run?.httpStatus ?? null,
          confirmedEmpty: input.confirmedEmpty,
        });
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    mode: input.live ? 'live' : 'dry-run',
    sourceKey: input.sourceKey,
    sourceName: input.sourceName,
    adapterKey: input.adapterKey,
    source: maskSourceUrl(input.listingUrl),
    dataDir: input.dataDir,
    isolation: {
      databaseDriver: 'file',
      productionDatabase: 'NOT USED',
      scheduler: 'DISABLED',
      email: 'DISABLED',
      telegram: 'DISABLED',
      ai: 'DISABLED',
      browserFallback: 'DISABLED',
      tlsVerification: 'ON',
    },
    terms: {
      status: input.terms.entry?.decision ?? 'unknown',
      reason: input.terms.reason,
      reviewedAt: input.terms.entry?.reviewedAt ?? null,
      reviewedBy: input.terms.entry?.reviewedBy ?? null,
      allowsStorage: input.terms.entry?.allowsStorage ?? null,
    },
    budgets: input.budgets,
    http: input.http,
    run: run
      ? {
          status: run.status,
          completion,
          errorType: run.errorType,
          durationMs: run.durationMs,
          httpStatuses: run.httpStatuses ?? [],
          itemsFound: run.itemsFound,
          itemsAccepted: run.itemsAccepted,
          itemsRejected: run.itemsRejected,
          itemsReview: run.itemsReview,
          jobsCreated: run.jobsCreated,
          jobsUpdated: run.jobsUpdated,
          itemsMerged: run.itemsMerged,
          errors: run.errors.length,
          notes: run.notes.length,
          coverageStatus,
          coverageNote: run.coverageNote,
          locked: run.locked,
        }
      : null,
    zeroResultReason,
    runErrorHash: hash(input.runError),
  };
}

/** Kısa, secret/PII içermeyen konsol özeti. */
export function formatStagingReport(report: StagingReport): string {
  if (report.mode === 'dry-run') {
    return [
      'KURU ÇALIŞMA: hiçbir HTTP isteği yapılmadı, veri yazılmadı.',
      `Kaynak: ${report.sourceKey} (${report.adapterKey}) · host: ${report.source.host}`,
      `Erişim şartları: ${report.terms.status} — ${report.terms.reason}`,
    ].join('\n');
  }
  const run = report.run;
  const lines = [
    `Kaynak: ${report.sourceKey} (${report.adapterKey}) · host: ${report.source.host}`,
    `Koşum: ${run?.status ?? 'yok'} · kapsam: ${run?.completion ?? 'unknown'} · 0-sonuç nedeni: ${report.zeroResultReason ?? '—'}`,
    `HTTP: ${report.http.requestsMade} istek (${report.http.redirectsMade} yönlendirme, ${report.http.textFetchesMade} metin, ${report.http.binaryFetchesMade} ikili) · durumlar: ${(run?.httpStatuses ?? []).join(', ') || '—'}`,
    `İlan: bulunan ${run?.itemsFound ?? 0}, kabul ${run?.itemsAccepted ?? 0}, inceleme ${run?.itemsReview ?? 0}, ret ${run?.itemsRejected ?? 0}, yeni ${run?.jobsCreated ?? 0}, güncellenen ${run?.jobsUpdated ?? 0}`,
    `Yalıtım: file DB · scheduler/email/telegram/AI/browser kapalı · TLS doğrulama AÇIK · üretim DB kullanılmadı`,
  ];
  if (
    report.zeroResultReason !== null &&
    report.zeroResultReason !== 'confirmed-empty' &&
    report.zeroResultReason !== 'dry-run'
  ) {
    lines.push(
      `SONUÇ: 0 ilan (${report.zeroResultReason}); bu koşum başarı sayılmaz ve exit 6 döner. ` +
        'Kaynağın gerçekten boş olduğu ancak tam kapsam + insan onayı ile "confirmed-empty" olur.',
    );
  }
  return lines.join('\n');
}
