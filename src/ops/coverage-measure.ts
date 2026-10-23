/**
 * Kaynak başına kapsam ölçümü — SAF hesap (depoya dokunmaz).
 *
 * Girdi: depodan salt-okunur çekilmiş kaynak/ilan/inceleme/karar kayıtları.
 * Çıktı: kaynak başına toplam ilan, açık ilan (son başvuru ≥ bugün), son 7 gün
 * eklenen, açık inceleme ve ret sayısı + en sık ret gerekçeleri.
 *
 * Gerekçe (`reasons`) alanı PR #100 sonrası kararlarda vardır; eski kayıtlar
 * "gerekçe kaydı yok" olarak ayrı sayılır, uydurulmaz.
 */

export interface CoverageSourceInput {
  key: string;
  name: string;
  enabled: boolean;
}

export interface CoverageJobInput {
  primarySourceKey: string;
  sourceKeys: string[];
  status: string;
  applicationEndDate: string | null;
  createdAt: string;
}

export interface CoverageReviewInput {
  sourceKey: string;
  status: string;
}

export interface CoverageJobSourceInput {
  sourceKey: string;
  jobId: string;
}

export interface CoverageDecisionInput {
  sourceKey: string;
  decision: string;
  reasons?: string[] | undefined;
  rules?: string[] | undefined;
}

export interface CoverageMeasureRow {
  sourceKey: string;
  name: string;
  enabled: boolean;
  /** Bu kaynağın birincil olduğu ilan sayısı. */
  jobs: number;
  /** Bu kaynağın herhangi bir kaynak anahtarı olarak geçtiği ilan sayısı (tekilleştirilmiş katkı dâhil). */
  jobsAnyRole: number;
  /**
   * Bu kaynaktan gelen ve bir ilana bağlanan kaynak öğesi sayısı (jobSources).
   * `sourceItems` ≫ `jobsAnyRole` ise ayrı ilanlar tek ilana birleştirilmiş olabilir.
   */
  sourceItems: number;
  /** Son başvuru tarihi bugün veya sonrası (iptal edilmemiş). */
  open: number;
  /** Son başvuru tarihi bilinmeyen, kapanmamış/iptal edilmemiş ilanlar. */
  openUnknownDeadline: number;
  addedLast7Days: number;
  reviewOpen: number;
  rejected: number;
  rejectedWithoutReason: number;
  topRejectReasons: Array<{ reason: string; count: number }>;
}

export interface CoverageMeasureReport {
  today: string;
  totals: Omit<CoverageMeasureRow, 'sourceKey' | 'name' | 'enabled' | 'topRejectReasons'>;
  rows: CoverageMeasureRow[];
}

export interface CoverageMeasureInput {
  sources: CoverageSourceInput[];
  jobs: CoverageJobInput[];
  reviews: CoverageReviewInput[];
  decisions: CoverageDecisionInput[];
  jobSources?: CoverageJobSourceInput[];
  /** İstanbul takvim günü, YYYY-MM-DD. */
  today: string;
  now: Date;
  topReasons?: number;
}

const DAY_MS = 86_400_000;

function emptyRow(source: CoverageSourceInput): CoverageMeasureRow {
  return {
    sourceKey: source.key,
    name: source.name,
    enabled: source.enabled,
    jobs: 0,
    jobsAnyRole: 0,
    sourceItems: 0,
    open: 0,
    openUnknownDeadline: 0,
    addedLast7Days: 0,
    reviewOpen: 0,
    rejected: 0,
    rejectedWithoutReason: 0,
    topRejectReasons: [],
  };
}

