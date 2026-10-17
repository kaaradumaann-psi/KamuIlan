/**
 * Eksik sertifika zincirini AIA ile tamamlama (doğrulamayı KAPATMADAN).
 *
 * Sorun: ilan.gov.tr, BDDK, TMSF gibi bazı resmî siteler TLS el sıkışmasında
 * YALNIZCA yaprak sertifikayı gönderir; ara sertifika (intermediate) yoktur.
 * Node/OpenSSL zinciri kendisi tamamlayamadığı için hata
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` olur. Tarayıcılar ve işletim sistemleri bu
 * durumu yaprak sertifikadaki **AIA** (Authority Information Access →
 * "CA Issuers") adresinden ara sertifikayı indirerek çözer. Node bunu yapmaz;
 * bu yüzden geliştiriciler genellikle `NODE_TLS_REJECT_UNAUTHORIZED=0` ile
 * doğrulamayı tümüyle kapatır. Bu modül, doğrulama AÇIK KALARAK aynı çözümü
 * uygular.
 *
 * Güvenlik sınırı (bilinçli tasarım):
 *  - İndirilen sertifika **güven kökü OLMAZ**; yalnızca zincir halkasıdır.
 *    Zincir, zaten güvenilen bir kök tarafından imzalanmışsa kabul edilir.
 *  - Her halka için imza doğrulanır: `çocuk.verify(eklenen.publicKey)`.
 *    İmza tutmuyorsa sertifika zincire EKLENMEZ (AIA adresi saldırgan
 *    kontrolündeyse bile rastgele sertifika güven kazanmaz).
 *  - Eklenen sertifika CA olmalı (`basicConstraints CA:TRUE`) ve süresi
 *    geçerli olmalıdır.
 *  - İndirme SSRF korumalıdır: yalnızca http/https, kullanıcı bilgisi içermeyen
 *    adresler ve YALNIZCA kamuya açık IP'lere çözümlenen host'lar; boyut,
 *    süre, yönlendirme ve indirme sayısı sınırlıdır.
 *  - Sonuçta bağlantı yine Node'un TLS yığını tarafından doğrulanır
 *    (`rejectUnauthorized` açık kalır, host adı denetimi yapılır).
 *
 * Bu modül hiçbir sır içermez; hata metinleri URL/sertifika konusu (CN) ile
 * sınırlıdır (bağlantı dizesi ya da anahtar yazdırılmaz).
 */
import { X509Certificate } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { shouldBlockExternalHttpInTest } from './offline-network';
import { connect as tlsConnect } from 'node:tls';
import { createPublicOnlyLookup } from '../sources/network-safety';

/** Zincir tamamlamada kabul edilen TLS hata kodları (yalnızca "halka eksik" durumları). */
export const CHAIN_INCOMPLETE_ERROR_CODES: readonly string[] = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
];

/** Hata zincirinde (cause) eksik-zincir kodu var mı? */
export function isChainIncompleteError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === 'string' && CHAIN_INCOMPLETE_ERROR_CODES.includes(code)) return true;
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

export interface ChainCompletionOptions {
  /** En çok kaç ek halka indirilebilir (varsayılan 3). */
  maxDepth?: number;
  /** Tek indirme zaman aşımı (varsayılan 5 sn). */
  timeoutMs?: number;
  /** Tek indirme için en çok bayt (varsayılan 1 MiB). */
  maxBytes?: number;
  /** Toplam indirme sayısı sınırı (varsayılan 4; yönlendirmeler dahil). */
  maxFetches?: number;
  /** Şu an (testlerde sabitlenebilir). */
  now?: () => Date;
  /**
   * İndirme işlevi (testlerde enjekte edilir). Varsayılan: SSRF korumalı HTTP(S).
   * `null` dönerse indirme başarısız sayılır.
   */
  fetchIssuer?: (url: string, options: { timeoutMs: number; maxBytes: number }) => Promise<Buffer | null>;
}

