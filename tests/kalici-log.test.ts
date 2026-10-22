/**
 * Kalıcı log (LOG_FILE): döndürme, yeniden başlatmada koruma, dosyada sır maskeleme.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingFileStream } from '../src/lib/rotating-file';
import { resetEnvCache } from '../src/config/env';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-log-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LOG_FILE;
  delete process.env.LOG_LEVEL;
  resetEnvCache();
});

describe('RotatingFileStream', () => {
  it('sınırı aşınca döndürür, en fazla maxFiles eski dosya tutar, satır kaybetmez', () => {
    const path = join(tempDir(), 'alt', 'api.log');
    const stream = new RotatingFileStream(path, { maxBytes: 100, maxFiles: 2 });
    const lines = Array.from({ length: 12 }, (_, i) => `{"n":${i},"dolgu":"xxxxxxxxxxxxxxxx"}\n`);
    for (const line of lines) stream.write(line);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    const current = readFileSync(path, 'utf8');
    expect(current).toContain('"n":11');
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(100);
  });

  it('yeniden açılınca (süreç yeniden başlatma) mevcut dosyaya ekler', () => {
    const path = join(tempDir(), 'worker.log');
    new RotatingFileStream(path, { maxBytes: 10_000, maxFiles: 2 }).write('{"once":1}\n');
    new RotatingFileStream(path, { maxBytes: 10_000, maxFiles: 2 }).write('{"sonra":2}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"once":1}\n{"sonra":2}\n');
  });
});

describe('createLogger + LOG_FILE', () => {
  it('JSON satırları dosyaya yazılır; sırlar ve e-posta maskelenir', async () => {
    const path = join(tempDir(), 'api.log');
    process.env.LOG_FILE = path;
    process.env.LOG_LEVEL = 'info';
    resetEnvCache();
    const { createLogger } = await import('../src/lib/logger');
    const logger = createLogger('kalici-log-test');
    logger.error(
      { email: 'kisi@ornek.test', apiKey: 'gsk_GIZLIANAHTAR', password: 'parola', sourceKey: 'resmigazete', durationMs: 42 },
      'tarama başarısız',
    );
    logger.flush?.();
    const line = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
    expect(line.msg).toBe('tarama başarısız');
    expect(line.level).toBe(50);
    expect(line.sourceKey).toBe('resmigazete');
    expect(typeof line.time).toBe('string');
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('gsk_GIZLIANAHTAR');
    expect(raw).not.toContain('kisi@ornek.test');
    expect(raw).not.toContain('"parola"');
  });
});
