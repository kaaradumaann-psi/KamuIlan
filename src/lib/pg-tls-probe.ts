/**
 * Postgres TLS tanı sondası (kimlik bilgisi GEREKTİRMEZ).
 *
 * `pg` sürücüsü bağlantı kuramadığında yalnızca bir hata kodu verir
 * (`SELF_SIGNED_CERT_IN_CHAIN`). Kod, zincirin NEDEN doğrulanamadığını
 * söylemez: sunucunun hangi sertifikaları sunduğu, zincirin hangi halkada
 * koptuğu ve kökün kim olduğu bilinmeden yapılan her öneri tahmindir.
 *
 * Bu modül Postgres'in SSLRequest müzakeresini (8 bayt, kod 80877103) elle
 * yürütür ve TLS el sıkışmasını `rejectUnauthorized: false` ile tamamlar.
 * Amaç bağlantı kurmak değil, sunucunun sunduğu zinciri OKUMAKTIR; bu yüzden
 * parola gönderilmez, startup paketi yazılmaz ve doğrulama kararı burada
 * verilmez. Karar, `evaluateChainTrust` ile kullanıcının GERÇEK güven
 * kümesine (CA dosyası + sistem kökleri) karşı yeniden üretilir.
 *
 * Gizlilik: çıktı yalnızca sunucu adını ve sertifikanın herkese açık
 * alanlarını (subject/issuer/SAN/geçerlilik/parmak izi) içerir. Bağlantı
 * dizesi, parola ve veritabanı içeriği asla yazdırılmaz.
 */
import { createConnection, type Socket } from 'node:net';
import {
  connect as tlsConnect,
  checkServerIdentity,
  getCACertificates,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { extractCn } from './ca-file';
import { loadCaStore } from './tls-trust';

/** Postgres SSLRequest paketinin protokol kodu. */
export const PG_SSL_REQUEST_CODE = 80877103;

export interface CertChainEntry {
  depth: number;
  fingerprint: string;
  subject: string;
  issuer: string;
  subjectCn: string;
  issuerCn: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  isCa: boolean;
  subjectAltNames: string;
  pem: string;
}

export type ProbeFailureCode =
  | 'dns'
  | 'tcp-refused'
  | 'tcp-timeout'
  | 'tcp-error'
  | 'tls-rejected'
  | 'tls-unsupported'
  | 'tls-error'
  | 'url-invalid';

export interface ProbeResult {
  ok: boolean;
  host: string;
  port: number;
  servername: string;
  /** Sunucu SSLRequest'e 'S' yanıtı verdi mi? ('N' → TLS desteklenmiyor) */
  tlsSupported: boolean | null;
  /** Leaf → kök sırasıyla sunulan zincir. */
  chain: CertChainEntry[];
  /** Sunucu adıyla leaf sertifika uyuşuyor mu? */
  hostnameMatch: boolean | null;
  hostnameError: string | null;
  /** Sunulan sertifika zincirindeki saat uyumsuzluğu. */
  clockSkew: 'expired' | 'not-yet-valid' | null;
  failure: ProbeFailureCode | null;
  /** Ham TLS/OS hatası kodu (ör. SELF_SIGNED_CERT_IN_CHAIN, ENOTFOUND). */
  errorCode: string | null;
  errorMessage: string | null;
}

export interface EndpointInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  /** Supabase proje referansı (varsa). */
  projectRef: string | null;
  kind: 'local' | 'supabase-direct' | 'supabase-pooler-session' | 'supabase-pooler-transaction' | 'other';
  kindLabel: string;
}

export function emptyProbeResult(host: string, port: number): ProbeResult {
  return {
    ok: false,
    host,
    port,
    servername: host,
    tlsSupported: null,
    chain: [],
    hostnameMatch: null,
    hostnameError: null,
    clockSkew: null,
    failure: null,
    errorCode: null,
    errorMessage: null,
  };
}

/**
 * Bağlantı dizesini tanılama için çözümler. Parola AYRIŞTIRILIR AMA ASLA
 * döndürülmez; yalnızca kullanıcı adı, host, port ve veritabanı adı çıkar.
 */
