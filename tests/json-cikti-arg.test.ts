/**
 * `--json [dosya]` bayrağının çözümlenmesi ve rapor yazımı testleri.
 *
 * Kanıt (16.10.2026, kullanıcının makinesi):
 *  - `npm run eval:classification -- --llm --json` → hiçbir dosya yazılmadı, uyarı da yoktu.
 *  - `npm run llm:doctor -- --json data\llm-doktor.json` → yol yok sayıldı, JSON konsola basıldı.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseJsonOutputArg, writeJsonReport } from '../src/lib/json-output';

const dir = mkdtempSync(join(tmpdir(), 'kamuilan-json-cikti-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('--json bayrağının çözümlenmesi', () => {
  it('bayrak yoksa hiçbir şey yazılmaz', () => {
    expect(parseJsonOutputArg(['node', 'script.ts', '--llm'])).toEqual({ mode: 'yok' });
  });

  it('bayrak var, yol yok → çıktı konsola gider', () => {
    expect(parseJsonOutputArg(['node', 'script.ts', '--llm', '--json'])).toEqual({ mode: 'stdout' });
  });

  it('bayraktan sonra başka bir bayrak gelirse yol sayılmaz (--json --llm)', () => {
    expect(parseJsonOutputArg(['node', 'script.ts', '--json', '--llm'])).toEqual({ mode: 'stdout' });
  });

  it('bayraktan sonra dosya yolu gelirse dosyaya yazılır', () => {
    expect(parseJsonOutputArg(['node', 'script.ts', '--json', 'data/rapor.json'])).toEqual({
      mode: 'dosya',
      path: 'data/rapor.json',
    });
  });

  it('Windows biçimli yol da yol sayılır', () => {
    expect(parseJsonOutputArg(['node', 'script.ts', '--json', 'data\\ai-kapisi.json'])).toEqual({
      mode: 'dosya',
      path: 'data\\ai-kapisi.json',
    });
  });
});

describe('rapor yazımı', () => {
  it('var olan klasöre yazar ve JSON biçimini korur', () => {
    const target = join(dir, 'rapor.json');
    const result = writeJsonReport(target, { a: 1, metin: 'şğü' });
    expect(result).toEqual({ ok: true, path: target });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1, metin: 'şğü' });
    // İnsan okunur biçim: girinti + satır sonu.
    expect(readFileSync(target, 'utf8').endsWith('}\n')).toBe(true);
    expect(statSync(target).size).toBeGreaterThan(0);
  });

  it('olmayan klasörde fırlatmaz, anlaşılır hata döner ve dosya bırakmaz', () => {
    const target = join(dir, 'yok', 'rapor.json');
    const result = writeJsonReport(target, { a: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(false);
  });
});
