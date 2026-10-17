/**
 * E-posta taşıma katmanı.
 *
 * Dört taşıyıcı:
 *  - resend : ÜRETİM (varsayılan). RESEND_API_KEY tanımlıysa HTTPS API kullanılır.
 *  - smtp   : üretim alternatifi. SMTP_HOST tanımlıysa kullanılır (Auth gerekiyorsa kullanıcı/şifre).
 *  - file   : geliştirme. Sağlayıcı ayarı yoksa e-postalar data/mail/ altına
 *             .html/.txt olarak yazılır; böylece hiçbir e-posta gerçek adrese gitmez.
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
import { shouldBlockExternalHttpInTest } from '../lib/offline-network';

/** Testlerde ağ çağrısını kesmek için kullanılan minimal fetch imzası. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    /** Sağlayıcı yönlendirmesi API anahtarını başka host'a taşımasın. */
    redirect?: 'error';
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

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
  readonly key: 'resend' | 'smtp' | 'file' | 'memory';
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

/**
 * Resend (https://resend.com) HTTPS API taşıyıcısı — Kamuİlan'ın üretim yolu.
 *
 * Neden `fetch`: resend SDK'sı ince bir sarmalayıcıdan ibaret; ek bağımlılık
 * yerine Node 22'nin global fetch'i kullanılıyor. Böylece taşıyıcı, ağ çağrısı
 * enjekte edilerek (FetchLike) testlerde tamamen çevrimdışı doğrulanabiliyor.
 *
 * Durum dili: Resend 2xx dönerse "sağlayıcı kabul etti" kaydedilir. Teslim
 * (delivered/bounced) bilgisi bu çağrıdan gelmez; bu yüzden hiçbir yerde
 * "teslim edildi" denmez.
 */
export class ResendEmailTransport implements EmailTransport {
  readonly key = 'resend' as const;
  readonly description: string;
  private readonly endpoint: string;

  constructor(
    private readonly options: {
      apiKey: string;
      from: string;
      baseUrl?: string;
      fetchImpl?: FetchLike;
      timeoutMs?: number;
    },
  ) {
    this.endpoint = `${(options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`;
    this.description = `Resend HTTPS API (${this.endpoint})`;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.options.fetchImpl && shouldBlockExternalHttpInTest(this.endpoint, 'email-provider')) {
      return {
        accepted: false,
        providerMessageId: null,
        providerResponse: null,
        error: 'Vitest offline guard: gerçek e-posta sağlayıcısı çağrısı engellendi.',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    const fetchImpl: FetchLike =
      this.options.fetchImpl ??
      ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
    try {
      const response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        // API anahtarı 30x ile başka host'a taşınmasın.
        redirect: 'error',
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        // Sağlayıcı hatası aynen döndürülür: sessiz yutma yok, kuyruk yeniden dener.
        return {
          accepted: false,
          providerMessageId: null,
          providerResponse: body.slice(0, 500),
          error: `Resend ${response.status}: ${body.slice(0, 300)}`,
        };
      }
      const parsed = parseResendId(body);
      return {
        accepted: true,
        providerMessageId: parsed,
        providerResponse: body.slice(0, 500),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        accepted: false,
        providerMessageId: null,
        providerResponse: null,
        error: `Resend çağrısı başarısız (${maskEmail(message.to)}): ${detail}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Resend yanıtından mesaj kimliğini çıkarır; beklenmeyen gövde hataya yol açmaz. */
export function parseResendId(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      const id = (parsed as { id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * SMTP TLS seçenekleri.
 *
 * Sertifika doğrulaması VARSAYILAN OLARAK AÇIKTIR ve ortamdan bağımsızdır; yalnızca
 * açıkça `SMTP_TLS_INSECURE=1` verilirse kapanır (üretimde bu aynı zamanda başlangıcı
 * durduran bir yapılandırma sorunudur — bkz. `collectEnvironmentProblems`). Eski
 * davranış doğrulamayı geliştirmede kapatıyordu; bu, SMTP kimlik bilgilerini ağdaki
 * ortadaki adama açık bırakıyordu.
 */
export function smtpTlsOptions(env: { SMTP_TLS_INSECURE: boolean } = getEnv()): {
  rejectUnauthorized: boolean;
} {
  return { rejectUnauthorized: !env.SMTP_TLS_INSECURE };
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
        tls: smtpTlsOptions(),
      });
    }
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (shouldBlockExternalHttpInTest(`smtp://${this.options.host}:${this.options.port}`, 'smtp')) {
      return {
        accepted: false,
        providerMessageId: null,
        providerResponse: null,
        error: 'Vitest offline guard: loopback dışındaki SMTP teslimatı engellendi.',
      };
    }
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

export type TransportMode = 'resend' | 'smtp' | 'file';
export type TransportChoice = { transport: EmailTransport; mode: TransportMode; note: string };

/**
 * Taşıyıcı seçimi.
 *  - RESEND_API_KEY varsa: Resend (üretim varsayılanı).
 *  - SMTP_HOST varsa: gerçek SMTP (üretim alternatifi).
 *  - yoksa: dosya taşıyıcısı (geliştirme/test) — hiçbir e-posta gerçek adrese gitmez.
 *  - üretimde hiçbir sağlayıcı yoksa: hata (sessizce e-posta kaybetmek yasak).
 */
export function createEmailTransport(env = getEnv()): TransportChoice {
  if (env.RESEND_API_KEY) {
    return {
      transport: new ResendEmailTransport({
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
        baseUrl: env.RESEND_API_BASE_URL,
      }),
      mode: 'resend',
      note: `Resend API üzerinden gönderim (${maskEmail(env.EMAIL_FROM)}).`,
    };
  }

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
      'Üretimde RESEND_API_KEY ya da SMTP_HOST tanımlı olmalıdır. Aksi halde e-postalar sessizce kaybolur; uygulama başlatılmaz.',
    );
  }

  if (env.EMAIL_DEV_FILE_TRANSPORT) {
    const dir = join(env.DATA_DIR, 'mail');
    return {
      transport: new FileEmailTransport(dir),
      mode: 'file',
      note: `Geliştirme: e-postalar gönderilmez, ${dir} klasörüne yazılır (sağlayıcı anahtarı yok).`,
    };
  }

  return {
    transport: new FileEmailTransport(join(env.DATA_DIR, 'mail')),
    mode: 'file',
    note: 'RESEND_API_KEY/SMTP_HOST tanımlı değil; e-postalar dosyaya yazılıyor.',
  };
}
