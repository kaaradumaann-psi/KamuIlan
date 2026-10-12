/**
 * HTTP istemcisi — scraping için sertleştirilmiş.
 *
 * Zorunlu kontroller:
 *  - SSRF: yalnızca izin listesindeki alan adları; özel/yerel ağ ve metadata
 *    adresleri reddedilir. Yönlendirmeler elle takip edilir ve her adım
 *    yeniden doğrulanır (açık yönlendirme ile koruma atlanamaz).
 *  - Boyut sınırı: gövde akış hâlinde okunur, sınır aşılırsa istek kesilir.
 *  - Zaman aşımı: her istek için ayrı sinyal.
 *  - Hız sınırı: alan adı başına en kısa istek aralığı.
 *  - Yeniden deneme: 429/503/5xx ve ağ hatalarında exponential backoff +
 *    jitter; Retry-After başlığı dikkate alınır. Retry fırtınası olmaz.
 *  - Koşullu istek: ETag / Last-Modified ile 304 desteği.
 */
import { request } from 'undici';
import { assertFetchableUrl, hostOf, normalizeUrl } from '../domain/urls';
import { sha256Hex } from '../domain/ids';
import { decodeBody } from '../lib/encoding';
import type { Logger } from '../lib/logger';
import { getEnv } from '../config/env';
import type { FetchRequestOptions, FetchResponse, Fetcher } from './types';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509]);

export interface HttpFetcherOptions {
  userAgent?: string;
  allowedHosts?: string[];
  defaultTimeoutMs?: number;
  defaultMaxBytes?: number;
  logger?: Logger;
  /** Testlerde beklemeyi kısaltmak için. */
  sleep?: (ms: number) => Promise<void>;
}

/** Alan adı başına en kısa istek aralığını uygular. */
export class HostRateLimiter {
  private readonly nextAllowedAt = new Map<string, number>();

