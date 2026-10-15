/**
 * Eksik zinciri AIA ile tamamlama (doğrulama açık kalır).
 *
 * Gerçek senaryo: bazı resmî siteler TLS'te yalnızca yaprak sertifikayı
 * gönderir; Node `UNABLE_TO_VERIFY_LEAF_SIGNATURE` verir ve geliştirici
 * doğrulamayı kapatmaya yönelir. Burada zincir openssl ile GERÇEKTEN üretilir
 * (kök → ara → yaprak), yaprağa AIA adresi yazılır ve indirme ENJEKTE edilir:
 * test hiçbir gerçek ağa çıkmaz.
 *
 * Doğrulanan güvenlik sınırları:
 *  - Eklenen halka zinciri gerçekten imzalamış olmalı (imza doğrulanır).
 *  - Eklenen halka CA olmalı ve süresi geçerli olmalı.
 *  - Zincir güvenilen bir köke bağlanmazsa REDDEDİLİR (hiçbir şey eklenmez).
 *  - AIA adresi saldırgan kontrolündeyse bile rastgele sertifika güven kazanmaz.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  aiaIssuerUrls,
  certificatesFromBuffer,
  CHAIN_INCOMPLETE_ERROR_CODES,
  completeCertificateChain,
  isChainIncompleteError,
  isUsableIssuer,
  readPresentedChain,
  subjectLabel,
  verifiesAgainst,
} from '../src/lib/tls-chain-completion';
import { shouldAttemptChainCompletion } from '../src/sources/fetcher';

interface Material {
  dir: string;
  rootPem: string;
  intermediatePem: string;
  leafPem: string;
  leafKeyPem: string;
  unrelatedPem: string;
  nonCaIntermediatePem: string;
}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runOpenssl(args: string[], dir: string): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

const AIA_URL = 'http://aia.example.gov.tr/ara-sertifika.der';

function buildMaterial(): Material {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-aia-'));
  writeFileSync(
    join(dir, 'root.cnf'),
    ['[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3_ca', '[dn]', 'CN=Test Kok CA', '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', ''].join('\n'),
  );
  writeFileSync(
    join(dir, 'intermediate.cnf'),
    ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=Test Ara CA', ''].join('\n'),
  );
  writeFileSync(
    join(dir, 'intermediate.ext'),
    ['basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign', ''].join('\n'),
  );
  writeFileSync(
    join(dir, 'nonca.ext'),
    ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', ''].join('\n'),
  );
  writeFileSync(
    join(dir, 'leaf.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:site.example.gov.tr',
      `authorityInfoAccess=CA Issuers;URI:${AIA_URL}`,
      '',
    ].join('\n'),
  );

  // Kök CA (kendinden imzalı).
  runOpenssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '30', '-config', 'root.cnf'], dir);
  // Ara CA (kök imzalar).
  runOpenssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'intermediate.key', '-out', 'intermediate.csr', '-config', 'intermediate.cnf'], dir);
  runOpenssl(['x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'intermediate.crt', '-days', '30', '-extfile', 'intermediate.ext'], dir);
  // Yaprak (ara CA imzalar, AIA adresi içerir).
  runOpenssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=site.example.gov.tr'], dir);
  runOpenssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.crt', '-CAkey', 'intermediate.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '30', '-extfile', 'leaf.ext'], dir);
  // Zincire uymayan, alakasız bir CA (AIA adresi ele geçirilse bile eklenmemeli).
  runOpenssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'unrelated.key', '-out', 'unrelated.crt', '-days', '30', '-subj', '/CN=Alakasiz CA', '-addext', 'basicConstraints=critical,CA:TRUE'], dir);
  // CA olmayan (basicConstraints CA:FALSE) ama yaprağı imzalayan sertifika.
  runOpenssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'nonca.key', '-out', 'nonca.csr', '-config', 'intermediate.cnf'], dir);
  runOpenssl(['x509', '-req', '-in', 'nonca.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'nonca.crt', '-days', '30', '-extfile', 'nonca.ext'], dir);

  return {
    dir,
    rootPem: readFileSync(join(dir, 'root.crt'), 'utf8'),
    intermediatePem: readFileSync(join(dir, 'intermediate.crt'), 'utf8'),
    leafPem: readFileSync(join(dir, 'leaf.crt'), 'utf8'),
    leafKeyPem: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    unrelatedPem: readFileSync(join(dir, 'unrelated.crt'), 'utf8'),
    nonCaIntermediatePem: readFileSync(join(dir, 'nonca.crt'), 'utf8'),
  };
}

/**
 * Sabit test sertifikaları (openssl kurulu olmayan makineler için).
 *
 * Windows'ta openssl PATH'te yoksa `buildMaterial()` çalışmaz; testler tümden
 * atlanırdı ve AIA zincir tamamlama (TMSF/BDDK/ilan.gov.tr gibi eksik zincir
 * sunan resmî siteler için kritik yol) hiç doğrulanmazdı. Aynı zincir 10 yıl
 * geçerli sabit dosyalar olarak `tests/fixtures/tls-aia/` altında tutulur.
 */
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tls-aia/', import.meta.url));

