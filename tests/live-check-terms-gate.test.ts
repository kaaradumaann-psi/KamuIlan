/**
 * `test:live` de staging ile AYNI insan onayı kapısından geçmelidir.
 *
 * Bu test alt süreçte CLI'yi, kaydı olmayan bir `config/source-terms.json` içeren geçici
 * çalışma dizininde çalıştırır; kaynak incelenmemiş sayıldığı için ağa çıkmadan exit 5 beklenir. Güvenlik ağı:
 * SOURCE_ALLOWED_HOSTS geçersiz bir ada çekilir; kapı ileride kaldırılırsa bile
 * istek gerçek siteye gitmez.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('test:live erişim şartları kapısı', () => {
  it('insan incelemesi yokken HTTP istemcisi kurmadan exit 5 verir', () => {
    const root = mkdtempSync(join(tmpdir(), 'kamuradar-live-terms-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'source-terms.json'), JSON.stringify({ version: 1, sources: [] }));
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(process.cwd(), 'scripts', 'live-check.ts'),
        '--live',
        '--source=osym-duyurular',
        '--max-requests=1',
        '--max-pages=1',
        '--max-details=0',
        '--min-delay-ms=1000',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          SOURCE_LIVE_FETCH: '1',
          SOURCE_BROWSER_FALLBACK: '0',
          SOURCE_ALLOWED_HOSTS: 'blocked.invalid',
        },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(5);
    expect(output).toContain('Erişim şartları kapısı');
    expect(output).toContain('Hiçbir istek yapılmadı');
    expect(output).not.toContain('→ osym');
    expect(output).not.toContain('HTTP attempt');
  }, 35_000);
});
