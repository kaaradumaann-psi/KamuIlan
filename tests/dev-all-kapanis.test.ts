/**
 * Geliştirme süreçlerinin sinyalle kapanışı (Ctrl+C) regresyonu.
 *
 * 2026-10-16 Windows koşumunda `npm run dev` Ctrl+C ile durdurulduğunda
 * süreç kapanmak yerine çöküyordu:
 *
 *   TypeError [ERR_INVALID_ARG_TYPE]: The "code" argument must be of type
 *   number. Received type string ('SIGINT')
 *
 * Kök neden: `process.on('SIGINT', shutdown)` — Node dinleyiciye sinyal ADINI
 * geçirir, `shutdown(exitCode = 0)` bunu çıkış kodu olarak alır ve
 * `process.exit('SIGINT')` çağrılır.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { safeExitCode, signalExitCode } from '../scripts/lib/exit-codes';
import { REPO_ROOT, tsxCliPath } from './helpers/run-tsx';

const isWindows = process.platform === 'win32';

describe('signalExitCode', () => {
  it('bilinen sinyalleri POSIX geleneğine göre sayıya çevirir', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGQUIT')).toBe(131);
  });

  it('küçük/büyük harf duyarsızdır ve tam sayıyı olduğu gibi geçirir', () => {
    expect(signalExitCode('sigint')).toBe(130);
    expect(signalExitCode(1)).toBe(1);
    expect(signalExitCode(0)).toBe(0);
  });

  it('tanınmayan ya da bozuk girdi fallback döner (asla string dönmez)', () => {
    expect(signalExitCode('SIGBILINMEYEN')).toBe(0);
    expect(signalExitCode('SIGBILINMEYEN', 1)).toBe(1);
    expect(signalExitCode(undefined)).toBe(0);
    expect(signalExitCode(null)).toBe(0);
    expect(signalExitCode({})).toBe(0);
    expect(signalExitCode(Number.NaN)).toBe(0);
    expect(signalExitCode(1.5)).toBe(0);
    expect(typeof signalExitCode('SIGINT')).toBe('number');
  });
});

describe('safeExitCode', () => {
  it('process.exit’e verilecek değeri her zaman sayıya indirger', () => {
    expect(safeExitCode(0)).toBe(0);
    expect(safeExitCode(1)).toBe(1);
    expect(safeExitCode(130)).toBe(130);
    // Orijinal hata: sinyal adı doğrudan process.exit’e geçiyordu.
    expect(safeExitCode('SIGINT')).toBe(0);
    expect(safeExitCode('SIGINT', 130)).toBe(130);
    expect(safeExitCode(undefined, 2)).toBe(2);
  });
});

/** Yorumları atar: dokümantasyon hatalı kalıbı ÖRNEK olarak içerebilir. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('dev-all.ts kaynağı', () => {
  const source = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'dev-all.ts'), 'utf8'));

  it('sinyal dinleyicisini doğrudan shutdown’a bağlamaz (hata geri gelmesin)', () => {
    expect(source).not.toMatch(/process\.on\(\s*['"]SIG(?:INT|TERM|HUP)['"]\s*,\s*shutdown\s*\)/);
  });

  it('çıkış kodunu sayıya indirgeyen yardımcıyı kullanır', () => {
    expect(source).toMatch(/signalExitCode\(/);
    expect(source).toMatch(/safeExitCode\(/);
    // process.exit’e ham sinyal adı geçirilmemeli.
    expect(source).not.toMatch(/process\.exit\(\s*['"]/);
  });
});

describe('sinyal alan süreç', () => {
  it.skipIf(isWindows)('SIGINT sonrası 130 ile çıkar ve ERR_INVALID_ARG_TYPE üretmez', async () => {
    const child = spawn(process.execPath, [tsxCliPath(), join(REPO_ROOT, 'tests', 'fixtures', 'signal-harness.ts')], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('kabuk hazır sinyali vermedi')), 30_000);
      child.stdout.on('data', (chunk: string) => {
        if (chunk.includes('hazir')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.kill('SIGINT');
    });

    expect(stderr).not.toContain('ERR_INVALID_ARG_TYPE');
    expect(exitCode).toBe(130);
    expect(stdout).toContain('hazir');
  }, 40_000);
});
