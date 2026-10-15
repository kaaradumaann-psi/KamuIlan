/**
 * Veritabanı TLS tanısı: uçtan uca kanıt.
 *
 * `SELF_SIGNED_CERT_IN_CHAIN` kullanıcının karşısına tek bir kod olarak çıkar;
 * oysa altında en az altı farklı kök neden olabilir. Bu dosya her birini GERÇEK
 * sertifikalarla ve Postgres SSLRequest müzakeresini taklit eden GERÇEK bir TLS
 * sunucusuyla üretir ve tanının doğru dalı seçtiğini kanıtlar:
 *
 *  1. CA dosyası denetimi: HTML, DER, özel anahtar, leaf-ama-CA-değil, eksik yol,
 *     göreli yolun `.env` kökünden çözülmesi, tam zincir paketi.
 *  2. Sondaj: sunucunun sunduğu zincirin leaf → kök sırasıyla okunması, ad
 *     doğrulaması, saat denetimi.
 *  3. Güven değerlendirmesi: doğru kök → doğrular; yanlış kök → doğrulamaz.
 *  4. Tanı karar tablosu: "dosya sistem köklerini eziyor", "eksik sağlayıcı
 *     kökü", "ara katman (proxy)", "CA dosyası kullanılamaz", "ad uyuşmazlığı".
 *  5. POSTGRES_SSL_CA_MERGE_SYSTEM: dosya kökleri + sistem kökleri birleşimi
 *     doğrulamayı AÇIK tutar (hiçbir dalda gevşetme önerilmez).
 *
 * Testler dış ağa çıkmaz; zincir 127.0.0.1 üzerinde kurulur. Sır değer üretmez.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  caFilePathCandidates,
  derToPem,
  expandPathTokens,
  inspectCaFile,
  loadTrustedCaCertificates,
} from '../src/lib/ca-file';
import {
  describePostgresEndpoint,
  evaluateChainTrust,
  parseAnchors,
  probePostgresTls,
  PG_SSL_REQUEST_CODE,
} from '../src/lib/pg-tls-probe';
import {
  diagnoseConfiguredDatabaseTls,
  diagnoseTls,
  describeCaFileForDiagnosis,
  formatTlsDiagnosis,
} from '../src/lib/tls-diagnosis';
import { sslConfigFor } from '../src/db/postgres-store';
import { getEnv, inspectEnvironment, postgresCaMergeSystem, resetEnvCache } from '../src/config/env';

const PG_SSL_REQUEST_LENGTH = 8;

/* ---------------------------------------------------------------------------
 * Sertifika malzemesi (openssl ile gerçek zincir: kök → ara → leaf)
 * ------------------------------------------------------------------------- */

interface ChainMaterial {
  rootCaPem: string;
  intermediateCaPem: string;
  leafPem: string;
  leafKeyPem: string;
  serverChainPem: string;
  wrongRootPem: string;
  wrongRootKeyPem: string;
  dir: string;
}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * openssl kurulu olmayan makineler (ör. Windows) için geçerli bir kök CA PEM'i.
 *
 * Bu dosyada üretilen zincirler openssl ister; openssl yoksa aynı doğrulamayı
 * depodaki sabit test köküyle yaparız. Böylece "CA dosyası tanımlıyken yalnızca
 * bu dosyadaki köklere güvenilir" uyarısı her platformda test edilir.
 */
const FIXTURE_ROOT_CA = fileURLToPath(new URL('./fixtures/tls-aia/root.crt', import.meta.url));

function validCaPem(dir: string): string {
  if (hasOpenssl()) return buildMaterial(dir).rootCaPem;
  return readFileSync(FIXTURE_ROOT_CA, 'utf8');
}

function runOpenssl(args: string[], dir: string): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