export function describePostgresEndpoint(urlString: string): EndpointInfo | null {
  if (!urlString) return null;
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : 5432;
  const normalizedHost = host.toLowerCase();
  const isSupabase = normalizedHost.includes('supabase');
  const isPoolerHost =
    normalizedHost.startsWith('aws-') ||
    normalizedHost.includes('.pooler.') ||
    normalizedHost.startsWith('pooler.');
  const projectRef = /([a-z0-9]{20})/.exec(normalizedHost)?.[1] ?? null;
  const isLocal = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(normalizedHost);

  let kind: EndpointInfo['kind'] = 'other';
  if (isLocal) kind = 'local';
  else if (isSupabase && isPoolerHost) kind = port === 5432 ? 'supabase-pooler-session' : 'supabase-pooler-transaction';
  else if (isSupabase && normalizedHost.startsWith('db.')) kind = 'supabase-direct';
  else if (isSupabase) kind = 'supabase-direct';

  const kindLabel =
    kind === 'local'
      ? 'yerel Postgres'
      : kind === 'supabase-direct'
        ? 'Supabase doğrudan bağlantı (db.<proje>.supabase.co)'
        : kind === 'supabase-pooler-session'
          ? 'Supabase pooler — session modu (5432)'
          : kind === 'supabase-pooler-transaction'
            ? 'Supabase pooler — transaction modu (6543)'
            : 'diğer Postgres sunucusu';

  return {
    host,
    port,
    database: url.pathname.replace(/^\//, '') || '(varsayılan)',
    user: url.username ? decodeURIComponent(url.username) : '(boş)',
    ssl: url.protocol.startsWith('postgres'),
    projectRef,
    kind,
    kindLabel,
  };
}

export interface ProbeOptions {
  host: string;
  port: number;
  /** SNI ve ad doğrulaması için sunucu adı (varsayılan: host). */
  servername?: string;
  timeoutMs?: number;
}

/**
 * Postgres uç noktasına TLS sondası yapar ve sunulan zinciri döner.
 *
 * Akış: TCP → SSLRequest → 'S'/'N' → TLS el sıkışması (doğrulama kapalı,
 * yalnızca OKUMAK için) → zincir + hostname + saat denetimi → kapat.
 */
export async function probePostgresTls(options: ProbeOptions): Promise<ProbeResult> {
  const host = options.host;
  const port = options.port;
  const servername = options.servername ?? host;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = emptyProbeResult(host, port);
  result.servername = servername;

  const socket = await openTcpSocket(host, port, timeoutMs).catch((error: unknown) => {
    applySocketFailure(result, error);
    return null;
  });
  if (!socket) return result;

  try {
    const reply = await readSslReply(socket, timeoutMs);
    if (reply === 'N') {
      result.tlsSupported = false;
      result.failure = 'tls-unsupported';
      result.errorMessage = 'Sunucu TLS desteklemiyor (SSLRequest yanıtı: N).';
      return result;
    }
    if (reply !== 'S') {
      result.failure = 'tls-rejected';
      result.errorMessage = `Sunucu beklenmeyen SSLRequest yanıtı verdi: ${JSON.stringify(reply)}.`;
      return result;
    }
    result.tlsSupported = true;

    const secure = await upgradeToTls(socket, servername, timeoutMs).catch((error: unknown) => {
      applyTlsFailure(result, error);
      return null;
    });
    if (!secure) return result;

    try {
      const peer = secure.getPeerCertificate(true) as PeerCertificateLike | undefined;
      const leaf = secure.getPeerX509Certificate();
      result.chain = buildChain(peer, leaf);
      result.hostnameMatch = null;
      result.hostnameError = null;
      // Ad doğrulaması, sürücünün kendi denetimiyle AYNI API üzerinden yapılır
      // (tls.checkServerIdentity); böylece tanı sonucu gerçek bağlantı davranışını
      // birebir yansıtır. Sertifikanın herkese açık SAN alanı kullanılır.
      const peerForIdentity = peer as PeerCertificate | undefined;
      if (peerForIdentity) {
        const mismatch = checkServerIdentity(servername, peerForIdentity);
        result.hostnameMatch = !mismatch;
        result.hostnameError = mismatch ? mismatch.message : null;
      }
      const now = Date.now();
      const first = result.chain[0];
      if (first) {
        const notAfter = Date.parse(first.validTo);
        const notBefore = Date.parse(first.validFrom);
        if (Number.isFinite(notAfter) && notAfter < now) result.clockSkew = 'expired';
        else if (Number.isFinite(notBefore) && notBefore > now + 60_000) result.clockSkew = 'not-yet-valid';
      }
      result.ok = result.chain.length > 0;
      if (!result.ok) {
        result.failure = 'tls-error';
        result.errorMessage = 'TLS el sıkışması tamamlandı ama sunucu sertifikası okunamadı.';
      }
    } finally {
      secure.destroy();
    }
  } finally {
    socket.destroy();
  }
  return result;
}

interface PeerCertificateLike {
  raw?: unknown;
  subject?: Record<string, unknown>;
  issuer?: Record<string, unknown>;
  valid_from?: string;
  valid_to?: string;
  subjectaltname?: string;
  infoAccess?: unknown;
  issuerCertificate?: PeerCertificateLike;
}

function openTcpSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(Object.assign(new Error(`TCP bağlantısı ${timeoutMs} ms içinde kurulamadı`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    socket.setTimeout(timeoutMs);
  });
}

/** SSLRequest gönderir ve tek baytlık 'S'/'N' yanıtını okur. */
function readSslReply(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('SSLRequest yanıtı zamanında gelmedi'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 1) {
        cleanup();
        resolve(buffer.subarray(0, 1).toString('utf8'));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    socket.on('data', onData);
    socket.once('error', onError);
    const request = Buffer.alloc(8);
    request.writeInt32BE(8, 0);
    request.writeInt32BE(PG_SSL_REQUEST_CODE, 4);
    socket.write(request);
  });
}

