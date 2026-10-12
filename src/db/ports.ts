/**
 * Depolama arayüzü (port).
 *
 * İki sürücü aynı sözleşmeyi uygular:
 *  - mongodb : üretim. Kalıcı, çok örnekli, benzersiz indekslerle yarış koruması.
 *  - file    : yerel geliştirme/test. data/kamuradar.json içinde kalıcı,
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
  readonly driver: 'mongodb' | 'file';

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
