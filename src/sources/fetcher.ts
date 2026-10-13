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
import { toHeaderSafeAscii } from '../lib/headerSafe';
import { request, Agent, type Dispatcher } from 'undici';
import { getCACertificates, connect as tlsConnect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { decodeBody, type DecodedBody } from '../lib/encoding';
import { getEnv } from '../config/env';
import { createLogger, type Logger } from '../lib/logger';

export interface FetchOptions {
  /** Üst katman iptal/zaman aşımı sinyali. */
  signal?: AbortSignal;
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
  // IPv4 eşlemeli IPv6 (::ffff:127.0.0.1) ve özel bloklar.
  /^\[?::ffff:/i,
  /^\[?(fc|fd|fe8|fe9|fea|feb)[0-9a-f]{2}:/i,
  /\.internal$/i,
  /^metadata\./i,
  /**
   * Sayısal/ondalık yazılmış IPv4 (ör. 2130706433 = 127.0.0.1, 0x7f000001).
   * Tarayıcı değiliz ama bu biçimler bazı DNS/vekil katmanlarında çözülür;
   * kaynak adresleri her zaman alan adıdır — sayısal host kabul edilmez.
   */
  /^0x[0-9a-f]+$/i,
  /^\d+$/,
  /^\d{1,3}(\.\d{1,3}){3}$/,
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
  private readonly nextRequestAt = new Map<string, number>();

  /**
   * Host için sıradaki uygun zamanı atomik olarak rezerve eder. Tek process'teki
   * ayrı tarama istemcileri de aynı limiter'ı paylaşabilir; böylece paralel
   * worker işleri aynı resmî host'a istekleri yığmaz.
   */
  async wait(host: string, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
    if (minIntervalMs <= 0) return;
    if (signal?.aborted) throw signal.reason ?? new Error('İstek hız sınırı beklerken iptal edildi.');

    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextRequestAt.get(host) ?? now);
    this.nextRequestAt.set(host, scheduledAt + minIntervalMs);
    this.lastRequestAt.set(host, scheduledAt);
    const delay = scheduledAt - now;
    if (delay <= 0) return;

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('İstek hız sınırı beklerken iptal edildi.'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.lastRequestAt);
  }
}

const PROCESS_HOST_RATE_LIMITER = new HostRateLimiter();

const HTML_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/xml', 'text/xml'];
const PDF_TYPES = ['application/pdf'];
const JSON_TYPES = ['application/json', 'text/json'];

export interface HttpClientOptions {
  logger?: Logger;
  /** Tek bir tarama zaman aşımında istemci isteklerini birlikte iptal eder. */
  signal?: AbortSignal;
  /** Testlerde sahte saat/bekleme. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** Testlerde MockAgent enjeksiyonu; üretimde verilmez. */
  dispatcher?: Dispatcher;
  /** Tarama istemcileri arasında host hız sınırını paylaşmak için. */
  rateLimiter?: HostRateLimiter;
}

/**
 * Bazı resmî sitelerin (ilan.gov.tr, BDDK, TMSF) sertifika zinciri, kökü
 * Node'un gömülü Mozilla listesinde olmayan (ör. ulusal) bir CA'ya çıkar;
 * tarayıcı Windows deposundaki kökü kullanabildiği için açılır, Node
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE ile reddeder. Çözüm doğrulamayı kapatmak
 * değil: sistem deposunu varsayılan paketle birleştirip ikisini de
 * güvenilir saymaktır (Node'un kendi önerisi: --use-system-ca).
 */
export function loadTrustBundle(): string[] | undefined {
  try {
    if (typeof getCACertificates !== 'function') return undefined;
    const merged = new Set<string>([...getCACertificates('default'), ...getCACertificates('system')]);
    return merged.size > 0 ? [...merged] : undefined;
  } catch {
    return undefined;
  }
}

/** Ara sertifika eksikliğini gösteren TLS hata kodları (kovalanabilir). */
const TLS_CHAIN_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

/** Hata (veya cause zinciri) eksik ara sertifikadan mı kaynaklanıyor? Kodunu döndürür. */
export function tlsChainErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === 'string' && TLS_CHAIN_CODES.has(code)) return code;
      current = (current as Error & { cause?: unknown }).cause;
    } else break;
  }
  return null;
}

