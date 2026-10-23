/**
 * Resmî Gazete geriye dönük (backfill) tarama planı.
 *
 * `RG_BACKFILL_DAYS` > 0 ise worker, olağan günlük taramadan (bugün + dün) ARTA KALAN bütçeyle
 * geçmiş günlerin Çeşitli İlânlar bölümlerini koşum başına en fazla `RG_BACKFILL_DAYS_PER_RUN`
 * gün işler. İlerleme kaynağın `adapterState.rgBackfill` alanında kalıcıdır:
 *  - `anchorDate`: taramanın başladığı gün; pencere bu güne sabitlenir (kaymaz, tek seferliktir).
 *  - `doneDates`: bölümü sonuna kadar gezilmiş ve tüm yeni PDF'leri işlenmiş günler.
 *  - `attempts`: tamamlanamayan günün deneme sayısı; `MAX_ATTEMPTS` sonrası gün `skippedDates`'e
 *    alınır (kalıcı hata tüm geri taramayı kilitlemesin).
 *  - `completedAt`: pencerenin tamamı bitince yazılır; sonra hiçbir istek yapılmaz.
 * Pencere daha sonra büyütülürse (ör. 60 → 90) yalnızca eklenen günler işlenir.
 */
import { addDaysDateOnly } from '../../domain/dates';

export const RG_BACKFILL_MAX_ATTEMPTS = 3;
/** Olağan tarama bugün ve dünü okur; geri tarama 2 gün önceden başlar. */
const FIRST_BACKFILL_OFFSET = 2;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface RgBackfillState {
  windowDays: number;
  anchorDate: string;
  doneDates: string[];
  skippedDates: string[];
  attempts: Record<string, number>;
  completedAt: string | null;
}

export function readRgBackfillState(adapterState: Readonly<Record<string, unknown>> | null | undefined): RgBackfillState | null {
  const raw = adapterState?.['rgBackfill'];
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const dates = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string' && DATE_ONLY.test(item)) : [];
  if (typeof value['anchorDate'] !== 'string' || !DATE_ONLY.test(value['anchorDate'])) return null;
  const attempts: Record<string, number> = {};
  if (value['attempts'] && typeof value['attempts'] === 'object') {
    for (const [date, count] of Object.entries(value['attempts'] as Record<string, unknown>)) {
      if (DATE_ONLY.test(date) && typeof count === 'number' && Number.isFinite(count)) attempts[date] = count;
    }
  }
  return {
    windowDays: typeof value['windowDays'] === 'number' ? value['windowDays'] : 0,
    anchorDate: value['anchorDate'],
    doneDates: dates(value['doneDates']),
    skippedDates: dates(value['skippedDates']),
    attempts,
    completedAt: typeof value['completedAt'] === 'string' ? value['completedAt'] : null,
  };
}

export interface RgBackfillPlan {
  state: RgBackfillState;
  /** Bu koşumda işlenecek günler (yeniden eskiye). */
  dates: string[];
}

/** Geri tarama kapalıysa (`windowDays` 0) ya da pencere bittiyse null. */
export function planRgBackfill(
  previous: RgBackfillState | null,
  options: { today: string; windowDays: number; maxDaysPerRun: number },
): RgBackfillPlan | null {
  if (options.windowDays <= 0 || options.maxDaysPerRun <= 0) return null;
  const state: RgBackfillState = previous
    ? { ...previous, doneDates: [...previous.doneDates], skippedDates: [...previous.skippedDates], attempts: { ...previous.attempts } }
    : { windowDays: options.windowDays, anchorDate: options.today, doneDates: [], skippedDates: [], attempts: {}, completedAt: null };
  if (options.windowDays > state.windowDays) {
    state.windowDays = options.windowDays;
    state.completedAt = null;
  }
  if (state.completedAt) return null;
  const finished = new Set([...state.doneDates, ...state.skippedDates]);
  const pending: string[] = [];
  for (let offset = FIRST_BACKFILL_OFFSET; offset <= state.windowDays; offset += 1) {
    const date = addDaysDateOnly(state.anchorDate, -offset);
    if (!finished.has(date)) pending.push(date);
  }
  return { state, dates: pending.slice(0, options.maxDaysPerRun) };
}

