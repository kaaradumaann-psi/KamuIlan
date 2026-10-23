/**
 * HTTP istemcisi (undici).
 *
 * Güvenlik ve nezaket kuralları:
 *  - SSRF savunması: yalnızca http/https, tam host allowlist, sayısal IP ve
 *    özel/ayrılmış IP aralıkları reddedilir; her DNS cevabı bağlantıdan önce doğrulanır.
 *  - Yönlendirmeler elle izlenir ve her adım yeniden allowlist'ten geçirilir.
 *  - Host başına asgari istek aralığı (rate limit) uygulanır.
 *  - 429/503 için Retry-After'a saygı duyulur; üstel geri çekilme + jitter.
 *  - Gövde boyutu sınırlanır; HTML/PDF dışındaki türler kabul edilmez.
 *  - TLS doğrulaması açık kalır; sertifika AIA içeriği güven deposuna eklenmez.
 *  - CAPTCHA/erişim kontrolü AŞILMAZ; engellenirse hata kaydedilir.
 */
import { toHeaderSafeAscii } from '../lib/headerSafe';
import { request, Agent, MockAgent, type Dispatcher } from 'undici';
import { request as nodeHttpRequest, type IncomingMessage } from 'node:http';
import { request as nodeHttpsRequest } from 'node:https';
import {
  loadCaStore as tlsLoadCaStore,
  systemCaStoreAvailable as tlsTrustStoreAvailable,
  describeTlsTrust as tlsTrustDescribe,
  tlsVerificationDisabled as tlsVerificationOff,
  SYSTEM_CA_MIN_NODE as TLS_TRUST_SYSTEM_CA_MIN_NODE,
} from '../lib/tls-trust';
import { isIP } from 'node:net';
import { decodeBody, type DecodedBody } from '../lib/encoding';
import { getEnv } from '../config/env';
import { createLogger, type Logger } from '../lib/logger';
import { createPublicOnlyLookup } from './network-safety';
import { shouldBlockExternalHttpInTest } from '../lib/offline-network';
import {
  completeCertificateChain,
  isChainIncompleteError,
  readPresentedChain,
  subjectLabel,
} from '../lib/tls-chain-completion';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { loadBundledIntermediates } from '../lib/tls-intermediates';

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
  method?: 'GET' | 'HEAD' | 'POST';
  /** POST gövdesi (JSON API'ler için); content-type otomatik ayarlanır. */
  jsonBody?: unknown;
  /**
   * POST gövdesi (application/x-www-form-urlencoded; ASP.NET postback formları için).
   * `jsonBody` ile birlikte verilemez.
   */
  formBody?: string;
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
      const label =
        typeof code === 'string' && code.length > 0 ? `${code}: ${current.message}` : current.message;
      if (label && !parts.includes(label)) parts.push(label);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ') || 'Bilinmeyen ağ hatası';
}

/**
 * Aktarım katmanı hata türü: yanıt kullanılabilir bir HTTP cevabına dönüşmeden
 * (status yok) nedenin kaba sınıfı. `malformed-response`, bağlantı kurulduğu
 * ve sunucunun yanıt gönderdiği ama başlıkların RFC 7230'a uymadığı (undici
 * llhttp'nin reddettiği geçersiz başlık belirteci gibi) durumu ifade eder.
 */
export type TransportFailureKind = 'connect-timeout' | 'dns' | 'refused' | 'tls' | 'malformed-response';

/**
 * undici'nin katı HTTP/1.1 ayrıştırıcısının (llhttp) RFC dışı bir yanıt başlığı
 * nedeniyle fırlattığı `HTTPParserError` sınıfını tanır. Türkiye'deki bazı resmî
 * sunucular (ör. BDDK) aralıklı olarak geçersiz başlık belirteci gönderir; bu hata
 * türü hoşgörülü ayrıştırıcıya düşülebilecek TEK sınıftır. Zaman aşımı, TLS veya
 * gerçek HTTP durum hatalarını KAPSAMAZ. Neden `cause` zincirinde olabileceği için
 * zincir dört düzeye kadar taranır.
 */
export function isMalformedResponseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      if (current.name === 'HTTPParserError') return true;
      if (typeof code === 'string' && code.startsWith('HPE_')) return true;
      if (typeof current.message === 'string' && /does not match the HTTP\/1\.1 protocol/i.test(current.message)) {
        return true;
      }
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Hata mesajındaki undici/Node kodundan aktarım hatası türünü çıkarır.
 * Bağlantı KURULAMADAN biten hataları ve RFC dışı (ayrıştırılamayan) yanıtları
 * sınıflar; başlık/gövde zaman aşımı (UND_ERR_HEADERS_TIMEOUT) bağlantı kurulduğu
 * için burada yer almaz.
 */