/** Sertifikanın AIA uzantısından CA Issuers (ara sertifika indirme) adreslerini çıkarır. */
export function extractCaIssuerUrls(infoAccess: unknown): string[] {
  const urls = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https?:\/\/[^\s;,']+/g)) urls.add(match[0]);
    } else if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
    } else if (value !== null && typeof value === 'object') {
      // Yalnızca CA Issuers girdileri ara sertifika adresidir (OCSP vb. değil).
      for (const [key, entry] of Object.entries(value)) {
        if (/ca issuers|1\.3\.6\.1\.5\.5\.7\.1\.2/i.test(key)) collect(entry);
      }
    }
  };
  collect(infoAccess);
  return [...urls];
}

/** DER sertifikayı PEM metnine çevirir. */
export function derToPem(der: Buffer): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

export class HttpClient {
  private readonly agent: Dispatcher;
  /** Ara sertifikası AIA ile tamamlanmış host'lara özel agent'lar. */
  private readonly hostAgents = new Map<string, Agent>();
  /** AIA kovalaması host başına bir kez denenir. */
  private readonly chasedHosts = new Set<string>();
  private readonly limiter: HostRateLimiter;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal: AbortSignal | undefined;

  constructor(options: HttpClientOptions = {}) {
    this.ownsAgent = options.dispatcher === undefined;
    this.limiter = options.rateLimiter ?? PROCESS_HOST_RATE_LIMITER;
    this.logger = options.logger ?? createLogger('fetch');
    this.signal = options.signal;
    this.userAgent =
      toHeaderSafeAscii(options.userAgent ?? getEnv().SCRAPE_USER_AGENT) ||
      'Mozilla/5.0 (compatible; KamuIlanBot/1.0; +https://kamuilan.halilkaraduman.com.tr)';
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.agent = options.dispatcher ?? this.createAgent(loadTrustBundle());
  }

  private createAgent(ca?: readonly string[]): Agent {
    return new Agent({
      connections: 8,
      // Yavaş resmî sunucular başlıkları geç gönderebilir; başlık bütçesi
      // çağrı bütçesinin (SCRAPE_TIMEOUT_MS, 60 sn) altında olmamalı.
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
      // Resmî sunucular boşta bağlantıyı erken kapatır; uzun keep-alive
      // bayat sokete istek yazıp başlık zaman aşımına yol açabilir.
      keepAliveTimeout: 4_000,
      connect: {
        // Kırık IPv6 yolu olan ağlarda (ev bağlantıları) tek aileye takılıp
        // zaman aşımına düşmemek için adres ailesi otomatik seçilir.
        autoSelectFamily: true,
        timeout: 15_000,
        ...(ca && ca.length > 0 ? { ca: [...ca] } : {}),
      },
    });
  }

  private dispatcherFor(url: URL): Dispatcher {
    return this.hostAgents.get(url.hostname) ?? this.agent;
  }

