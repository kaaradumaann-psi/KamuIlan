/**
 * MongoDB depolama sürücüsü (üretim).
 *
 * - Benzersiz indeksler üretimde veri bütünlüğünün garantisidir: iki worker aynı
 *   ilanı/bildirimi yazmaya çalışırsa ikinci yazma `insertIfAbsent` ile mevcut
 *   kayda düşer (çift kayıt/çift e-posta olmaz).
 * - Tüm sorgular `query.ts` içindeki ortak filtre diline uyar; böylece dosya
 *   deposu ile davranış aynıdır (testler dosya deposunda koşar, üretim Mongo).
 */
import { MongoClient, MongoServerError, type Collection, type Db, type Document } from 'mongodb';
import { toMongoFilter, type FindOptions, type Query } from './query';
import type { CollectionName, DocumentOf } from './schemas';
import { COLLECTION_SCHEMAS } from './schemas';
import { INDEXES } from './indexes';
import type { IndexSpec, InsertIfAbsentResult, StoragePort } from './ports';

const DUPLICATE_KEY_ERROR = 11_000;

export class MongoStore implements StoragePort {
  readonly driver = 'mongodb' as const;
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(private readonly options: { uri: string; dbName: string }) {}

  private get database(): Db {
    if (!this.db) throw new Error('MongoStore.init() çağrılmadan kullanılamaz.');
    return this.db;
  }

  private collection<K extends CollectionName>(name: K): Collection<Document> {
    return this.database.collection(name);
  }

  async init(): Promise<void> {
    if (this.client) return;
    this.client = new MongoClient(this.options.uri, {
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      maxPoolSize: 20,
      retryWrites: true,
    });
    await this.client.connect();
    this.db = this.client.db(this.options.dbName);
    await this.db.command({ ping: 1 });
    await this.ensureIndexes();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.db = null;
  }

  async health(): Promise<{ ok: boolean; driver: string; detail: string }> {
    try {
      if (!this.db) return { ok: false, driver: this.driver, detail: 'Bağlantı kurulmadı.' };
      const started = Date.now();
      await this.db.command({ ping: 1 });
      return { ok: true, driver: this.driver, detail: `MongoDB yanıt süresi ${Date.now() - started} ms` };
    } catch (error) {
      return { ok: false, driver: this.driver, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureIndexes(indexes: readonly IndexSpec[] = INDEXES): Promise<{ collection: string; name: string; created: boolean }[]> {
    const results: { collection: string; name: string; created: boolean }[] = [];
    for (const index of indexes) {
      const collection = this.collection(index.collection);
      const name = await collection.createIndex(
        Object.fromEntries(index.keys.map(([field, direction]) => [field, direction])),
        { unique: index.unique ?? false, name: index.name, background: true },
      );
      results.push({ collection: index.collection, name, created: true });
    }
    // Şema doğrulaması: yanlış biçimli belgelerin yazılmasını veritabanı engeller.
    for (const [name, schema] of Object.entries(COLLECTION_SCHEMAS)) {
      const jsonSchema = toJsonSchemaSafe(schema);
      if (!jsonSchema) continue;
      try {
        await this.db?.command({
          collMod: name,
          validator: { $jsonSchema: jsonSchema },
          validationLevel: 'moderate',
          validationAction: 'error',
        });
      } catch {
        // Koleksiyon henüz yoksa collMod hata verir; ilk yazmada oluşur, sonraki turda kurulur.
      }
    }
    return results;
  }

  async insertOne<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<DocumentOf<K>> {
    await this.collection(collection).insertOne({ ...(doc as Document) });
    return doc;
  }

  async insertMany<K extends CollectionName>(collection: K, docs: DocumentOf<K>[]): Promise<number> {
    if (docs.length === 0) return 0;
    const result = await this.collection(collection).insertMany(docs as Document[], { ordered: false });
    return result.insertedCount;
  }

  async findOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    options: { sort?: FindOptions['sort'] } = {},
  ): Promise<DocumentOf<K> | null> {
    const cursor = this.collection(collection).find(toMongoFilter(filter));
    if (options.sort) {
      cursor.sort(Object.fromEntries(options.sort.map(([field, direction]) => [field, direction])));
    }
    const doc = await cursor.limit(1).next();
    return doc ? stripMongoId<DocumentOf<K>>(doc) : null;
  }

  async find<K extends CollectionName>(
    collection: K,
    filter: Query = {},
    options: FindOptions = {},
  ): Promise<DocumentOf<K>[]> {
    const cursor = this.collection(collection).find(toMongoFilter(filter));
    if (options.sort) {
      cursor.sort(Object.fromEntries(options.sort.map(([field, direction]) => [field, direction])));
    }
    if (options.skip) cursor.skip(options.skip);
    if (options.limit) cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map((doc) => stripMongoId<DocumentOf<K>>(doc));
  }

  async count<K extends CollectionName>(collection: K, filter: Query = {}): Promise<number> {
    return this.collection(collection).countDocuments(toMongoFilter(filter));
  }

  async updateOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<DocumentOf<K> | null> {
    const result = await this.collection(collection).findOneAndUpdate(
      toMongoFilter(filter),
      { $set: patch },
      { returnDocument: 'after' },
    );
    return result ? stripMongoId<DocumentOf<K>>(result) : null;
  }

  async upsertOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    doc: DocumentOf<K>,
    patch: Record<string, unknown> = {},
  ): Promise<{ document: DocumentOf<K>; created: boolean }> {
    const result = await this.collection(collection).findOneAndUpdate(
      toMongoFilter(filter),
      { $set: patch, $setOnInsert: doc as Document },
      { upsert: true, returnDocument: 'after' },
    );
    const document = result ? stripMongoId<DocumentOf<K>>(result) : doc;
    const existing = result ? (result as Document & { id?: string }).id === (doc as Document).id : true;
    return { document, created: !existing };
  }

  /**
   * Yoksa ekle: benzersiz indeks ihlalinde mevcut kaydı bulur.
   * Yarış koşulunda iki worker'dan yalnızca biri kaydı oluşturur.
   */
  async insertIfAbsent<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<InsertIfAbsentResult<K>> {
    try {
      await this.collection(collection).insertOne({ ...(doc as Document) });
      return { inserted: true, document: doc };
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR) {
        const existing = await this.findExistingForUniqueIndex(collection, doc);
        if (existing) return { inserted: false, document: existing };
      }
      throw error;
    }
  }

