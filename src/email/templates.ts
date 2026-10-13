/**
 * E-posta şablonları (Türkçe, mobil uyumlu, sade HTML + düz metin).
 *
 * Kurallar:
 *  - Kullanıcıya giden her bağlantı gerçek ve çalışır olmalıdır; uydurma
 *    başvuru bağlantısı gönderilmez. Başvuru bağlantısı kaynakta yoksa
 *    yalnızca resmî ilan bağlantısı verilir.
 *  - Durum dili abartısızdır: sağlayıcı kabul ettiyse "kabul edildi" denir,
 *    "teslim edildi" denmez.
 *  - Şablonlar kullanıcı verisiyle doldurulurken HTML kaçışı uygulanır.
 */
import type { JobDoc } from '../db/schemas';
import { EMPLOYMENT_TYPE_LABELS } from '../domain/types';

export type EmailTemplate =
  'account-invite' | 'verify-email' | 'password-reset' | 'new-job' | 'job-changed' | 'daily-digest' | 'test';

export interface RenderContext {
  baseUrl: string;
  /** Abonelikten çıkma bağlantısı (jeton gönderim anında üretilir). */
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  senderName: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}


export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatter(locale = 'tr-TR'): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Istanbul' });
}

export function formatDateTr(value: string | null | undefined): string {
  if (!value) return 'Belirtilmemiş';
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return formatter().format(new Date(timestamp));
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return formatter().format(new Date(`${value}T00:00:00+03:00`));
  }
  return value;
}

export function formatDateTimeTr(value: string | null | undefined): string {
  if (!value) return 'Belirtilmemiş';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Istanbul',
  }).format(new Date(timestamp));
}

export function formatNumberTr(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Belirtilmemiş';
  return new Intl.NumberFormat('tr-TR').format(value);
}

export interface JobEmailPayload {
  jobId: string;
  title: string;
  institution: string;
  unit?: string | null;
  employmentType: string;
  quota: number | null;
  city: string | null;
  district?: string | null;
  applicationEndDate: string | null;
  applicationEndAt?: string | null;
  publishedAt?: string | null;
  detailUrl: string;
  applicationUrl: string | null;
  matchedOn: string[];
  changeSummary?: string;
  /** İlan kaydedildiyse kullanıcı panelindeki adresi. */
  panelUrl?: string;
}

export function buildJobPayload(
  job: JobDoc,
  options: { matchedOn: string[]; changeSummary?: string; baseUrl: string },
): JobEmailPayload {
  return {
    jobId: job.id,
    title: job.title,
    institution: job.institution,
    unit: job.unit,
    employmentType: job.employmentType,
    quota: job.quota,
    city: job.city,
    district: job.district,
    applicationEndDate: job.applicationEndDate,
    applicationEndAt: job.applicationEndAt,
    publishedAt: job.publishedAt,
    detailUrl: job.detailUrl,
    applicationUrl: job.applicationUrl,
    matchedOn: options.matchedOn,
    ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
    panelUrl: `${options.baseUrl.replace(/\/$/, '')}/ilanlar/${job.id}`,
  };
}

/** Özet satırları (HTML tablo olmadan, liste olarak). */
function summaryRows(payload: JobEmailPayload): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'Kurum', value: payload.institution },
    { label: 'Çalışma biçimi', value: EMPLOYMENT_TYPE_LABELS[payload.employmentType as keyof typeof EMPLOYMENT_TYPE_LABELS] ?? payload.employmentType },
  ];
  if (payload.unit) rows.push({ label: 'Birim', value: payload.unit });
  if (payload.quota !== null && payload.quota !== undefined)
    rows.push({ label: 'Kontenjan', value: formatNumberTr(payload.quota) });
  const place = [payload.city, payload.district]
    .filter((value): value is string => Boolean(value))
    .join(' / ');
  rows.push({ label: 'İl / İlçe', value: place || 'Belirtilmemiş' });
  rows.push({
    label: 'Son başvuru',
    value: payload.applicationEndAt
      ? formatDateTimeTr(payload.applicationEndAt)
      : formatDateTr(payload.applicationEndDate),
  });
  if (payload.publishedAt) rows.push({ label: 'Yayım tarihi', value: formatDateTr(payload.publishedAt) });
  return rows;
}

