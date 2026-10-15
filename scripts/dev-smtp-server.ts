/**
 * Geliştirme posta sunucusu: `npm run dev:smtp`
 *
 * - SMTP dinler (varsayılan 0.0.0.0:1025) ve gelen postaları diske yazar.
 * - Aynı süreçte küçük bir görüntüleyici HTTP sunar (varsayılan 1080):
 *     GET /            → gelen kutusu listesi
 *     GET /mail/:id    → e-postanın HTML gövdesi
 * - Üretimde KULLANILMAZ: gerçek gönderim SMTP_HOST ile yapılır (docs/setup.md).
 *
 * Neden var: bildirim hattını (outbox → transport → sağlayıcı) gerçekten
 * gözlemlemek için. Hiçbir dış servis/hesap gerekmez.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { getEnv } from '../src/config/env';
import { maskEmail } from '../src/domain/text';
// MIME çözümleme ortak modülden gelir: e-posta teslim testi de aynı kodu ölçer.
import { decodeMimeWords, escapeHtml, parseMessage } from '../src/lib/mime';

const env = getEnv();
const MAIL_DIR = resolve(env.DATA_DIR, 'mailbox');
mkdirSync(MAIL_DIR, { recursive: true });

interface StoredMail {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  raw: string;
}

function renderIndex(mails: StoredMail[]): string {
  const rows = mails
    .map(
      (mail) => `<tr>
        <td>${escapeHtml(mail.receivedAt)}</td>
        <td>${escapeHtml(maskEmail(mail.to))}</td>
        <td><a href="/mail/${encodeURIComponent(mail.id)}">${escapeHtml(mail.subject)}</a></td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Kamuİlan geliştirme posta kutusu</title>
  <style>body{font-family:system-ui,sans-serif;margin:24px;color:#1f2933}h1{font-size:20px}
  table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e4e7eb;padding:8px;text-align:left;font-size:14px}
  .note{background:#fff8e1;padding:10px;border-radius:8px;font-size:13px;margin-bottom:16px}</style></head>
  <body><h1>Geliştirme posta kutusu</h1>
  <p class="note">Bu sunucu yalnızca geliştirme içindir. Mesajlar yerel diske (${escapeHtml(MAIL_DIR)}) yazılır;
  "teslim edildi" bilgisi vermez, yalnızca gönderilen iletiyi gösterir.</p>
  <table><thead><tr><th>Zaman</th><th>Alıcı</th><th>Konu</th></tr></thead><tbody>${rows || '<tr><td colspan="3">Posta yok.</td></tr>'}</tbody></table>
  </body></html>`;
}

function listMails(): StoredMail[] {
  return readdirSync(MAIL_DIR)
    .filter((file) => file.endsWith('.eml'))
    .sort()
    .reverse()
    .slice(0, 200)
    .map((file) => {
      const raw = readFileSync(join(MAIL_DIR, file), 'utf8');
      const parsed = parseMessage(raw);
      const [id = ''] = file.split('.');
      return {
        id,
        from: decodeMimeWords(parsed.headers['from'] ?? ''),
        to: decodeMimeWords(parsed.headers['to'] ?? ''),
        subject: decodeMimeWords(parsed.headers['subject'] ?? '(konu yok)'),
        receivedAt: `${(file.split('msg-')[1] ?? '').slice(0, 19).replace(/-/g, ':')}`,
        raw,
      };
    });
}

const smtpPort = env.SMTP_PORT;
const viewerPort = env.DEV_MAIL_VIEWER_PORT;

const smtpServer = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS', 'AUTH'],
  onData(stream, _session, callback) {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', callback);
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = parseMessage(raw);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = `msg-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
      const file = join(MAIL_DIR, `${id}.eml`);
      writeFileSync(file, raw, 'utf8');
      console.log(
        `[dev-smtp] posta alındı: ${maskEmail(parsed.headers['to'] ?? '')} | konu: ${decodeMimeWords(parsed.headers['subject'] ?? '(yok)')} | ${file}`,
      );
      callback();
    });
  },
});

smtpServer.listen(smtpPort, env.HOST, () => {
  console.log(`[dev-smtp] SMTP dinliyor: ${env.HOST}:${smtpPort} (kimlik doğrulama istenmez, yalnızca geliştirme)`);
});

smtpServer.on('error', (error) => {
  console.error(`[dev-smtp] SMTP hatası: ${error.message}`);
});

const viewer = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const mails = listMails();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderIndex(mails));
    return;
  }
  const mailMatch = /^\/mail\/(.+)$/.exec(url.pathname);
  if (mailMatch?.[1]) {
    const id = decodeURIComponent(mailMatch[1]);
    const mail = listMails().find((candidate) => candidate.id === id);
    if (!mail) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Posta bulunamadı.');
      return;
    }
    const parsed = parseMessage(mail.raw);
    const body =
      parsed.html ||
      `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(parsed.text || '(gövde yok)')}</pre>`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(parsed.headers['subject'] ?? 'Posta')}</title></head>
      <body style="font-family:system-ui,sans-serif;margin:24px">
      <h1 style="font-size:18px">${escapeHtml(decodeMimeWords(parsed.headers['subject'] ?? '(konu yok)'))}</h1>
      <p style="font-size:13px;color:#616e7c">Alıcı: ${escapeHtml(maskEmail(parsed.headers['to'] ?? ''))} · Gönderen: ${escapeHtml(parsed.headers['from'] ?? '')}</p>
      <hr>${body}</body></html>`);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Bulunamadı');
});

viewer.listen(viewerPort, env.HOST, () => {
  console.log(`[dev-smtp] görüntüleyici: http://${env.HOST}:${viewerPort} (geliştirme posta kutusu)`);
});

const shutdown = (): void => {
  console.log('[dev-smtp] kapatılıyor…');
  viewer.close();
  // Açık bir SMTP bağlantısı `close` geri çağrısını geciktirebilir; Ctrl+C
  // sonrasında süreç askıda kalmasın diye sınırlı bir zorla çıkış bekletilir.
  const forceExit = setTimeout(() => process.exit(0), 2_000);
  forceExit.unref();
  smtpServer.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
