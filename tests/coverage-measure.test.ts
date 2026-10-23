import { describe, expect, it } from 'vitest';
import {
  buildCoverageMeasure,
  formatCoverageMeasure,
  normalizeRejectReason,
} from '../src/ops/coverage-measure';

const now = new Date('2026-10-23T09:00:00Z');
const job = (
  overrides: Partial<{
    primarySourceKey: string;
    sourceKeys: string[];
    status: string;
    applicationEndDate: string | null;
    createdAt: string;
  }>,
) => ({
  primarySourceKey: 'rg',
  sourceKeys: ['rg'],
  status: 'active',
  applicationEndDate: '2026-11-01',
  createdAt: '2026-10-22T10:00:00Z',
  ...overrides,
});

describe('buildCoverageMeasure', () => {
  const report = buildCoverageMeasure({
    today: '2026-10-23',
    now,
    sources: [
      { key: 'rg', name: 'Resmî Gazete', enabled: true },
      { key: 'iskur', name: 'İŞKUR', enabled: true },
      { key: 'kapali', name: 'Kapalı', enabled: false },
    ],
    jobs: [
      job({}),
      job({ applicationEndDate: '2026-10-23' }), // bugün son gün → açık
      job({ applicationEndDate: '2026-10-22', status: 'closed' }),
      job({ applicationEndDate: null, status: 'unknown' }),
      job({ applicationEndDate: null, status: 'closed', createdAt: '2026-10-01T00:00:00Z' }),
      job({ applicationEndDate: '2026-11-05', status: 'cancelled' }),
      job({ primarySourceKey: 'iskur', sourceKeys: ['iskur', 'rg'] }),
    ],
    jobSources: [
      { sourceKey: 'iskur', jobId: 'job_1' },
      { sourceKey: 'iskur', jobId: 'job_1' },
      { sourceKey: 'iskur', jobId: 'job_1' },
    ],
    reviews: [
      { sourceKey: 'rg', status: 'open' },
      { sourceKey: 'rg', status: 'resolved' },
    ],
    decisions: [
      {
        sourceKey: 'rg',
        decision: 'rejected',
        reasons: ['Başlık ihale ilanı — personel alımı değil', 'Kural: ret-baslik.ihale'],
      },
      { sourceKey: 'rg', decision: 'rejected', reasons: ['Başlık ihale ilanı — personel alımı değil'] },
      { sourceKey: 'rg', decision: 'rejected', rules: ['ret.sinav-sonucu'] },
      { sourceKey: 'rg', decision: 'rejected' },
      { sourceKey: 'rg', decision: 'review' },
      { sourceKey: 'bilinmeyen', decision: 'rejected' },
    ],
  });
  const rg = report.rows.find((row) => row.sourceKey === 'rg')!;
  const iskur = report.rows.find((row) => row.sourceKey === 'iskur')!;

  it('counts open jobs by deadline ≥ today and excludes cancelled', () => {
    expect(rg.jobs).toBe(6);
    expect(rg.open).toBe(2);
    expect(rg.openUnknownDeadline).toBe(1);
    expect(rg.addedLast7Days).toBe(5);
    expect(iskur.open).toBe(1);
  });

  it('counts secondary source roles and linked source items separately', () => {
    expect(rg.jobsAnyRole).toBe(7);
    expect(iskur.jobs).toBe(1);
    expect(iskur.sourceItems).toBe(3);
  });

  it('counts only open review items', () => {
    expect(rg.reviewOpen).toBe(1);
  });

  it('groups reject reasons, skips duplicated rule lines and reports missing reasons', () => {
    expect(rg.rejected).toBe(4);
    expect(rg.rejectedWithoutReason).toBe(1);
    expect(rg.topRejectReasons[0]).toEqual({ reason: 'Başlık ihale ilanı — personel alımı değil', count: 2 });
    expect(rg.topRejectReasons.map((item) => item.reason)).toContain('ret.sinav-sonucu');
    expect(rg.topRejectReasons.some((item) => item.reason.startsWith('Kural:'))).toBe(false);
  });

  it('keeps sources with no data and unknown source keys visible', () => {
    expect(report.rows.find((row) => row.sourceKey === 'kapali')?.jobs).toBe(0);
    expect(report.rows.find((row) => row.sourceKey === 'bilinmeyen')?.rejected).toBe(1);
  });

  it('formats a table with totals', () => {
    const text = formatCoverageMeasure(report);
    expect(text).toContain('TOPLAM: 7 ilan · 3 kaynak öğesi · açık 3');
    expect(text).toContain('rg');
  });
});

describe('normalizeRejectReason', () => {
  it('collapses numbers and quoted details so similar reasons group together', () => {
    expect(normalizeRejectReason('Başlıklar benzer (74%) "Ege Üniversitesi"')).toBe(
      normalizeRejectReason('Başlıklar benzer (81%) "Akhisar"'),
    );
  });
});