/**
 * TLS el sıkışmasını doğrulama YAPMADAN tamamlar.
 *
 * Bu, güvenlik kararının atlanması demek değildir: sonda yalnızca zinciri
 * okur, hiçbir sorgu göndermez ve kararı `evaluateChainTrust` kullanıcının
 * gerçek güven kümesiyle yeniden üretir. Doğrulama açık bırakılsaydı hata
 * kodundan başka bilgi alınamaz ve tanılama imkânsız olurdu.
 */
function upgradeToTls(socket: Socket, servername: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({
      socket,
      servername,
      rejectUnauthorized: false,
      requestCert: false,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      secure.destroy();
      reject(Object.assign(new Error(`TLS el sıkışması ${timeoutMs} ms içinde tamamlanmadı`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    secure.once('secure', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure.destroy();
      reject(error);
    });
  });
}

/** `getPeerCertificate(true)` halkalarını leaf → kök sırasına çevirir. */
function buildChain(peer: PeerCertificateLike | undefined, leaf: X509Certificate | undefined): CertChainEntry[] {
  const entries: CertChainEntry[] = [];
  const seen = new Set<string>();
  let current: PeerCertificateLike | undefined = peer;
  let depth = 0;

  while (current && depth < 12) {
    const raw = current.raw;
    let cert: X509Certificate | null = null;
    if (raw instanceof Uint8Array && raw.length > 0) {
      try {
        cert = new X509Certificate(raw as Uint8Array);
      } catch {
        cert = null;
      }
    }
    if (!cert) {
      // Sıra dışı durum: ham sertifika yoksa leaf ile en azından bir halka üret.
      if (depth === 0 && leaf) cert = leaf;
      else break;
    }
    if (!cert) break;
    const fingerprint = cert.fingerprint256;
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);

    const subject = cert.subject.replace(/\n/g, ', ');
    const issuer = cert.issuer.replace(/\n/g, ', ');
    const subjectCn = extractCn(cert.subject);
    const issuerCn = extractCn(cert.issuer);
    entries.push({
      depth,
      fingerprint,
      subject,
      issuer,
      subjectCn,
      issuerCn,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      selfSigned: subjectCn !== '' && subjectCn === issuerCn && safeVerify(cert, cert),
      isCa: cert.ca || (cert.keyUsage ?? []).includes('keyCertSign'),
      subjectAltNames: cert.subjectAltName ?? '',
      pem: cert.toString().trim(),
    });
    depth += 1;
    const next = current.issuerCertificate;
    // Node, zincirin son halkasında issuerCertificate'i kendine bağlar.
    current = next && next !== current ? next : undefined;
  }
  return entries;
}

function safeVerify(cert: X509Certificate, publicKeyCert: X509Certificate): boolean {
  try {
    return cert.verify(publicKeyCert.publicKey);
  } catch {
    return false;
  }
}

function applySocketFailure(result: ProbeResult, error: unknown): void {
  const code = errorCodeOf(error);
  result.errorCode = code;
  result.errorMessage = error instanceof Error ? error.message : String(error);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') result.failure = 'dns';
  else if (code === 'ECONNREFUSED') result.failure = 'tcp-refused';
  else if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') result.failure = 'tcp-timeout';
  else result.failure = 'tcp-error';
}

function applyTlsFailure(result: ProbeResult, error: unknown): void {
  const code = errorCodeOf(error);
  result.errorCode = code;
  result.errorMessage = error instanceof Error ? error.message : String(error);
  result.failure = 'tls-error';
}

function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/* ---------------------------------------------------------------------------
 * Zincir güven değerlendirmesi
 * ------------------------------------------------------------------------- */

export type ChainTrustLevel = 'trusted' | 'untrusted';

export interface ChainTrustResult {
  trusted: boolean;
  /**
   * Güven, zincirin LEAF sertifikasının birebir çapa listesinde bulunmasından
   * mı geldi? Node/OpenSSL bu durumda bağlantıyı kabul eder (açıkça güvenilen
   * sertifika), ancak bu bir CA pinning'i DEĞİLDİR: sunucu sertifikası
   * yenilendiğinde bağlantı yeniden kopar. Tanıda ayrıca raporlanır.
   */
  leafIsAnchor: boolean;
  level: ChainTrustLevel;
  /** Kaç çapa (anchor) denendi. */
  anchorCount: number;
  /** Zinciri doğrulayan çapalar (parmak izi + CN). */
  matched: { fingerprint: string; subjectCn: string; subject: string; selfSigned: boolean }[];
  /** Zincirde sunucunun GÖNDERMEDİĞİ, güvenilen halka var mı? (partial chain) */
  partialChain: boolean;
  /** Güven eksikliğinin en olası nedeni. */
  reason: 'verified' | 'no-anchor-signs-chain' | 'missing-intermediate' | 'no-anchors' | 'no-chain';
}

/**
 * Sunulan zinciri verilen güven çapalarına karşı doğrular.
 *
 * Node/OpenSSL davranışı birebir taklit edilmez; üç pratik yol denetlenir:
 *  1. Zincirdeki bir sertifika çapalarla birebir aynı (parmak izi).
 *  2. Zincirdeki bir sertifikanın imzası bir çapanın açık anahtarıyla doğrulanır
 *     (kök → leaf ya da kök → ara → leaf'in herhangi bir halkası).
 *  3. Zincirde kendi kendini imzalayan bir kök var ama çapalarda yoksa zincir
 *     KOPUKTUR (SELF_SIGNED_CERT_IN_CHAIN'in gerçek anlamı).
 */
export function evaluateChainTrust(chain: CertChainEntry[], anchorsPem: string[]): ChainTrustResult {
  if (chain.length === 0) {
    return {
      trusted: false,
      leafIsAnchor: false,
      level: 'untrusted',
      anchorCount: 0,
      matched: [],
      partialChain: false,
      reason: 'no-chain',
    };
  }
  const anchors = parseAnchors(anchorsPem);
  if (anchors.length === 0) {
    return {
      trusted: false,
      leafIsAnchor: false,
      level: 'untrusted',
      anchorCount: 0,
      matched: [],
      partialChain: false,
      reason: 'no-anchors',
    };
  }

  const anchorByFingerprint = new Map(anchors.map((anchor) => [anchor.cert.fingerprint256, anchor]));
  const matched: ChainTrustResult['matched'] = [];
  let verified = false;
  let partialChain = false;
  let leafIsAnchor = false;

  for (const entry of chain) {
    const identical = anchorByFingerprint.get(entry.fingerprint);
    if (identical) {
      verified = true;
      if (entry.depth === 0) leafIsAnchor = true;
      matched.push({
        fingerprint: entry.fingerprint,
        subjectCn: identical.subjectCn,
        subject: identical.cert.subject.replace(/\n/g, ', '),
        selfSigned: identical.selfSigned,
      });
      continue;
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(entry.pem);
    } catch {
      continue;
    }
    for (const anchor of anchors) {
      if (safeVerify(cert, anchor.cert)) {
        verified = true;
        // İmzalayan çapa, zincirin GÖNDERİLMEYEN bir halkasıysa zincir eksiktir.
        if (anchor.cert.fingerprint256 !== entry.fingerprint) partialChain = true;
        matched.push({
          fingerprint: anchor.cert.fingerprint256,
          subjectCn: anchor.subjectCn,
          subject: anchor.cert.subject.replace(/\n/g, ', '),
          selfSigned: anchor.selfSigned,
        });
      }
    }
  }

  const uniqueMatched = dedupeMatched(matched);
  return {
    trusted: verified,
    leafIsAnchor,
    level: verified ? 'trusted' : 'untrusted',
    anchorCount: anchors.length,
    matched: uniqueMatched,
    partialChain,
    reason: verified ? 'verified' : 'no-anchor-signs-chain',
  };
}

function dedupeMatched(matched: ChainTrustResult['matched']): ChainTrustResult['matched'] {
  const seen = new Set<string>();
  return matched.filter((entry) => {
    if (seen.has(entry.fingerprint)) return false;
    seen.add(entry.fingerprint);
    return true;
  });
}

interface ParsedAnchor {
  cert: X509Certificate;
  subjectCn: string;
  selfSigned: boolean;
}

/** PEM listesi (dizi ya da çok blokluk tek metin) → çözümlenmiş çapalar. */
export function parseAnchors(anchorsPem: readonly string[]): ParsedAnchor[] {
  const anchors: ParsedAnchor[] = [];
  const seen = new Set<string>();
  for (const value of anchorsPem) {
    const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    for (const block of blocks) {
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(block);
      } catch {
        continue;
      }
      const fingerprint = cert.fingerprint256;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const subjectCn = extractCn(cert.subject);
      anchors.push({
        cert,
        subjectCn,
        selfSigned: subjectCn !== '' && subjectCn === extractCn(cert.issuer) && safeVerify(cert, cert),
      });
    }
  }
  return anchors;
}

/** Node'un gömülü + sistem + NODE_EXTRA_CA_CERTS kökleri (tanı için). */
export function systemTrustAnchors(): string[] {
  return loadCaStore() ?? [];
}

/** Yalnızca Node'un gömülü Mozilla kökleri (tanı için). */
export function defaultTrustAnchors(): string[] {
  if (typeof getCACertificates !== 'function') return [];
  try {
    return getCACertificates('default') ?? [];
  } catch {
    return [];
  }
}

/** Bağlantı dizesinden hedefi çıkarır ve sondayı çalıştırır. */
export async function probeEndpointFromUrl(
  urlString: string,
  options: { timeoutMs?: number } = {},
): Promise<{ endpoint: EndpointInfo | null; probe: ProbeResult | null }> {
  const endpoint = describePostgresEndpoint(urlString);
  if (!endpoint) return { endpoint: null, probe: null };
  const probe = await probePostgresTls({
    host: endpoint.host,
    port: endpoint.port,
    timeoutMs: options.timeoutMs,
  });
  return { endpoint, probe };
}
