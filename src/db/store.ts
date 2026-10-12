/**
 * Depo (storage) seçimi ve tek örnek yönetimi.
 *
 * Kural: üretimde kalıcı bir veritabanı zorunludur. Kamuİlan'ın üretim deposu
 * Supabase (Postgres) üzerindeki JSONB tablolarıdır; eski kurulumlar için
 * MongoDB sürücüsü korunur. Geliştirme/testte tek dosyalık depo kullanılır.
 * Üçü de aynı `StoragePort` sözleşmesini uygular, bu yüzden iş mantığı değişmez.
 */
import { join } from 'node:path';
import { getEnv, hasPostgresConfig, postgresUrl, type Env } from '../config/env';
import { FileStore } from './file-store';
import { MongoStore } from './mongo-store';
import { PostgresStore } from './postgres-store';
import type { StoragePort } from './ports';

export const DEFAULT_STORE_FILE = 'kamuilan.json';

export function createStore(env: Env = getEnv(), fileName = DEFAULT_STORE_FILE): StoragePort {
  const wantsPostgres = env.DATABASE_DRIVER === 'postgres' || env.DATABASE_DRIVER === 'supabase';
  if (wantsPostgres || (hasPostgresConfig(env) && env.DATABASE_DRIVER !== 'mongo')) {
    if (!hasPostgresConfig(env)) {
      throw new Error('DATABASE_DRIVER=postgres/supabase için POSTGRES_URL (Supabase bağlantı dizesi) zorunludur.');
    }
    return new PostgresStore({
      connectionString: postgresUrl(env),
      maxConnections: env.POSTGRES_MAX_CONNECTIONS,
      ssl: env.POSTGRES_SSL,
    });
  }
  if (env.DATABASE_DRIVER === 'mongo' || env.MONGODB_URI) {
    if (!env.MONGODB_URI) {
      throw new Error('DATABASE_DRIVER=mongo için MONGODB_URI zorunludur.');
    }
    return new MongoStore({ uri: env.MONGODB_URI, dbName: env.MONGODB_DB });
  }
  return new FileStore(env.DATA_DIR, fileName);
}

/** Testler için: ayrı dosya adıyla izole depo. */
export function createTestStore(dataDir: string, fileName = 'test.json'): StoragePort {
  return new FileStore(dataDir, fileName);
}

export function fileStorePath(env: Env = getEnv(), fileName = DEFAULT_STORE_FILE): string {
  return join(env.DATA_DIR, fileName);
}

let singleton: StoragePort | null = null;

/** Depoyu hazırlar (indeksler dahil). Uygulama başlangıcında bir kez çağrılır. */
export async function initStore(store?: StoragePort): Promise<StoragePort> {
  if (singleton && !store) return singleton;
  const instance = store ?? createStore();
  await instance.init();
  await instance.ensureIndexes();
  singleton = instance;
  return instance;
}

export function getStore(): StoragePort {
  if (!singleton) {
    throw new Error('Depo başlatılmadı: önce initStore() çağrılmalıdır.');
  }
  return singleton;
}

export function setStore(store: StoragePort | null): void {
  singleton = store;
}

export async function closeStore(): Promise<void> {
  await singleton?.close();
  singleton = null;
}
