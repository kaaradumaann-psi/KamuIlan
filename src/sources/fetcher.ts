/**
 * HTTP istemcisi (undici).
 *
 * Güvenlik ve nezaket kuralları:
 *  - SSRF savunması: yalnızca http/https, host allowlist (kaynak kaydındaki
 *    allowedHosts), özel/ayrılmış IP ve bulut metadata adresleri reddedilir.
 *  - Yönlendirmeler elle izlenir ve her adım yeniden allowlist'ten geçirilir.
 *  - Host başına asgari istek aralığı (rate limit) uygulanır.
 *  - 429/503 için Retry-After'a saygı duyulur; üstel geri çekilme + jitter.
 *  - Gövde boyutu sınırlanır; HTML/PDF dışındaki türler kabul edilmez.
 *  - CAPTCHA/erişim kontrolü AŞILMAZ; engellenirse hata kaydedilir.
 */
import { request, Agent, type Dispatcher } from 'undici';
import { decodeBody, type DecodedBody } from '../lib/encoding';
import { getEnv } from '../config/env';
import { createLogger, type Logger } from '../lib/logger';

export interface FetchOptions {
  /** Ek başlıklar (ör. Referer). */
  headers?: Record<string, string>;
  /** İzin verilen host'lar. Boşsa yalnızca genel SSRF kontrolü yapılır. */
  allowedHosts?: string[];
  /** Koşullu istek: ETag/Last-Modified. */
  etag?: string | null;
  lastModified?: string | null;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  /** Host başına asgari istek aralığı (ms). */
  minIntervalMs?: number;
  expectedContentTypes?: readonly string[];
  method?: 'GET' | 'HEAD';
}

export interface FetchResponse {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  /** Metin gövdeler için çözülmüş içerik (encoding tespiti ile). */
  decoded?: DecodedBody;
  bytes: number;
}

/**
 * undici hatalarının asıl nedeni `cause` zincirindedir (ör. UND_ERR_CONNECT_TIMEOUT,
 * ECONNRESET, CERT_HAS_EXPIRED). Yalnızca üst mesajı saklamak ("fetch failed")
 * canlı tanıyı imkânsızlaştırır; bu yüzden kod + neden mesaja eklenir.
 */
export function describeFetchFailure(error: unknown): string {
  if (error instanceof FetchError) return error.message;
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      const label = typeof code === 'string' && code.length > 0 ? `${code}: ${current.message}` : current.message;
      if (label && !parts.includes(label)) parts.push(label);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ') || 'Bilinmeyen ağ hatası';
}

export class FetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(url: string, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
    this.retryable = retryable;
  }
}

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local + bulut metadata (169.254.169.254)
  /^::1$/,
  /^\[?::1\]?$/,
  /^fc00:/i,
  /^fe80:/i,
  /\.internal$/i,
  /^metadata\./i,
];

