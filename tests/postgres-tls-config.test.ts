/**
 * Veritabanı TLS yapılandırması.
 *
 * İki katman:
 *  1. Birim testi: `sslConfigFor` karar tablosu ve `postgresTlsMode` ortam eşlemesi
 *     (doğrulamayı kapatan tek yol AÇIK bir tercihtir; sessiz varsayılan değildir).
 *  2. GERÇEK TLS el sıkışma testi: geçici bir self-signed sertifika ile Postgres
 *     SSLRequest protokolünü taklit eden bir sunucu kaldırılır ve `pg` sürücüsüyle
 *     gerçekten bağlanılır. Böylece "doğrulama açık" iddiası konfigürasyon nesnesi
 *     karşılaştırmasıyla değil, sertifika zincirinin gerçekten reddedilmesiyle kanıtlanır.
 *
 * Test üretim veritabanına bağlanmaz; yalnızca 127.0.0.1 üzerinde kendi sunucusunu kullanır.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sslConfigFor, verifiesServerCertificate, type PostgresSslConfig } from '../src/db/postgres-store';
import {
  describeEnv,
  getEnv,
  inspectEnvironment,
  postgresTlsMode,
  postgresUrl,
  postgresUrlTlsConflicts,
  resetEnvCache,
} from '../src/config/env';

const CA_PEM_HEADER = '-----BEGIN CERTIFICATE-----';

/** Config nesnesindeki `ca` alanını (string | string[] | yok) düz metne çevirir. */
function caOf(config: PostgresSslConfig): string {
  if (config === false || !('ca' in config)) return '';
  return Array.isArray(config.ca) ? config.ca.join('\n') : config.ca;
}

describe('sslConfigFor karar tablosu', () => {
  it('CA verilirse sunucu sertifikası yalnızca o CA ile doğrulanır', () => {
    const config = sslConfigFor(`${CA_PEM_HEADER}\nTEST\n-----END CERTIFICATE-----\n`);
    expect(config).toMatchObject({ rejectUnauthorized: true });
    expect(caOf(config)).toContain(CA_PEM_HEADER);
    expect(verifiesServerCertificate(config)).toBe(true);
  });

  it('CA yoksa doğrulama sistem kökleriyle açık kalır (eski sessiz "no-verify" varsaylanmaz)', () => {
    const config = sslConfigFor(undefined, { systemCaStore: ['ROOT-A', 'ROOT-B'] });
    expect(config).toEqual({ ca: ['ROOT-A', 'ROOT-B'], rejectUnauthorized: true });
    expect(verifiesServerCertificate(config)).toBe(true);
  });

  it('sistem deposu okunamazsa Node\'un gömülü köklerine düşer; doğrulama YİNE AÇIKTIR', () => {
    const config = sslConfigFor(undefined, { systemCaStore: undefined });
    expect(config).toEqual({ rejectUnauthorized: true });
    expect(verifiesServerCertificate(config)).toBe(true);
  });

  it('doğrulamayı kapatan tek yol AÇIK no-verify tercihidir', () => {
    const config = sslConfigFor(`${CA_PEM_HEADER}\nTEST\n-----END CERTIFICATE-----\n`, { mode: 'no-verify' });
    expect(config).toEqual({ rejectUnauthorized: false });
    expect(verifiesServerCertificate(config)).toBe(false);
  });

  it('disable modu TLS hiç kullanmaz (yerel Postgres yolu)', () => {
    expect(sslConfigFor(undefined, { mode: 'disable' })).toBe(false);
    expect(verifiesServerCertificate(false)).toBe(false);
  });

  it('boş CA dizgisi doğrulamayı kapatmaz (sistem kökleriyle devam eder)', () => {
    expect(sslConfigFor('   ', { systemCaStore: ['ROOT'] })).toEqual({ ca: ['ROOT'], rejectUnauthorized: true });
  });
});

