/**
 * Salt okuma güvencesi: depoyu açıp kapatmak (ör. kuru çalıştırma) dosyayı yeniden yazmaz.
 * Yazmalar ise yine kalıcı olur.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';

describe('dosya deposu salt okuma', () => {
  it('açıp kapatmak dosyayı değiştirmez (savedAt ve içerik aynı kalır)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-ro-'));
    const writer = new FileStore(dir);
    await writer.init();
    await writer.insertOne('sources', { key: 'ro-test' } as never);
    await writer.close();
    const filePath = join(dir, 'kamuilan.json');
    const before = readFileSync(filePath, 'utf8');
    const mtimeBefore = statSync(filePath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const reader = new FileStore(dir);
    await reader.init();
    const rows = await reader.find('sources', {});
    expect(rows.length).toBe(1);
    await reader.close();

    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });

  it('yazma kapatmadan önce de kalıcıdır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-rw-'));
    const store = new FileStore(dir);
    await store.init();
    await store.insertOne('sources', { key: 'persist-test' } as never);
    await store.close();
    const reopened = new FileStore(dir);
    await reopened.init();
    const rows = (await reopened.find('sources', {})) as Array<{ key: string }>;
    expect(rows.map((row) => row.key)).toEqual(['persist-test']);
    await reopened.close();
  });
});