/**
 * Gün sonucu: `done` bölüm sonuna kadar gezildi ve yeni PDF'lerin tümü işlendi; `deferred` PDF/zaman
 * bütçesi bitti (hata sayılmaz, sonraki koşumda kaldığı yerden sürer); `failed` bölüm okunamadı.
 */
export type RgBackfillOutcome = 'done' | 'deferred' | 'failed';

/** Koşum sonuçlarını işler: tamamlanan günler `doneDates`'e, tekrar tekrar düşenler `skippedDates`'e. */
export function recordRgBackfill(
  plan: RgBackfillPlan,
  results: readonly { dateOnly: string; outcome: RgBackfillOutcome }[],
  now: Date,
): RgBackfillState {
  const state: RgBackfillState = {
    ...plan.state,
    doneDates: [...plan.state.doneDates],
    skippedDates: [...plan.state.skippedDates],
    attempts: { ...plan.state.attempts },
  };
  for (const result of results) {
    if (result.outcome === 'deferred') continue;
    if (result.outcome === 'done') {
      if (!state.doneDates.includes(result.dateOnly)) state.doneDates.push(result.dateOnly);
      delete state.attempts[result.dateOnly];
      continue;
    }
    const attempts = (state.attempts[result.dateOnly] ?? 0) + 1;
    if (attempts >= RG_BACKFILL_MAX_ATTEMPTS) {
      delete state.attempts[result.dateOnly];
      if (!state.skippedDates.includes(result.dateOnly)) state.skippedDates.push(result.dateOnly);
    } else {
      state.attempts[result.dateOnly] = attempts;
    }
  }
  state.doneDates.sort();
  state.skippedDates.sort();
  const remaining = planRgBackfill(state, { today: state.anchorDate, windowDays: state.windowDays, maxDaysPerRun: 1 });
  if (remaining && remaining.dates.length === 0) state.completedAt = now.toISOString();
  return state;
}

/**
 * Bir koşumda kayıt aşamasında (sınıflandırma/DB) HATA alan ilanların ait olduğu günleri "tamamlandı"
 * kümesinden geri çeker ki gün yeniden taransın. Kullanım: pipeline, adaptör durumunu artık ilan
 * işleme hatası olsa da kalıcılaştırır (eski davranış: tek hata TÜM geri tarama ilerlemesini
 * siliyordu, ilerleme hiç tutmuyordu); yalnızca ilanı kaybolan günler geri alınır.
 *
 * Gün `attempts`'e eklenir (deneme sayısıyla sınırlı): kalıcı bir kayıt hatası günü sonsuza dek
 * yeniden indirtmesin, `MAX_ATTEMPTS` sonrası `skippedDates`'e geçsin.
 */
export function demoteBackfillDates(
  adapterState: Readonly<Record<string, unknown>>,
  failedDates: ReadonlySet<string>,
): Record<string, unknown> {
  if (failedDates.size === 0) return { ...adapterState };
  const state = readRgBackfillState(adapterState);
  if (!state) return { ...adapterState };
  let changed = false;
  const doneDates: string[] = [];
  for (const date of state.doneDates) {
    if (!failedDates.has(date)) {
      doneDates.push(date);
      continue;
    }
    changed = true;
    const attempts = (state.attempts[date] ?? 0) + 1;
    if (attempts >= RG_BACKFILL_MAX_ATTEMPTS) {
      if (!state.skippedDates.includes(date)) state.skippedDates.push(date);
      delete state.attempts[date];
    } else {
      state.attempts[date] = attempts;
    }
  }
  if (!changed) return { ...adapterState };
  state.skippedDates.sort();
  return {
    ...adapterState,
    rgBackfill: { ...state, doneDates, completedAt: null },
  };
}