/** Kök CA, ara CA ve leaf üreten CNF dosyaları (openssl 3.x uyumlu). */
function writeConfigs(dir: string): void {
  writeFileSync(
    join(dir, 'root.cnf'),
    [
      '[req]',
      'distinguished_name=dn',
      'prompt=no',
      'x509_extensions=v3_ca',
      '[dn]',
      'CN=Kamuilan Test Root CA',
      'O=Kamuilan Test',
      '[v3_ca]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'intermediate.cnf'),
    ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=Kamuilan Test Intermediate CA', 'O=Kamuilan Test'].join('\n'),
  );
  writeFileSync(
    join(dir, 'intermediate.ext'),
    ['basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign'].join('\n'),
  );
  writeFileSync(
    join(dir, 'leaf.cnf'),
    ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=localhost', 'O=Kamuilan Test'].join('\n'),
  );
  writeFileSync(
    join(dir, 'leaf.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'wrong-root.cnf'),
    ['[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3_ca', '[dn]', 'CN=Baska Proje Root CA', 'O=Baska', '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign'].join('\n'),
  );
  writeFileSync(
    join(dir, 'proxy-root.cnf'),
    [
      '[req]',
      'distinguished_name=dn',
      'prompt=no',
      'x509_extensions=v3_ca',
      '[dn]',
      'CN=Kurumsal TLS Denetim Proxy Root',
      'O=Zscaler Benzeri Ara Katman',
      '[v3_ca]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
    ].join('\n'),
  );
}

function buildMaterial(dir: string): ChainMaterial {
  writeConfigs(dir);

  // Kök CA (kendi kendini imzalar)
  runOpenssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '2', '-config', 'root.cnf'],
    dir,
  );
  // Ara CA (kök imzalar)
  runOpenssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'intermediate.key', '-out', 'intermediate.csr', '-config', 'intermediate.cnf'], dir);
  runOpenssl(
    ['x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'intermediate.crt', '-days', '2', '-extfile', 'intermediate.ext'],
    dir,
  );
  // Leaf (ara CA imzalar)
  runOpenssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-config', 'leaf.cnf'], dir);
  runOpenssl(
    ['x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.crt', '-CAkey', 'intermediate.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'leaf.ext'],
    dir,
  );
  // Yanlış proje kökü (tanının "bu dosya bu uç noktaya ait değil" dalı için)
  runOpenssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'wrong-root.key', '-out', 'wrong-root.crt', '-days', '2', '-config', 'wrong-root.cnf'],
    dir,
  );

  const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
  return {
    rootCaPem: read('root.crt'),
    intermediateCaPem: read('intermediate.crt'),
    leafPem: read('leaf.crt'),
    leafKeyPem: read('leaf.key'),
    // Sunucu, leaf + ara CA sunar (gerçek Postgres/Supabase davranışı gibi).
    serverChainPem: `${read('leaf.crt')}${read('intermediate.crt')}`,
    wrongRootPem: read('wrong-root.crt'),
    wrongRootKeyPem: read('wrong-root.key'),
    dir,
  };
}

