/**
 * Depolama arayüzü (port).
 *
 * Üç sürücü aynı sözleşmeyi uygular:
 *  - postgres: ÜRETİM. Supabase (Postgres) üzerinde JSONB tablo/indeksler.
 *  - mongodb : alternatif kalıcı sürücü (eski kurulumlar).
 *  - file    : yerel geliştirme/test. data/kamuilan.json içinde kalıcı,
 *              atomik yazma + süreç içi kilit ile tutarlı.
 *
 * Üst katmanlar (ingest, notifier, API) yalnızca bu arayüzü bilir.
 */
import type { CollectionName, DocumentOf } from './schemas';
import type { FindOptions, Query } from './query';

export interface IndexSpec {
  collection: CollectionName;
  name: string;
  keys: ReadonlyArray<readonly [string, 1 | -1]>;
  unique?: boolean;
}

export interface InsertIfAbsentResult<K extends CollectionName> {
  inserted: boolean;
  document: DocumentOf<K>;
}

export interface StoragePort {
  readonly driver: 'postgres' | 'mongodb' | 'file';

  /** Bağlantı/yerel dosya deposunu hazırlar; kalıcı sürücülerde şema DDL'i çalıştırmaz. */
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; driver: string; detail: string }>;

  /** Benzersiz indeksleri oluşturur (idempotent). */
  ensureIndexes(indexes?: readonly IndexSpec[]): Promise<{ collection: string; name: string; created: boolean }[]>;

  insertOne<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<DocumentOf<K>>;
  insertMany<K extends CollectionName>(collection: K, docs: DocumentOf<K>[]): Promise<number>;

  findOne<K extends CollectionName>(collection: K, filter: Query): Promise<DocumentOf<K> | null>;
  find<K extends CollectionName>(collection: K, filter?: Query, options?: FindOptions): Promise<DocumentOf<K>[]>;
  count<K extends CollectionName>(collection: K, filter?: Query): Promise<number>;

  /** Kısmi güncelleme (nokta yolu destekler). Bulunamazsa null döner. */
  updateOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<DocumentOf<K> | null>;

  /**
   * Eşleşen belgenin sayısal sayacını depoda atomik olarak artırır.
   * Bulunamazsa null döner; çağıran, sayacı oku-yaz yaparak artırmamalıdır.
   */
  incrementOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    field: string,
    amount?: number,
  ): Promise<DocumentOf<K> | null>;

  /** Sayacın artış sonrası sınırı aşmayacağı durumda atomik artırır. */
  incrementOneIfBelow<K extends CollectionName>(
    collection: K,
    filter: Query,
    field: string,
    amount: number,
    maximum: number,
  ): Promise<DocumentOf<K> | null>;

  /** Filtre eşleşiyorsa günceller, eşleşmiyorsa ekler. */
  upsertOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    doc: DocumentOf<K>,
    patch?: Record<string, unknown>,
  ): Promise<{ document: DocumentOf<K>; created: boolean }>;

  /**
   * Atomik "yoksa ekle": benzersiz anahtar çakışırsa mevcut kaydı döner.
   * İki worker aynı işi işlediğinde çift ilan/bildirim oluşmasını engeller.
   */
  insertIfAbsent<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<InsertIfAbsentResult<K>>;

  updateMany<K extends CollectionName>(collection: K, filter: Query, patch: Record<string, unknown>): Promise<number>;
  deleteOne<K extends CollectionName>(collection: K, filter: Query): Promise<boolean>;
  deleteMany<K extends CollectionName>(collection: K, filter: Query): Promise<number>;

  /** Yalnızca test/seed amaçlı: koleksiyonu boşaltır. */
  truncate(collection: CollectionName): Promise<void>;
}