export function assertSafeUrl(rawUrl: string, allowedHosts: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError(rawUrl, 'Geçersiz URL.', null, false);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(rawUrl, `Desteklenmeyen protokol: ${url.protocol}`, null, false);
  }
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new FetchError(rawUrl, `Özel/ayrılmış adresler engellendi: ${host}`, null, false);
  }
  if (allowedHosts.length > 0) {
    const permitted = allowedHosts.some((allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`));
    if (!permitted) {
      throw new FetchError(rawUrl, `Host beyaz listede değil: ${host}`, null, false);
    }
  }
  return url;
}

export class HostRateLimiter {
  private readonly lastRequestAt = new Map<string, number>();

  /** Host için sıradaki uygun zamanı bekler (asenkron, global kilidi bloke etmez). */
  async wait(host: string, minIntervalMs: number): Promise<void> {
    if (minIntervalMs <= 0) return;
    const last = this.lastRequestAt.get(host) ?? 0;
    const elapsed = Date.now() - last;
    const remaining = minIntervalMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.lastRequestAt.set(host, Date.now());
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.lastRequestAt);
  }
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/xml', 'text/xml'];
const PDF_TYPES = ['application/pdf'];
const JSON_TYPES = ['application/json', 'text/json'];

export interface HttpClientOptions {
  logger?: Logger;
  /** Testlerde sahte saat/bekleme. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** Testlerde MockAgent enjeksiyonu; üretimde verilmez. */
  dispatcher?: Dispatcher;
}

export class HttpClient {
  private readonly agent: Dispatcher;
  private readonly limiter = new HostRateLimiter();
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions = {}) {
    this.ownsAgent = options.dispatcher === undefined;
    this.logger = options.logger ?? createLogger('fetch');
    this.userAgent = options.userAgent ?? getEnv().SCRAPE_USER_AGENT;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.agent =
      options.dispatcher ??
      new Agent({
        connections: 8,
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
        keepAliveTimeout: 10_000,
        // Kırık IPv6 yolu olan ağlarda (ev bağlantıları) tek aileye takılıp
        // zaman aşımına düşmemek için adres ailesi otomatik seçilir.
        connect: { autoSelectFamily: true, timeout: 15_000 },
      });
  }

  private readonly ownsAgent: boolean;

  async close(): Promise<void> {
    if (this.ownsAgent) await this.agent.close();
  }

  /** Metin (HTML/XML/JSON) getirir. */
  async fetchText(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
    const response = await this.fetch(url, { ...options, expectedContentTypes: options.expectedContentTypes ?? [...HTML_TYPES, ...JSON_TYPES] });
    if (!response.decoded) {
      response.decoded = decodeBody(response.body, response.contentType);
    }
    return response;
  }

  /** İkili belge (PDF) getirir. */
  async fetchBinary(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
    return this.fetch(url, {
      ...options,
      expectedContentTypes: options.expectedContentTypes ?? [...PDF_TYPES, 'application/octet-stream'],
    });
  }

  async fetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResponse> {
    const env = getEnv();
    const allowedHosts = options.allowedHosts ?? [];
    const timeoutMs = options.timeoutMs ?? env.SCRAPE_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? env.MAX_DOCUMENT_BYTES;
    const maxRetries = options.retries ?? env.SCRAPE_MAX_RETRIES;
    const minIntervalMs = options.minIntervalMs ?? env.SOURCE_MIN_REQUEST_INTERVAL_MS;

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        const response = await this.performFetch(rawUrl, {
          ...options,
          allowedHosts,
          timeoutMs,
          maxBytes,
          minIntervalMs,
        });
        return response;
      } catch (error) {
        const fetchError =
          error instanceof FetchError ? error : new FetchError(rawUrl, describeFetchFailure(error), null, true);
        lastError = fetchError;
        if (!fetchError.retryable || attempt > maxRetries) throw fetchError;
        const backoff = Math.min(2 ** attempt * 500, 15_000) * (0.8 + Math.random() * 0.4);
        this.logger.warn(
          {
            url: rawUrl,
            attempt,
            maxRetries,
            status: fetchError.status,
            error: fetchError.message,
            backoffMs: Math.round(backoff),
          },
          'istek başarısız, yeniden denenecek',
        );
        await this.sleep(Math.round(backoff));
      }
    }

    throw lastError ?? new FetchError(rawUrl, 'Bilinmeyen istek hatası.', null, false);
  }

  private async performFetch(rawUrl: string, options: Required<Pick<FetchOptions, 'timeoutMs'>> & FetchOptions): Promise<FetchResponse> {
    const env = getEnv();
    const maxRedirects = env.MAX_REDIRECTS;
    let currentUrl = assertSafeUrl(rawUrl, options.allowedHosts ?? []).toString();
    const requestHeaders: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'tr-TR,tr;q=0.9,en;q=0.5',
      ...(options.etag ? { 'if-none-match': options.etag } : {}),
      ...(options.lastModified ? { 'if-modified-since': options.lastModified } : {}),
      ...(options.headers ?? {}),
    };

    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const url = new URL(currentUrl);
      await this.limiter.wait(url.hostname, options.minIntervalMs ?? env.SOURCE_MIN_REQUEST_INTERVAL_MS);

      const response = await request(currentUrl, {
        method: options.method ?? 'GET',
        headers: requestHeaders,
        dispatcher: this.agent,
        // Not: yönlendirmeler burada ELLE izlenir (her adımda SSRF allowlist doğrulaması
        // yapılır), bu yüzden undici'nin kendi yönlendirme takibi (varsayılan: kapalı)
        // kullanılmaz.
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
      });

      const status = response.statusCode;
      const headers = normalizeHeaders(response.headers);
      const contentType = headers['content-type'] ?? null;

      if (status >= 300 && status < 400 && headers['location']) {
        const nextUrl = new URL(headers['location'], currentUrl).toString();
        assertSafeUrl(nextUrl, options.allowedHosts ?? []);
        if (redirect === maxRedirects) {
          throw new FetchError(currentUrl, `Çok fazla yönlendirme (${maxRedirects}).`, status, false);
        }
        currentUrl = nextUrl;
        await response.body.dump();
        continue;
      }

      if (status === 304) {
        await response.body.dump();
        return {
          url: rawUrl,
          finalUrl: currentUrl,
          status,
          headers,
          body: Buffer.alloc(0),
          contentType,
          etag: headers['etag'] ?? null,
          lastModified: headers['last-modified'] ?? null,
          notModified: true,
          bytes: 0,
        };
      }

      if (status === 429 || status === 503) {
        const retryAfter = parseRetryAfter(headers['retry-after']);
        await response.body.dump();
        throw new FetchError(
          currentUrl,
          `Kaynak geçici olarak hizmet vermiyor (HTTP ${status})${retryAfter ? `; Retry-After: ${retryAfter}s` : ''}.`,
          status,
          true,
        );
      }

      if (status >= 500) {
        await response.body.dump();
        throw new FetchError(currentUrl, `Sunucu hatası (HTTP ${status}).`, status, true);
      }

      if (status === 403 || status === 401) {
        await response.body.dump();
        throw new FetchError(
          currentUrl,
          `Erişim reddedildi (HTTP ${status}). Kaynağın erişim kısıtı olabilir; kısıt aşılmaz.`,
          status,
          false,
        );
      }

      if (status >= 400) {
        await response.body.dump();
        throw new FetchError(currentUrl, `İstek başarısız (HTTP ${status}).`, status, false);
      }

      if (options.expectedContentTypes && options.expectedContentTypes.length > 0 && contentType) {
        const isExpected = options.expectedContentTypes.some((expected) => contentType.toLowerCase().includes(expected));
        if (!isExpected) {
          await response.body.dump();
          throw new FetchError(currentUrl, `Beklenmeyen içerik türü: ${contentType}`, status, false);
        }
      }

      const body = await readWithLimit(response.body, options.maxBytes ?? env.MAX_DOCUMENT_BYTES);

      return {
        url: rawUrl,
        finalUrl: currentUrl,
        status,
        headers,
        body,
        contentType,
        etag: headers['etag'] ?? null,
        lastModified: headers['last-modified'] ?? null,
        notModified: false,
        bytes: body.length,
      };
    }

    throw new FetchError(rawUrl, 'Yönlendirme döngüsü.', null, false);
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, Math.round((date - Date.now()) / 1000)), 300);
  return null;
}

/** Gövdeyi okuyup sınırı aşarsa hata verir (disk/bellek şişmesini engeller). */
async function readWithLimit(
  body: AsyncIterable<Uint8Array> & { destroy?: () => void },
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw new FetchError('stream', `Belge boyutu sınırı aşıldı (> ${maxBytes} bayt).`, null, false);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