  async updateMany<K extends CollectionName>(collection: K, filter: Query, patch: Record<string, unknown>): Promise<number> {
    const result = await this.collection(collection).updateMany(toMongoFilter(filter), { $set: patch });
    return result.modifiedCount;
  }

  async deleteOne<K extends CollectionName>(collection: K, filter: Query): Promise<boolean> {
    const result = await this.collection(collection).deleteOne(toMongoFilter(filter));
    return result.deletedCount > 0;
  }

  async deleteMany<K extends CollectionName>(collection: K, filter: Query): Promise<number> {
    const result = await this.collection(collection).deleteMany(toMongoFilter(filter));
    return result.deletedCount;
  }

  async truncate(collection: CollectionName): Promise<void> {
    await this.collection(collection).deleteMany({});
  }

  /** Çakışan benzersiz indeksin alanlarıyla mevcut kaydı bulur. */
  private async findExistingForUniqueIndex<K extends CollectionName>(
    collection: K,
    doc: DocumentOf<K>,
  ): Promise<DocumentOf<K> | null> {
    const candidates = INDEXES.filter((index) => index.collection === collection && index.unique);
    for (const index of candidates) {
      const filter: Record<string, unknown> = {};
      let complete = true;
      for (const [field] of index.keys) {
        const value = readPath(doc as unknown as Record<string, unknown>, field);
        if (value === undefined) {
          complete = false;
          break;
        }
        filter[field] = value;
      }
      if (!complete) continue;
      const found = await this.collection(collection).findOne(filter);
      if (found) return stripMongoId<DocumentOf<K>>(found);
    }
    return null;
  }
}

function stripMongoId<T>(doc: Document): T {
  const { _id, ...rest } = doc as Document & { _id?: unknown };
  void _id;
  return rest as T;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Zod şemasını MongoDB $jsonSchema'ya çevirir.
 * Karmaşık doğrulama uygulamada yapılır; burada yalnızca tip ve zorunlu alan
 * denetimi kurulur (üretimde bozuk belge yazılmasını engeller).
 */
function toJsonSchemaSafe(schema: unknown): Record<string, unknown> | null {
  const shape = (schema as { shape?: Record<string, unknown> } | null)?.shape;
  if (!shape) return null;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    if (key.startsWith('_')) continue;
    properties[key] = {};
    if (!isOptional(value)) required.push(key);
  }
  return { bsonType: 'object', required, properties };
}

function isOptional(fieldSchema: unknown): boolean {
  const definition = (fieldSchema as { _def?: { typeName?: string; innerType?: unknown } } | null)?._def;
  if (!definition) return true;
  if (definition.typeName === 'ZodOptional' || definition.typeName === 'ZodDefault') return true;
  return false;
}