/** Gerekçeyi gruplamak için kısaltır: sayılar ve tırnak içi ayrıntılar tek anahtar altında toplanır. */
export function normalizeRejectReason(reason: string): string {
  return reason
    .replace(/["“”'‘’][^"“”'‘’]{0,120}["“”'‘’]/g, '"…"')
    .replace(/\d+([.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function buildCoverageMeasure(input: CoverageMeasureInput): CoverageMeasureReport {
  const topN = input.topReasons ?? 3;
  const rows = new Map<string, CoverageMeasureRow>();
  const rowFor = (key: string): CoverageMeasureRow => {
    let row = rows.get(key);
    if (!row) {
      row = emptyRow({ key, name: key, enabled: false });
      rows.set(key, row);
    }
    return row;
  };
  for (const source of input.sources) rows.set(source.key, emptyRow(source));

  const weekAgo = input.now.getTime() - 7 * DAY_MS;
  for (const job of input.jobs) {
    const row = rowFor(job.primarySourceKey);
    row.jobs += 1;
    for (const key of new Set([job.primarySourceKey, ...job.sourceKeys])) rowFor(key).jobsAnyRole += 1;
    const live = job.status !== 'cancelled' && job.status !== 'closed';
    if (job.applicationEndDate) {
      if (job.status !== 'cancelled' && job.applicationEndDate >= input.today) row.open += 1;
    } else if (live) {
      row.openUnknownDeadline += 1;
    }
    const created = Date.parse(job.createdAt);
    if (Number.isFinite(created) && created >= weekAgo) row.addedLast7Days += 1;
  }

  for (const link of input.jobSources ?? []) rowFor(link.sourceKey).sourceItems += 1;

  for (const review of input.reviews) {
    if (review.status === 'open') rowFor(review.sourceKey).reviewOpen += 1;
  }

  const reasonCounts = new Map<string, Map<string, number>>();
  for (const decision of input.decisions) {
    if (decision.decision !== 'rejected') continue;
    const row = rowFor(decision.sourceKey);
    row.rejected += 1;
    // `reasons` içindeki "Kural: …" satırları `rules` alanının kopyasıdır; gerekçe varken sayılmaz.
    const explained = decision.reasons?.filter((reason) => !/^Kural:/i.test(reason.trim())) ?? [];
    const reasons = explained.length ? explained : decision.rules?.length ? decision.rules : null;
    if (!reasons) {
      row.rejectedWithoutReason += 1;
      continue;
    }
    const counts = reasonCounts.get(decision.sourceKey) ?? new Map<string, number>();
    // Tek kararın aynı gerekçeyi iki kez sayması engellenir.
    for (const reason of new Set(reasons.map(normalizeRejectReason)))
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    reasonCounts.set(decision.sourceKey, counts);
  }
  for (const [key, counts] of reasonCounts) {
    rowFor(key).topRejectReasons = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count }));
  }

  const sorted = [...rows.values()].sort((a, b) => b.jobs - a.jobs || a.sourceKey.localeCompare(b.sourceKey));
  const totals = {
    jobs: input.jobs.length,
    jobsAnyRole: input.jobs.length,
    sourceItems: sorted.reduce((sum, row) => sum + row.sourceItems, 0),
    open: sorted.reduce((sum, row) => sum + row.open, 0),
    openUnknownDeadline: sorted.reduce((sum, row) => sum + row.openUnknownDeadline, 0),
    addedLast7Days: sorted.reduce((sum, row) => sum + row.addedLast7Days, 0),
    reviewOpen: sorted.reduce((sum, row) => sum + row.reviewOpen, 0),
    rejected: sorted.reduce((sum, row) => sum + row.rejected, 0),
    rejectedWithoutReason: sorted.reduce((sum, row) => sum + row.rejectedWithoutReason, 0),
  };
  return { today: input.today, totals, rows: sorted };
}

function cell(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

export function formatCoverageMeasure(report: CoverageMeasureReport): string {
  const lines = [
    `Kaynak başına kapsam ölçümü — ${report.today} (salt okunur)`,
    `${cell('KAYNAK', 34)} ${cell('E', 2)} ${cell('TOPLAM', 7)} ${cell('ÖĞE', 5)} ${cell('AÇIK', 5)} ${cell('AÇIK?', 6)} ${cell('7GÜN', 5)} ${cell('İNC', 4)} ${cell('RET', 5)} EN SIK RET GEREKÇESİ`,
  ];
  for (const row of report.rows) {
    const reasons = row.topRejectReasons.map((item) => `${item.count}× ${item.reason}`).join(' | ');
    const noReason = row.rejectedWithoutReason ? ` (gerekçesiz ${row.rejectedWithoutReason})` : '';
    lines.push(
      `${cell(row.sourceKey, 34)} ${cell(row.enabled ? 'e' : '-', 2)} ${cell(String(row.jobs), 7)} ${cell(String(row.sourceItems), 5)} ${cell(String(row.open), 5)} ${cell(String(row.openUnknownDeadline), 6)} ${cell(String(row.addedLast7Days), 5)} ${cell(String(row.reviewOpen), 4)} ${cell(String(row.rejected), 5)} ${reasons}${noReason}`,
    );
  }
  const t = report.totals;
  lines.push(
    `TOPLAM: ${t.jobs} ilan · ${t.sourceItems} kaynak öğesi · açık ${t.open} · son başvurusu bilinmeyen ${t.openUnknownDeadline} · son 7 gün ${t.addedLast7Days} · açık inceleme ${t.reviewOpen} · ret ${t.rejected} (gerekçesiz ${t.rejectedWithoutReason})`,
    'TOPLAM = birincil kaynağı bu olan ilan; ÖĞE = ilana bağlanan kaynak öğesi (ÖĞE ≫ TOPLAM ise ayrı ilanlar birleşmiş olabilir).',
    'AÇIK = son başvuru ≥ bugün (iptal hariç); AÇIK? = son başvuru tarihi yok, kapanmamış.',
  );
  return `${lines.join('\n')}\n`;
}