  async wait(host: string, minIntervalMs: number): Promise<void> {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const next = this.nextAllowedAt.get(host) ?? 0;
    const delay = Math.max(0, next - now);
    this.nextAllowedAt.set(host, Math.max(now, next) + minIntervalMs);
    if (delay > 0) await sleep(delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpFetcher implements Fetcher {
  private readonly limiter = new HostRateLimiter();
  private readonly userAgent: string;
  private readonly allowedHosts: string[];
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxBytes: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger: Logger | undefined;

  constructor(options: HttpFetcherOptions = {}) {
    const env = getEnv();
    this.userAgent = options.userAgent ?? env.SCRAPER_USER_AGENT;
    this.allowedHosts = options.allowedHosts ?? [];
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? env.SCRAPE_TIMEOUT_MS;
    this.defaultMaxBytes = options.defaultMaxBytes ?? env.MAX_DOCUMENT_BYTES;
    this.sleepFn = options.sleep ?? sleep;
    this.logger = options.logger;
  }

  async fetchText(url: string, options: FetchRequestOptions): Promise<FetchResponse> {
    return this.fetch(url, options, 'text');
  }

  async fetchBinary(url: string, options: FetchRequestOptions): Promise<FetchResponse> {
    return this.fetch(url, options, 'binary');
  }

  private async fetch(
    url: string,
    options: FetchRequestOptions,
    mode: 'text' | 'binary',
  ): Promise<FetchResponse> {
    const env = getEnv();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = options.maxBytes ?? this.defaultMaxBytes;
    const maxRetries = options.retries ?? env.SCRAPE_MAX_RETRIES;
    const allowHosts = this.allowedHosts.length > 0 ? this.allowedHosts : options.source.allowHosts;
    const httpStatuses: number[] = [];

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        const response = await this.fetchOnce(url, options, mode, {
          timeoutMs,
          maxBytes,
          allowHosts,
          conditional: options.conditional,
          accept: options.accept,
          signal: options.signal,
          onStatus: (status) => httpStatuses.push(status),
        });
        return { ...response, attempts: attempt };
      } catch (error) {
        lastError = error as Error;
        const retryAfterMs = extractRetryAfterMs(error);
        const retryable = isRetryableError(error);
        if (!retryable || attempt > maxRetries) break;
        const backoff = retryAfterMs ?? Math.min(2 ** attempt * 1_000, 30_000);
        const jitter = Math.floor(Math.random() * 400);
        this.logger?.warn(
          { url, attempt, backoffMs: backoff + jitter, error: (error as Error).message },
          'scrape isteği yeniden denenecek',
        );
        await this.sleepFn(backoff + jitter);
      }
    }

    throw new FetchError(
      `İstek başarısız (${attempt} deneme): ${lastError?.message ?? 'bilinmeyen hata'}`,
      { url, attempts: attempt, httpStatuses },
    );
  }

  private async fetchOnce(
    url: string,
    options: FetchRequestOptions,
    mode: 'text' | 'binary',
    runtime: {
      timeoutMs: number;
      maxBytes: number;
      allowHosts: string[];
      conditional?: { etag?: string | null; lastModified?: string | null };
      accept?: string;
      signal?: AbortSignal;
      onStatus: (status: number) => void;
    },
  ): Promise<Omit<FetchResponse, 'attempts'>> {
    const allowed = [...runtime.allowHosts, ...this.allowedHosts];
    const redirectChain: string[] = [];
    let currentUrl = assertFetchableUrl(url, { allowHosts: allowed.length > 0 ? allowed : undefined }).toString();

    for (let hop = 0; hop <= getEnv().MAX_REDIRECTS; hop += 1) {
      const target = assertFetchableUrl(currentUrl, { allowHosts: allowed.length > 0 ? allowed : undefined });
      await this.limiter.wait(hostOf(target.toString()), options.source.minRequestIntervalMs);

      const headers: Record<string, string> = {
        'user-agent': this.userAgent,
        accept:
          runtime.accept ??
          (mode === 'binary'
            ? 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5'),
        'accept-language': 'tr-TR,tr;q=0.9,en;q=0.6',
        'cache-control': 'no-cache',
      };
      if (options.conditional?.etag) headers['if-none-match'] = options.conditional.etag;
      if (options.conditional?.lastModified) headers['if-modified-since'] = options.conditional.lastModified;

      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), runtime.timeoutMs);
      const onExternalAbort = () => abortController.abort();
      runtime.signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const response = await request(target, {
          method: 'GET',
          headers,
          signal: abortController.signal,
          headersTimeout: runtime.timeoutMs,
          bodyTimeout: runtime.timeoutMs,
        });
        runtime.onStatus(response.statusCode);

        if (response.statusCode === 304) {
          await response.body.dump();
          return {
            url,
            finalUrl: target.toString(),
            status: 304,
            notModified: true,
            contentType: headerValue(response.headers['content-type']),
            etag: headerValue(response.headers['etag']),
            lastModified: headerValue(response.headers['last-modified']),
            contentHash: sha256Hex('not-modified'),
            byteLength: 0,
            text: null,
            buffer: null,
            charset: null,
            redirectChain,
          };
        }

        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = headerValue(response.headers['location']);
          await response.body.dump();
          if (!location) throw new FetchError(`Yönlendirme konumu yok (${response.statusCode})`, { url, httpStatuses: [response.statusCode] });
          redirectChain.push(location);
          currentUrl = new URL(location, target).toString();
          continue;
        }

        if (response.statusCode === 429 || response.statusCode === 503) {
          const retryAfter = headerValue(response.headers['retry-after']);
          await response.body.dump();
          throw new RetryableHttpError(`HTTP ${response.statusCode}`, {
            url: target.toString(),
            statusCode: response.statusCode,
            retryAfterMs: parseRetryAfter(retryAfter),
            httpStatuses: [response.statusCode],
          });
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          await response.body.dump();
          throw new FetchError(`HTTP ${response.statusCode}`, {
            url: target.toString(),
            statusCode: response.statusCode,
            retryable: RETRYABLE_STATUS.has(response.statusCode),
            httpStatuses: [response.statusCode],
          });
        }

        const contentType = headerValue(response.headers['content-type']);
        const { buffer, truncated } = await readWithCap(response.body, runtime.maxBytes);
        const contentHash = sha256Hex(buffer.toString('base64'));
        if (truncated) {
          this.logger?.warn({ url: target.toString(), maxBytes: runtime.maxBytes }, 'belge boyut sınırında kesildi');
        }

        if (mode === 'binary') {
          return {
            url,
            finalUrl: target.toString(),
            status: response.statusCode,
            notModified: false,
            contentType,
            etag: headerValue(response.headers['etag']),
            lastModified: headerValue(response.headers['last-modified']),
            contentHash,
            byteLength: buffer.byteLength,
            text: null,
            buffer,
            charset: null,
            redirectChain,
          };
        }

        const { text, charset } = decodeBody(buffer, contentType);
        return {
          url,
          finalUrl: target.toString(),
          status: response.statusCode,
          notModified: false,
          contentType,
          etag: headerValue(response.headers['etag']),
          lastModified: headerValue(response.headers['last-modified']),
          contentHash,
          byteLength: buffer.byteLength,
          text,
          buffer: null,
          charset,
          redirectChain,
        };
      } catch (error) {
        if (error instanceof FetchError || error instanceof RetryableHttpError) throw error;
        if ((error as Error).name === 'AbortError') {
          throw new FetchError(`Zaman aşımı (${runtime.timeoutMs} ms)`, { url: target.toString(), retryable: true });
        }
        throw new FetchError(`Ağ hatası: ${(error as Error).message}`, { url: target.toString(), retryable: true });
      } finally {
        clearTimeout(timer);
        runtime.signal?.removeEventListener('abort', onExternalAbort);
      }
    }
    throw new FetchError(`Yönlendirme sayısı sınırı aşıldı (${getEnv().MAX_REDIRECTS})`, {
      url,
      redirectChain,
      httpStatuses: [],
    });
  }
}