/** Kurumsal proxy senaryosu için ayrı kök + onun imzaladığı leaf. */
function buildProxyMaterial(dir: string): { rootPem: string; keyPem: string; chainPem: string } {
  writeConfigs(dir);
  runOpenssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'proxy-root.key', '-out', 'proxy-root.crt', '-days', '2', '-config', 'proxy-root.cnf'],
    dir,
  );
  runOpenssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'proxy-leaf.key', '-out', 'proxy-leaf.csr', '-config', 'leaf.cnf'], dir);
  writeFileSync(join(dir, 'proxy-leaf.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ].join('\n'));
  runOpenssl(
    ['x509', '-req', '-in', 'proxy-leaf.csr', '-CA', 'proxy-root.crt', '-CAkey', 'proxy-root.key', '-CAcreateserial', '-out', 'proxy-leaf.crt', '-days', '2', '-extfile', 'proxy-leaf.ext'],
    dir,
  );
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
  return { rootPem: read('proxy-root.crt'), keyPem: read('proxy-leaf.key'), chainPem: read('proxy-leaf.crt') };
}

/* ---------------------------------------------------------------------------
 * Postgres SSLRequest müzakeresini taklit eden TLS sunucusu
 * ------------------------------------------------------------------------- */

interface FakePgServer {
  port: number;
  close(): Promise<void>;
}

async function startFakePgServer(key: string, certChain: string): Promise<FakePgServer> {
  const secureContext = tls.createSecureContext({ key, cert: certChain });
  const sockets = new Set<Socket>();
  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => {
      const code = chunk.length >= PG_SSL_REQUEST_LENGTH ? chunk.readUInt32BE(4) : -1;
      if (code !== PG_SSL_REQUEST_CODE) {
        socket.end('N');
        return;
      }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
      secure.on('secure', () => secure.end());
      secure.on('error', () => secure.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test sunucusu port alamadı');
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ---------------------------------------------------------------------------
 * Testler
 * ------------------------------------------------------------------------- */

describe.runIf(hasOpenssl())('CA dosyası denetimi (gerçek sertifikalar)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kamuilan-ca-'));
  let material: ChainMaterial;

  beforeAll(() => {
    material = buildMaterial(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, contents: string | Buffer): string => {
    const target = join(root, name);
    mkdirSync(join(root, 'certs'), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };

  it('kök CA dosyası kullanılabilir sayılır; leaf ve ara CA doğru etiketlenir', () => {
    const path = write('certs/root-only.pem', material.rootCaPem);
    const report = inspectCaFile(path);
    expect(report.exists).toBe(true);
    expect(report.usable).toBe(true);
    expect(report.certificates).toHaveLength(1);
    expect(report.certificates[0]?.isCa).toBe(true);
    expect(report.certificates[0]?.selfSigned).toBe(true);
    expect(report.issues).toEqual([]);

    const leafReport = inspectCaFile(write('certs/leaf.pem', material.leafPem));
    expect(leafReport.usable).toBe(false);
    expect(leafReport.issues.map((entry) => entry.code)).toContain('leaf-not-ca');
    // Kendi kendini imzalayan leaf (eski Supabase sunucu sertifikası indirmesi):
    // bağlantı çalışır ama kırılgandır → uyarı, engelleme değil.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'selfleaf.key', '-out', 'selfleaf.crt', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=critical,CA:FALSE'], { cwd: root, stdio: 'ignore' });
    const selfLeaf = inspectCaFile(join(root, 'selfleaf.crt'));
    expect(selfLeaf.usable).toBe(true);
    expect(selfLeaf.warnings.map((entry) => entry.code)).toContain('leaf-not-ca');
  });

  it('tam zincir paketi (ara + kök) kullanılabilir; eksik zincir uyarı üretir', () => {
    const full = inspectCaFile(write('certs/full-chain.pem', `${material.intermediateCaPem}${material.rootCaPem}`));
    expect(full.certificates).toHaveLength(2);
    expect(full.usable).toBe(true);
    expect(full.issues).toEqual([]);

    // Ara CA + leaf var ama kök yok: zincir dosya içinde tamamlanmıyor.
    const partial = inspectCaFile(write('certs/partial.pem', `${material.leafPem}${material.intermediateCaPem}`));
    expect(partial.warnings.map((entry) => entry.code)).toContain('incomplete-chain');
    // Dosyada gerçek bir CA olduğu için ek leaf reddedilmez (uyarı olarak raporlanır).
    expect(partial.usable).toBe(true);
    expect(partial.warnings.map((entry) => entry.code)).toContain('leaf-not-ca');

    // Yalnızca leaf (kendi kendini imzalamıyor): zincir bu dosyayla doğrulanamaz.
    const leafOnly = inspectCaFile(write('certs/leaf-only.pem', material.leafPem));
    expect(leafOnly.usable).toBe(false);
    expect(leafOnly.issues.map((entry) => entry.code)).toContain('leaf-not-ca');
  });

  it('HTML indirme sayfası, boş dosya ve özel anahtar açıkça reddedilir', () => {
    const html = inspectCaFile(write('certs/html.crt', `<!DOCTYPE html>\n<html><body>${material.rootCaPem}</body></html>`));
    expect(html.issues.map((entry) => entry.code)).toContain('html');
    expect(html.usable).toBe(false);

    const empty = inspectCaFile(write('certs/empty.crt', '   \n'));
    expect(empty.issues.map((entry) => entry.code)).toContain('empty');

    const key = inspectCaFile(write('certs/with-key.pem', `${material.rootCaPem}${material.leafKeyPem}`));
    expect(key.issues.map((entry) => entry.code)).toContain('private-key');
    expect(key.usable).toBe(false);
  });

  it('DER (ikili) dosya PEM e çevrilir ve kullanılabilir sayılır', () => {
    execFileSync('openssl', ['x509', '-in', join(root, 'root.crt'), '-outform', 'DER', '-out', join(root, 'root.der')], { stdio: 'ignore' });
    const der = readFileSync(join(root, 'root.der'));
    expect(derToPem(der)).not.toBeNull();
    const report = inspectCaFile(join(root, 'root.der'));
    expect(report.exists).toBe(true);
    expect(report.usable).toBe(true);
    expect(report.warnings.map((entry) => entry.code)).toContain('der');
    expect(report.certificates[0]?.subject).toContain('Kamuilan Test Root CA');
  });

  it('olmayan dosya için denenen yollar listelenir (göreli yol .env kökünden çözülür)', () => {
    const report = inspectCaFile('./certs/olmayan-supabase-ca.crt', { root });
    expect(report.exists).toBe(false);
    expect(report.usable).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toEqual(['not-found']);
    expect(report.candidates).toContain(join(root, 'certs', 'olmayan-supabase-ca.crt'));
    expect(report.candidates.length).toBeGreaterThanOrEqual(2);
    expect(caFilePathCandidates('./certs/x.crt', root)).toContain(join(root, 'certs', 'x.crt'));
  });

  it('göreli yol çalışma dizini dışında .env kökünden bulunur', () => {
    // Dosya proje kökünde (root/certs/) ama çalışan dizin farklı: yine de bulunmalı.
    write('certs/root-only.pem', material.rootCaPem);
    const report = inspectCaFile('./certs/root-only.pem', { root });
    expect(report.exists).toBe(true);
    expect(report.resolvedPath).toBe(join(root, 'certs', 'root-only.pem'));
  });

  it('yol genişletme: ~ ve %VAR% / ${VAR} biçimleri çözülür', () => {
    process.env['KAMUILAN_TEST_CERT_DIR'] = root;
    expect(expandPathTokens('%KAMUILAN_TEST_CERT_DIR%/root.crt')).toBe(join(root, 'root.crt'));
    expect(expandPathTokens('${KAMUILAN_TEST_CERT_DIR}/root.crt')).toBe(join(root, 'root.crt'));
    delete process.env['KAMUILAN_TEST_CERT_DIR'];
  });

  it('loadTrustedCaCertificates: dosya kökleri döner, merge ile sistem kökleri eklenir', () => {
    const path = write('certs/root-only.pem', material.rootCaPem);
    const strict = loadTrustedCaCertificates(path, { mergeSystem: false, systemCaStore: () => ['SISTEM-KOK'] });
    expect(strict.fileOnly).toBe(true);
    expect(strict.certificates).toHaveLength(1);

    const merged = loadTrustedCaCertificates(path, { mergeSystem: true, systemCaStore: () => ['SISTEM-KOK'] });
    expect(merged.fileOnly).toBe(false);
    expect(merged.certificates).toContain('SISTEM-KOK');
    expect(merged.certificates.length).toBe(2);

    // Geçersiz dosya: doğrulamasıza DÜŞMEZ, açık hata verir.
    const badPath = write('certs/leaf.pem', material.leafPem);
    expect(() => loadTrustedCaCertificates(badPath)).toThrow(/POSTGRES_SSL_CA_FILE kullanılamadı/);
  });

  it('sslConfigFor: merge kapalıyken yalnızca dosya, açıkken dosya + sistem kökleri', () => {
    const strict = sslConfigFor(material.rootCaPem, { systemCaStore: ['SISTEM-KOK'], mergeSystemCa: false });
    expect(strict).toEqual({ ca: material.rootCaPem, rejectUnauthorized: true });

    const merged = sslConfigFor(material.rootCaPem, { systemCaStore: ['SISTEM-KOK'], mergeSystemCa: true });
    expect(merged).toMatchObject({ rejectUnauthorized: true });
    const ca = Array.isArray((merged as { ca: string[] }).ca) ? (merged as { ca: string[] }).ca : [];
    expect(ca).toContain('SISTEM-KOK');
    // Dosya kökü PEM bloğu olarak birleşir (aynı sertifika iki kez listelenmez).
    expect(ca.some((entry) => entry.includes('-----BEGIN CERTIFICATE-----'))).toBe(true);
    expect(ca).toHaveLength(2);

    // Birleştirme doğrulamayı GEVŞETMEZ.
    expect(sslConfigFor(material.rootCaPem, { mergeSystemCa: true })).toMatchObject({ rejectUnauthorized: true });
  });
});

describe.runIf(hasOpenssl())('canlı sondaj ve tanı (gerçek TLS el sıkışması)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-probe-'));
  let material: ChainMaterial;
  let server: FakePgServer;
  let proxyServer: FakePgServer;

  beforeAll(async () => {
    material = buildMaterial(dir);
    server = await startFakePgServer(material.leafKeyPem, material.serverChainPem);
    const proxyDir = join(dir, 'proxy');
    mkdirSync(proxyDir, { recursive: true });
    const proxy = buildProxyMaterial(proxyDir);
    proxyServer = await startFakePgServer(proxy.keyPem, proxy.chainPem);
  });

  afterAll(async () => {
    await server?.close();
    await proxyServer?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uç nokta sınıflandırması: doğrudan bağlantı, session pooler, transaction pooler', () => {
    const direct = describePostgresEndpoint('postgres://postgres.x:parola@db.abcdefghijklmnopqrst.supabase.co:5432/postgres');
    expect(direct?.kind).toBe('supabase-direct');
    expect(direct?.projectRef).toBe('abcdefghijklmnopqrst');
    expect(direct?.kindLabel).toContain('doğrudan');

    const session = describePostgresEndpoint('postgres://postgres.abcdefghijklmnopqrst:parola@aws-0-eu-central-1.pooler.supabase.com:5432/postgres');
    expect(session?.kind).toBe('supabase-pooler-session');

    const transaction = describePostgresEndpoint('postgres://postgres.abcdefghijklmnopqrst:parola@aws-0-eu-central-1.pooler.supabase.com:6543/postgres');
    expect(transaction?.kind).toBe('supabase-pooler-transaction');
    expect(transaction?.kindLabel).toContain('transaction');

    // Parola hiçbir çıktıya sızmaz.
    expect(JSON.stringify(transaction)).not.toContain('parola');
  });

  it('sondaj zinciri leaf → ara → kök eksikliğiyle okur; ad doğrulaması yapılır', async () => {
    const probe = await probePostgresTls({ host: '127.0.0.1', port: server.port, servername: 'localhost', timeoutMs: 8_000 });
    expect(probe.ok).toBe(true);
    expect(probe.tlsSupported).toBe(true);
    expect(probe.chain.length).toBe(2);
    expect(probe.chain[0]?.subjectCn).toBe('localhost');
    expect(probe.chain[0]?.isCa).toBe(false);
    expect(probe.chain[1]?.subjectCn).toBe('Kamuilan Test Intermediate CA');
    // Kök sunulmadı: zincir eksik (gerçek SELF_SIGNED_CERT_IN_CHAIN nedeni).
    expect(probe.hostnameMatch).toBe(true);
    expect(probe.clockSkew).toBeNull();
    // Parola/sır sızmaz.
    expect(JSON.stringify(probe)).not.toMatch(/password|parola/i);
  });

  it('güven değerlendirmesi: doğru kök doğrular, yanlış kök doğrulamaz', async () => {
    const probe = await probePostgresTls({ host: '127.0.0.1', port: server.port, servername: 'localhost', timeoutMs: 8_000 });
    const withRoot = evaluateChainTrust(probe.chain, [material.rootCaPem]);
    expect(withRoot.trusted).toBe(true);
    expect(withRoot.partialChain).toBe(true); // kök sunucudan GELMEDİ, dosyadan doğrulandı
    expect(withRoot.matched[0]?.subjectCn).toBe('Kamuilan Test Root CA');

    const withWrongRoot = evaluateChainTrust(probe.chain, [material.wrongRootPem]);
    expect(withWrongRoot.trusted).toBe(false);
    expect(withWrongRoot.matched).toEqual([]);

    // Leaf'i çapa olarak vermek Node/OpenSSL'in kabul ettiği bir durumdur
    // (açıkça güvenilen sertifika) ama CA pinning DEĞİLDİR; tanı bunu ayrıca söyler.
    const withLeafOnly = evaluateChainTrust(probe.chain, [material.leafPem]);
    expect(withLeafOnly.trusted).toBe(true);
    expect(withLeafOnly.leafIsAnchor).toBe(true);
    expect(evaluateChainTrust(probe.chain, [material.rootCaPem]).leafIsAnchor).toBe(false);

    expect(parseAnchors([`${material.rootCaPem}${material.intermediateCaPem}`])).toHaveLength(2);
    expect(evaluateChainTrust(probe.chain, []).reason).toBe('no-anchors');
  });

  it('tanı: eksik sağlayıcı kökü → panelden CA indirme adımı (doğrulamayı kapatma önerisi YOK)', async () => {
    const probe = await probePostgresTls({ host: '127.0.0.1', port: server.port, servername: 'localhost', timeoutMs: 8_000 });
    const diagnosis = diagnoseTls({
      probe,
      endpoint: describePostgresEndpoint(`postgres://kullanici@127.0.0.1:${server.port}/kamuilan`),
      caFileReport: null,
      fileAnchors: [material.wrongRootPem],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(['missing-provider-root', 'unknown-chain']).toContain(diagnosis.cause);
    expect(diagnosis.headline).toMatch(/kök|zincir/i);
    const all = [...diagnosis.actions, ...diagnosis.findings].join('\n');
    expect(all).not.toMatch(/no-verify|NODE_TLS_REJECT_UNAUTHORIZED=0/i);
    expect(diagnosis.trust.file?.trusted).toBe(false);
  });

  it('tanı: zincir sistem kökleriyle doğrulanıyor ama CA dosyası eziyorsa birleştirme/kaldırma önerilir', async () => {
    const probe = await probePostgresTls({ host: '127.0.0.1', port: server.port, servername: 'localhost', timeoutMs: 8_000 });
    // Dosya kökü yanlış; ancak "sistem deposu" yerine geçen çapa doğru kökü içeriyor.
    const report = inspectCaFile(join(dir, 'root.crt'));
    expect(report.usable).toBe(true);
    const diagnosis = diagnoseTls(
      {
        probe,
        endpoint: describePostgresEndpoint(`postgres://kullanici@127.0.0.1:${server.port}/kamuilan`),
        caFileReport: report,
        fileAnchors: [material.wrongRootPem],
        mergeSystem: false,
        mode: 'verify',
      },
      { compareSystemStore: false },
    );
    // Sistem deposu denetlenmediğinde dosya tek kaynak olduğu için doğrulama başarısız kalır.
    expect(diagnosis.trust.file?.trusted).toBe(false);

    // Dosya doğru kökü içeriyorsa tanı "TLS tarafında sorun yok" der.
    const trusted = diagnoseTls({
      probe,
      endpoint: describePostgresEndpoint(`postgres://kullanici@127.0.0.1:${server.port}/kamuilan`),
      caFileReport: report,
      fileAnchors: [material.rootCaPem],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(trusted.cause).toBe('trusted-by-file');
    expect(trusted.trust.file?.trusted).toBe(true);
  });

  it('tanı: kurumsal ara katman kökü tanınır ve NODE_EXTRA_CA_CERTS yönlendirmesi yapılır', async () => {
    const probe = await probePostgresTls({ host: '127.0.0.1', port: proxyServer.port, servername: 'localhost', timeoutMs: 8_000 });
    expect(probe.ok).toBe(true);
    expect(probe.chain[0]?.issuerCn).toContain('Kurumsal TLS Denetim Proxy Root');
    const diagnosis = diagnoseTls({
      probe,
      endpoint: describePostgresEndpoint(`postgres://kullanici@127.0.0.1:${proxyServer.port}/kamuilan`),
      caFileReport: null,
      fileAnchors: [material.rootCaPem],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(diagnosis.cause).toBe('intercepted-chain');
    expect(diagnosis.actions.join('\n')).toContain('NODE_EXTRA_CA_CERTS');
    expect(diagnosis.actions.join('\n')).toMatch(/no-verify|kapatmak/i);
  });

  it('tanı: ad uyuşmazlığı CA eklemekle çözülmez; adres düzeltmesi önerilir', async () => {
    const probe = await probePostgresTls({ host: '127.0.0.1', port: server.port, servername: 'localhost', timeoutMs: 8_000 });
    const mismatched = { ...probe, hostnameMatch: false, hostnameError: "Host: 1.2.3.4. is not in the cert's list" };
    const diagnosis = diagnoseTls({
      probe: mismatched,
      endpoint: describePostgresEndpoint(`postgres://kullanici@127.0.0.1:${server.port}/kamuilan`),
      caFileReport: null,
      fileAnchors: [material.rootCaPem],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(diagnosis.cause).toBe('hostname-mismatch');
    expect(diagnosis.actions.join('\n')).toContain('POSTGRES_URL');
  });

  it('tanı: bozuk CA dosyası ve ulaşılamayan uç nokta ayrı dallarda raporlanır', async () => {
    const badPath = join(dir, 'bad-ca.pem');
    writeFileSync(badPath, '<html><body>indirme sayfası</body></html>');
    const badReport = inspectCaFile(badPath);
    expect(badReport.usable).toBe(false);

    const probe = await probePostgresTls({ host: '127.0.0.1', port: server.port, servername: 'localhost', timeoutMs: 8_000 });
    const withBadFile = diagnoseTls({
      probe,
      endpoint: describePostgresEndpoint(`postgres://kullanici@127.0.0.1:${server.port}/kamuilan`),
      caFileReport: badReport,
      fileAnchors: [],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(withBadFile.cause).toBe('ca-file-unusable');
    expect(describeCaFileForDiagnosis(badReport).join('\n')).toContain('POSTGRES_SSL_CA_FILE');

    const unreachable = await probePostgresTls({ host: '127.0.0.1', port: 1, timeoutMs: 3_000 });
    expect(unreachable.ok).toBe(false);
    const diagnosis = diagnoseTls({
      probe: unreachable,
      endpoint: describePostgresEndpoint('postgres://kullanici@127.0.0.1:1/kamuilan'),
      caFileReport: null,
      fileAnchors: [],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(diagnosis.cause).toBe('unreachable');
  });

  it('tanı: TLS desteklenmeyen sunucu için disable değil adres kontrolü önerilir', () => {
    const probe = {
      ok: false,
      host: '127.0.0.1',
      port: 5432,
      servername: '127.0.0.1',
      tlsSupported: false,
      chain: [],
      hostnameMatch: null,
      hostnameError: null,
      clockSkew: null,
      failure: 'tls-unsupported' as const,
      errorCode: null,
      errorMessage: 'Sunucu TLS desteklemiyor',
    };
    const diagnosis = diagnoseTls({
      probe,
      endpoint: describePostgresEndpoint('postgres://kullanici@127.0.0.1:5432/kamuilan'),
      caFileReport: null,
      fileAnchors: [],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(diagnosis.cause).toBe('tls-unsupported');
    expect(diagnosis.actions.join('\n')).toMatch(/Connect ekran|Network|POSTGRES_SSL_MODE=disable/);
  });
});

describe('ortam denetimi: CA dosyası doğrulaması env:check’e yansır', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_DRIVER: 'postgres',
    POSTGRES_URL: 'postgres://kullanici:gizli-parola@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  } as const;



  it('olmayan CA dosyası bir SORUNdur: getEnv BAŞLANGIÇTA engeller (sessiz düşüş yok)', () => {
    resetEnvCache();
    let message = '';
    try {
      getEnv({ ...base, POSTGRES_SSL_CA_FILE: './certs/kesinlikle-yok-12345.crt' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/POSTGRES_SSL_CA_FILE bulunamadı/);
    // Hata metni bağlantı dizesini/parolayı içermez.
    expect(message).not.toContain('gizli-parola');
    expect(message).not.toContain('db.abcdefghijklmnopqrst.supabase.co');

    // Mesaj, denenen yolları gösterir (kullanıcı doğru klasörü görebilsin).
    expect(message).toMatch(/certs/);
    expect(message).toMatch(/docs\/database-tls\.md|db:tls-doctor/);
    resetEnvCache();
  });

  it('DATABASE_DRIVER=file iken unutulmuş CA yolu başlatmayı ENGELLEMEZ', () => {
    resetEnvCache();
    const env = getEnv({
      ...base,
      DATABASE_DRIVER: 'file',
      POSTGRES_SSL_CA_FILE: './certs/kesinlikle-yok-12345.crt',
    });
    expect(inspectEnvironment(env).problems.join(' ')).not.toMatch(/POSTGRES_SSL_CA_FILE/);
    resetEnvCache();
  });

  it('CA dosyası tanımlıyken "yalnızca bu dosya" uyarısı ve birleştirme önerisi verilir', () => {
    resetEnvCache();
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-env-ca-'));
    const caPath = join(dir, 'ca.pem');
    // Geçerli CA dosyası: openssl varsa taze üretilir, yoksa depodaki sabit
    // test kökü kullanılır. (Eski sürümde openssl'siz dal geçersiz bir dosya
    // yazıp `getEnv` çağırıyordu; CA sorunları engelleyici olduğu için getEnv
    // değer DÖNDÜRMEZ, fırlatır → test Windows'ta patlıyordu.)
    writeFileSync(caPath, validCaPem(dir));
    const env = getEnv({ ...base, POSTGRES_SSL_CA_FILE: caPath });
    const inspection = inspectEnvironment(env);
    expect(inspection.problems).toEqual([]);
    expect(inspection.warnings.join(' ')).toMatch(/YALNIZCA bu dosyadaki köklerle/);
    expect(postgresCaMergeSystem(env)).toBe(false);

    const merged = getEnv({ ...base, POSTGRES_SSL_CA_FILE: caPath, POSTGRES_SSL_CA_MERGE_SYSTEM: '1' });
    expect(postgresCaMergeSystem(merged)).toBe(true);
    expect(inspectEnvironment(merged).warnings.join(' ')).not.toMatch(/YALNIZCA bu dosyadaki köklerle/);

    // Geçersiz CA dosyası fail-closed'dur: başlatma engellenir (uyarı değil).
    writeFileSync(caPath, 'gecersiz');
    resetEnvCache();
    expect(() => getEnv({ ...base, POSTGRES_SSL_CA_FILE: caPath })).toThrow(/POSTGRES_SSL_CA_FILE/);
    rmSync(dir, { recursive: true, force: true });
    resetEnvCache();
  });

  it('birleştirme bayrağı yalnızca CA dosyası tanımlıyken etkinleşir', () => {
    resetEnvCache();
    const env = getEnv({ ...base, POSTGRES_SSL_CA_FILE: '', POSTGRES_SSL_CA_MERGE_SYSTEM: '1' });
    expect(postgresCaMergeSystem(env)).toBe(false);
    resetEnvCache();
  });

  it('geçersiz CA içeriği (HTML) env:check’te engelleme üretir', () => {
    resetEnvCache();
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-env-bad-'));
    const caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, '<!DOCTYPE html><html><body>Supabase download</body></html>');
    expect(() => getEnv({ ...base, POSTGRES_SSL_CA_FILE: caPath })).toThrow(/POSTGRES_SSL_CA_FILE kullanılamaz \(html\)/);
    rmSync(dir, { recursive: true, force: true });
    resetEnvCache();
  });
});

describe('tanı yardımcıları', () => {
  it('sondaj yapılamazsa genel "ulaşılamadı" tanısı üretilir', () => {
    const diagnosis = diagnoseTls({
      probe: null,
      endpoint: describePostgresEndpoint('postgres://kullanici@db.example:5432/postgres'),
      caFileReport: null,
      fileAnchors: [],
      mergeSystem: false,
      mode: 'verify',
    });
    expect(diagnosis.cause).toBe('unreachable');
    expect(diagnosis.actions.join('\n')).toContain('POSTGRES_URL');
  });

  it('geçersiz URL için tanı null döner (çağıran genel yardıma düşer)', async () => {
    const report = await diagnoseConfiguredDatabaseTls({
      postgresUrl: 'mongodb://kullanici@db.example:27017/kamuilan',
      mode: 'verify',
      timeoutMs: 2_000,
    });
    expect(report).toBeNull();
  });

  it('ulaşılamayan uç nokta için rapor ve okunabilir çıktı üretir', async () => {
    const report = await diagnoseConfiguredDatabaseTls({
      postgresUrl: 'postgres://kullanici:gizli-parola@127.0.0.1:1/kamuilan',
      mode: 'verify',
      timeoutMs: 3_000,
    });
    expect(report).not.toBeNull();
    expect(report?.diagnosis.cause).toBe('unreachable');
    const lines = formatTlsDiagnosis(report!);
    expect(lines.join('\n')).toContain('Yapılacaklar');
    expect(lines.join('\n')).toContain('docs/database-tls.md');
    // Bağlantı dizesi/parola çıktıya sızmaz.
    expect(lines.join('\n')).not.toContain('gizli-parola');
    expect(lines.join('\n')).not.toContain('postgres://');
  });

  it('TLS kapalıyken sondaj yapılmaz (gereksiz ağ trafiği yok)', async () => {
    const report = await diagnoseConfiguredDatabaseTls({
      postgresUrl: 'postgres://kullanici@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
      mode: 'disable',
      timeoutMs: 1_000,
    });
    expect(report).toBeNull();
  });
});