export interface ChainCompletionResult {
  /** Zincir güvenilen bir köke bağlandı mı? (yalnızca bu durumda `added` kullanılabilir) */
  ok: boolean;
  /** Kullanıcıya yazılabilir açıklama (sır içermez). */
  reason: string;
  /** Sunucunun sunduğu zincir (leaf → ...). */
  presented: X509Certificate[];
  /** AIA ile bulunan ve DOĞRULANAN ek halkalar (PEM'leri `ca` listesine eklenebilir). */
  added: X509Certificate[];
  /** Zinciri imzalayan güvenilen kök (bulunabildiyse). */
  trustedBy: X509Certificate | null;
  /** Denenen AIA adresleri (tanılama için; içerik değil). */
  attemptedUrls: string[];
}

/** PEM/DER karışımı bir yüklemden sertifika listesi üretir; bozuksa boş döner. */
export function certificatesFromBuffer(buffer: Buffer): X509Certificate[] {
  const text = buffer.toString('utf8');
  const certificates: X509Certificate[] = [];
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    for (const block of blocks) {
      try {
        certificates.push(new X509Certificate(block));
      } catch {
        // Bozuk blok atlanır; diğerleri kullanılabilir.
      }
    }
    return certificates;
  }
  try {
    certificates.push(new X509Certificate(buffer));
  } catch {
    // DER değil ya da bozuk: yok sayılır (çağıran taraf "bulunamadı" der).
  }
  return certificates;
}

/**
 * Sertifikadaki AIA "CA Issuers" adresleri.
 *
 * Node `x509.infoAccess` alanını SATIR SATIR metin olarak verir:
 * `OCSP - URI:http://...` ve `CA Issuers - URI:http://...`. Yalnızca
 * "CA Issuers" satırları işe yarar (OCSP adresleri zincir tamamlamaz).
 */
