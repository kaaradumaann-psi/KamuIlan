/** Depo sürücüsü seçimi: açık `file` seçimi bulut yapılandırmasını geçersiz kılmalıdır. */
import { describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { effectiveDriver } from '../src/db/store';

const CLOUD = { POSTGRES_URL: 'postgresql://user:pass@db.example.test:5432/postgres' };

describe('effectiveDriver', () => {
  it('DATABASE_DRIVER=file iken POSTGRES_URL tanımlı olsa bile dosya deposunu seçer', () => {
    expect(effectiveDriver(getEnv({ ...CLOUD, DATABASE_DRIVER: 'file' }))).toBe('file');
  });

  it('DATABASE_DRIVER=supabase ise Postgres seçer', () => {
    expect(effectiveDriver(getEnv({ ...CLOUD, DATABASE_DRIVER: 'supabase' }))).toBe('postgres');
  });

  it('sürücü belirtilmemiş ve POSTGRES_URL varsa Postgres seçer (geriye dönük davranış)', () => {
    expect(effectiveDriver(getEnv({ ...CLOUD, DATABASE_DRIVER: undefined }))).toBe('postgres');
  });
});
