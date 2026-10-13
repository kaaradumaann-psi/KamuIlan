/**
 * Son başvuru günü için takvim (.ics) dosyası üretimi.
 *
 * Dosya yalnızca ilanın gerçek alanlarından üretilir: son başvuru tarihi
 * yoksa dosya da yoktur (tarih uydurulmaz). Saat belirtilmemişse tüm gün
 * etkinliği oluşturulur.
 */

export interface DeadlineCalendarInput {
  id: string;
  title: string;
  institution: string;
  applicationEndDate: string | null;
  applicationEndAt: string | null;
  detailUrl: string;
}

function escapeIcs(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** `YYYY-MM-DD` → ertesi gün `YYYYMMDD` (tüm gün etkinliğinin bitişi). */
function nextDay(dateOnly: string): string {
  const base = new Date(`${dateOnly}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString().slice(0, 10).replace(/-/g, '');
}

export function buildDeadlineIcs(job: DeadlineCalendarInput, now: Date = new Date()): string | null {
  if (!job.applicationEndDate) return null;
  const day = job.applicationEndDate.replace(/-/g, '');
  const summary = escapeIcs(`Son başvuru: ${job.title}`);
  const description = escapeIcs(
    `${job.institution}\nSon başvuru: ${job.applicationEndDate}\nResmî ilan: ${job.detailUrl}\nBaşvuru öncesi koşulları resmî kaynaktan doğrulayın.`,
  );
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KamuIlan//Deadline//TR',
    'BEGIN:VEVENT',
    `UID:${job.id}@kamuilan`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${nextDay(job.applicationEndDate)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `URL:${job.detailUrl}`,
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    `DESCRIPTION:${summary}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Takvim dosyasını tarayıcıda indirir. */
export function downloadDeadlineIcs(job: DeadlineCalendarInput): boolean {
  const ics = buildDeadlineIcs(job);
  if (!ics) return false;
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `kamuilan-son-basvuru-${job.id}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
