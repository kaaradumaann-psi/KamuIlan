/**
 * SMS metni: kısa tutulur (Türkçe karakter UCS-2 kodlamasıyla segment başına ~70 karakter;
 * uzun metin çok segment = çok ücret). Başlık kırpılır, ilan bağlantısı her zaman eklenir.
 */
import type { EmailOutboxDoc } from '../db/schemas';
import type { JobEmailPayload } from '../email/templates';
import { formatDateTr } from '../email/templates';

const MAX_SMS_LENGTH = 320;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function renderSmsText(input: {
  kind: EmailOutboxDoc['kind'];
  payload: JobEmailPayload;
  daysLeft: number | null;
  baseUrl: string;
  senderName: string;
}): string {
  const { payload } = input;
  const link = `${input.baseUrl.replace(/\/+$/, '')}/ilanlar/${encodeURIComponent(payload.jobId)}`;
  const title = clip(`${payload.title} - ${payload.institution}`, 120);
  let head: string;
  if (input.kind === 'deadline-reminder') {
    head =
      input.daysLeft === 0
        ? 'Son başvuru BUGÜN'
        : `Son başvuruya ${input.daysLeft ?? '?'} gün (${formatDateTr(payload.applicationEndDate)})`;
  } else if (input.kind === 'saved-job-update') {
    head = `Takip ettiğiniz ilanda değişiklik${payload.changeSummary ? `: ${clip(payload.changeSummary, 80)}` : ''}`;
  } else if (input.kind === 'test') {
    head = 'Test mesajı';
  } else {
    head = 'Yeni ilan';
  }
  return clip(`${input.senderName}: ${head}. ${title} ${link}`, MAX_SMS_LENGTH);
}
