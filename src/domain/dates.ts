/**
 * Tarih işleme (Türkçe ilan metinleri).
 *
 * KURALLAR:
 *  - Tarihler Türkiye saatine göre yorumlanır ve ISO-8601 (+03:00) olarak saklanır.
 *  - Yıl içermeyen ifadeden KESİN tarih üretilmez; `null` döner ve çağıran taraf
 *    kullanıcıya "belirtilmemiş" der. Tahmin yürütmek yasaktır.
 *  - Aralık ifadeleri ("20-30 Ekim 2026", "20.10.2026 - 30.10.2026") iki ucu ayrı ayrı verir.
 */

export const ISTANBUL_TIMEZONE = 'Europe/Istanbul';
const TR_OFFSET = '+03:00';

export const TURKISH_MONTHS: Record<string, number> = {
  ocak: 1,
  şubat: 2,
  subat: 2,
  mart: 3,
  nisan: 4,
  mayıs: 5,
  mayis: 5,
  haziran: 6,
  temmuz: 7,
  ağustos: 8,
  agustos: 8,
  eylül: 9,
  eylul: 9,
  ekim: 10,
  kasım: 11,
  kasim: 11,
  aralık: 12,
  aralik: 12,
};

export function isValidDateParts(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** YYYY-MM-DD biçiminde tarih (Türkiye günü). */
export function toDateOnly(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Bir Date'i Türkiye saatine göre YYYY-MM-DD'ye çevirir. */
export function toIstanbulDateOnly(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/** Tarih (YYYY-MM-DD) + saat → Türkiye saatinde ISO dizesi. */
export function toIstanbulIso(dateOnly: string, time = '00:00'): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) throw new Error(`Geçersiz tarih: ${dateOnly}`);
  const normalizedTime = /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '00:00';
  return `${dateOnly}T${normalizedTime}:00${TR_OFFSET}`;
}

export function addDaysDateOnly(dateOnly: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) throw new Error(`Geçersiz tarih: ${dateOnly}`);
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  const date = new Date(base);
  return toDateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function diffInDays(fromDateOnly: string, toDateOnlyValue: string): number {
  const from = Date.parse(`${fromDateOnly}T00:00:00${TR_OFFSET}`);
  const to = Date.parse(`${toDateOnlyValue}T00:00:00${TR_OFFSET}`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((to - from) / 86_400_000);
}

/** Yayımından bu kadar gün sonra, son başvuru tarihi yoksa ilan "kapalı" sayılır. */
export const STALE_PUBLICATION_DAYS = 60;

/** Yayım tarihini (YYYY-MM-DD ya da ISO) güvenli biçime indirir; gelecek tarih ya da bozuk değer null. */
export function sanePublishedDate(value: string | null | undefined, todayDateOnly: string): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!match?.[1]) return null;
  const dateOnly = match[1];
  if (!isValidDateParts(Number(dateOnly.slice(0, 4)), Number(dateOnly.slice(5, 7)), Number(dateOnly.slice(8, 10)))) {
    return null;
  }
  // Bugünden sonraki yayım tarihi bir veri hatasıdır (ör. 12 Kasım, bugün 14 Ekim).
  if (dateOnly > todayDateOnly) return null;
  return dateOnly;
}

/** Yayımından maxAgeDays günden fazla geçmiş mi? Yayım tarihi yoksa bilinmez → false. */
export function isStalePublication(
  publishedDate: string | null | undefined,
  todayDateOnly: string,
  maxAgeDays = STALE_PUBLICATION_DAYS,
): boolean {
  if (!publishedDate) return false;
  const age = diffInDays(publishedDate, todayDateOnly);
  return Number.isFinite(age) && age > maxAgeDays;
}

export type DeadlineState = 'open' | 'closing-soon' | 'closed' | 'unknown';

/** Son başvuru tarihine göre durum (3 gün ve altı "kapanıyor"). */
export function deadlineState(applicationEndDate: string | null, now: Date, closingSoonDays = 3): DeadlineState {
  if (!applicationEndDate) return 'unknown';
  const today = toIstanbulDateOnly(now);
  const remaining = diffInDays(today, applicationEndDate);
  if (Number.isNaN(remaining)) return 'unknown';
  if (remaining < 0) return 'closed';
  if (remaining <= closingSoonDays) return 'closing-soon';
  return 'open';
}

