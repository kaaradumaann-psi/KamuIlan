/**
 * MongoDB tabanlı depo (üretim).
 *
 * Benzersiz indeksler yarış koşullarını çözer: iki worker aynı anda aynı
 * ilanı/bildirimi yazmaya çalışırsa ikinci yazma duplicate key (11000) alır ve
 * sistem mevcut kaydı kullanır.
 */
import { MongoClient, MongoServerError, type Db, type Document, type Filter } from 'mongodb';
import { COLLECTION_SCHEMAS, type CollectionName, type DocumentOf } from './schemas';
import { INDEXES } from './indexes';
import { applyPatch, toMongoFilter, type FindOptions, type Query } from './query';
import type { IndexSpec, InsertIfAbsentResult, StoragePort } from './ports';

export interface MongoStoreOptions {
  uri: string;
  dbName: string;
  maxPoolSize?: number;
  serverSelectionTimeoutMS?: number;
}

export class MongoStore implements StoragePort {
  readonly driver = 'mongodb' as const;
  private client: MongoClient;
  private db: Db | null = null;
  private readonly options: MongoStoreOptions;

  constructor(options: MongoStoreOptions) {
    this.options = options;
    this.client = new MongoClient(options.uri, {
      maxPoolSize: options.maxPoolSize ?? 10,
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 8_000,
      retryWrites: true,
    });
  }

  private database(): Db {
    if (!this.db) throw new Error('MongoStore.init() çağrılmadan kullanılamaz.');
    return this.db;
  }

  private collection<K extends CollectionName>(name: K) {
    return this.database().collection(name);
  }

  async init(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.options.dbName);
    await this.db.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client.close();
    this.db = null;
  }

  async health(): Promise<{ ok: boolean; driver: string; detail: string }> {
    try {
      await this.database().command({ ping: 1 });
      return { ok: true, driver: this.driver, detail: `MongoDB: ${this.options.dbName}` };
    } catch (error) {
      return { ok: false, driver: this.driver, detail: (error as Error).message };
    }
  }

  async ensureIndexes(
    indexes: readonly IndexSpec[] = INDEXES,
  ): Promise<{ collection: string; name: string; created: boolean }[]> {
    const report: { collection: string; name: string; created: boolean }[] = [];
    for (const index of indexes) {
      const keys = Object.fromEntries(index.keys.map(([path, dir]) => [path, dir]));
      const existing = await this.collection(index.collection).indexExists(index.name);
      await this.collection(index.collection).createIndex(keys, {
        name: index.name,
        unique: index.unique ?? false,
        background: false,
      });
      report.push({ collection: index.collection, name: index.name, created: !existing });
    }
    return report;
  }

  async insertOne<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<DocumentOf<K>> {
    await this.collection(collection).insertOne({ ...(doc as object) } as Document);
    return doc;
  }

  async insertMany<K extends CollectionName>(collection: K, docs: DocumentOf<K>[]): Promise<number> {
    if (docs.length === 0) return 0;
    const result = await this.collection(collection).insertMany(docs.map((doc) => ({ ...(doc as object) })) as Document[]);
    return result.insertedCount;
  }

  async findOne<K extends CollectionName>(collection: K, filter: Query): Promise<DocumentOf<K> | null> {
    const found = await this.collection(collection).findOne(toMongoFilter(filter) as Filter<Document>);
    return stripId(found) as DocumentOf<K> | null;
  }

  async find<K extends CollectionName>(
    collection: K,
    filter: Query = {},
    options: FindOptions = {},
  ): Promise<DocumentOf<K>[]> {
    let cursor = this.collection(collection).find(toMongoFilter(filter) as Filter<Document>);
    if (options.sort && options.sort.length > 0) {
      cursor = cursor.sort(
        Object.fromEntries(options.sort.map(([path, dir]) => [path, dir])) as Record<string, 1 | -1>,
      );
    }
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit !== undefined) cursor = cursor.limit(options.limit);
    const rows = await cursor.toArray();
    return rows.map((row) => stripId(row)) as DocumentOf<K>[];
  }

  async count<K extends CollectionName>(collection: K, filter: Query = {}): Promise<number> {
    return this.collection(collection).countDocuments(toMongoFilter(filter) as Filter<Document>);
  }

  async updateOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<DocumentOf<K> | null> {
    if (Object.keys(patch).length === 0) return this.findOne(collection, filter);
    const result = await this.collection(collection).findOneAndUpdate(
      toMongoFilter(filter) as Filter<Document>,
      { $set: patch },
      { returnDocument: 'after' },
    );
    return stripId(result) as DocumentOf<K> | null;
  }

  async upsertOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    doc: DocumentOf<K>,
    patch: Record<string, unknown> = {},
  ): Promise<{ document: DocumentOf<K>; created: boolean }> {
    const update: Document = { $set: patch, $setOnInsert: doc as object };
    const result = await this.collection(collection).findOneAndUpdate(
      toMongoFilter(filter) as Filter<Document>,
      update,
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    const document = stripId(result.value) as DocumentOf<K>;
    return { document, created: result.lastErrorObject?.updatedExisting === false };
  }

  async insertIfAbsent<K extends CollectionName>(
    collection: K,
    doc: DocumentOf<K>,
  ): Promise<InsertIfAbsentResult<K>> {
    try {
      await this.collection(collection).insertOne({ ...(doc as object) } as Document);
      return { inserted: true, document: doc };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await this.findExistingByUniqueKeys(collection, doc);
      if (!existing) throw error;
      return { inserted: false, document: existing };
    }
  }

  private async findExistingByUniqueKeys<K extends CollectionName>(
    collection: K,
    doc: DocumentOf<K>,
  ): Promise<DocumentOf<K> | null> {
    const record = doc as unknown as Record<string, unknown>;
    for (const index of INDEXES.filter((entry) => entry.collection === collection && entry.unique)) {
      const filter: Record<string, unknown> = {};
      let complete = true;
      for (const [path] of index.keys) {
        const value = readPath(record, path);
        if (value === undefined) {
          complete = false;
          break;
        }
        filter[path] = value;
      }
      if (!complete) continue;
      const found = await this.collection(collection).findOne(filter as Filter<Document>);
      if (found) return stripId(found) as DocumentOf<K>;
    }
    return null;
  }

  async updateMany<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<number> {
    const result = await this.collection(collection).updateMany(
      toMongoFilter(filter) as Filter<Document>,
      { $set: patch },
    );
    return result.modifiedCount;
  }

  async deleteOne<K extends CollectionName>(collection: K, filter: Query): Promise<boolean> {
    const result = await this.collection(collection).deleteOne(toMongoFilter(filter) as Filter<Document>);
    return result.deletedCount > 0;
  }

  async deleteMany<K extends CollectionName>(collection: K, filter: Query): Promise<number> {
    const result = await this.collection(collection).deleteMany(toMongoFilter(filter) as Filter<Document>);
    return result.deletedCount;
  }

  async truncate(collection: CollectionName): Promise<void> {
    await this.collection(collection).deleteMany({});
  }

  /** Test yardımı: koleksiyon sayıları. */
  async rawSnapshot(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const name of Object.keys(COLLECTION_SCHEMAS) as CollectionName[]) {
      out[name] = await this.count(name);
    }
    return out;
  }
}

function stripId(value: unknown): unknown {
  if (value && typeof value === 'object' && '_id' in (value as Record<string, unknown>)) {
    const { _id, ...rest } = value as Record<string, unknown>;
    void _id;
    return rest;
  }
  return value;
}

function readPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[segment];
    return undefined;
  }, doc);
}

export { applyPatch };
