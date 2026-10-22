/**
 * Adaptör kayıt defteri.
 *
 * Yeni kaynak ekleme akışı (docs/source-onboarding.md):
 *  1. Uygun adaptörü seç (ya da yaz) ve burada `adapterKey` ile kaydet.
 *  2. `src/config/sources.ts` envanterine kaynak kaydını ekle (doğrulama kanıtıyla).
 *  3. Fixture testi yaz; canlı doğrulamayı `npm run test:live` ile çalıştır.
 *
 * Bu dosya dışında hiçbir yer adaptör adlarını bilmez.
 */
import type { SourceAdapter } from './types';
import { ResmiGazeteAdapter } from './adapters/resmigazete';
import { IlanGovTrAdapter } from './adapters/ilan-gov-tr';
import { IlanGovTrApiAdapter } from './adapters/ilan-gov-tr-api';
import { OsymAdapter } from './adapters/osym';
import { SbbKamuIlanAdapter } from './adapters/sbb-kamuilan';
import { KariyerKapisiAdapter } from './adapters/kariyerkapisi';
import { ManualEntryAdapter } from './adapters/manual-entry';
import { IskurEsubeAdapter } from './adapters/iskur-esube';
import { createIskurAdapter, createKurumAdapter, createMebAdapter } from './adapters/anchor-list';

const ADAPTERS: readonly SourceAdapter[] = [
  new ResmiGazeteAdapter(),
  new IlanGovTrAdapter(),
  new IlanGovTrApiAdapter(),
  new OsymAdapter(),
  new SbbKamuIlanAdapter(),
  new KariyerKapisiAdapter(),
  new IskurEsubeAdapter(),
  createIskurAdapter(),
  createMebAdapter(),
  createKurumAdapter(),
  new ManualEntryAdapter(),
];

const registry = new Map<string, SourceAdapter>(ADAPTERS.map((adapter) => [adapter.key, adapter]));

export function getAdapter(adapterKey: string): SourceAdapter | null {
  return registry.get(adapterKey) ?? null;
}

export function requireAdapter(adapterKey: string): SourceAdapter {
  const adapter = registry.get(adapterKey);
  if (!adapter) {
    throw new Error(
      `Adaptör kayıtlı değil: ${adapterKey}. src/sources/registry.ts içine ekleyip config/sources.ts envanterini güncelleyin.`,
    );
  }
  return adapter;
}

export function listAdapters(): { key: string; label: string; method: string }[] {
  return ADAPTERS.map((adapter) => ({ key: adapter.key, label: adapter.label, method: adapter.method }));
}

export {
  ResmiGazeteAdapter,
  IlanGovTrAdapter,
  OsymAdapter,
  SbbKamuIlanAdapter,
  KariyerKapisiAdapter,
  ManualEntryAdapter,
};
