/**
 * CA dosyası çözümleme, doğrulama ve güvenilir kök listesi üretimi.
 *
 * Neden ayrı modül: `POSTGRES_SSL_CA_FILE` verildiğinde Postgres sunucu
 * sertifikası YALNIZCA o dosyadaki köklerle doğrulanır. Dosya yanlışsa
 * (eksik yol, HTML indirme sayfası, DER biçimi, özel anahtar, CA yerine
 * sunucu/leaf sertifikası) sonuç her zaman aynı kafa karıştırıcı hata olur:
 * `SELF_SIGNED_CERT_IN_CHAIN`. Bu modül "dosya okundu mu?" sorusunu
 * "dosya bu bağlantıyı doğrulamaya YETERLİ mi?" sorusuna çevirir:
 *
 *  1. Yol çözümleme: göreli yollar çalışma dizinine VE `.env` dosyasının
 *     bulunduğu proje köküne göre denenir (npm betikleri farklı dizinden
 *     çalıştırıldığında `./certs/...` yolu kaybolmasın).
 *  2. İçerik normalleştirme: DER (ikili) sertifika PEM'e çevrilir, PEM
 *     blokları ayrıştırılır; içerik sertifika değilse NEDENİ söylenir.
 *  3. Anlam denetimi: her sertifika `X509Certificate` ile açılır; CA mı,
 *     leaf mi, süresi geçmiş mi, kendi kendine mi imzalı, dosyadaki
 *     zincir eksik mi (ara CA yok) tek tek raporlanır.
 *
 * Güvenlik kuralı değişmez: doğrulama hiçbir yolda KAPATILMAZ. Okunamayan
 * veya geçersiz dosya "sistem kökleriyle devam et" demek değildir; açık hata
 * ya da tanılama üretir (bkz. `loadTrustedCaCertificates`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, normalize as normalizePath, resolve as resolvePath } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { envFileSource } from '../config/load-env';

const PEM_CERT_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/;

/** Dosya içeriği sertifika değilse olası nedenler (kullanıcıya gösterilir). */
export type CaFileIssueCode =
  | 'not-found'
  | 'unreadable'
  | 'empty'
  | 'html'
  | 'private-key'
  | 'der'
  | 'no-certificate'
  | 'parse-failed'
  | 'leaf-not-ca'
  | 'expired'
  | 'not-yet-valid'
  | 'incomplete-chain';

export interface CaFileIssue {
  code: CaFileIssueCode;
  /** Sorun; bağlantıyı reddeder (hata). */
  blocking: boolean;
  message: string;
}

/** Dosyadaki tek bir sertifikanın özeti (herkese açık alanlar; sır içermez). */
export interface CaCertSummary {
  subject: string;
  issuer: string;
  serial: string;
  fingerprint: string;
  notBefore: string;
  notAfter: string;
  selfSigned: boolean;
  isCa: boolean;
  pem: string;
}

export interface CaFileReport {
  /** `.env` içinde yazıldığı gibi (göreli olabilir). */
  requestedPath: string;
  /** Diskte bulunan tam yol; bulunamadıysa `null`. */
  resolvedPath: string | null;
  /** Denenen aday yollar (tanılama çıktısında gösterilir). */
  candidates: string[];
  exists: boolean;
  /** Dosyadan çıkarılan PEM blokları (DER → PEM dönüşümü dahil). */
  certificates: CaCertSummary[];
  /** Dosyadaki PEM bloğu sayısı (çözümlenemeyenler dahil). */
  pemBlockCount: number;
  issues: CaFileIssue[];
  warnings: CaFileIssue[];
  /** Dosyadaki köklerle zincir doğrulanabilir görünüyor mu? (blocking sorun yok + en az bir CA) */
  usable: boolean;
}

export interface TrustedCaResult {
  /** `pg`/Node TLS'e verilecek PEM listesi. */
  certificates: string[];
  /** Yalnızca CA dosyası mı kullanıldı? (merge kapalıyken true) */
  fileOnly: boolean;
  report: CaFileReport;
}

