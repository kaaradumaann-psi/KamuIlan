/**
 * Depoda sabitlenmiş ara sertifikalar (doğrulamayı KAPATMADAN eksik zinciri tamamlama).
 *
 * Sorun (22.10.2026 `openssl s_client -showcerts` ile doğrulandı): www.ilan.gov.tr ve
 * www.tmsf.org.tr TLS el sıkışmasında YALNIZCA yaprak sertifikayı gönderir; yaprağı
 * imzalayan "GeoTrust TLS RSA CA G1" ara sertifikası eksiktir. Windows bu halkayı kendi
 * deposundan/AIA'dan tamamladığı için yerelde çalışır; Ubuntu + Node'da zincir kurulamaz
 * ve istek `UNABLE_TO_VERIFY_LEAF_SIGNATURE` ile reddedilir.
 *
 * Çözüm: eksik ara sertifika yetkili kaynağından (yaprağın AIA "CA Issuers" adresi)
 * bir kez alınıp `certs/intermediates/*.pem` altında depoya konur. HTTP istemcisi bu
 * dosyaları güven listesine EK HALKA olarak katar. Güvenlik sınırı:
 *  - Her dosya yüklenirken CA olmalı (`basicConstraints CA:TRUE`), süresi geçerli
 *    olmalı ve imzası zaten güvenilen bir KÖK sertifikayla doğrulanmalıdır. Aksi
 *    halde dosya YOK SAYILIR (bozuk/sahte dosya güven kazanamaz).
 *  - Node/OpenSSL kısmi zinciri kabul etmez (X509_V_FLAG_PARTIAL_CHAIN kapalı): ara
 *    sertifika tek başına güven kökü olamaz; zincir yine kendinden imzalı bir köke
 *    bağlanmak zorundadır. Host adı ve süre denetimi her istekte Node tarafından yapılır.
 *  - Bu dosyalar herkese açık sertifikalardır; sır içermez.
 */
import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUsableIssuer, verifiesAgainst } from './tls-chain-completion';

/** Depodaki ara sertifika klasörü (`certs/intermediates`). */
export function bundledIntermediatesDir(): string {
  return fileURLToPath(new URL('../../certs/intermediates/', import.meta.url));
}

export interface BundledIntermediates {
  /** Doğrulanmış ara sertifikalar (PEM). */
  accepted: string[];
  /** Reddedilen dosyalar ve nedenleri (günlük/tanı için; sertifika içeriği yazılmaz). */
  rejected: { file: string; reason: string }[];
}

function pemBlocks(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * `dir` içindeki `.pem`/`.crt` dosyalarını okur ve yalnızca `roots` içindeki
 * kendinden imzalı bir kök tarafından imzalanmış, süresi geçerli CA sertifikalarını döndürür.
 */
export function loadBundledIntermediates(
  roots: readonly string[],
  options: { dir?: string; now?: Date } = {},
): BundledIntermediates {
  const dir = options.dir ?? bundledIntermediatesDir();
  const now = options.now ?? new Date();
  const result: BundledIntermediates = { accepted: [], rejected: [] };
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => /\.(pem|crt)$/i.test(name))
      .sort();
  } catch {
    return result;
  }
  const rootCertificates = roots
    .map((pem) => {
      try {
        return new X509Certificate(pem);
      } catch {
        return null;
      }
    })
    .filter((certificate): certificate is X509Certificate => certificate !== null)
    // Yalnız kendinden imzalı kökler çapa olabilir (zincir zinciri doğrulamaz).
    .filter((certificate) => certificate.subject === certificate.issuer);

  for (const file of files) {
    let blocks: string[];
    try {
      blocks = pemBlocks(readFileSync(join(dir, file), 'utf8'));
    } catch {
      result.rejected.push({ file, reason: 'okunamadı' });
      continue;
    }
    if (blocks.length === 0) {
      result.rejected.push({ file, reason: 'PEM sertifika bloğu yok' });
      continue;
    }
    for (const block of blocks) {
      let certificate: X509Certificate;
      try {
        certificate = new X509Certificate(block);
      } catch {
        result.rejected.push({ file, reason: 'sertifika ayrıştırılamadı' });
        continue;
      }
      if (!isUsableIssuer(certificate, now)) {
        result.rejected.push({ file, reason: 'CA değil ya da geçerlilik süresi dışında' });
        continue;
      }
      const signedByRoot = rootCertificates.some(
        (root) => root.subject === certificate.issuer && verifiesAgainst(certificate, root),
      );
      if (!signedByRoot) {
        result.rejected.push({ file, reason: 'güvenilen bir kök tarafından imzalanmamış' });
        continue;
      }
      result.accepted.push(certificate.toString().trim());
    }
  }
  return result;
}