export function classifyTransportFailure(message: string): TransportFailureKind | null {
  if (/UND_ERR_CONNECT_TIMEOUT|\bETIMEDOUT\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/.test(message)) return 'connect-timeout';
  if (/\bENOTFOUND\b|\bEAI_AGAIN\b/.test(message)) return 'dns';
  if (/\bECONNREFUSED\b/.test(message)) return 'refused';
  if (/CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|ERR_SSL/.test(message)) return 'tls';
  if (/\bHPE_[A-Z_]+\b|does not match the HTTP\/1\.1 protocol/i.test(message)) return 'malformed-response';
  return null;
}

const TRANSPORT_HINT_MARKER = 'Olası neden:';

const TRANSPORT_HINTS: Record<TransportFailureKind, string> = {
  'connect-timeout':
    `${TRANSPORT_HINT_MARKER} TCP bağlantısı kurulamadı (hedef yanıt vermedi). Hedef kapalı olabilir ya da bu ` +
    "sunucunun çıkış IP'sini/bölgesini ağ katmanında engelliyor olabilir; Türkiye'deki bir bağlantıdan " +
    'erişilebiliyorsa neden büyük olasılıkla yurt dışı IP engelidir. Engel aşılmaz.',
  dns: `${TRANSPORT_HINT_MARKER} alan adı çözümlenemedi (DNS kaydı yok veya çözümleyici erişilemiyor).`,
  refused: `${TRANSPORT_HINT_MARKER} hedef bağlantıyı reddetti (port kapalı).`,
  tls: `${TRANSPORT_HINT_MARKER} TLS sertifika doğrulaması başarısız; doğrulama kapatılmaz.`,
  'malformed-response':
    `${TRANSPORT_HINT_MARKER} sunucu RFC'ye uymayan bir HTTP yanıtı döndürdü (geçersiz başlık belirteci). ` +
    'Hoşgörülü ayrıştırıcıyla tek seferlik yeniden deneme de başarısız oldu; TLS ve kimlik korunur, sorun kaynaktadır.',
};

export function transportFailureHint(kind: TransportFailureKind): string {
  return TRANSPORT_HINTS[kind];
}

/**
 * Yeniden denemeler tükendiğinde fırlatılan aktarım hatasına operatörün panelde
 * göreceği kısa bir neden ipucu ekler. Durum kodu olan (yanıt alınmış) hatalara
 * ve zaten ipucu taşıyan mesajlara dokunmaz.
 */
export function withTransportHint(error: FetchError): FetchError {
  if (error.status !== null || error.message.includes(TRANSPORT_HINT_MARKER)) return error;
  const kind = classifyTransportFailure(error.message);
  if (!kind) return error;
  return new FetchError(
    error.url,
    `${error.message} — ${transportFailureHint(kind)}`,
    error.status,
    error.retryable,
    error.retryAfterMs,
  );
}

export class FetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    url: string,
    message: string,
    status: number | null,
    retryable: boolean,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Browser retrieval is only a fallback for transport failures, never a way to
 * retry an HTTP denial, rate limit, or other explicit response through another
 * client identity.
 */
export function isTransientTransportFailure(error: unknown): error is FetchError {
  return error instanceof FetchError && error.status === null && error.retryable;
}

/**
 * Hoşgörülü aktarım için tek bir HTTP isteğinin undici `request` ile aynı alanları
 * sağlayan sadeleştirilmiş yanıtı. Yönlendirme döngüsü yalnızca bu üç alanı okur.
 */
export interface DispatchResponseLike {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array> & { dump: () => Promise<void>; destroy?: (error?: Error) => void };
}

export interface LenientDispatchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** undici ajanıyla eş güven deposu; boşsa Node'un gömülü kökleri kullanılır. */
  ca?: readonly string[];
  signal?: AbortSignal;
  /** Testlerde yerel sunucuya yönlendirmek için SSRF güvenli varsayılan lookup geçersiz kılınır. */
  lookup?: ReturnType<typeof createPublicOnlyLookup>;
}

export type LenientDispatch = (url: string, init: LenientDispatchInit) => Promise<DispatchResponseLike>;