/**
 * Proje kökü: `.env` dosyasının bulunduğu dizin (yüklenmediyse çalışma dizini).
 *
 * `.env` her zaman `process.cwd()` kökünden arandığı için bu iki değer normalde
 * aynıdır; ayrım, betikler alt dizinden çalıştırıldığında göreli CA yolunun
 * yine de bulunmasını sağlar.
 */
export function projectRoot(): string {
  const source = envFileSource();
  return source ? dirname(source) : process.cwd();
}

/** Göreli bir yolu `.env` köküne göre mutlak hâle getirir. */
export function resolveFromProjectRoot(value: string): string {
  return resolvePath(projectRoot(), value);
}

/**
 * CA dosyası için denenecek yollar (öncelik sırasıyla):
 *  1. Verilen yol (mutlak ya da çalışma dizinine göre).
 *  2. Proje köküne (`.env` dizini) göre aynı yol.
 * Tekilleştirilmiş ve sırası korunmuş liste döner.
 *
 * Neden iki kök: npm betikleri çoğunlukla proje kökünden çalışır, ancak
 * `npm --prefix` ya da alt dizinden çağrıldığında `./certs/supabase-ca.crt`
 * yolu kaybolur ve kullanıcı "dosya var ama bulunamadı" duvarına çarpar.
 */
export function caFilePathCandidates(rawPath: string, root: string = projectRoot()): string[] {
  const trimmed = stripQuotes(rawPath.trim());
  const candidates = [resolvePath(process.cwd(), trimmed)];
  const fromRoot = resolvePath(root, trimmed);
  if (!candidates.includes(fromRoot)) candidates.push(fromRoot);
  return candidates;
}

