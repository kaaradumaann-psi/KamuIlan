import { describe, expect, it } from 'vitest';
import {
  buildStagingReport,
  classifyZeroResult,
  formatStagingReport,
  hasBlockingHttpStatus,
  maskSourceUrl,
  stagingExitCode,
} from '../src/staging/report';
import { assessSourceTerms, type SourceTermsEntry } from '../src/sources/terms';

const allowedEntry: SourceTermsEntry = {
  sourceKey: 'resmigazete-cestili-ilanlar',
  decision: 'allowed',
  reviewedAt: '2026-10-01',
  reviewedBy: 'operatör',
  robotsUrl: 'https://www.resmigazete.gov.tr/robots.txt',
  termsUrl: 'https://www.resmigazete.gov.tr/kullanim-sartlari',
  allowsStorage: true,
  notes: '',
};

const allowedAssessment = assessSourceTerms(allowedEntry, new Date('2026-10-17T00:00:00Z'));

const baseInput = {
  sourceKey: 'resmigazete-cestili-ilanlar',
  sourceName: 'Resmî Gazete',
  adapterKey: 'resmigazete-cestili',
  listingUrl: 'https://www.resmigazete.gov.tr/ilanlar?gizli=deger#bolum',
  generatedAt: '2026-10-17T00:00:00.000Z',
  dataDir: '/tmp/kamuradan-staging/data',
  live: true,
  confirmedEmpty: false,
  budgets: { maxRequests: 5, maxPages: 3, maxDetails: 1, minDelayMs: 1500 },
  terms: allowedAssessment,
  http: { requestsMade: 0, textFetchesMade: 0, redirectsMade: 0, binaryFetchesMade: 0 },
} as const;

describe('maskSourceUrl', () => {
  it('yalnızca host ve yol hash’i üretir; query/fragment sızdırmaz', () => {
    const masked = maskSourceUrl(baseInput.listingUrl);
    expect(masked.host).toBe('www.resmigazete.gov.tr');
    expect(masked.pathHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(masked)).not.toContain('gizli');
    expect(JSON.stringify(masked)).not.toContain('bolum');
  });

  it('farklı yollar farklı hash üretir', () => {
    expect(maskSourceUrl('https://a.example/x').pathHash).not.toBe(maskSourceUrl('https://a.example/y').pathHash);
  });

  it('geçersiz URL’i gizli değer yazmadan işaretler', () => {
    expect(maskSourceUrl('secret-not-a-url?token=abc')).toEqual({
      host: '[INVALID-URL]',
      pathHash: '0000000000000000',
    });
  });
});

describe('classifyZeroResult', () => {
  const base = {
    live: true,
    itemsFound: 0,
    runStatus: 'success' as const,
    coverageStatus: 'complete' as const,
    errorType: null,
    httpStatuses: [] as number[],
    httpStatus: null as number | null,
    confirmedEmpty: false,
  };

  it('kuru çalışma her zaman dry-run', () => {
    expect(classifyZeroResult({ ...base, live: false })).toBe('dry-run');
  });

  it('ilan bulunduysa neden yok', () => {
    expect(classifyZeroResult({ ...base, itemsFound: 3 })).toBeNull();
  });

  it('HTML yapı hatası parse-failure', () => {
    expect(classifyZeroResult({ ...base, errorType: 'structure', confirmedEmpty: true })).toBe('parse-failure');
  });

  it('403/429/5xx engel sayılır', () => {
    expect(classifyZeroResult({ ...base, httpStatuses: [403] })).toBe('blocked');
    expect(classifyZeroResult({ ...base, httpStatuses: [429] })).toBe('blocked');
    expect(classifyZeroResult({ ...base, httpStatuses: [503] })).toBe('blocked');
    expect(classifyZeroResult({ ...base, httpStatus: 401 })).toBe('blocked');
    expect(hasBlockingHttpStatus([200, 404])).toBe(false);
  });

  it('doğrulanmış boş sonuç yalnızca açık onayla confirmed-empty', () => {
    expect(classifyZeroResult(base)).toBe('not-observed');
    expect(classifyZeroResult({ ...base, confirmedEmpty: true })).toBe('confirmed-empty');
    expect(classifyZeroResult({ ...base, coverageStatus: 'partial', confirmedEmpty: true })).toBe('not-observed');
    expect(classifyZeroResult({ ...base, coverageStatus: 'unknown', confirmedEmpty: true })).toBe('not-observed');
  });

  it('başarısız/atlanmış/kilitli koşum unknown', () => {
    expect(classifyZeroResult({ ...base, runStatus: 'failed' })).toBe('unknown');
    expect(classifyZeroResult({ ...base, runStatus: 'skipped' })).toBe('unknown');
    expect(classifyZeroResult({ ...base, runStatus: 'locked' })).toBe('unknown');
  });
});