/**
 * Node'un yerleşik `node:http`/`node:https` istemcisiyle TEK bir istek yapar ve
 * `insecureHTTPParser: true` ile RFC dışı başlık belirteçlerini tolere eder.
 *
 * Güvenlik: TLS doğrulaması (`rejectUnauthorized: true`) AÇIK kalır, undici
 * ajanıyla aynı güven deposu (`ca`) verilir, SSRF için yalnızca genel adrese
 * çözümleyen `lookup` kullanılır, kimlik (User-Agent) ve diğer başlıklar aynen
 * taşınır. Yalnızca ayrıştırıcı katılığı gevşetilir; istek kimliği değişmez.
 */
export function lenientHttpDispatch(rawUrl: string, init: LenientDispatchInit): Promise<DispatchResponseLike> {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? nodeHttpsRequest : nodeHttpRequest;
  return new Promise<DispatchResponseLike>((resolve, reject) => {
    const requestOptions = {
      method: init.method,
      headers: init.headers,
      insecureHTTPParser: true,
      // Kırık IPv6 yolu olan ağlarda tek aileye takılıp zaman aşımına düşmemek için;
      // bu seçenek net katmanına iletilir ve @types/node'da http seçeneklerinde tanımlı değildir.
      autoSelectFamily: true,
      lookup: init.lookup ?? createPublicOnlyLookup(),
      ...(isHttps
        ? { rejectUnauthorized: true, ...(init.ca && init.ca.length > 0 ? { ca: [...init.ca] } : {}) }
        : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    } as Parameters<typeof requestFn>[1] & { autoSelectFamily?: boolean };
    const request_ = requestFn(
      url,
      requestOptions,
      (incoming: IncomingMessage) => {
        const body = incoming as unknown as DispatchResponseLike['body'];
        body.dump = () =>
          new Promise<void>((resolveDump) => {
            incoming.on('end', resolveDump);
            incoming.on('error', () => resolveDump());
            incoming.resume();
          });
        resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body });
      },
    );
    request_.setTimeout(init.timeoutMs, () => {
      request_.destroy(new Error(`Hoşgörülü HTTP isteği zaman aşımına uğradı (${init.timeoutMs} ms).`));
    });
    request_.on('error', reject);
    if (init.body !== undefined) request_.write(init.body);
    request_.end();
  });
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
  if (
    (url.protocol === 'https:' && url.port && url.port !== '443') ||
    (url.protocol === 'http:' && url.port && url.port !== '80')
  ) {
    throw new FetchError(rawUrl, `Desteklenmeyen URL portu: ${url.port}`, null, false);
  }
  const host = url.hostname.toLowerCase();
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (url.username || url.password) {
    throw new FetchError(rawUrl, 'URL içinde kimlik bilgisi kullanılamaz.', null, false);
  }
  if (isIP(bareHost) !== 0 || PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new FetchError(rawUrl, `Özel, sayısal veya ayrılmış adresler engellendi: ${host}`, null, false);
  }
  if (allowedHosts.length > 0) {
    const normalizedHost = bareHost.replace(/\.$/, '');
    const permitted = allowedHosts.some(
      (allowed) => normalizedHost === allowed.toLowerCase().replace(/\.$/, ''),
    );
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
      if (signal?.aborted) onAbort();
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
  /** Testlerde sahte bekleme; AbortSignal verilir ki retry iptali sınanabilsin. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  userAgent?: string;
  /** Testlerde MockAgent enjeksiyonu; üretimde verilmez. */
  dispatcher?: Dispatcher;
  /**
   * RFC dışı yanıt başlığı (HTTPParserError) için hoşgörülü yedek aktarım.
   * Üretimde verilmez; `lenientHttpDispatch` (node:http/https, insecureHTTPParser)
   * kullanılır. Testlerde MockAgent gerçek ağa çıkamadığı için enjekte edilir.
   */
  lenientDispatch?: LenientDispatch;
  /** Tarama istemcileri arasında host hız sınırını paylaşmak için. */
  rateLimiter?: HostRateLimiter;
  /** İsteğe bağlı toplam HTTP attempt sınırı; redirect/retry dahil. */
  maxRequests?: number;
  /** İsteğe bağlı fetchText belge sınırı; canlı probe'da sayfa + detay için tutucu üst sınır. */
  maxTextRequests?: number;
  /**
   * Kaynağın robots.txt `Disallow` kuralları (bkz. `SourceDefinition.robotsDisallow`).
   * Eşleşen adrese — yönlendirme hedefi dahil — istek gönderilmez.
   */
  disallowedPaths?: readonly string[];
}

/**
 * robots.txt `Disallow` eşleşmesi: yol + sorgu, kuralın başından; `*` herhangi dizi,
 * sondaki `$` bitişi sabitler. `Allow` istisnaları bilinçli olarak yok sayılır (yalnız
 * daha kısıtlayıcı). Eşleşen kuralı, yoksa null döner.
 */
