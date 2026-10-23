/**
 * Veritabanını yalnız OKUYAN operatör araçları şema/indeks DDL çalıştırmamalı.
 *
 * Eski davranış (22.10.2026): `eval:build-set` ve `sources:report` `initStore()`'u seçeneksiz
 * çağırıyordu → varsayılan `ensureIndexes()` canlı Supabase veritabanında CREATE INDEX çalıştırdı
 * (17 indeks oluştu; veri değişmedi). "Salt okunur" iddiası koda bağlanır.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const READ_ONLY_SCRIPTS = [
  'eval-build-set.ts',
  'coverage-report.ts',
  'coverage-measure.ts',
  'runs-retention.ts',
  'durum.ts',
];

describe('salt okunur betikler', () => {
  it.each(READ_ONLY_SCRIPTS)('%s depoyu ensureIndexes:false ile açar', (name) => {
    const source = readFileSync(join(process.cwd(), 'scripts', name), 'utf8');
    const calls = [...source.matchAll(/initStore\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    expect(calls.length, 'initStore çağrısı bulunamadı').toBeGreaterThan(0);
    for (const args of calls) expect(args).toContain('ensureIndexes: false');
  });
});