function renderLayout(input: {
  heading: string;
  intro: string;
  bodyHtml: string;
  bodyText: string;
  ctx: RenderContext;
  /**
   * Alt bilgideki "neden gönderildi" satırı. Bildirim e-postalarında tercih
   * kaydına, işlemsel e-postalarda (davet/doğrulama/şifre sıfırlama) ilgili
   * işleme atıf yapılır: kullanıcıya yanlış gerekçe gösterilmez.
   */
  reason?: string;
}): { html: string; text: string } {
  const { ctx } = input;
  const footerLines = [
    `${ctx.senderName} — kamu personel alım ilanı takip sistemi.`,
    input.reason ?? 'Bu e-posta, bildirim tercihleriniz kaydedildiği için gönderildi.',
  ];
  const footerLinks: string[] = [];
  if (ctx.preferencesUrl)
    footerLinks.push(`<a href="${escapeHtml(ctx.preferencesUrl)}">Bildirim tercihleri</a>`);
  if (ctx.unsubscribeUrl) footerLinks.push(`<a href="${escapeHtml(ctx.unsubscribeUrl)}">Abonelikten çık</a>`);

  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2933;">
  <div style="max-width:600px;margin:0 auto;padding:16px;">
    <div style="background:#0f766e;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0;">
      <div style="font-size:18px;font-weight:600;">${escapeHtml(input.heading)}</div>
    </div>
    <div style="background:#ffffff;padding:20px;border:1px solid #e4e7eb;border-top:none;border-radius:0 0 12px 12px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(input.intro)}</p>
      ${input.bodyHtml}
      <hr style="border:none;border-top:1px solid #e4e7eb;margin:20px 0;" />
      <p style="margin:0;font-size:12px;color:#616e7c;line-height:1.6;">
        ${footerLines.map((line) => escapeHtml(line)).join('<br />')}
        ${footerLinks.length > 0 ? `<br />${footerLinks.join(' &middot; ')}` : ''}
      </p>
    </div>
  </div>
</body>
</html>`;

  const textFooter = [
    '',
    '---',
    ...footerLines,
    ...(ctx.preferencesUrl ? [`Bildirim tercihleri: ${ctx.preferencesUrl}`] : []),
    ...(ctx.unsubscribeUrl ? [`Abonelikten çık: ${ctx.unsubscribeUrl}`] : []),
  ].join('\n');

  return { html, text: `${input.bodyText}${textFooter}` };
}

function jobBodyHtml(payload: JobEmailPayload): string {
  const rows = summaryRows(payload)
    .map(
      (row) =>
        `<li style="margin-bottom:6px;font-size:14px;"><strong>${escapeHtml(row.label)}:</strong> ${escapeHtml(row.value)}</li>`,
    )
    .join('');
  const links = [
    `<a href="${escapeHtml(payload.detailUrl)}" style="color:#0f766e;">Resmî ilan bağlantısı</a>`,
  ];
  if (payload.applicationUrl) {
    links.push(
      `<a href="${escapeHtml(payload.applicationUrl)}" style="color:#0f766e;">Başvuru bağlantısı</a>`,
    );
  }
  if (payload.panelUrl) {
    links.push(`<a href="${escapeHtml(payload.panelUrl)}" style="color:#0f766e;">İlan detay sayfası</a>`);
  }
  return `
    <div style="border:1px solid #e4e7eb;border-radius:10px;padding:14px;margin-bottom:16px;">
      <div style="font-size:16px;font-weight:600;margin-bottom:8px;">${escapeHtml(payload.title)}</div>
      <ul style="margin:0;padding-left:18px;list-style:disc;">
        ${rows}
      </ul>
    </div>
    <p style="margin:0 0 12px;font-size:14px;">${links.join(' &middot; ')}</p>
    ${(payload.matchedOn ?? []).length > 0 ? `<p style="margin:0;font-size:13px;color:#616e7c;">Eşleşme nedeni: ${escapeHtml((payload.matchedOn ?? []).join(', '))}</p>` : ''}
  `;
}

function jobBodyText(payload: JobEmailPayload): string {
  const rows = summaryRows(payload).map((row) => `${row.label}: ${row.value}`);
  const lines = [payload.title, '', ...rows, '', `Resmî ilan: ${payload.detailUrl}`];
  if (payload.applicationUrl) lines.push(`Başvuru bağlantısı: ${payload.applicationUrl}`);
  const matchedOn = payload.matchedOn ?? [];
  if (matchedOn.length > 0) lines.push(`Eşleşme nedeni: ${matchedOn.join(', ')}`);
  return lines.join('\n');
}

/**
 * Konu satırını güvenli hâle getirir.
 *
 * Konu, taranan web içeriğinden (ilan başlığı/kurum adı) gelebilir. Denetim
 * karakterleri (CR/LF) e-posta başlık enjeksiyonuna kapı açar; her taşıyıcıda
 * ayrı ayrı savunma yapmak yerine konu TEK yerde temizlenir. Uzunluk da
 * sınırlanır (başlık taşması).
 */
export function sanitizeSubject(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'Kamuİlan bildirimi';
}

export function renderEmail(
  template: EmailTemplate,
  payload: Record<string, unknown>,
  ctx: RenderContext,
): RenderedEmail {
  const rendered = renderEmailBody(template, payload, ctx);
  return { ...rendered, subject: sanitizeSubject(rendered.subject) };
}

function renderEmailBody(
  template: EmailTemplate,
  payload: Record<string, unknown>,
  ctx: RenderContext,
): RenderedEmail {
  switch (template) {
    case 'verify-email': {
      const link = String(payload['verifyUrl'] ?? '');
      const body = renderLayout({
        heading: 'E-posta adresinizi doğrulayın',
        intro: `${ctx.senderName} bildirimlerini alabilmeniz için e-posta adresinizi doğrulamanız gerekiyor.`,
        bodyHtml: `<p style="margin:0 0 16px;font-size:14px;"><a href="${escapeHtml(link)}" style="background:#0f766e;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;">E-posta adresimi doğrula</a></p>
          <p style="margin:0;font-size:12px;color:#616e7c;word-break:break-all;">Bağlantı çalışmazsa: ${escapeHtml(link)}</p>`,
        bodyText: `E-posta adresinizi doğrulamak için: ${link}`,
        ctx,
        reason: 'Bu e-posta, hesabınızın e-posta adresini doğrulamanız için gönderildi.',
      });
      return { subject: `${ctx.senderName}: e-posta adresinizi doğrulayın`, ...body };
    }
    case 'account-invite': {
      const link = String(payload['inviteUrl'] ?? '');
      const role = String(payload['roleLabel'] ?? 'kullanıcı');
      const body = renderLayout({
        heading: 'Hesabınız açıldı',
        intro: `${ctx.senderName} için bir hesap açıldı (${role}). Aşağıdaki bağlantıdan kendi şifrenizi belirleyin; bağlantı tek kullanımlıktır.`,
        bodyHtml: `<p style="margin:0 0 16px;font-size:14px;"><a href="${escapeHtml(link)}" style="background:#0a84ff;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;">Şifremi belirle</a></p>
          <p style="margin:0;font-size:12px;color:#6e6e73;word-break:break-all;">Bağlantı çalışmazsa: ${escapeHtml(link)}</p>
          <p style="margin:12px 0 0;font-size:12px;color:#6e6e73;">Kamuİlan'da dışarıdan kayıt yoktur; hesaplar yalnızca yönetici tarafından açılır. Bu daveti siz beklemiyorsanız e-postayı yok sayın.</p>`,
        bodyText:
          `Hesabınız açıldı. Şifre belirleme bağlantısı: ${link}\n` +
          "Kamuİlan'da dışarıdan kayıt yoktur; hesaplar yalnızca yönetici tarafından açılır. " +
          'Bu daveti siz beklemiyorsanız e-postayı yok sayın.',
        ctx,
        reason: 'Bu e-posta, yönetici tarafından açılan hesabınız için gönderildi.',
      });
      return { subject: `${ctx.senderName}: hesabınız açıldı — şifre belirleyin`, ...body };
    }
    case 'password-reset': {
      const link = String(payload['resetUrl'] ?? '');
      const body = renderLayout({
        heading: 'Şifre sıfırlama',
        intro:
          'Şifrenizi sıfırlamak için aşağıdaki bağlantıyı kullanın. Bağlantı kısa süre içinde geçersiz olur.',
        bodyHtml: `<p style="margin:0 0 16px;font-size:14px;"><a href="${escapeHtml(link)}" style="background:#0f766e;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;">Yeni şifre belirle</a></p>
          <p style="margin:0;font-size:12px;color:#616e7c;word-break:break-all;">Bağlantı çalışmazsa: ${escapeHtml(link)}</p>
          <p style="margin:12px 0 0;font-size:12px;color:#616e7c;">Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>`,
        bodyText: `Şifre sıfırlama bağlantısı: ${link}`,
        ctx,
        reason:
          'Bu e-posta, şifre sıfırlama isteğiniz üzerine gönderildi. İsteği siz yapmadıysanız yok sayın.',
      });
      return { subject: `${ctx.senderName}: şifre sıfırlama isteği`, ...body };
    }
    case 'new-job':
    case 'job-changed': {
      const job = payload as unknown as JobEmailPayload;
      const heading =
        template === 'new-job' ? 'Yeni kamu personel alım ilanı' : 'Takip ettiğiniz ilanda değişiklik';
      const intro =
        template === 'new-job'
          ? 'Tercihlerinizle eşleşen yeni bir ilan yayımlandı.'
          : `Tercihlerinizle eşleşen bir ilanda güncelleme var${job.changeSummary ? `: ${job.changeSummary}` : '.'}`;
      const body = renderLayout({
        heading,
        intro,
        bodyHtml: jobBodyHtml(job),
        bodyText: jobBodyText(job),
        ctx,
      });
      const subject =
        template === 'new-job'
          ? `${job.title} — ${job.institution}`
          : `Güncelleme: ${job.title} — ${job.institution}`;
      return { subject: subject.slice(0, 180), ...body };
    }
    case 'daily-digest': {
      const jobs = Array.isArray(payload['jobs']) ? (payload['jobs'] as JobEmailPayload[]) : [];
      const count = jobs.length;
      const listHtml = jobs
        .map(
          (job) => `<li style="margin-bottom:10px;font-size:14px;">
            <a href="${escapeHtml(job.detailUrl)}" style="color:#0f766e;font-weight:600;">${escapeHtml(job.title)}</a><br />
            <span style="color:#616e7c;">${escapeHtml(job.institution)} &middot; son başvuru: ${escapeHtml(formatDateTr(job.applicationEndDate))}</span>
          </li>`,
        )
        .join('');
      const body = renderLayout({
        heading: 'Günlük ilan özeti',
        intro: `Tercihlerinizle eşleşen ${formatNumberTr(count)} ilan var.`,
        bodyHtml: `<ul style="margin:0;padding-left:18px;list-style:disc;">${listHtml}</ul>`,
        bodyText: jobs.map((job) => `- ${job.title} (${job.institution}) ${job.detailUrl}`).join('\n'),
        ctx,
      });
      return { subject: `${ctx.senderName} günlük özet: ${formatNumberTr(count)} ilan`, ...body };
    }
    case 'test': {
      const body = renderLayout({
        heading: 'Test e-postası',
        intro: 'Bu e-posta Kamuİlan kurulum doğrulaması için gönderildi.',
        bodyHtml: `<p style="margin:0;font-size:14px;">Sağlayıcı yapılandırması: ${escapeHtml(String(payload['provider'] ?? 'bilinmiyor'))}</p>`,
        bodyText: `Test e-postası. Sağlayıcı: ${String(payload['provider'] ?? 'bilinmiyor')}`,
        ctx,
        reason: 'Bu e-posta, yöneticinin başlattığı kurulum doğrulaması için gönderildi.',
      });
      return { subject: `${ctx.senderName}: test e-postası`, ...body };
    }
    default: {
      const exhaustive: never = template;
      throw new Error(`Bilinmeyen e-posta şablonu: ${String(exhaustive)}`);
    }
  }
}