/** Yol değerindeki sarmalayan tırnakları temizler (`.env` içinde yazılmış olabilir). */
function stripQuotes(value: string): string {
  const quote = value.charAt(0);
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** `~` ve ortam değişkeni içeren yolları genişletir (Windows `%VAR%` dahil). */
export function expandPathTokens(value: string): string {
  let expanded = value;
  if (expanded.startsWith('~/') || expanded === '~') {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    if (home) expanded = resolvePath(home, expanded.slice(1).replace(/^\//, ''));
  }
  const beforeTokens = expanded;
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '');
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => process.env[name] ?? '');
  // Değişken genişletildiyse ayraçlar platforma göre birleştirilir: Windows'ta
  // "%USERPROFILE%/certs/x.pem" → "C:\Users\…/certs/x.pem" karışık kalıyordu.
  return expanded === beforeTokens ? expanded : normalizePath(expanded);
}

/** PEM gövdesini 64 sütuna sarar (bazı TLS yığınları uzun satırı reddeder). */
function wrapBase64(body: string): string {
  const compact = body.replace(/\s+/g, '');
  const lines: string[] = [];
  for (let index = 0; index < compact.length; index += 64) lines.push(compact.slice(index, index + 64));
  return lines.join('\n');
}

/**
 * DER (ikili) sertifika → PEM. DER değilse `null`.
 *
 * DER bir X.509 sertifikası `0x30` (SEQUENCE) + uzunluk alanı + içerik'tir.
 * PEM'e çevirirken dosyanın TAMAMI base64'lanır (başlık dahil); içerikten bayt
 * atlamak sertifikayı bozar ve `asn1 encoding routines::wrong tag` hatası verir.
 * Uzunluk alanı dosya boyutuyla tutarsızsa giriş DER sayılmaz (ör. bir HTML ya
 * da metin dosyasının ilk baytları `0x30` olabilir).
 */
export function derToPem(buffer: Buffer): string | null {
  if (buffer.length < 4 || buffer[0] !== 0x30) return null;
  const lengthByte = buffer[1] ?? 0;
  if (lengthByte & 0x80) {
    const octets = lengthByte & 0x7f;
    if (octets === 0 || octets > 4 || buffer.length < 2 + octets) return null;
    let contentLength = 0;
    for (let index = 0; index < octets; index += 1) {
      contentLength = contentLength * 256 + (buffer[2 + index] ?? 0);
    }
    if (contentLength <= 0 || 2 + octets + contentLength !== buffer.length) return null;
  } else if (2 + lengthByte !== buffer.length) {
    return null;
  }
  const body = buffer.toString('base64');
  if (body.length < 64) return null;
  return `-----BEGIN CERTIFICATE-----\n${wrapBase64(body)}\n-----END CERTIFICATE-----\n`;
}

function issue(code: CaFileIssueCode, message: string, blocking: boolean): CaFileIssue {
  return { code, blocking, message };
}

/** X509Certificate alanlarından kısa, okunabilir özet üretir. */
function summarize(cert: X509Certificate, pem: string): CaCertSummary {
  const subjectCn = extractCn(cert.subject);
  const issuerCn = extractCn(cert.issuer);
  const keyUsage = cert.keyUsage ?? [];
  return {
    subject: cert.subject.replace(/\n/g, ', ') || '(boş)',
    issuer: cert.issuer.replace(/\n/g, ', ') || '(boş)',
    serial: cert.serialNumber,
    fingerprint: cert.fingerprint256,
    notBefore: cert.validFrom,
    notAfter: cert.validTo,
    // Teknik olarak "CA" kararı basicConstraints CA:TRUE'dır; pratikte kök
    // sertifikalar kendi kendini imzalar, bu yüzden iki koşul birlikte bakılır.
    selfSigned: subjectCn !== '' && subjectCn === issuerCn && cert.verify(cert.publicKey),
    isCa: cert.ca || keyUsage.includes('keyCertSign'),
    pem: pem.trim(),
  };
}

/** X.509 subject/issuer metninden CN değerini çeker. */
export function extractCn(distinguishedName: string): string {
  const match = /(?:^|\n)CN=([^\n]*)/.exec(distinguishedName);
  return (match?.[1] ?? '').trim();
}

/**
 * CA dosyasını okur, çözümler ve raporlar. Bu fonksiyon HATA FIRLATMAZ:
 * çağırana göre ya tanılama (doctor/env:check) ya da açık ret (store) üretilir.
 */
export function inspectCaFile(rawPath: string, options: { root?: string } = {}): CaFileReport {
  const requestedPath = rawPath;
  const expanded = expandPathTokens(rawPath);
  const candidates = caFilePathCandidates(expanded, options.root ?? projectRoot());
  const resolvedPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
  const report: CaFileReport = {
    requestedPath,
    resolvedPath,
    candidates,
    exists: resolvedPath !== null,
    certificates: [],
    pemBlockCount: 0,
    issues: [],
    warnings: [],
    usable: false,
  };

  if (!resolvedPath) {
    report.issues.push(
      issue(
        'not-found',
        `CA dosyası bulunamadı: ${requestedPath}\n     Denenen yollar:\n${candidates
          .map((candidate) => `       - ${candidate}`)
          .join('\n')}`,
        true,
      ),
    );
    return report;
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolvedPath);
  } catch (error) {
    report.issues.push(
      issue('unreadable', `CA dosyası okunamadı (${describeError(error)}): ${resolvedPath}`, true),
    );
    return report;
  }

  if (buffer.length === 0 || buffer.toString('utf8').trim().length === 0) {
    report.issues.push(issue('empty', `CA dosyası boş: ${resolvedPath}`, true));
    return report;
  }

  const text = buffer.toString('utf8');

  if (PRIVATE_KEY_PATTERN.test(text)) {
    report.issues.push(
      issue(
        'private-key',
        `CA dosyası ÖZEL ANAHTAR içeriyor: ${resolvedPath}. Güvenilir kök olarak yalnızca ` +
          'sertifika (PUBLIC) verilir; özel anahtar dosyaya yazılmaz ve repoya gönderilmez.',
        true,
      ),
    );
  }

  if (/<\s*(?:!doctype\s+html|html|head|body|script)\b/i.test(text)) {
    report.issues.push(
      issue(
        'html',
        `CA dosyası HTML görünüyor (indirme sayfası kaydedilmiş olabilir): ${resolvedPath}. ` +
          'Dosya -----BEGIN CERTIFICATE----- ile başlayan PEM içermelidir.',
        true,
      ),
    );
  }

  // PEM blokları toplanır; hiç yoksa DER (ikili) olasılığı denenir.
  const blocks = text.match(PEM_CERT_PATTERN) ?? [];
  report.pemBlockCount = blocks.length;
  const pemCandidates: { pem: string; origin: 'pem' | 'der' }[] = blocks.map((pem) => ({
    pem: pem.trim(),
    origin: 'pem' as const,
  }));

  if (pemCandidates.length === 0) {
    const converted = derToPem(buffer);
    if (converted) {
      pemCandidates.push({ pem: converted.trim(), origin: 'der' });
      report.warnings.push(
        issue(
          'der',
          `CA dosyası ikili (DER) biçimdeydi, PEM'e çevrildi: ${resolvedPath}. Node DER'i de kabul eder ` +
            'ancak dosyanın PEM olarak saklanması önerilir.',
          false,
        ),
      );
    } else {
      report.issues.push(
        issue(
          'no-certificate',
          `CA dosyasında sertifika bulunamadı: ${resolvedPath}. Dosya -----BEGIN CERTIFICATE----- ... ` +
            '-----END CERTIFICATE----- bloğu içermelidir (Base64 gövde, PEM).',
          true,
        ),
      );
      return finish(report);
    }
  }

  for (const candidate of pemCandidates) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(candidate.pem);
    } catch (error) {
      report.issues.push(
        issue(
          'parse-failed',
          `PEM bloğu sertifika olarak çözümlenemedi (${describeError(error)}): ${resolvedPath}. ` +
            'Dosya kopyalanırken kırpılmış/bozulmuş olabilir; panelden yeniden indirin.',
          true,
        ),
      );
      continue;
    }
    report.certificates.push(summarize(cert, candidate.pem));
  }

  if (report.certificates.length === 0) return finish(report);

  const now = Date.now();
  const hasCaCertificate = report.certificates.some((entry) => entry.isCa);
  for (const entry of report.certificates) {
    const label = describeCertShort(entry);
    if (!entry.isCa) {
      // Dosyada en az bir gerçek CA varsa, ek leaf sertifikası zararsızdır
      // (panelden indirilen dosyalar çoğunlukla tam zinciri içerir).
      if (hasCaCertificate) {
        report.warnings.push(
          issue(
            'leaf-not-ca',
            `${label} bir CA değil; dosyada gerçek CA bulunduğu için yok sayılıyor (doğrulamayı etkilemez).`,
            false,
          ),
        );
      } else if (entry.selfSigned) {
        // Node/OpenSSL kendi kendini imzalayan leaf'i "açıkça güvenilen sertifika"
        // olarak kabul eder: bağlantı bugünlük çalışır ama pinning kırılgandır.
        report.warnings.push(
          issue(
            'leaf-not-ca',
            `${label} kendi kendini imzalıyor ama CA değil (basicConstraints CA:TRUE yok). Node bu ` +
              'sertifikayı açıkça güvenilen sertifika olarak kabul eder; sunucu sertifikası ' +
              'YENİLENDİĞİNDE bağlantı tekrar kopar. Kalıcı çözüm: panelden CA sertifikasını indirin ' +
              '(Supabase: Database Settings → SSL Configuration → CA certificate).',
            false,
          ),
        );
      } else {
        report.issues.push(
          issue(
            'leaf-not-ca',
            `${label} bir CA sertifikası DEĞİL (basicConstraints CA:TRUE yok) ve kendi kendini imzalamıyor. ` +
              'Sunucu sertifikası (leaf) güvenilir kök olarak kullanılamaz; zincir bu dosyayla doğrulanmaz. ' +
              'Panelden CA sertifikasını indirin (Supabase: Database Settings → SSL Configuration → CA certificate).',
            true,
          ),
        );
      }
    }
    const notBefore = Date.parse(entry.notBefore);
    const notAfter = Date.parse(entry.notAfter);
    if (Number.isFinite(notAfter) && notAfter < now) {
      report.issues.push(
        issue('expired', `${label} süresi dolmuş (${entry.notAfter}). Sistem saatini ve sertifikayı kontrol edin.`, true),
      );
    } else if (Number.isFinite(notBefore) && notBefore > now + 60_000) {
      report.issues.push(
        issue(
          'not-yet-valid',
          `${label} henüz geçerli değil (${entry.notBefore}). Sistem saati geri kalmış olabilir.`,
          true,
        ),
      );
    }
  }

  // Dosya içi zincir denetimi: birden çok sertifika varsa her leaf'in ihracısı
  // dosyada bulunmalıdır. Kök (kendi kendini imzalayan) için ihracı aranmaz.
  if (report.certificates.length > 1) {
    const bySubject = new Map(report.certificates.map((entry) => [entry.subject, entry]));
    for (const entry of report.certificates) {
      if (entry.selfSigned) continue;
      if (!bySubject.has(entry.issuer)) {
        report.warnings.push(
          issue(
            'incomplete-chain',
            `${describeCertShort(entry)} sertifikasının ihracısı (${entry.issuer}) dosyada yok: ` +
              'ara (intermediate) CA eksik olabilir. Panelden indirilen tam zinciri ekleyin ya da ' +
              'POSTGRES_SSL_CA_MERGE_SYSTEM=1 ile sistem köklerini birleştirin.',
            false,
          ),
        );
      }
    }
  }

  return finish(report);
}