export interface ParsedTurkishDate {
  /** YYYY-MM-DD (Türkiye günü). */
  dateOnly: string;
  /** HH:mm varsa; yoksa null. */
  time: string | null;
  /** Metindeki özgün ifade (kanıt olarak saklanır). */
  raw: string;
  /** ISO-8601 (+03:00). Saat yoksa 00:00 kabul edilir ve `timeIsDefault` true olur. */
  iso: string;
  timeIsDefault: boolean;
}

interface DateCandidate {
  year: number;
  month: number;
  day: number;
  raw: string;
  index: number;
  time: string | null;
}

const NUMERIC_DATE = /(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?!\d)/g;
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
/** "20-30 Ekim 2026" / "20 – 30 Ekim 2026": ay ve yıl ortaktır. */
const SHARED_MONTH_RANGE =
  /(?<!\d)(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s+(\d{4})(?!\d)/gi;
const TEXT_DATE =
  /(?<!\d)(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)(?:\s+(\d{4}))?(?!\d)/gi;
const TIME_IN_TEXT = /(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)/g;

/**
 * Tarih jetonunun DIŞINDA kalan en yakın saat ifadesini bulur.
 *
 * Aksi halde "20.10.2026" içindeki "20.10" saat sanılır. Aranan aralık, komşu
 * tarih jetonlarıyla sınırlanır; böylece bir tarihin saati başka tarihe yazılmaz.
 * Öncelik: tarihten SONRA gelen "saat" ifadesi > sonra gelen saat > önceki saat.
 */
function timeOutside(
  text: string,
  start: number,
  end: number,
  leftBound: number,
  rightBound: number,
): string | null {
  const from = Math.max(0, leftBound);
  const to = Math.min(text.length, rightBound);
  const slice = text.slice(from, to);
  let best: { time: string; score: number } | null = null;

  for (const match of slice.matchAll(TIME_IN_TEXT)) {
    const absoluteStart = from + (match.index ?? 0);
    const absoluteEnd = absoluteStart + match[0].length;
    if (absoluteStart < end && absoluteEnd > start) continue; // tarih jetonunun içinde
    // Başka bir tarih jetonunun parçası mı? (dd.mm.yyyy içindeki "mm.yyyy")
    const around = text.slice(Math.max(0, absoluteStart - 4), Math.min(text.length, absoluteEnd + 6));
    if (/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.test(around)) continue;

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;

    const after = absoluteStart >= end;
    const before = match.index ?? 0;
    const preceding = slice.slice(Math.max(0, before - 7), before).toLocaleLowerCase('tr');
    const hasSaat = /saat\s*$/.test(preceding);
    const distance = after ? absoluteStart - end : start - absoluteEnd;
    const score = (hasSaat ? 200 : 0) + (after ? 100 : 0) - distance;
    const time = `${pad(hour)}:${pad(minute)}`;
    if (!best || score > best.score) best = { time, score };
  }
  return best?.time ?? null;
}

export function findDateCandidates(text: string): DateCandidate[] {
  interface Span {
    year: number;
    month: number;
    day: number;
    raw: string;
    index: number;
    end: number;
  }
  const spans: Span[] = [];

  const pushSpan = (year: number, month: number, day: number, raw: string, index: number) => {
    if (!isValidDateParts(year, month, day)) return;
    spans.push({ year, month, day, raw, index, end: index + raw.length });
  };

  for (const match of text.matchAll(SHARED_MONTH_RANGE)) {
    const month = TURKISH_MONTHS[(match[3] ?? '').toLocaleLowerCase('tr')];
    const year = Number(match[4]);
    if (!month) continue;
    const index = match.index ?? 0;
    pushSpan(year, month, Number(match[1]), match[0], index);
    pushSpan(year, month, Number(match[2]), match[0], index);
  }
  for (const match of text.matchAll(ISO_DATE)) {
    pushSpan(Number(match[1]), Number(match[2]), Number(match[3]), match[0], match.index ?? 0);
  }
  for (const match of text.matchAll(NUMERIC_DATE)) {
    // Türkiye'de gg.aa.yyyy kullanılır; 13.10.2026 gibi ifadeler doğrudan geçerlidir.
    pushSpan(Number(match[3]), Number(match[2]), Number(match[1]), match[0], match.index ?? 0);
  }
  for (const match of text.matchAll(TEXT_DATE)) {
    const monthName = (match[2] ?? '').toLocaleLowerCase('tr');
    const month = TURKISH_MONTHS[monthName];
    const year = match[3] ? Number(match[3]) : Number.NaN;
    if (!month || !Number.isFinite(year)) continue; // yıl yoksa atla
    pushSpan(year, month, Number(match[1]), match[0], match.index ?? 0);
  }

  const ordered = spans.sort((a, b) => a.index - b.index || a.day - b.day);
  const unique: Span[] = [];
  for (const span of ordered) {
    const duplicate = unique.some(
      (kept) =>
        (kept.index === span.index && kept.day === span.day && kept.month === span.month && kept.year === span.year) ||
        kept.raw === span.raw,
    );
    if (!duplicate) unique.push(span);
  }

  // Saat aramasının komşu tarih jetonlarına taşmaması için sınırlar hesaplanır.
  return unique
    .sort((a, b) => a.index - b.index)
    .map((span, position, list) => {
      const previous = position > 0 ? list[position - 1] : undefined;
      const next = position < list.length - 1 ? list[position + 1] : undefined;
      const leftBound = previous ? previous.end : Math.max(0, span.index - 25);
      const rightBound = next ? next.index : Math.min(text.length, span.end + 35);
      return {
        year: span.year,
        month: span.month,
        day: span.day,
        raw: span.raw,
        index: span.index,
        time: timeOutside(text, span.index, span.end, leftBound, rightBound),
      };
    });
}

/** Metinden ilk tarihi Türkçe kurallarla çözer. */
export function parseTurkishDate(text: string): ParsedTurkishDate | null {
  const candidate = findDateCandidates(text)[0];
  if (!candidate) return null;
  const dateOnly = toDateOnly(candidate.year, candidate.month, candidate.day);
  return {
    dateOnly,
    time: candidate.time,
    raw: candidate.raw,
    iso: toIstanbulIso(dateOnly, candidate.time ?? '00:00'),
    timeIsDefault: candidate.time === null,
  };
}

export interface TurkishDateRange {
  start: ParsedTurkishDate | null;
  end: ParsedTurkishDate | null;
  /** Aralığın metindeki özgün ifadesi. */
  raw: string | null;
}

const RANGE_SEPARATORS = /\b(?:ile|arasında|arasinda|ve|-|–|—|ile\s+bitiş|'?\s*den|'?\s*dan)\b/i;

/**
 * "20.10.2026 - 30.10.2026", "20-30 Ekim 2026", "20 Ekim 2026 ile 30 Ekim 2026" gibi
 * ifadeleri çözer. İlk tarih başlangıç, ikinci tarih bitiş kabul edilir.
 */
export function parseTurkishDateRange(text: string): TurkishDateRange {
  const candidates = findDateCandidates(text);
  if (candidates.length === 0) return { start: null, end: null, raw: null };

  const toParsed = (candidate: DateCandidate): ParsedTurkishDate => {
    const dateOnly = toDateOnly(candidate.year, candidate.month, candidate.day);
    return {
      dateOnly,
      time: candidate.time,
      raw: candidate.raw,
      iso: toIstanbulIso(dateOnly, candidate.time ?? '00:00'),
      timeIsDefault: candidate.time === null,
    };
  };

  if (candidates.length === 1) {
    const start = candidates[0];
    const single = start ? toParsed(start) : null;
    // Tek tarih varsa "son başvuru" gibi ifadeler bitiş kabul edilir (çağıran karar verir).
    return { start: single, end: single, raw: single?.raw ?? null };
  }

  const first = candidates[0];
  const second = candidates[1];
  if (!first || !second) return { start: null, end: null, raw: null };

  const between = text.slice(first.index, second.index);
  const hasSeparator = RANGE_SEPARATORS.test(between) || /[-–—]/.test(between);
  if (!hasSeparator) {
    return { start: toParsed(first), end: toParsed(second), raw: `${first.raw} … ${second.raw}` };
  }
  return { start: toParsed(first), end: toParsed(second), raw: text.slice(first.index, second.index + second.raw.length).trim() };
}

/** Metinde geçen ilk tarihi YYYY-MM-DD olarak döner (yoksa null). */
export function firstDateOnlyIn(text: string): string | null {
  return parseTurkishDate(text)?.dateOnly ?? null;
}

/** İnsan okur Türkçe biçim (arayüz/panel). */
export function formatDateTr(dateOnly: string | null, withTime?: string | null): string {
  if (!dateOnly) return 'Belirtilmemiş';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return 'Belirtilmemiş';
  const date = new Date(`${dateOnly}T00:00:00${TR_OFFSET}`);
  const formatted = new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: ISTANBUL_TIMEZONE,
  }).format(date);
  return withTime ? `${formatted} ${withTime}` : formatted;
}
