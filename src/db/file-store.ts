/**
 * Dosya tabanlı kalıcı depo (geliştirme ve test).
 *
 * - Tüm koleksiyonlar tek JSON dosyasında tutulur, atomik rename ile yazılır.
 * - Yazma işlemleri bir mutex kuyruğunda serileştirilir; böylece
 *   `insertIfAbsent` tek süreç içinde atomiktir.
 * - Çok örnekli üretim için tasarlanmamıştır: üretimde PostgreSQL/Supabase
 *   zorunludur (bkz. assertProductionSafety).
 *
 * Geliştirmede API, worker ve betikler (ör. `seed:demo`) aynı dosyayı paylaşır.
 * Bu yüzden her okuma/yazma öncesi dosyanın zaman damgası kontrol edilir ve
 * başka bir süreç yazdıysa bellek yeniden yüklenir; aksi hâlde worker'ın kalp
 * atışı yazımı seed betiğinin eklediği kayıtları ezerdi. Yine de tam eşzamanlı
 * çok süreçli kullanım garantili DEĞİLDİR (paylaşımlı kilit yoktur).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createId } from '../domain/ids';
import { COLLECTION_SCHEMAS, type CollectionName, type DocumentOf } from './schemas';
import { INDEXES } from './indexes';
import { applyPatch, matchesQuery, sortDocuments, type FindOptions, type Query } from './query';
import type { IndexSpec, InsertIfAbsentResult, StoragePort } from './ports';

interface FilePayload {
  version: number;
  savedAt: string;
  collections: Record<string, unknown[]>;
}

export class FileStore implements StoragePort {
  readonly driver = 'file' as const;
  private readonly filePath: string;
  private data: Record<CollectionName, DocumentOf<CollectionName>[]>;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;
  /** Diskten son okunan sürümün izi (başka süreç yazdı mı?). */
  private loadedMtimeMs = -1;
  private loadedSize = -1;

  constructor(dataDir: string, fileName = 'kamuilan.json') {
    this.filePath = join(dataDir, fileName);
    this.data = this.emptyCollections();
    mkdirSync(dataDir, { recursive: true });
  }

  private emptyCollections(): Record<CollectionName, DocumentOf<CollectionName>[]> {
    const out = {} as Record<CollectionName, DocumentOf<CollectionName>[]>;
    for (const name of Object.keys(COLLECTION_SCHEMAS) as CollectionName[]) {
      out[name] = [];
    }
    return out;
  }

  async init(): Promise<void> {
    if (!existsSync(this.filePath)) {
      await this.flush();
      return;
    }
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const stat = statSync(this.filePath);
      const parsed = JSON.parse(raw) as FilePayload;
      this.data = this.emptyCollections();
      for (const [name, docs] of Object.entries(parsed.collections ?? {})) {
        if (name in this.data && Array.isArray(docs)) {
          this.data[name as CollectionName] = docs as DocumentOf<CollectionName>[];
        }
      }
      this.loadedMtimeMs = stat.mtimeMs;
      this.loadedSize = stat.size;
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync(this.filePath, backup);
      this.data = this.emptyCollections();
      this.loadedMtimeMs = -1;
      this.loadedSize = -1;
      throw new Error(
        `Veri dosyası okunamadı, bozuk kopya ${backup} olarak saklandı: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Başka bir süreç dosyayı değiştirdiyse belleği tazeler.
   * Okuma ve yazma işlemlerinin başında çağrılır; böylece kayıtlar kaybolmaz.
   */
  private refreshIfChanged(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.mtimeMs === this.loadedMtimeMs && stat.size === this.loadedSize) return;
      this.loadFromDisk();
    } catch {
      // Dosya henüz yok: bellekteki durum geçerli.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue;
    this.flush();
  }

  private flush(): void {
    const payload: FilePayload = {
      version: 1,
      savedAt: new Date().toISOString(),
      collections: this.data as unknown as Record<string, unknown[]>,
    };
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, this.filePath);
    try {
      const stat = statSync(this.filePath);
      this.loadedMtimeMs = stat.mtimeMs;
      this.loadedSize = stat.size;
    } catch {
      // İzin/yarış durumu: sonraki okuma tazeleme denemesi yapacak.
    }
  }

  /** Yazma serileştirme: tüm mutasyonlar bu kuyruktan geçer. */
  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.writeQueue.then(async () => {
      this.refreshIfChanged();
      const result = await operation();
      this.flush();
      return result;
    });
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async health(): Promise<{ ok: boolean; driver: string; detail: string }> {
    return {
      ok: !this.closed,
      driver: this.driver,
      detail: `Dosya deposu: ${this.filePath} (yerel geliştirme; üretimde Supabase/PostgreSQL kullanın)`,
    };
  }

  async ensureIndexes(
    indexes: readonly IndexSpec[] = INDEXES,
  ): Promise<{ collection: string; name: string; created: boolean }[]> {
    const report: { collection: string; name: string; created: boolean }[] = [];
    for (const index of indexes) {
      // Dosya sürücüsünde indeks fiziksel değildir; benzersizlik sözleşmesi
      // insertIfAbsent içinde uygulanır. Rapor yine de üretilir.
      if (index.unique) {
        const docs = this.data[index.collection] as Record<string, unknown>[];
        const seen = new Set<string>();
        for (const doc of docs) {
          const key = JSON.stringify(index.keys.map(([path]) => readPath(doc, path)));
          if (seen.has(key)) {
            throw new Error(
              `Benzersizlik ihlali: ${index.collection}.${index.name} -> ${key}. Veri elle düzeltilmeli.`,
            );
          }
          seen.add(key);
        }
      }
      report.push({ collection: index.collection, name: index.name, created: true });
    }
    return report;
  }

  async insertOne<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<DocumentOf<K>> {
    return this.mutate(() => {
      (this.data[collection] as DocumentOf<K>[]).push(doc);
      return doc;
    });
  }

  async insertMany<K extends CollectionName>(collection: K, docs: DocumentOf<K>[]): Promise<number> {
    return this.mutate(() => {
      (this.data[collection] as DocumentOf<K>[]).push(...docs);
      return docs.length;
    });
  }

  async findOne<K extends CollectionName>(collection: K, filter: Query): Promise<DocumentOf<K> | null> {
    await this.writeQueue;
    this.refreshIfChanged();
    const rows = this.data[collection] as unknown[];
    for (const row of rows) if (matchesQuery(row, filter)) return row as DocumentOf<K>;
    return null;
  }

  async find<K extends CollectionName>(
    collection: K,
    filter: Query = {},
    options: FindOptions = {},
  ): Promise<DocumentOf<K>[]> {
    await this.writeQueue;
    this.refreshIfChanged();
    const rows = (this.data[collection] as unknown[]).filter((row) =>
      matchesQuery(row, filter),
    ) as DocumentOf<K>[];
    const sorted = sortDocuments(rows, options.sort);
    const skip = options.skip ?? 0;
    const limited =
      options.limit !== undefined ? sorted.slice(skip, skip + options.limit) : sorted.slice(skip);
    return limited;
  }

  async count<K extends CollectionName>(collection: K, filter: Query = {}): Promise<number> {
    await this.writeQueue;
    this.refreshIfChanged();
    return (this.data[collection] as unknown[]).filter((row) => matchesQuery(row, filter)).length;
  }

  async updateOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<DocumentOf<K> | null> {
    return this.mutate(() => {
      const rows = this.data[collection] as unknown as Record<string, unknown>[];
      const index = rows.findIndex((row) => matchesQuery(row, filter));
      if (index < 0) return null;
      const updated = applyPatch(rows[index] as object, patch) as unknown as DocumentOf<K>;
      rows[index] = updated as unknown as Record<string, unknown>;
      return updated;
    });
  }

  async upsertOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    doc: DocumentOf<K>,
    patch: Record<string, unknown> = {},
  ): Promise<{ document: DocumentOf<K>; created: boolean }> {
    return this.mutate(() => {
      const rows = this.data[collection] as unknown as Record<string, unknown>[];
      const index = rows.findIndex((row) => matchesQuery(row, filter));
      if (index >= 0) {
        const updated = applyPatch(rows[index] as object, patch) as unknown as DocumentOf<K>;
        rows[index] = updated as unknown as Record<string, unknown>;
        return { document: updated, created: false };
      }
      rows.push(doc as unknown as Record<string, unknown>);
      return { document: doc, created: true };
    });
  }

  async insertIfAbsent<K extends CollectionName>(
    collection: K,
    doc: DocumentOf<K>,
  ): Promise<InsertIfAbsentResult<K>> {
    return this.mutate(() => {
      const schema = COLLECTION_SCHEMAS[collection];
      const unique = INDEXES.filter((index) => index.collection === collection && index.unique);
      const rows = this.data[collection] as unknown as Record<string, unknown>[];
      for (const index of unique) {
        const target = uniqueKeyOf(doc as unknown as Record<string, unknown>, index.keys);
        for (const row of rows) {
          if (uniqueKeyOf(row, index.keys) === target) {
            return { inserted: false, document: row as unknown as DocumentOf<K> };
          }
        }
      }
      void schema;
      rows.push(doc as unknown as Record<string, unknown>);
      return { inserted: true, document: doc };
    });
  }

  async updateMany<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<number> {
    return this.mutate(() => {
      const rows = this.data[collection] as unknown as Record<string, unknown>[];
      let updated = 0;
      for (let i = 0; i < rows.length; i += 1) {
        if (!matchesQuery(rows[i], filter)) continue;
        rows[i] = applyPatch(rows[i] as object, patch) as unknown as Record<string, unknown>;
        updated += 1;
      }
      return updated;
    });
  }

  async deleteOne<K extends CollectionName>(collection: K, filter: Query): Promise<boolean> {
    return this.mutate(() => {
      const rows = this.data[collection] as unknown as Record<string, unknown>[];
      const index = rows.findIndex((row) => matchesQuery(row, filter));
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    });
  }

  async deleteMany<K extends CollectionName>(collection: K, filter: Query): Promise<number> {
    return this.mutate(() => {
      const rows = this.data[collection] as unknown as Record<string, unknown>[];
      const kept = rows.filter((row) => !matchesQuery(row, filter));
      const removed = rows.length - kept.length;
      this.data[collection] = kept as DocumentOf<CollectionName>[];
      return removed;
    });
  }

  async truncate(collection: CollectionName): Promise<void> {
    await this.mutate(() => {
      this.data[collection] = [];
    });
  }

  /** Test yardımcıları için ham erişim. */
  rawSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, docs] of Object.entries(this.data)) out[name] = docs.length;
    return out;
  }
}

function readPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[segment];
    return undefined;
  }, doc);
}

function uniqueKeyOf(doc: Record<string, unknown>, keys: ReadonlyArray<readonly [string, 1 | -1]>): string {
  return JSON.stringify(keys.map(([path]) => readPath(doc, path) ?? null));
}

/** Yeni kimlik üretimi için yardımcı (depo dışı kodlar da kullanır). */
export function newId(prefix: string): string {
  return createId(prefix);
}
