/**
 * E-posta taşıma katmanı.
 *
 * Üç taşıyıcı:
 *  - smtp   : üretim. SMTP_HOST tanımlıysa kullanılır (Auth gerekiyorsa kullanıcı/şifre).
 *  - file   : geliştirme. SMTP ayarı yoksa ve EMAIL_DEV_FILE_TRANSPORT=1 ise
 *             e-postalar data/mail/ altına .html/.txt olarak yazılır; böylece
 *             hiçbir e-posta gerçek adrese gitmez.
 *  - memory : testler için.
 *
 * Durum dili: taşıyıcı yalnızca "sağlayıcı mesajı kabul etti" bilgisini döner.
 * "Teslim edildi" iddiası hiçbir yerde üretilmez.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '../config/env';
import { maskEmail } from '../domain/text';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Ek bilgi (loglama/iz sürme). */
  template: string;
}

export interface EmailSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  providerResponse: string | null;
  error?: string;
}

export interface EmailTransport {
  readonly key: 'smtp' | 'file' | 'memory';
  readonly description: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
  close?(): Promise<void>;
}

export class FileEmailTransport implements EmailTransport {
  readonly key = 'file' as const;
  readonly description: string;

  constructor(private readonly directory: string) {
    this.description = `Geliştirme dosya taşıyıcısı (${directory}) — e-posta gönderilmez, dosyaya yazılır.`;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    mkdirSync(this.directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = message.to.replace(/[^a-z0-9.@+-]/gi, '_');
    const base = join(this.directory, `${stamp}__${safeTo}`);
    writeFileSync(`${base}.html`, message.html, 'utf8');
    writeFileSync(
      `${base}.txt`,
      `To: ${message.to}\nSubject: ${message.subject}\nTemplate: ${message.template}\n\n${message.text}`,
      'utf8',
    );
    return {
      accepted: true,
      providerMessageId: `file:${base}`,
      providerResponse: `Yerel dosyaya yazıldı (${maskEmail(message.to)}).`,
    };
  }
}

export class SmtpEmailTransport implements EmailTransport {
  readonly key = 'smtp' as const;
  readonly description: string;
  private transporter: Transporter | null = null;

  constructor(private readonly options: { host: string; port: number; secure: boolean; user: string; pass: string; from: string }) {
    this.description = `SMTP (${options.host}:${options.port}, secure=${options.secure})`;
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.options.host,
        port: this.options.port,
        secure: this.options.secure,
        ...(this.options.user ? { auth: { user: this.options.user, pass: this.options.pass } } : {}),
        // Yavaş/erişilemez SMTP sunucusu worker'ı kilitlemesin.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        tls: { rejectUnauthorized: getEnv().NODE_ENV === 'production' },
      });
    }
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.getTransporter().sendMail({
        from: this.options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
      return {
        accepted,
        providerMessageId: info.messageId ?? null,
        providerResponse: typeof info.response === 'string' ? info.response.slice(0, 300) : null,
        ...(accepted ? {} : { error: 'Sağlayıcı alıcıyı kabul etmedi.' }),
      };
    } catch (error) {
      return {
        accepted: false,
        providerMessageId: null,
        providerResponse: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }
}

export class MemoryEmailTransport implements EmailTransport {
  readonly key = 'memory' as const;
  readonly description = 'Bellek içi test taşıyıcısı';
  readonly sent: EmailMessage[] = [];
  private failures = 0;

  constructor(options: { failuresBeforeSuccess?: number } = {}) {
    this.failures = options.failuresBeforeSuccess ?? 0;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      return {
        accepted: false,
        providerMessageId: null,
        providerResponse: null,
        error: 'Geçici SMTP hatası (test)',
      };
    }
    this.sent.push(message);
    return {
      accepted: true,
      providerMessageId: `memory:${this.sent.length}`,
      providerResponse: 'Test taşıyıcısı kabul etti.',
    };
  }
}

export type TransportChoice = { transport: EmailTransport; mode: 'smtp' | 'file'; note: string };

/**
 * Taşıyıcı seçimi.
 *  - SMTP_HOST varsa: gerçek SMTP (üretim).
 *  - yoksa ve dosya taşıyıcısı açıksa: dosya (geliştirme).
 *  - üretimde SMTP yoksa: hata (sessizce e-posta kaybetmek yasak).
 */
export function createEmailTransport(env = getEnv()): TransportChoice {
  if (env.SMTP_HOST) {
    return {
      transport: new SmtpEmailTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.EMAIL_FROM,
      }),
      mode: 'smtp',
      note: `SMTP: ${env.SMTP_HOST}:${env.SMTP_PORT}`,
    };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Üretimde SMTP_HOST tanımlı olmalıdır. Aksi halde e-postalar sessizce kaybolur; uygulama başlatılmaz.',
    );
  }

  if (env.EMAIL_DEV_FILE_TRANSPORT) {
    const dir = join(env.DATA_DIR, 'mail');
    return {
      transport: new FileEmailTransport(dir),
      mode: 'file',
      note: `Geliştirme: e-postalar gönderilmez, ${dir} klasörüne yazılır (MailHog yerine).`,
    };
  }

  return {
    transport: new FileEmailTransport(join(env.DATA_DIR, 'mail')),
    mode: 'file',
    note: 'SMTP tanımlı değil; e-postalar dosyaya yazılıyor.',
  };
}