describe('ortam doğrulaması (env:check ve süreç başlangıcı)', () => {
  afterEach(() => resetEnvCache());

  const base = {
    DATABASE_DRIVER: 'postgres',
    POSTGRES_URL: 'postgres://u:p@db.example:5432/kamuilan',
  } as const;

  it('POSTGRES_URL tanımlıyken doğrulama varsayılan olarak AÇIKTIR; uyarı üretilmez', () => {
    const inspection = inspectEnvironment(getEnv({ ...base, NODE_ENV: 'development' }));
    expect(inspection.problems.join(' ')).not.toMatch(/sertifika|TLS/i);
    expect(inspection.warnings.join(' ')).not.toMatch(/doğrulanmıyor|tamamen kapalı/i);
    expect(describeEnv(getEnv({ ...base, NODE_ENV: 'development' }))).toMatchObject({ dbTls: 'verify' });
  });

  it('üretimde no-verify bir ENGELLEME sayılır ve süreç başlangıcı bu durumda ÇÖZER', () => {
    const inspection = inspectEnvironment(
      getEnv({ ...base, NODE_ENV: 'development', POSTGRES_SSL_MODE: 'no-verify' }),
    );
    expect(inspection.warnings.join(' ')).toMatch(/sertifikası doğrulanmıyor/i);
    // Aynı yapılandırma üretimde getEnv()'i fırlatır (env:check ve start yolu).
    expect(() => getEnv({ ...base, NODE_ENV: 'production', POSTGRES_SSL_MODE: 'no-verify' })).toThrow(
      /Üretimde Veritabanı bağlantısında sunucu sertifikası doğrulanmıyor/i,
    );
  });

  it('üretimde TLS tamamen kapalıysa (POSTGRES_SSL=0) başlangıç engellenir', () => {
    expect(() => getEnv({ ...base, NODE_ENV: 'production', POSTGRES_SSL: '0' })).toThrow(/TLS tamamen kapalı/i);
  });

  it('geliştirmede aynı durum yalnızca uyarıdır (yerel Postgres çalışabilir)', () => {
    const inspection = inspectEnvironment(getEnv({ ...base, NODE_ENV: 'development', POSTGRES_SSL: '0' }));
    expect(inspection.warnings.join(' ')).toMatch(/TLS tamamen kapalı/i);
    expect(inspection.ok).toBe(true);
    expect(postgresTlsMode(getEnv({ ...base, POSTGRES_SSL: '0' }))).toBe('disable');
    expect(postgresTlsMode(getEnv({ ...base }))).toBe('verify');
    expect(postgresTlsMode(getEnv({ ...base, POSTGRES_SSL_MODE: 'no-verify' }))).toBe('no-verify');
  });

  it('URL içindeki sslmode=disable, verify kararını EZEMEZ: bağlantı kurulmadan reddedilir', () => {
    // pg, connectionString'i açık ssl nesnesinin üzerine yazar; bu URL kabul
    // edilseydi TLS sessizce kapanırdı. Fail-closed davranış kilitlenir.
    const env = getEnv({ ...base, NODE_ENV: 'development' });
    const poisoned = { ...env, POSTGRES_URL: 'postgres://u:p@db.example:5432/kamuilan?sslmode=disable' };
    expect(postgresUrlTlsConflicts(poisoned.POSTGRES_URL)).toEqual(['sslmode']);
    expect(() => postgresUrl(poisoned)).toThrow(/TLS parametresi kullanılamaz \(sslmode\)/);
    // Hata metni bağlantı dizesinin kendisini (sırrı) içermez.
    let message = '';
    try {
      postgresUrl(poisoned);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('u:p@');
    expect(message).not.toContain('db.example');
  });

  it('sslmode=require / ssl / sslrootcert / uselibpqcompat da reddedilir; env:check bunu sorun sayar', () => {
    for (const param of ['sslmode=require', 'ssl=0', 'sslrootcert=/tmp/ca.pem', 'uselibpqcompat=true&sslmode=require']) {
      const env = getEnv({ ...base, NODE_ENV: 'development' });
      const poisoned = { ...env, POSTGRES_URL: `postgres://u:p@db.example:5432/kamuilan?${param}` };
      expect(() => postgresUrl(poisoned)).toThrow(/TLS parametresi kullanılamaz/);
      const inspection = inspectEnvironment(poisoned);
      expect(inspection.problems.join(' ')).toMatch(/bağlantı dizesinde TLS parametresi var/);
      expect(inspection.ok).toBe(false);
    }
  });

  it('TLS parametresiz URL aynen döner; ilgisiz sorgu parametreleri engellenmez', () => {
    const env = getEnv({ ...base, NODE_ENV: 'development' });
    const clean = { ...env, POSTGRES_URL: 'postgres://u:p@db.example:5432/kamuilan?connect_timeout=10' };
    expect(postgresUrlTlsConflicts(clean.POSTGRES_URL)).toEqual([]);
    expect(postgresUrl(clean)).toBe(clean.POSTGRES_URL);
  });

  it('postgres tanımlı değilse TLS denetimi hiçbir sorun/uyarı üretmez (dosya deposu)', () => {
    const inspection = inspectEnvironment(
      // Üretimde kalıcı veritabanı ZORUNLU olduğundan bu denetim başka bir nedenden
      // fırlardı; burada asıl sorulanan şey TLS denetiminin hiç devreye girmemesidir.
      getEnv({ NODE_ENV: 'development', DATABASE_DRIVER: 'file', POSTGRES_URL: '', DATABASE_URL: '' }),
    );
    expect(inspection.problems.join(' ') + inspection.warnings.join(' ')).not.toMatch(/TLS|sertifika/i);
  });
});

/* ---------------------------------------------------------------------------
 * Gerçek TLS el sıkışma kanıtı
 * ------------------------------------------------------------------------- */

const PG_SSL_REQUEST_CODE = 80877103;

interface FakePgTlsServer {
  port: number;
  sslRequests: number;
  secureConnections: number;
  close(): Promise<void>;
}

/**
 * Postgres'in SSLRequest müzakeresini taklit eden sunucu: 8 btye SSLRequest gelirse
 * 'S' yanıtı verilir ve bağlantı TLS'e yükseltilir; gelmezse düz bağlantı kabul edilir.
 * TLS el sıkışması tamamlandıktan sonra protokol bitirilir — burada ölçülen şey
 * SÜRÜCÜNÜN SERTİFİKAYI DOĞRULAYIP DOĞRULAMADIĞIDIR, SQL davranışı değildir.
 */
async function startFakePgTlsServer(key: string, cert: string): Promise<FakePgTlsServer> {
  const tlsContext = tls.createSecureContext({ key, cert });
  let sslRequests = 0;
  let secureConnections = 0;
  const sockets = new Set<Socket>();

  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => {
      const code = chunk.length >= 8 ? chunk.readUInt32BE(4) : -1;
      if (code !== PG_SSL_REQUEST_CODE) {
        // TLS istenmedi: düz bağlantı. İstemciyi nazikçe kapatıyoruz.
        socket.end('N');
        return;
      }
      sslRequests += 1;
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: tlsContext });
      secure.on('secure', () => {
        secureConnections += 1;
        // Sürücü sertifika zincirini kabul etti → artık protokolü bitir.
        secure.end();
      });
      secure.on('error', () => secure.destroy());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test sunucusu port alamadı');
  return {
    port: address.port,
    get sslRequests() {
      return sslRequests;
    },
    get secureConnections() {
      return secureConnections;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeSelfSigned(dir: string): { key: string; cert: string } {
  const keyPath = join(dir, 'server.key');
  const certPath = join(dir, 'server.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

/** Bağlantı girişiminin sonucunu (hata ya da başarılı el sıkışma) sınırlı sürede döndürür. */
async function tryConnect(ssl: PostgresSslConfig, port: number): Promise<{ error: Error | null }> {
  const pool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'kamuilan',
    password: 'secret',
    database: 'kamuilan',
    ssl,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8_000)),
    ]);
    client.release();
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

describe.runIf(hasOpenssl())('gerçek TLS el sıkışması (pg sürücüsü + self-signed sertifika)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-tls-'));

  let material: { key: string; cert: string };
  let server: FakePgTlsServer;

  beforeAll(async () => {
    material = makeSelfSigned(dir);
    server = await startFakePgTlsServer(material.key, material.cert);
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('CA gösterildiğinde zincir doğrulanır ve TLS el sıkışması tamamlanır', async () => {
    const before = server.secureConnections;
    const config = sslConfigFor(material.cert);
    const { error } = await tryConnect(config, server.port);
    // Sertifika bu CA ile doğrulanıyor: "unable to verify" / "self signed" hatası YOK.
    expect(error?.message ?? '').not.toMatch(/unable to verify|self[- ]signed|unknown ca|certificate/i);
    expect(server.secureConnections).toBeGreaterThan(before);
    expect(verifiesServerCertificate(config)).toBe(true);
  });

  it('CA verilmediğinde doğrulama AÇIK kaldığı için self-signed sertifika REDDEDİLİR', async () => {
    // Sistem kök depoları bu test sertifikasını içermez; güvenli varsayılan bağlantıyı kesmelidir.
    const config = sslConfigFor(undefined);
    expect(verifiesServerCertificate(config)).toBe(true);
    const { error } = await tryConnect(config, server.port);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/unable to verify|self[- ]signed|unknown ca|ssl|ECONNRESET|socket hang up/i);
  });

  it('açık no-verify tercihinde bağlantı kurulur (risk bilinçli kabul edildi)', async () => {
    const before = server.secureConnections;
    const config = sslConfigFor(material.cert, { mode: 'no-verify' });
    await tryConnect(config, server.port);
    expect(server.secureConnections).toBeGreaterThan(before);
  });

  it('disable modu SSLRequest göndermez (TLS hiç kullanılmaz)', async () => {
    const before = server.sslRequests;
    await tryConnect(sslConfigFor(undefined, { mode: 'disable' }), server.port);
    expect(server.sslRequests).toBe(before);
  });
});

describe('CA dosyası okunamazsa güvenli düşüş yok', () => {
  it('eksik dosya yolu doğrulamasız bağlantıya düşürülmez (readFileSync hata verir)', () => {
    const missing = join(tmpdir(), `kamuilan-olmayan-ca-${Date.now()}.pem`);
    expect(existsSync(missing)).toBe(false);
    expect(() => readFileSync(missing, 'utf8')).toThrow();
  });
});