function finish(report: CaFileReport): CaFileReport {
  report.usable = report.certificates.length > 0 && report.issues.every((entry) => !entry.blocking);
  return report;
}

/** Sertifika özeti → tek satırlık insan okunur etiket. */
export function describeCertShort(entry: CaCertSummary): string {
  const cn = extractCn(entry.subject) || entry.subject;
  const kind = entry.isCa ? (entry.selfSigned ? 'kök CA' : 'ara CA') : 'sunucu sertifikası';
  return `${cn} (${kind})`;
}

/** Raporun sorun/uyarı metinlerini girintili liste olarak döner. */
export function formatCaFileIssues(report: CaFileReport, indent = '  '): string[] {
  const lines: string[] = [];
  for (const entry of report.issues) lines.push(`${indent}✖ ${entry.message.replace(/\n/g, `\n${indent}`)}`);
  for (const entry of report.warnings) lines.push(`${indent}! ${entry.message.replace(/\n/g, `\n${indent}`)}`);
  return lines;
}

/**
 * CA dosyasını güvenilir kök listesine çevirir.
 *
 * `mergeSystem=true` ise dosya kökleri, Node'un gömülü Mozilla kökleri +
 * işletim sistemi deposu + `NODE_EXTRA_CA_CERTS` ile BİRLEŞTİRİLİR. Bu,
 * hem Supabase proje CA'sına hem de kurumsal TLS denetimi köküne aynı anda
 * güvenmek gerektiğinde kullanılır; doğrulama yine AÇIKTIR (yalnızca güven
 * kümesi genişler). Varsayılan (`mergeSystem=false`) mevcut davranışı korur:
 * sunucu sertifikası YALNIZCA dosyadaki köklerle doğrulanır.
 *
 * Dosya blocking bir sorun içeriyorsa hata fırlatılır: doğrulamasız
 * bağlantıya SESSİZCE düşülmez.
 */
export function loadTrustedCaCertificates(
  rawPath: string,
  options: { mergeSystem?: boolean; systemCaStore?: () => string[] | undefined } = {},
): TrustedCaResult {
  const report = inspectCaFile(rawPath);
  if (!report.usable) {
    const detail = report.issues.map((entry) => entry.message).join('\n  ');
    throw new Error(
      `POSTGRES_SSL_CA_FILE kullanılamadı (${rawPath}). Doğrulamasız bağlantıya düşülmedi.\n  ${detail}\n` +
        'Tanılama: npm run db:tls-doctor — kurulum: docs/database-tls.md',
    );
  }
  const fileCerts = report.certificates.map((entry) => entry.pem);
  if (!options.mergeSystem) {
    return { certificates: fileCerts, fileOnly: true, report };
  }
  const load = options.systemCaStore;
  const merged = new Set<string>(fileCerts);
  if (load) {
    for (const cert of load() ?? []) merged.add(cert.trim());
  }
  return { certificates: [...merged], fileOnly: false, report };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