  /**
   * Bazı resmî sunucular (ilan.gov.tr, BDDK, TMSF) sertifika zincirindeki ara
   * sertifikayı göndermez; tarayıcılar eksik halkayı sertifikanın AIA
   * (CA Issuers) adresinden indirir, Node indirmez ve zincir doğrulanamaz.
   * Burada aynısı yapılır: ara sertifikalar AIA adreslerinden alınır ve
   * doğrulama AÇIKken yeniden denenir. İndirilen sertifikaya körü körüne
   * güvenilmez — zincir, güven paketi (sistem + Mozilla) ile OpenSSL
   * doğrulamasından geçmek zorundadır; geçemezse özgün hata yükselir.
   * Host başına bir kez denenir, sonuç istemci ömrü boyunca saklanır.
   */
  private async tryChaseIntermediates(rawUrl: string): Promise<boolean> {
    if (!this.ownsAgent) return false;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || this.chasedHosts.has(url.hostname)) return false;
    this.chasedHosts.add(url.hostname);
    const trustBundle = loadTrustBundle();
    // Güven paketinin varsayılan kökleri sayısallaştırılamıyorsa ara sertifika
    // eklemek varsayılanları ezip başka zincirleri bozabilir; o platformda
    // kovalamak yerine özgün hatanın görünmesi daha güvenlidir.
    if (!trustBundle) return false;
    const intermediates = await this.collectIntermediates(url.hostname, Number(url.port || 443)).catch(() => []);
    if (intermediates.length === 0) return false;
    this.hostAgents.set(url.hostname, this.createAgent([...trustBundle, ...intermediates]));
    this.logger.info(
      { host: url.hostname, intermediates: intermediates.length },
      'eksik ara sertifika AIA üzerinden tamamlandı; doğrulama açık olarak yeniden denenecek',
    );
    return true;
  }

  /** Leaf'ten başlayıp AIA adreslerini izleyerek ara sertifikaları toplar (≤3 halka). */
  private async collectIntermediates(hostname: string, port: number): Promise<string[]> {
    const collected: string[] = [];
    let frontier = await this.peerCertificatePems(hostname, port);
    for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const pem of frontier) {
        let infoAccess: unknown;
        try {
          infoAccess = new X509Certificate(pem).infoAccess;
        } catch {
          continue;
        }
        for (const issuerUrl of extractCaIssuerUrls(infoAccess)) {
          const downloaded = await this.downloadCertificate(issuerUrl);
          if (downloaded && !collected.includes(downloaded)) {
            collected.push(downloaded);
            next.push(downloaded);
          }
        }
      }
      frontier = next;
    }
    return collected;
  }

  /** Sunucunun sunduğu zinciri DOĞRULAMADAN yalnızca AIA keşfi için okur; güven bu adımda oluşmaz. */
  private peerCertificatePems(hostname: string, port: number): Promise<string[]> {
    return new Promise((resolve) => {
      const socket = tlsConnect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 10_000 });
      const done = (pems: string[]) => {
        socket.destroy();
        resolve(pems);
      };
      socket.once('secureConnect', () => {
        try {
          const pems: string[] = [];
          let cert = socket.getPeerCertificate(true);
          const seen = new Set<string>();
          while (cert && cert.raw && !seen.has(cert.fingerprint)) {
            seen.add(cert.fingerprint);
            pems.push(derToPem(Buffer.from(cert.raw)));
            if (!cert.issuerCertificate || cert.issuerCertificate === cert) break;
            cert = cert.issuerCertificate;
          }
          done(pems);
        } catch {
          done([]);
        }
      });
      socket.once('error', () => done([]));
      socket.once('timeout', () => done([]));
    });
  }

  /** AIA adresinden sertifika indirir (PEM ya da DER), ayrıştırılabiliyorsa PEM döndürür. */
  private async downloadCertificate(url: string): Promise<string | null> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const response = await request(url, { method: 'GET', headersTimeout: 10_000, bodyTimeout: 10_000 });
      if (response.statusCode !== 200) {
        await response.body.dump();
        return null;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += (chunk as Buffer).byteLength;
        if (total > 524_288) return null;
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      const pem = text.includes('-----BEGIN CERTIFICATE-----') ? text.trim() : derToPem(body);
      new X509Certificate(pem);
      return pem;
    } catch {
      return null;
    }
  }

  private readonly ownsAgent: boolean;

  async close(): Promise<void> {
    for (const agent of this.hostAgents.values()) await agent.close().catch(() => undefined);
    this.hostAgents.clear();
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
    const signal = options.signal ?? this.signal;

    if (signal?.aborted) {
      throw new FetchError(rawUrl, 'İstek tarama zaman aşımı nedeniyle iptal edildi.', null, false);
    }

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        const response = await this.performFetch(rawUrl, {
          ...options,
          signal,
          allowedHosts,
          timeoutMs,
          maxBytes,
          minIntervalMs,
        });
        return response;
      } catch (error) {
        if (signal?.aborted) {
          throw new FetchError(rawUrl, 'İstek tarama zaman aşımı nedeniyle iptal edildi.', null, false);
        }
        const fetchError =
          error instanceof FetchError ? error : new FetchError(rawUrl, describeFetchFailure(error), null, true);
        lastError = fetchError;
        // Eksik ara sertifika: AIA ile tamamlanabiliyorsa yeni agent'la hemen yeniden dene.
        if (attempt <= maxRetries && tlsChainErrorCode(error) !== null && (await this.tryChaseIntermediates(rawUrl))) {
          continue;
        }
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
      await this.limiter.wait(url.hostname, options.minIntervalMs ?? env.SOURCE_MIN_REQUEST_INTERVAL_MS, options.signal);

      const response = await request(currentUrl, {
        method: options.method ?? 'GET',
        headers: requestHeaders,
        dispatcher: this.dispatcherFor(url),
        ...(options.signal ? { signal: options.signal } : {}),
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