function loadFixtureMaterial(): Material | null {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-aia-fixture-'));
  try {
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    return {
      dir,
      rootPem: readFileSync(join(dir, 'root.crt'), 'utf8'),
      intermediatePem: readFileSync(join(dir, 'intermediate.crt'), 'utf8'),
      leafPem: readFileSync(join(dir, 'leaf.crt'), 'utf8'),
      leafKeyPem: readFileSync(join(dir, 'leaf.key'), 'utf8'),
      unrelatedPem: readFileSync(join(dir, 'unrelated.crt'), 'utf8'),
      nonCaIntermediatePem: readFileSync(join(dir, 'nonca.crt'), 'utf8'),
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/** PEM gövdesini DER'e çevirir (openssl çağrısı gerektirmez). */
function pemToDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

const material = (hasOpenssl() ? buildMaterial() : null) ?? loadFixtureMaterial();
// DİKKAT: Vitest'te `describe.skip` çağrının GÖVDESİNİ yine de çalıştırır; bu
// yüzden gövde düzeyinde `material!` çözümlenemez (null ise toplama çöker).
const describeWithCerts = material ? describe : describe.skip;

describeWithCerts('AIA ile zincir tamamlama', () => {
  const dir = material?.dir ?? '';
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  let root: X509Certificate;

  beforeAll(() => {
    leaf = new X509Certificate(material!.leafPem);
    intermediate = new X509Certificate(material!.intermediatePem);
    root = new X509Certificate(material!.rootPem);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yaprak sertifikadaki AIA adresi okunur', () => {
    expect(aiaIssuerUrls(leaf)).toEqual([AIA_URL]);
    // Kök/ara sertifikalarda AIA yoksa boş liste döner (uydurma adres üretilmez).
    expect(aiaIssuerUrls(root)).toEqual([]);
  });

  it('eksik ara sertifika tamamlanır ve zincir güvenilen köke bağlanır', async () => {
    const result = await completeCertificateChain([leaf], [root], {
      fetchIssuer: async (url) => {
        expect(url).toBe(AIA_URL);
        return readFileSync(join(dir, 'intermediate.crt'));
      },
    });
    expect(result.ok).toBe(true);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.fingerprint256).toBe(intermediate.fingerprint256);
    expect(result.trustedBy?.fingerprint256).toBe(root.fingerprint256);
    expect(result.reason).toMatch(/AIA ile tamamlandı/);
  });

  it('DER biçimindeki AIA cevabı da kabul edilir', async () => {
    const der = pemToDer(material!.intermediatePem);
    const result = await completeCertificateChain([leaf], [root], { fetchIssuer: async () => der });
    expect(result.ok).toBe(true);
    expect(result.added[0]?.fingerprint256).toBe(intermediate.fingerprint256);
  });

  it('AIA adresinden gelen ALAKASIZ sertifika zincire eklenmez', async () => {
    const result = await completeCertificateChain([leaf], [root], {
      fetchIssuer: async () => Buffer.from(material!.unrelatedPem, 'utf8'),
    });
    expect(result.ok).toBe(false);
    expect(result.added).toHaveLength(0);
    expect(result.reason).toMatch(/EKLENMEDİ/);
  });

  it('CA olmayan sertifika ara halka olarak kabul edilmez', async () => {
    const nonCa = new X509Certificate(material!.nonCaIntermediatePem);
    // Bu sertifika kök tarafından imzalanmıştır ama yaprağı imzalamamıştır ve CA değildir.
    expect(isUsableIssuer(nonCa)).toBe(false);
    const result = await completeCertificateChain([leaf], [root], {
      fetchIssuer: async () => Buffer.from(material!.nonCaIntermediatePem, 'utf8'),
    });
    expect(result.ok).toBe(false);
    expect(result.added).toHaveLength(0);
  });

  it('süresi dolmuş (ya da henüz başlamamış) ara sertifika kabul edilmez', () => {
    expect(isUsableIssuer(intermediate)).toBe(true);
    expect(isUsableIssuer(intermediate, new Date('2099-01-01T00:00:00Z'))).toBe(false);
    expect(isUsableIssuer(intermediate, new Date('1999-01-01T00:00:00Z'))).toBe(false);
    // Süre denetimi tamamlamada da geçerlidir: gelecekte bir "şimdi" ile reddedilir.
  });

  it('süresi geçmişse tamamlama reddedilir (now enjekte edilebilir)', async () => {
    const result = await completeCertificateChain([leaf], [root], {
      now: () => new Date('2099-01-01T00:00:00Z'),
      fetchIssuer: async () => Buffer.from(material!.intermediatePem, 'utf8'),
    });
    expect(result.ok).toBe(false);
    expect(result.added).toHaveLength(0);
  });

  it('güvenilen kök yoksa tamamlama başarılı sayılmaz (zincir köksüz kalır)', async () => {
    const unrelatedRoot = new X509Certificate(material!.unrelatedPem);
    const result = await completeCertificateChain([leaf], [unrelatedRoot], {
      fetchIssuer: async () => Buffer.from(material!.intermediatePem, 'utf8'),
    });
    // Ara halka bulunur ve imza doğrulanır, ama zincir GÜVENİLEN köke bağlanmaz.
    expect(result.ok).toBe(false);
    expect(result.trustedBy).toBeNull();
    expect(result.reason).toMatch(/köke bağlanmadı/i);
  });

  it('indirme başarısızsa (null) açıklayıcı neden döner, çökmez', async () => {
    const result = await completeCertificateChain([leaf], [root], { fetchIssuer: async () => null });
    expect(result.ok).toBe(false);
    expect(result.added).toHaveLength(0);
    expect(result.attemptedUrls).toEqual([AIA_URL]);
  });

  it('indirme sayısı sınırlandırılır (sonsuz AIA döngüsü olmaz)', async () => {
    let calls = 0;
    const result = await completeCertificateChain([leaf], [root], {
      maxFetches: 1,
      fetchIssuer: async () => {
        calls += 1;
        return Buffer.from(material!.unrelatedPem, 'utf8');
      },
    });
    expect(calls).toBeLessThanOrEqual(1);
    expect(result.ok).toBe(false);
  });

  it('zincir zaten güvenilirse tamamlama denenmez', async () => {
    const result = await completeCertificateChain([leaf, intermediate], [root], {
      fetchIssuer: async () => {
        throw new Error('indirilmemeli');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.added).toHaveLength(0);
    expect(result.trustedBy?.fingerprint256).toBe(root.fingerprint256);
    expect(result.reason).toMatch(/gerekmiyor/);
  });

  it('yardımcılar: PEM/DER ayrıştırma, imza doğrulama, etiket', () => {
    expect(certificatesFromBuffer(Buffer.from(material!.intermediatePem, 'utf8'))).toHaveLength(1);
    expect(certificatesFromBuffer(Buffer.from(`${material!.rootPem}${material!.intermediatePem}`, 'utf8'))).toHaveLength(2);
    expect(certificatesFromBuffer(Buffer.from('bozuk içerik', 'utf8'))).toHaveLength(0);
    expect(verifiesAgainst(leaf, intermediate)).toBe(true);
    expect(verifiesAgainst(leaf, root)).toBe(false);
    expect(subjectLabel(intermediate)).toBe('Test Ara CA');
  });

  it('eksik zincir hata kodları tanınır (cause zincirinde aranır)', () => {
    expect(CHAIN_INCOMPLETE_ERROR_CODES).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    const nested = new Error('fetch failed', { cause: Object.assign(new Error('tls'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
    expect(isChainIncompleteError(nested)).toBe(true);
    expect(isChainIncompleteError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe(false);
    expect(isChainIncompleteError(new Error('düz hata'))).toBe(false);
    expect(isChainIncompleteError(null)).toBe(false);
  });
});

describe('HTTP istemcisinin tamamlama kararı (SOURCE_TLS_AIA_COMPLETION)', () => {
  it('anahtar kapalıysa ya da hata eksik zincir değilse denenmez', () => {
    const base = {
      enabled: true,
      chainIncomplete: true,
      host: 'bddk.org.tr:443',
      attemptedHosts: new Set<string>(),
      completedHosts: new Set<string>(),
    };
    expect(shouldAttemptChainCompletion(base)).toBe(true);
    expect(shouldAttemptChainCompletion({ ...base, enabled: false })).toBe(false);
    expect(shouldAttemptChainCompletion({ ...base, chainIncomplete: false })).toBe(false);
    // Host başına tek deneme: döngü ve tekrarlı AIA indirmesi olmaz.
    expect(shouldAttemptChainCompletion({ ...base, attemptedHosts: new Set(['bddk.org.tr:443']) })).toBe(false);
    expect(shouldAttemptChainCompletion({ ...base, completedHosts: new Set(['bddk.org.tr:443']) })).toBe(false);
    // Farklı host yeniden denenebilir (port/host anahtarı ayrı tutulur).
    expect(shouldAttemptChainCompletion({ ...base, host: 'www.tmsf.gov.tr:443' })).toBe(true);
  });

  it('katalogda ve şemada tanımlıdır; doğrulamayı kapatan bir anahtar DEĞİLDİR', async () => {
    const { ENV_FIELD_BY_KEY } = await import('../src/config/env-spec');
    const field = ENV_FIELD_BY_KEY.get('SOURCE_TLS_AIA_COMPLETION');
    expect(field).toBeDefined();
    expect(field?.defaultValue).toBe('1');
    // Bu anahtar riskli sayılmaz: doğrulamayı kapatmaz, yalnızca zinciri tamamlar.
    const { riskyDecision } = await import('../src/config/env-prompt');
    expect(riskyDecision(field!, '0')).toBeNull();
    expect(riskyDecision(field!, '1')).toBeNull();
  });
});

describeWithCerts('readPresentedChain (sunucunun sunduğu zincir)', () => {
  it('yalnızca yaprak sunan sunucudan tek sertifikalık zincir okur', async () => {
    const server = createServer({ cert: material!.leafPem, key: material!.leafKeyPem }, (_req, res) => {
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('adres yok');
    try {
      const chain = await readPresentedChain({
        host: '127.0.0.1',
        port: address.port,
        servername: 'site.example.gov.tr',
        timeoutMs: 5_000,
        // Test yerel sunucuya bağlanır: SSRF bekçisi bilinçli olarak atlanır.
        lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4),
      });
      expect(chain).toHaveLength(1);
      expect(chain[0]?.fingerprint256).toBe(new X509Certificate(material!.leafPem).fingerprint256);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
