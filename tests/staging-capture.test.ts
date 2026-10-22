import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `.bin/tsx` Windows'ta kabuk betiğidir; kabuksuz spawnSync onu çalıştıramaz (status null).
// tsx CLI'si doğrudan Node ile çalıştırılır: her platformda aynı.
const TSX_CLI = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRIPT = join(process.cwd(), 'scripts', 'staging-capture.ts');

function runStaging(args: string[], extraEnv: Record<string, string> = {}, cwd = process.cwd()) {
  const root = mkdtempSync(join(tmpdir(), 'kamuradar-staging-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Windows'ta Node/OpenSSL için gerekli sistem değişkenleri (Linux'ta tanımsızdır).
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TEMP } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
  };
  // Vitest'in test ortamını ve üretim işaretlerini taşımıyoruz; açıkça verilen
  // test girdileri (ör. POSTGRES_URL) en son uygulanır.
  for (const key of ['POSTGRES_URL', 'DATABASE_URL', 'MONGODB_URI', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    delete env[key];
  }
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args, `--data-root=${root}`], {
    env,
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...result, root };
}

describe('staging-capture komut kapıları', () => {
  it('kuru çalışma ağa çıkmadan rapor üretir ve veri deposu açmaz', () => {
    const result = runStaging(['--source=resmigazete-cestili-ilanlar', '--dry-run']);
    expect(result.status).toBe(0);
    const runDir = onlyRunDir(result.root);
    const reportPath = join(runDir, 'report', 'staging-report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      mode: string;
      http: { requestsMade: number };
      zeroResultReason: string;
      isolation: { databaseDriver: string };
    };
    expect(report.mode).toBe('dry-run');
    expect(report.http.requestsMade).toBe(0);
    expect(report.zeroResultReason).toBe('dry-run');
    expect(report.isolation.databaseDriver).toBe('file');
    expect(existsSync(join(result.root, 'data'))).toBe(false);
  });

  it('allowlist dışı kaynak reddedilir', () => {
    const result = runStaging(['--source=ilan-gov-tr', '--dry-run']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('allowlist');
  });

  it('insan incelemesi olmadan canlı koşum engellenir', () => {
    // Staging allowlist'teki kaynakların hepsi 22.10.2026'da incelendi; kural, kaydı olmayan
    // bir şartlar dosyasıyla (geçici çalışma dizini) sınanır.
    const result = runStaging(
      ['--source=osym-duyurular', '--live', '--max-requests=1', '--max-pages=1', '--max-details=0'],
      {},
      emptyTermsRoot(),
    );
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('robots/ToS');
  });

  it('üretim veritabanı değişkeni varken çalışmaz', () => {
    const result = runStaging(['--source=osym-duyurular', '--dry-run'], {
      POSTGRES_URL: 'postgres://kullanici:parola@example.invalid/db',
    });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('POSTGRES_URL');
    expect(result.stderr).not.toContain('parola');
  });

  it('alternatif DATABASE_URL doluysa da üretim DB riski sayılır', () => {
    const result = runStaging(['--source=osym-duyurular', '--dry-run'], {
      DATABASE_URL: 'postgres://kullanici:baska-parola@example.invalid/db',
    });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('DATABASE_URL');
    expect(result.stderr).not.toContain('baska-parola');
  });

  it('TLS doğrulamasını kapatan ortamı reddeder', () => {
    const result = runStaging(['--source=osym-duyurular', '--dry-run'], {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('TLS');
  });
});

function emptyTermsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kamuradar-terms-bos-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'source-terms.json'), JSON.stringify({ version: 1, sources: [] }));
  return root;
}

function onlyRunDir(root: string): string {
  const dirs = readdirSync(root);
  const first = dirs[0];
  if (!first) throw new Error('staging dizini yok');
  return join(root, first);
}
