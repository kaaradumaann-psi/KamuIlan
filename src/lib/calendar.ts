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

/**
 * Saati METİNDE açıkça yazılmış bitiş anını döndürür (yoksa `null`).
 *
 * Çıkarım motoru saati bilinmeyen tarihlere 00:00 yazar. Bu "gün başı" damgası
 * gerçek bir saat sanılırsa takvim etkinliği yanlış saate kurulur; bu yüzden
 * yalnızca açıkça yazılmış saatler için saatli etkinlik üretilir.
 */
function explicitEndAt(applicationEndAt: string | null): Date | null {
  if (!applicationEndAt || applicationEndAt.includes('T00:00:00')) return null;
  const parsed = new Date(applicationEndAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildDeadlineIcs(job: DeadlineCalendarInput, now: Date = new Date()): string | null {
  if (!job.applicationEndDate) return null;
  const day = job.applicationEndDate.replace(/-/g, '');
  const endAt = explicitEndAt(job.applicationEndAt);
  const summary = escapeIcs(`Son başvuru: ${job.title}`);
  const endLabel = endAt
    ? `${job.applicationEndDate} ${new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        hour: '2-digit',
        minute: '2-digit',
      }).format(endAt)}`
    : job.applicationEndDate;
  const description = escapeIcs(
    `${job.institution}\nSon başvuru: ${endLabel}\nResmî ilan: ${job.detailUrl}\nBaşvuru öncesi koşulları resmî kaynaktan doğrulayın.`,
  );
  const when = endAt
    ? [
        // Saat gerçekten yazılı: etkinlik o saate kurulur (30 dakika sürer).
        `DTSTART:${stamp(endAt)}`,
        `DTEND:${stamp(new Date(endAt.getTime() + 30 * 60_000))}`,
      ]
    : [`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(job.applicationEndDate)}`];
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KamuIlan//Deadline//TR',
    'BEGIN:VEVENT',
    `UID:${job.id}@kamuilan`,
    `DTSTAMP:${stamp(now)}`,
    ...when,
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