export class FetchError extends Error {
  readonly url: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly httpStatuses: number[];
  readonly redirectChain: string[];

  constructor(
    message: string,
    context: {
      url: string;
      statusCode?: number;
      retryable?: boolean;
      httpStatuses?: number[];
      redirectChain?: string[];
      attempts?: number;
    },
  ) {
    super(message);
    this.name = 'FetchError';
    this.url = context.url;
    this.statusCode = context.statusCode;
    this.retryable = context.retryable ?? false;
    this.httpStatuses = context.httpStatuses ?? [];
    this.redirectChain = context.redirectChain ?? [];
  }
}

class RetryableHttpError extends FetchError {
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    context: { url: string; statusCode: number; retryAfterMs: number | null; httpStatuses: number[] },
  ) {
    super(message, { ...context, retryable: true });
    this.name = 'RetryableHttpError';
    this.retryAfterMs = context.retryAfterMs;
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 60_000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return null;
}

function extractRetryAfterMs(error: unknown): number | null {
  if (error instanceof RetryableHttpError) return error.retryAfterMs;
  return null;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true;
  if (error instanceof FetchError) {
    if (error.retryable) return true;
    return error.statusCode !== undefined && RETRYABLE_STATUS.has(error.statusCode);
  }
  return false;
}

/** Gövdeyi sınırla okur; sınır aşılırsa akışı keser. */
export async function readWithCap(
  body: AsyncIterable<Uint8Array> & { destroy?: () => void },
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      const excess = total - maxBytes;
      chunks.push(buf.subarray(0, Math.max(0, buf.byteLength - excess)));
      truncated = true;
      break;
    }
    chunks.push(buf);
  }
  if (typeof (body as { destroy?: () => void }).destroy === 'function') {
    (body as { destroy: () => void }).destroy();
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

export { normalizeUrl };
