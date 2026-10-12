/**
 * Adaptör kayıt defteri.
 *
 * Yeni kaynak ekleme akışı (docs/source-onboarding.md):
 *  1. Adaptör yaz (veya mevcut generic adaptörü yapılandır).
 *  2. Burada `adapterKey` ile kaydet.
 *  3. config/sources.ts envanterine kaynak kaydını ekle.
 *  4. Fixture testi yaz; canlı doğrulamayı `npm run test:live` ile çalıştır.
 *
 * Uygulamanın tamamını değiştirmek gerekmez.
 */
import type { SourceAdapter } from './types';
import { ResmiGazeteAdapter } from './adapters/resmigazete';
import { IlanGovTrAdapter } from './adapters/ilan-gov-tr';
import { OsymAdapter } from './adapters/osym';
import { createIskurAdapter, createMebAdapter } from './adapters/anchor-list';
import { KariyerKapisiAdapter } from './adapters/kariyerkapisi';
import { ManualAdapter } from './adapters/manual';

const ADAPTERS: readonly SourceAdapter[] = [
  new ResmiGazeteAdapter(),
  new IlanGovTrAdapter(),
  new OsymAdapter(),
  createIskurAdapter(),
  createMebAdapter(),
  new KariyerKapisiAdapter(),
  new ManualAdapter(),
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

export function listAdapters(): { key: string; label: string }[] {
  return ADAPTERS.map((adapter) => ({ key: adapter.key, label: adapter.label }));
}

export { ResmiGazeteAdapter, IlanGovTrAdapter, OsymAdapter, KariyerKapisiAdapter, ManualAdapter };