export function robotsDisallowMatch(url: URL, patterns: readonly string[]): string | null {
  const target = `${url.pathname}${url.search}`;
  for (const pattern of patterns) {
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (new RegExp(`^${source}${anchored ? '$' : ''}`, 'u').test(target)) return pattern;
  }
  return null;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new Error('İstek yeniden deneme beklerken iptal edildi.'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason ?? new Error('İstek yeniden deneme beklerken iptal edildi.'));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Sertifika zinciri güven deposu (bkz. `src/lib/tls-trust.ts`). Doğrulama
 * ilkesi tek kaynaktan gelir: HTTP istemcisi ve Postgres sürücüsü aynı kök
 * deposunu kullanır; hiçbir yerde doğrulama sessizce kapatılmaz.
 */
export const SYSTEM_CA_MIN_NODE = TLS_TRUST_SYSTEM_CA_MIN_NODE;

export function systemCaStoreAvailable(): boolean {
  return tlsTrustStoreAvailable();
}

/** Kullanıcıya gösterilecek TLS güven modu özeti (live-check başlığı). */
export function describeTlsTrust(): string {
  return tlsTrustDescribe();
}

/**
 * Süreç genelinde TLS doğrulaması kapatılmış mı? (`NODE_TLS_REJECT_UNAUTHORIZED=0`)
 *
 * İstemci bu anahtarı kendisi kullanmaz; yalnızca RAPORLAR. Doğrulama her zaman
 * açıktır ve açık kalır — kapatılmış bir süreçte yapılan taramanın sonucu
 * güvenilmez olduğu için bunu gizlemek yerine görünür kılarız.
 */
export function tlsVerificationDisabled(): boolean {
  return tlsVerificationOff();
}

export function loadTrustBundle(): string[] | undefined {
  return tlsLoadCaStore();
}

let bundledIntermediatesCache: { key: number; pems: string[] } | null = null;

/**
 * Depodaki doğrulanmış ara sertifikalar (`certs/intermediates`, bkz. `src/lib/tls-intermediates.ts`).
 * Sunucusu ara sertifikayı göndermeyen siteler (ilan.gov.tr, TMSF) Ubuntu'da da doğrulanır;
 * dosya yalnız güvenilen bir köke bağlanıyorsa kullanılır. Kök sayısına göre önbelleklenir.
 */
export function bundledIntermediatesFor(roots: readonly string[], logger?: Logger): string[] {
  if (bundledIntermediatesCache && bundledIntermediatesCache.key === roots.length) return bundledIntermediatesCache.pems;
  const loaded = loadBundledIntermediates(roots);
  if (loaded.rejected.length > 0) {
    logger?.warn(
      { rejected: loaded.rejected },
      'Depodaki bazı ara sertifikalar reddedildi (CA değil, süresi dışında ya da güvenilen köke bağlanmıyor); kullanılmadı.',
    );
  }
  bundledIntermediatesCache = { key: roots.length, pems: loaded.accepted };
  return loaded.accepted;
}

/**
 * Eksik zincir için AIA tamamlaması denenmeli mi?
 *
 * Kararın ayrı bir saf fonksiyon olması bilinçlidir: bu yol TLS doğrulamasına
 * dokunduğu için "ne zaman denenir" kuralı test edilebilir olmalıdır.
 *
 * Kurallar:
 *  - Anahtar kapalıysa (`SOURCE_TLS_AIA_COMPLETION=0`) asla denenmez.
 *  - Hata eksik zincir kodlarından biri değilse denenmez (ör. host adı
 *    uyuşmazlığı ya da süresi dolmuş sertifika zincir tamamlamayla çözülmez).
 *  - Host başına YALNIZCA bir kez denenir; tamamlanmış host yeniden denenmez.
 */
export function shouldAttemptChainCompletion(state: {
  enabled: boolean;
  chainIncomplete: boolean;
  host: string;
  attemptedHosts: ReadonlySet<string>;
  completedHosts: ReadonlySet<string>;
}): boolean {
  if (!state.enabled) return false;
  if (!state.chainIncomplete) return false;
  if (state.attemptedHosts.has(state.host)) return false;
  if (state.completedHosts.has(state.host)) return false;
  return true;
}

let trustWarningShown = false;

export class HttpClient {
  private readonly agent: Dispatcher;
  private readonly limiter: HostRateLimiter;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly signal: AbortSignal | undefined;
  private readonly maxRequests: number | null;
  private readonly maxTextRequests: number | null;
  private readonly disallowedPaths: readonly string[];
  private requestCount = 0;
  private requestReservations = 0;
  private textRequestCount = 0;
  private redirectCount = 0;
  private binaryRequestCount = 0;
  private malformedFallbackCount = 0;
  /** undici ajanıyla eş güven deposu; hoşgörülü yedek aktarıma aynen verilir. */
  private readonly effectiveCa: readonly string[] | undefined;
  /** RFC dışı yanıt için hoşgörülü yedek aktarım (node:http/https, insecureHTTPParser). */
  private readonly lenientDispatch: LenientDispatch;
  /** Yedek aktarım açıkça enjekte edildi mi? (MockAgent testlerinde yanlışlıkla ağa çıkmayı önler.) */
  private readonly lenientDispatchInjected: boolean;
  /** Birleşik güven deposu (Node + sistem + NODE_EXTRA_CA_CERTS) PEM listesi. */
  private readonly baseCa: readonly string[];
  /** Depodan doğrulanarak yüklenen ara sertifikalar (güven kökü değil, zincir halkası). */
  private readonly bundledIntermediates: readonly string[];
  /**
   * AIA ile tamamlanmış zincirler: `host` → ek halkaları içeren dispatcher.
   *
   * Sunucu ara sertifikayı göndermediğinde (bkz. src/lib/tls-chain-completion.ts)
   * eksik halka DOĞRULANARAK bulunur ve o host için ayrı bir ajan oluşturulur.
   * Doğrulama her istekte AÇIKTIR; yalnızca güven kümesi, zaten güvenilen bir
   * köke bağlanan halkalarla genişler.
   */
  private readonly completedChainAgents = new Map<string, Dispatcher>();
  /** Aynı host için tamamlama yalnızca BİR kez denenir (döngü/tekrar koruması). */
  private readonly chainCompletionAttempted = new Set<string>();

  constructor(options: HttpClientOptions = {}) {
    this.ownsAgent = options.dispatcher === undefined;
    this.isMockDispatcher = options.dispatcher instanceof MockAgent;
    if (options.dispatcher instanceof MockAgent && process.env.NODE_ENV === 'test') options.dispatcher.disableNetConnect();
    if (options.maxRequests !== undefined && (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)) {
      throw new Error('HttpClient maxRequests pozitif güvenli tamsayı olmalıdır.');
    }
    if (options.maxTextRequests !== undefined && (!Number.isSafeInteger(options.maxTextRequests) || options.maxTextRequests < 1)) {
      throw new Error('HttpClient maxTextRequests pozitif güvenli tamsayı olmalıdır.');
    }
    this.maxRequests = options.maxRequests ?? null;
    this.maxTextRequests = options.maxTextRequests ?? null;
    this.disallowedPaths = options.disallowedPaths ?? [];
    this.limiter = options.rateLimiter ?? PROCESS_HOST_RATE_LIMITER;
    this.logger = options.logger ?? createLogger('fetch');
    this.signal = options.signal;
    this.userAgent =
      toHeaderSafeAscii(options.userAgent ?? getEnv().SCRAPE_USER_AGENT) ||
      'Mozilla/5.0 (compatible; KamuIlan/0.3; +https://kamuilan.halilkaraduman.com.tr)';
    this.sleep = options.sleep ?? abortableSleep;
    if (options.dispatcher === undefined && !systemCaStoreAvailable() && !trustWarningShown) {
      trustWarningShown = true;
      this.logger.warn(
        { nodeVersion: process.version, requiredNodeVersion: SYSTEM_CA_MIN_NODE },
        'Sistem sertifika deposu okunamıyor; eksik zincirli resmî siteler reddedilebilir. Node 22.15+ kurun.',
      );
    }
    const trustBundle = loadTrustBundle();
    this.baseCa = trustBundle ?? [];
    // `ca` verildiğinde Node varsayılan depoyu kullanmaz; sistem deposu API'si yoksa
    // ara sertifikalar Node'un gömülü kökleriyle birlikte verilir.
    this.bundledIntermediates =
      options.dispatcher === undefined ? bundledIntermediatesFor(trustBundle ?? rootCertificates, this.logger) : [];
    const agentCaInput =
      this.bundledIntermediates.length > 0 ? [...(trustBundle ?? rootCertificates)] : trustBundle;
    // Yedek (node:https) aktarıma, undici ajanının kullandığı kök + ara sertifika
    // birleşiminin AYNISI verilir ki TLS güven kümesi iki yolda da özdeş olsun.
    const combinedCa =
      agentCaInput && agentCaInput.length > 0 ? [...agentCaInput, ...this.bundledIntermediates] : undefined;
    this.effectiveCa = combinedCa;
    this.agent = options.dispatcher ?? this.createAgent(agentCaInput);
    this.lenientDispatch = options.lenientDispatch ?? lenientHttpDispatch;
    this.lenientDispatchInjected = options.lenientDispatch !== undefined;
  }

  get requestsMade(): number {
    return this.requestCount;
  }

  get textFetchesMade(): number {
    return this.textRequestCount;
  }

  /** İzlenen HTTP yönlendirme adımı sayısı (her adım ayrıca istek bütçesine sayılır). */
  get redirectsMade(): number {
    return this.redirectCount;
  }

  /** fetchBinary çağrısı sayısı (PDF/ek denemeleri; retry'lar ayrı istek sayılır). */
  get binaryFetchesMade(): number {
    return this.binaryRequestCount;
  }

  /** RFC dışı yanıt nedeniyle hoşgörülü yedek aktarıma düşülen istek sayısı (telemetri). */
  get malformedHeaderFallbacks(): number {
    return this.malformedFallbackCount;
  }

  get remainingRequestBudget(): number | null {
    return this.maxRequests === null ? null : Math.max(0, this.maxRequests - this.requestReservations);
  }

  get remainingTextRequestBudget(): number | null {
    return this.maxTextRequests === null ? null : Math.max(0, this.maxTextRequests - this.textRequestCount);
  }

  private createAgent(ca?: readonly string[]): Agent {
    const trust = ca && ca.length > 0 ? [...ca, ...this.bundledIntermediates] : [];
    return new Agent({
      connections: 8,
      // Yavaş resmî sunucular başlıkları geç gönderebilir; başlık bütçesi
      // çağrı bütçesinin (SCRAPE_TIMEOUT_MS, varsayılan 120 sn) altında olmamalı.
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
        lookup: createPublicOnlyLookup(),
        ...(trust.length > 0 ? { ca: trust } : {}),
      },
    });
  }

  private dispatcherFor(url: URL): Dispatcher {
    // AIA ile tamamlanmış zinciri olan host'lar kendi ajanını kullanır.
    return this.completedChainAgents.get(url.host) ?? this.agent;
  }

  /**
   * Eksik zinciri AIA ile tamamlamayı dener; başarılıysa host'a özel ajan kurar.
   *
   * @returns Kullanıcıya/günlüğe yazılabilir not; tamamlama olmadıysa `null`.
   */
  private async tryCompleteTlsChain(url: URL, timeoutMs: number): Promise<string | null> {
    const presented = await readPresentedChain({
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      servername: url.hostname,
      timeoutMs: Math.min(timeoutMs, 10_000),
    });
    if (presented.length === 0) return null;
    const roots = this.baseCa
      .map((pem) => {
        try {
          return new X509Certificate(pem);
        } catch {
          return null;
        }
      })
      .filter((certificate): certificate is X509Certificate => certificate !== null);
    const result = await completeCertificateChain(presented, roots, {
      timeoutMs: Math.min(timeoutMs, 10_000),
    });
    if (!result.ok || result.added.length === 0) {
      this.logger.warn(
        { host: url.hostname, reason: result.reason, attemptedUrls: result.attemptedUrls.length },
        'Eksik sertifika zinciri AIA ile tamamlanamadı; doğrulama açık kaldı ve istek reddedildi.',
      );
      return null;
    }
    const addedPem = result.added.map((certificate) => certificate.toString());
    const agent = this.createAgent([...this.baseCa, ...addedPem]);
    this.completedChainAgents.set(url.host, agent);
    const note =
      `Eksik ara sertifika AIA ile tamamlandı (${result.added.map(subjectLabel).join(', ')}); ` +
      `zincir güvenilen köke bağlandı: ${result.trustedBy ? subjectLabel(result.trustedBy) : 'bilinmiyor'}. ` +
      'TLS doğrulaması açık kaldı.';
    this.logger.info({ host: url.hostname, added: result.added.map(subjectLabel) }, note);
    return note;
  }

  private readonly ownsAgent: boolean;
  private readonly isMockDispatcher: boolean;

  async close(): Promise<void> {
    if (!this.ownsAgent) return;
    await this.agent.close();
    for (const agent of this.completedChainAgents.values()) {
      await (agent as Agent).close().catch(() => undefined);
    }
    this.completedChainAgents.clear();
  }

  /** Metin (HTML/XML/JSON) getirir. */
  async fetchText(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
    if (this.maxTextRequests !== null && this.textRequestCount >= this.maxTextRequests) {
      throw new FetchError(url, `Tutucu text/page request bütçesi doldu (${this.maxTextRequests}).`, null, false);
    }
    this.textRequestCount += 1;
    const response = await this.fetch(url, {
      ...options,
      expectedContentTypes: options.expectedContentTypes ?? [...HTML_TYPES, ...JSON_TYPES],
    });
    if (!response.decoded) {
      response.decoded = decodeBody(response.body, response.contentType);
    }
    return response;
  }

  /** İkili belge (PDF) getirir. */
  async fetchBinary(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
    this.binaryRequestCount += 1;
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
      if (signal?.aborted) {
        throw new FetchError(rawUrl, 'İstek tarama zaman aşımı nedeniyle iptal edildi.', null, false);
      }
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
          error instanceof FetchError
            ? error
            : new FetchError(rawUrl, describeFetchFailure(error), null, true);
        lastError = fetchError;

        // Eksik sertifika zinciri: geri çekilme/yeniden deneme bütçesini
        // tüketmeden, doğrulamayı KAPATMADAN tek seferlik tamamlama denenir.
        // (NODE_TLS_REJECT_UNAUTHORIZED=0 yerine gerçek çözüm budur.)
        const target = new URL(rawUrl);
        const hostKey = target.host;
        if (
          shouldAttemptChainCompletion({
            enabled: env.SOURCE_TLS_AIA_COMPLETION,
            chainIncomplete: isChainIncompleteError(error),
            host: hostKey,
            attemptedHosts: this.chainCompletionAttempted,
            completedHosts: new Set(this.completedChainAgents.keys()),
          })
        ) {
          this.chainCompletionAttempted.add(hostKey);
          const note = await this.tryCompleteTlsChain(target, timeoutMs).catch(() => null);
          if (note) {
            attempt -= 1; // tamamlama sonrası deneme bütçesi aynı kalır
            continue;
          }
        }

        if (!fetchError.retryable || attempt > maxRetries) throw withTransportHint(fetchError);
        const exponentialBackoff = Math.min(2 ** attempt * 500, 15_000) * (0.8 + Math.random() * 0.4);
        const backoff = Math.max(exponentialBackoff, fetchError.retryAfterMs ?? 0);
        this.logger.warn(
          {
            url: rawUrl,
            attempt,
            maxRetries,
            status: fetchError.status,
            error: fetchError.message,
            retryAfterMs: fetchError.retryAfterMs,
            backoffMs: Math.round(backoff),
          },
          'istek başarısız, yeniden denenecek',
        );
        try {
          await this.sleep(Math.round(backoff), signal);
        } catch (sleepError) {
          if (signal?.aborted) {
            throw new FetchError(rawUrl, 'İstek tarama zaman aşımı nedeniyle iptal edildi.', null, false);
          }
          throw sleepError;
        }
        if (signal?.aborted) {
          throw new FetchError(rawUrl, 'İstek tarama zaman aşımı nedeniyle iptal edildi.', null, false);
        }
      }
    }

    throw lastError ?? new FetchError(rawUrl, 'Bilinmeyen istek hatası.', null, false);
  }

  private async performFetch(
    rawUrl: string,
    options: Required<Pick<FetchOptions, 'timeoutMs'>> & FetchOptions,
  ): Promise<FetchResponse> {
    const env = getEnv();
    const maxRedirects = env.MAX_REDIRECTS;
    let currentUrl = assertSafeUrl(rawUrl, options.allowedHosts ?? []).toString();
    let method: 'GET' | 'HEAD' | 'POST' = options.method ?? 'GET';
    let requestBody: string | undefined =
      options.jsonBody !== undefined
        ? JSON.stringify(options.jsonBody)
        : options.formBody !== undefined
          ? options.formBody
          : undefined;
    const requestContentType =
      options.jsonBody !== undefined
        ? 'application/json; charset=utf-8'
        : options.formBody !== undefined
          ? 'application/x-www-form-urlencoded; charset=utf-8'
          : null;
    const requestHeaders: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'tr-TR,tr;q=0.9,en;q=0.5',
      ...(options.etag ? { 'if-none-match': options.etag } : {}),
      ...(options.lastModified ? { 'if-modified-since': options.lastModified } : {}),
      ...(requestBody !== undefined && requestContentType ? { 'content-type': requestContentType } : {}),
      ...(options.headers ?? {}),
    };

    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const url = new URL(currentUrl);
      const robotsRule = robotsDisallowMatch(url, this.disallowedPaths);
      if (robotsRule) {
        throw new FetchError(currentUrl, `robots.txt kuralı bu adresi yasaklıyor (Disallow: ${robotsRule}); istek gönderilmedi.`, null, false);
      }
      if (!this.isMockDispatcher && shouldBlockExternalHttpInTest(currentUrl, 'source-http')) {
        throw new FetchError(
          currentUrl,
          'Vitest offline guard: gerçek kaynak HTTP isteği engellendi; MockAgent kullanın.',
          null,
          false,
        );
      }
      if (this.maxRequests !== null && this.requestReservations >= this.maxRequests) {
        throw new FetchError(currentUrl, `Tutucu toplam HTTP istek bütçesi doldu (${this.maxRequests}).`, null, false);
      }
      // Eşzamanlı adapter Promise'leri aynı kalan bütçeyi göremez.
      this.requestReservations += 1;
      await this.limiter.wait(
        url.hostname,
        options.minIntervalMs ?? env.SOURCE_MIN_REQUEST_INTERVAL_MS,
        options.signal,
      );

      this.requestCount += 1;
      let response: Pick<DispatchResponseLike, 'statusCode' | 'headers' | 'body'>;
      try {
        response = await request(currentUrl, {
          method,
          headers: requestHeaders,
          dispatcher: this.dispatcherFor(url),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(requestBody !== undefined ? { body: requestBody } : {}),
          // Not: yönlendirmeler burada ELLE izlenir (her adımda SSRF allowlist doğrulaması
          // yapılır), bu yüzden undici'nin kendi yönlendirme takibi (varsayılan: kapalı)
          // kullanılmaz.
          headersTimeout: options.timeoutMs,
          bodyTimeout: options.timeoutMs,
        });
      } catch (error) {
        // SADECE RFC dışı yanıt (HTTPParserError / geçersiz başlık belirteci) için
        // hoşgörülü yedek aktarıma tek sefer düşülür. Zaman aşımı, TLS, bağlantı veya
        // gerçek HTTP durum hataları buraya girmez; o yüzden gerçek arızalar maskelenmez.
        // MockAgent testlerinde yedek enjekte edilmediyse gerçek ağa çıkmamak için atlanır.
        if (!isMalformedResponseError(error) || (this.isMockDispatcher && !this.lenientDispatchInjected)) {
          throw error;
        }
        this.malformedFallbackCount += 1;
        this.logger.warn(
          { url: currentUrl, error: describeFetchFailure(error) },
          'RFC dışı yanıt başlığı; hoşgörülü ayrıştırıcı (node:https, insecureHTTPParser) ile tek sefer yeniden deneniyor (TLS ve kimlik korunur)',
        );
        response = await this.lenientDispatch(currentUrl, {
          method,
          headers: requestHeaders,
          ...(requestBody !== undefined ? { body: requestBody } : {}),
          timeoutMs: options.timeoutMs,
          ...(this.effectiveCa ? { ca: this.effectiveCa } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }

      const status = response.statusCode;
      const headers = normalizeHeaders(response.headers);
      const contentType = headers['content-type'] ?? null;

      if (status >= 300 && status < 400 && headers['location']) {
        this.redirectCount += 1;
        const nextUrl = new URL(headers['location'], currentUrl).toString();
        assertSafeUrl(nextUrl, options.allowedHosts ?? []);
        if (redirect === maxRedirects) {
          throw new FetchError(currentUrl, `Çok fazla yönlendirme (${maxRedirects}).`, status, false);
        }
        // POST yönlendirmesi: 307/308 yöntemi ve gövdeyi korur; 301/302/303
        // tarayıcı davranışıyla GET'e düşer (gövde yeniden gönderilmez).
        if (method === 'POST' && status !== 307 && status !== 308) {
          method = 'GET';
          requestBody = undefined;
          delete requestHeaders['content-type'];
          requestHeaders['accept'] = options.accept ?? 'application/json, text/plain, */*';
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
          `Kaynak geçici olarak hizmet vermiyor (HTTP ${status})${retryAfter !== null ? `; Retry-After: ${retryAfter}s` : ''}.`,
          status,
          true,
          retryAfter === null ? null : retryAfter * 1_000,
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
        const isExpected = options.expectedContentTypes.some((expected) =>
          contentType.toLowerCase().includes(expected),
        );
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
    // Set-Cookie değerleri virgül içerebilir (Expires); satır sonuyla birleştirilir ki ayrıştırılabilsin.
    const separator = key.toLowerCase() === 'set-cookie' ? '\n' : ', ';
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(separator) : value;
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