export function aiaIssuerUrls(cert: X509Certificate): string[] {
  const access = cert.infoAccess;
  if (!access) return [];
  const urls: string[] = [];
  for (const line of String(access).split(/\r?\n/)) {
    const trimmed = line.trim();
    // Biçim: "CA Issuers - URI:http://örnek/ara.crt" (birden çok adres olabilir).
    const match = /^CA Issuers\s*-\s*URI:(.+)$/i.exec(trimmed);
    if (!match) continue;
    for (const candidate of (match[1] ?? '').split(/[,\s]+/)) {
      const url = candidate.trim();
      if (url.length > 0 && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** CA temel kısıtı ve süre geçerliliği (ek halka olabilmenin ön koşulu). */
export function isUsableIssuer(cert: X509Certificate, now: Date = new Date()): boolean {
  if (cert.ca !== true) return false;
  const notBefore = new Date(cert.validFrom).getTime();
  const notAfter = new Date(cert.validTo).getTime();
  const current = now.getTime();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return false;
  return current >= notBefore && current <= notAfter;
}

/** İmza doğrulaması: `child` sertifikasını `issuer` imzalamış mı? */
export function verifiesAgainst(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/** Güvenilen köklerden hangisi bu sertifikayı imzalamış? (yoksa null) */
export function findTrustedIssuer(
  cert: X509Certificate,
  trustedRoots: readonly X509Certificate[],
): X509Certificate | null {
  for (const root of trustedRoots) {
    if (verifiesAgainst(cert, root)) return root;
  }
  return null;
}

/**
 * Sunucunun sunduğu zinciri, AIA adreslerinden indirilen ara sertifikalarla
 * güvenilen bir köke bağlamaya çalışır.
 *
 * @param presented Sunucunun gönderdiği zincir (leaf birinci).
 * @param trustedRoots Zaten güvenilen kökler (Node + sistem + NODE_EXTRA_CA_CERTS).
 */
export async function completeCertificateChain(
  presented: readonly X509Certificate[],
  trustedRoots: readonly X509Certificate[],
  options: ChainCompletionOptions = {},
): Promise<ChainCompletionResult> {
  const maxDepth = options.maxDepth ?? 3;
  const maxFetches = options.maxFetches ?? 4;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const now = options.now ?? (() => new Date());
  const download = options.fetchIssuer ?? defaultFetchIssuer;

  const attemptedUrls: string[] = [];
  const base: ChainCompletionResult = {
    ok: false,
    reason: '',
    presented: [...presented],
    added: [],
    trustedBy: null,
    attemptedUrls,
  };
  if (presented.length === 0) return { ...base, reason: 'Sunucu sertifika sunmadı; zincir tamamlanamaz.' };

  // Zincir zaten güvenilen bir köke bağlanıyorsa yapılacak iş yok.
  const alreadyTrusted = findTrustedIssuer(presented[presented.length - 1]!, trustedRoots);
  if (alreadyTrusted) {
    return { ...base, ok: false, reason: 'Zincir zaten güvenilen bir köke bağlı; tamamlama gerekmiyor.', trustedBy: alreadyTrusted };
  }

  const chain: X509Certificate[] = [...presented];
  const added: X509Certificate[] = [];
  const seen = new Set(chain.map((cert) => cert.fingerprint256));
  let fetches = 0;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const tip = chain[chain.length - 1]!;
    const urls = aiaIssuerUrls(tip).filter((url) => !attemptedUrls.includes(url));
    if (urls.length === 0) {
      return {
        ...base,
        added,
        reason:
          added.length > 0
            ? `Zincire ${added.length} halka eklendi ama GÜVENİLEN bir köke bağlanmadı ` +
              `(${subjectLabel(tip)} için başka AIA adresi yok); tamamlama reddedildi.`
            : `Zincirin son halkası (${subjectLabel(tip)}) AIA adresi içermiyor; eksik halka otomatik bulunamaz.`,
      };
    }

    let progressed = false;
    for (const url of urls) {
      if (fetches >= maxFetches) {
        return {
          ...base,
          added,
          reason: `AIA indirme sınırına ulaşıldı (${maxFetches}); zincir tamamlanamadı.`,
        };
      }
      attemptedUrls.push(url);
      fetches += 1;
      let payload: Buffer | null = null;
      try {
        payload = await download(url, { timeoutMs, maxBytes });
      } catch {
        payload = null;
      }
      if (!payload) continue;
      const candidates = certificatesFromBuffer(payload);
      for (const candidate of candidates) {
        if (seen.has(candidate.fingerprint256)) continue;
        // 1) Bu sertifika gerçekten zincirin son halkasını imzalamış olmalı.
        if (!verifiesAgainst(tip, candidate)) continue;
        // 2) Ara sertifika olmalı ve süresi geçerli olmalı.
        if (!isUsableIssuer(candidate, now())) continue;
        seen.add(candidate.fingerprint256);
        chain.push(candidate);
        added.push(candidate);
        progressed = true;

        // 3) Yeni halka güvenilen bir köke bağlandı mı?
        const trusted = findTrustedIssuer(candidate, trustedRoots);
        if (trusted) {
          return {
            ...base,
            ok: true,
            added,
            trustedBy: trusted,
            reason:
              `Eksik ara sertifika AIA ile tamamlandı: ${subjectLabel(candidate)} ` +
              `(güvenilen kök: ${subjectLabel(trusted)}). Doğrulama açık kaldı.`,
          };
        }
        break; // Zincire bir halka eklendi; üst sınır döngüsünde devam edilir.
      }
      if (progressed) break;
    }
    if (!progressed) {
      return {
        ...base,
        added,
        reason:
          `AIA adreslerinden indirilen sertifikalar ${subjectLabel(tip)} zincirine uymadı ` +
          '(imza doğrulanamadı, CA değil ya da süresi geçersiz); hiçbir halka EKLENMEDİ.',
      };
    }
  }

  return {
    ...base,
    added,
    reason: `Zincir ${maxDepth} ek halkadan sonra da güvenilen bir köke bağlanmadı; tamamlama reddedildi.`,
  };
}

/** Sertifika konusu (CN) — günlüklerde kimlik için; sır içermez. */
export function subjectLabel(cert: X509Certificate): string {
  const subject = cert.subject ?? '';
  const commonName = /CN=([^\n]+)/.exec(subject)?.[1]?.trim();
  return commonName && commonName.length > 0 ? commonName : subject.split('\n')[0] ?? 'bilinmeyen';
}

/**
 * Sunucunun sunduğu zinciri okumak için ham TLS bağlantısı.
 *
 * `rejectUnauthorized: false` burada GÜVENLİDİR: bu bağlantı yalnızca
 * ZİNCİRİ OKUMAK için açılır, veri alışverişi yapılmaz ve doğrulama kararı
 * verilmez. Asıl istek, tamamlanmış `ca` listesiyle ve doğrulama AÇIK olarak
 * yeniden yapılır.
 */
export async function readPresentedChain(options: {
  host: string;
  port: number;
  servername?: string;
  timeoutMs?: number;
  /**
   * DNS çözümleyici. Varsayılan: yalnızca kamuya açık adreslere izin veren bekçi.
   * Testlerde yerel sunucuya bağlanabilmek için enjekte edilir.
   */
  lookup?: ReturnType<typeof createPublicOnlyLookup>;
}): Promise<X509Certificate[]> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const lookup = options.lookup ?? createPublicOnlyLookup();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (certificates: X509Certificate[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(certificates);
    };
    const socket = tlsConnect(
      {
        host: options.host,
        port: options.port,
        servername: options.servername ?? options.host,
        rejectUnauthorized: false,
        lookup,
      },
      () => {
        try {
          const peer = socket.getPeerCertificate(true);
          finish(peerChainCertificates(peer));
        } catch {
          finish([]);
        }
      },
    );
    const timer = setTimeout(() => finish([]), timeoutMs);
    socket.setTimeout(timeoutMs, () => finish([]));
    socket.on('error', () => finish([]));
  });
}

/** `getPeerCertificate(true)` halka yapısını diziye çevirir (döngü korumalı). */
function peerChainCertificates(peer: unknown): X509Certificate[] {
  const certificates: X509Certificate[] = [];
  const seen = new Set<unknown>();
  let current = peer as { issuerCertificate?: unknown; raw?: Buffer } | undefined;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const raw = current.raw;
    if (Buffer.isBuffer(raw)) {
      try {
        certificates.push(new X509Certificate(raw));
      } catch {
        break;
      }
    }
    current = current.issuerCertificate as typeof current;
  }
  return certificates;
}

/**
 * AIA adresinden sertifika indirme (SSRF korumalı).
 *
 * Kurallar: yalnızca http/https, kullanıcı bilgisi yok, host kamuya açık bir
 * IP'ye çözümlenmeli, en çok 2 yönlendirme, süre/boyut sınırlı.
 */
export function defaultFetchIssuer(
  rawUrl: string,
  options: { timeoutMs: number; maxBytes: number },
): Promise<Buffer | null> {
  return downloadOnce(rawUrl, options, 0);
}

function downloadOnce(
  rawUrl: string,
  options: { timeoutMs: number; maxBytes: number },
  redirects: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      resolve(null);
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      resolve(null);
      return;
    }
    if (url.username || url.password) {
      resolve(null);
      return;
    }
    // AIA is a secondary raw node:http(s) path; check every redirect hop as well.
    if (shouldBlockExternalHttpInTest(rawUrl, 'source-http')) {
      resolve(null);
      return;
    }
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const finished = { done: false };
    const done = (value: Buffer | null): void => {
      if (finished.done) return;
      finished.done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = request(
      rawUrl,
      {
        method: 'GET',
        timeout: options.timeoutMs,
        lookup: createPublicOnlyLookup(),
        headers: { accept: 'application/pkix-cert, application/x-x509-ca-cert, */*' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirects >= 2) {
            response.destroy();
            done(null);
            return;
          }
          const next = new URL(response.headers.location, rawUrl).toString();
          response.destroy();
          void downloadOnce(next, options, redirects + 1).then(done);
          return;
        }
        if (status !== 200) {
          response.destroy();
          done(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > options.maxBytes) {
            response.destroy();
            done(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => done(Buffer.concat(chunks)));
        response.on('error', () => done(null));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(null);
    }, options.timeoutMs);
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.end();
  });
}
