/**
 * Telegram mesaj metinleri (saf fonksiyonlar, HTML parse_mode).
 *
 * Kurallar:
 *  - Her dinamik değer kaçışlanır (ilan başlığı gibi dış veriler HTML enjeksiyonu yapamaz).
 *  - Mesaj Telegram'ın 4096 karakter sınırının altında kalır.
 *  - Bağlantılar yalnızca https olduğunda düğme olur.
 *  - Metinlerdeki kurum adı, ilan başlığı vb. e-posta ile aynı kaynaktan gelir (domain etiketleri).
 */
import { EMPLOYMENT_TYPE_LABELS } from '../domain/types';
import {
  escapeHtml,
  formatDateTimeTr,
  formatDateTr,
  formatNumberTr,
  type JobEmailPayload,
} from '../email/templates';
import type { TelegramButton } from './client';

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_TEXT_LIMIT = 3900;

export function escapeTelegram(value: string): string {
  return escapeHtml(value);
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function httpsOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Outbox kaydındaki serbest biçimli payload'dan ilan verisini güvenle okur. */
export function readJobPayload(raw: Record<string, unknown>): JobEmailPayload | null {
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const jobId = str(raw['jobId']);
  const title = str(raw['title']);
  const institution = str(raw['institution']);
  if (!jobId || !title || !institution) return null;
  return {
    jobId,
    title,
    institution,
    unit: str(raw['unit']),
    employmentType: str(raw['employmentType']) ?? 'other',
    quota: typeof raw['quota'] === 'number' ? raw['quota'] : null,
    city: str(raw['city']),
    district: str(raw['district']),
    applicationEndDate: str(raw['applicationEndDate']),
    applicationEndAt: str(raw['applicationEndAt']),
    publishedAt: str(raw['publishedAt']),
    detailUrl: str(raw['detailUrl']) ?? '',
    applicationUrl: str(raw['applicationUrl']),
    matchedOn: Array.isArray(raw['matchedOn'])
      ? raw['matchedOn'].filter((v): v is string => typeof v === 'string')
      : [],
    changeSummary: str(raw['changeSummary']) ?? undefined,
    ...(typeof raw['daysLeft'] === 'number' ? { daysLeft: raw['daysLeft'] } : {}),
  };
}

export interface RenderedTelegramMessage {
  text: string;
  buttons: TelegramButton[];
}

export function renderJobMessage(input: {
  kind: 'new-job' | 'job-changed' | 'saved-job-update' | 'deadline-reminder';
  payload: JobEmailPayload;
  baseUrl: string;
  senderName: string;
}): RenderedTelegramMessage {
  const { payload, kind } = input;
  const heading =
    kind === 'new-job'
      ? '🆕 <b>Yeni kamu ilanı</b>'
      : kind === 'saved-job-update'
        ? '📌 <b>Takip ettiğiniz ilanda değişiklik</b>'
        : kind === 'deadline-reminder'
          ? payload.daysLeft === 0
            ? '⏰ <b>Son başvuru BUGÜN</b>'
            : `⏰ <b>Son başvuruya ${payload.daysLeft ?? '?'} gün kaldı</b>`
          : '🔄 <b>İlanda değişiklik</b>';
  const employment =
    (EMPLOYMENT_TYPE_LABELS as Record<string, string>)[payload.employmentType] ?? payload.employmentType;
  const place = [payload.city, payload.district].filter(Boolean).join(' / ');
  const deadline = payload.applicationEndAt
    ? formatDateTimeTr(payload.applicationEndAt)
    : formatDateTr(payload.applicationEndDate);

  const lines: string[] = [
    heading,
    '',
    `<b>${escapeTelegram(clip(payload.title, 180))}</b>`,
    '',
    `🏛 Kurum: ${escapeTelegram(clip(payload.institution, 160))}`,
  ];
  if (payload.unit) lines.push(`🏢 Birim: ${escapeTelegram(clip(payload.unit, 160))}`);
  lines.push(`📍 Yer: ${escapeTelegram(clip(place || 'Belirtilmemiş', 120))}`);
  lines.push(`💼 Çalışma biçimi: ${escapeTelegram(employment)}`);
  if (payload.quota !== null && payload.quota !== undefined) {
    lines.push(`🔢 Kontenjan: ${formatNumberTr(payload.quota)}`);
  }
  lines.push(`⏳ Son başvuru: ${escapeTelegram(deadline)}`);
  if (payload.matchedOn.length > 0) {
    lines.push(
      '',
      `🎯 <b>Eşleşme:</b> ${escapeTelegram(clip(payload.matchedOn.slice(0, 5).join(' · '), 300))}`,
    );
  }
  if ((kind === 'job-changed' || kind === 'saved-job-update') && payload.changeSummary) {
    lines.push(`📝 <b>Değişiklik:</b> ${escapeTelegram(clip(payload.changeSummary, 400))}`);
  }
  lines.push('', '⚠️ Başvurmadan önce resmî ilan metnini ve şartlarını kontrol edin.');
  lines.push(`<i>${escapeTelegram(input.senderName)} · bildirimleri durdurmak için /dur yazın</i>`);

  const buttons: TelegramButton[] = [];
  const official = httpsOnly(payload.applicationUrl) ?? httpsOnly(payload.detailUrl);
  if (official) buttons.push({ text: '🌐 Resmî ilan', url: official });
  const portal = httpsOnly(
    `${input.baseUrl.replace(/\/+$/, '')}/ilanlar/${encodeURIComponent(payload.jobId)}`,
  );
  if (portal) buttons.push({ text: '📋 Kamuİlan’da aç', url: portal });

  return { text: clampMessage(lines.join('\n')), buttons };
}

export function renderTestMessage(senderName: string): RenderedTelegramMessage {
  return {
    text: [
      '🧪 <b>Telegram bağlantı testi</b>',
      '',
      `Bu mesaj ${escapeTelegram(senderName)} hesabınıza bağlı sohbete ulaştı.`,
      'Eşleşen yeni ilanlar bu sohbete gönderilecek.',
      '',
      '<i>/dur ile durdurabilir, /basla ile yeniden açabilir, /cik ile bağlantıyı kaldırabilirsiniz.</i>',
    ].join('\n'),
    buttons: [],
  };
}

/** Son güvenlik ağı: sınırı aşan metni kırpar (HTML etiketi ortasında kesmemek için satır bazlı). */
export function clampMessage(text: string): string {
  if (text.length <= SAFE_TEXT_LIMIT) return text;
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    if ((out + line).length > SAFE_TEXT_LIMIT - 1) break;
    out += `${line}\n`;
  }
  return `${out.trimEnd()}\n…`;
}