describe('buildStagingReport', () => {
  const fakeRun = {
    runId: 'run-1',
    sourceKey: 'resmigazete-cestili-ilanlar',
    status: 'success' as const,
    itemsFound: 0,
    itemsAccepted: 0,
    itemsRejected: 0,
    itemsReview: 0,
    jobsCreated: 0,
    jobsUpdated: 0,
    itemsMerged: 0,
    revisionsCreated: 0,
    notificationsQueued: 0,
    durationMs: 1234,
    coverageStatus: 'complete' as const,
    coverageNote: '1 sayfa tarandı; son sayfa doğrulandı.',
    notes: ['not-1'],
    errors: [],
    httpStatuses: [200],
    httpStatus: null,
    errorType: null,
    locked: false,
    llm: {
      enabled: false,
      calls: 0,
      cacheHits: 0,
      upgradedToJob: 0,
      upgradedToProcess: 0,
      rejected: 0,
      keptReview: 0,
      blocked: 0,
      invalid: 0,
      errors: 0,
    },
  };

  it('yalıtım sabitlerini ve 0-sonuç nedenini raporlar', () => {
    const report = buildStagingReport({ ...baseInput, run: fakeRun, runError: null });
    expect(report.isolation).toEqual({
      databaseDriver: 'file',
      productionDatabase: 'NOT USED',
      scheduler: 'DISABLED',
      email: 'DISABLED',
      telegram: 'DISABLED',
      ai: 'DISABLED',
      browserFallback: 'DISABLED',
      tlsVerification: 'ON',
    });
    expect(report.mode).toBe('live');
    expect(report.zeroResultReason).toBe('not-observed');
    expect(report.source).toEqual(maskSourceUrl(baseInput.listingUrl));
    expect(JSON.stringify(report)).not.toContain('gizli=deger');
    expect(formatStagingReport(report)).toContain('0-sonuç nedeni: not-observed');
  });

  it('koşum çökerse error hash’i üretir, ham hata metnini yazmaz', () => {
    const report = buildStagingReport({
      ...baseInput,
      run: null,
      runError: 'İstek başarısız: gizli-anahtar=abc',
    });
    expect(report.zeroResultReason).toBe('unknown');
    expect(report.runErrorHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(report)).not.toContain('gizli-anahtar');
  });

  it('kuru çalışma raporu ağ kullanılmadığını açıkça söyler', () => {
    const report = buildStagingReport({ ...baseInput, live: false, run: null, runError: null });
    expect(report.mode).toBe('dry-run');
    expect(report.zeroResultReason).toBe('dry-run');
    expect(formatStagingReport(report)).toContain('hiçbir HTTP isteği yapılmadı');
  });
});

describe('stagingExitCode', () => {
  it('kuru çalışma her zaman 0', () => {
    expect(
      stagingExitCode({ live: false, runError: false, runStatus: null, zeroResultReason: 'dry-run' }),
    ).toBe(0);
  });

  it('doğrulanmamış 0 ilan başarı değildir: exit 6', () => {
    for (const reason of ['not-observed', 'blocked', 'parse-failure', 'unknown'] as const) {
      expect(
        stagingExitCode({
          live: true,
          runError: false,
          runStatus: 'success',
          zeroResultReason: reason,
        }),
      ).toBe(6);
    }
  });

  it('yalnızca açık insan onaylı confirmed-empty 0 döner', () => {
    expect(
      stagingExitCode({
        live: true,
        runError: false,
        runStatus: 'success',
        zeroResultReason: 'confirmed-empty',
      }),
    ).toBe(0);
  });

  it('ilan bulunduysa 0, koşum hatası/kilit 1', () => {
    expect(
      stagingExitCode({ live: true, runError: false, runStatus: 'success', zeroResultReason: null }),
    ).toBe(0);
    expect(
      stagingExitCode({ live: true, runError: true, runStatus: null, zeroResultReason: 'unknown' }),
    ).toBe(1);
    expect(
      stagingExitCode({ live: true, runError: false, runStatus: 'locked', zeroResultReason: 'unknown' }),
    ).toBe(1);
    expect(
      stagingExitCode({ live: true, runError: false, runStatus: 'failed', zeroResultReason: 'unknown' }),
    ).toBe(1);
  });

  it('0-sonuç raporu başarısız olduğunu açıkça yazar', () => {
    const report = buildStagingReport({ ...baseInput, run: null, runError: null });
    expect(report.zeroResultReason).toBe('not-observed');
    expect(formatStagingReport(report)).toContain('exit 6');
  });
});
