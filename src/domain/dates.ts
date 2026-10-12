/**
 * Turkish date handling.
 *
 * Rules that the whole system relies on:
 *  - Turkey runs on a fixed UTC+03:00 offset (no DST since 2016). We therefore
 *    convert local wall-clock times using an explicit +03:00 offset instead of
 *    relying on the host machine timezone.
 *  - If a text does not contain an explicit year (and no month+year pair that can
 *    be unambiguously completed) we DO NOT guess a year. We return `null`.
 *  - `dateOnly` ("YYYY-MM-DD" in Istanbul local time) is kept next to the instant
 *    because Turkish announcements define deadlines by calendar day (23:59).
 */

export const ISTANBUL_TZ = 'Europe/Istanbul';
export const TR_OFFSET_MINUTES = 180;
export const TR_OFFSET_ISO = '+03:00';

const MONTHS: Record<string, number> = {
  ocak: 1,
  subat: 2,
  şubat: 2,
  mart: 3,
  nisan: 4,
  mayis: 5,
  mayıs: 5,
  haziran: 6,
  temmuz: 7,
  agustos: 8,
  ağustos: 8,
  eylul: 9,
  eylül: 9,
  ekim: 10,
  kasim: 11,
  kasım: 11,
  aralik: 12,
  aralık: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

export interface ParsedTurkishDate {
  /** ISO-8601 instant with explicit +03:00 offset. */
  iso: string;
  /** Local calendar day in Istanbul time: YYYY-MM-DD. */
  dateOnly: string;
  hadTime: boolean;
  /** The exact substring that was parsed (evidence for the UI). */
  matched: string;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function build(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  hadTime: boolean,
  matched: string,
): ParsedTurkishDate | null {
  if (!isValidDate(year, month, day)) return null;
  if (hour > 23 || minute > 59) return null;
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  return {
    iso: `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${TR_OFFSET_ISO}`,
    dateOnly: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    hadTime,
    matched: matched.trim(),
  };
}

/**
 * Extracts the first explicit Turkish date from free text.
 * Returns `null` when no date with an unambiguous year is present.
 */
export function parseTurkishDate(input: string): ParsedTurkishDate | null {
  if (!input) return null;
  const tokens = findDateTokens(input.replace(/\u00A0/g, ' '));
  return tokens.length > 0 ? (tokens[0] as { parsed: ParsedTurkishDate }).parsed : null;
}

/**
 * Metindeki tüm tarih jetonlarını konumlarıyla birlikte bulur.
 * Sayı biçimi (12.10.2026), ISO (2026-10-12) ve metin biçimi (12 Ekim 2026)
 * desteklenir; saat parantez içinde de olabilir: "14/09/2026 (09:00)".
 */
export function findDateTokens(text: string): { index: number; parsed: ParsedTurkishDate }[] {
  const tokens: { index: number; parsed: ParsedTurkishDate }[] = [];

  const numeric =
    /(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})(?!\d)(?:\s*\(?\s*(?:saat\s*)?(\d{1,2})[:.](\d{2})\s*\)?)?/gi;
  for (const m of text.matchAll(numeric)) {
    const parsed = build(
      Number(m[3]),
      Number(m[2]),
      Number(m[1]),
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      Boolean(m[4]),
      m[0],
    );
    if (parsed) tokens.push({ index: m.index ?? 0, parsed });
  }

  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/g;
  for (const m of text.matchAll(iso)) {
    const parsed = build(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      Boolean(m[4]),
      m[0],
    );
    if (parsed) tokens.push({ index: m.index ?? 0, parsed });
  }

  const textual = new RegExp(
    `(?<!\\d)(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})(?:\\s*\\(?\\s*(?:saat\\s*)?(\\d{1,2})[:.](\\d{2})\\s*\\)?)?`,
    'gi',
  );
  for (const m of text.matchAll(textual)) {
    const month = MONTHS[(m[2] ?? '').toLowerCase()];
    if (!month) continue;
    const parsed = build(
      Number(m[3]),
      month,
      Number(m[1]),
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      Boolean(m[4]),
      m[0],
    );
    if (parsed) tokens.push({ index: m.index ?? 0, parsed });
  }

  return tokens.sort((a, b) => a.index - b.index);
}

/**
 * Türkçe başvuru penceresini ayrıştırır:
 *   "14/09/2026 (09:00) – 24/09/2026 (23:59)"
 *   "12.10.2026 - 26.10.2026"
 *   "12-26 Ekim 2026"                (ortak ay/yıl → aritmetik, tahmin değil)
 *   "2026-10-12 / 2026-10-26"
 * Yıl içermeyen ifadelerden kesin tarih üretilmez.
 */
export function parseTurkishDateRange(input: string): {
  start: ParsedTurkishDate | null;
  end: ParsedTurkishDate | null;
  evidence: string | null;
} {
  if (!input) return { start: null, end: null, evidence: null };
  const text = input.replace(/\u00A0/g, ' ');

  // Ortak ay/yıl: "12-26 Ekim 2026"
  const sharedMonth = new RegExp(
    `(?<!\\d)(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})`,
    'i',
  ).exec(text);
  if (sharedMonth) {
    const month = MONTHS[(sharedMonth[3] ?? '').toLowerCase()];
    if (month) {
      const start = build(Number(sharedMonth[4]), month, Number(sharedMonth[1]), 0, 0, false, sharedMonth[0]);
      const end = build(Number(sharedMonth[4]), month, Number(sharedMonth[2]), 23, 59, false, sharedMonth[0]);
      if (start && end) return { start, end, evidence: sharedMonth[0].trim() };
    }
  }

  const tokens = findDateTokens(text);
  if (tokens.length >= 2) {
    const first = tokens[0] as { index: number; parsed: ParsedTurkishDate };
    const last = tokens[tokens.length - 1] as { index: number; parsed: ParsedTurkishDate };
    // Çok uzak tarihler (örn. yayım ve sınav tarihi) tek pencere sayılmaz.
    if (last.index - first.index <= 240) {
      return {
        start: first.parsed,
        end: last.parsed,
        evidence: text.slice(first.index, Math.min(last.index + 40, text.length)).trim(),
      };
    }
    return { start: first.parsed, end: null, evidence: first.parsed.matched };
  }
  if (tokens.length === 1) {
    const only = tokens[0] as { index: number; parsed: ParsedTurkishDate };
    return { start: only.parsed, end: null, evidence: only.parsed.matched };
  }
  return { start: null, end: null, evidence: null };
}

const DAY_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ISTANBUL_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DT_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ISTANBUL_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** "2026-10-12" in Istanbul local time (sv-SE sorts naturally). */
export function toIstanbulDateOnly(value: Date | string): string {
  return DAY_FORMATTER.format(typeof value === 'string' ? new Date(value) : value);
}

/** "2026-10-12 14:30" in Istanbul local time. */
export function toIstanbulDateTime(value: Date | string): string {
  return DT_FORMATTER.format(typeof value === 'string' ? new Date(value) : value).replace(' ', ' ');
}

const TR_DISPLAY = new Intl.DateTimeFormat('tr-TR', {
  timeZone: ISTANBUL_TZ,
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

const TR_DISPLAY_DT = new Intl.DateTimeFormat('tr-TR', {
  timeZone: ISTANBUL_TZ,
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTrDate(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return TR_DISPLAY.format(date);
}

export function formatTrDateTime(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return TR_DISPLAY_DT.format(date);
}

export function istanbulNow(clock: { now(): Date } = { now: () => new Date() }): Date {
  return clock.now();
}

/** Whole days between two Istanbul calendar days (b - a). */
export function daysBetweenDateOnly(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  if (!ay || !am || !ad || !by || !bm || !bd) return Number.NaN;
  const msA = Date.UTC(ay, am - 1, ad);
  const msB = Date.UTC(by, bm - 1, bd);
  return Math.round((msB - msA) / 86_400_000);
}

export function daysUntil(endDateOnly: string, now: Date = new Date()): number {
  return daysBetweenDateOnly(toIstanbulDateOnly(now), endDateOnly);
}

/** Adds `days` days to a YYYY-MM-DD value in Istanbul local terms. */
export function addDaysDateOnly(value: string, days: number): string {
  const [y, m, d] = value.split('-').map(Number);
  const base = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function toIsoInstant(dateOnly: string, hour = 0, minute = 0): string {
  return `${dateOnly}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${TR_OFFSET_ISO}`;
}
