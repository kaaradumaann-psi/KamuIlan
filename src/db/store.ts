/**
 * Depo (storage) seçimi ve tek örnek yönetimi.
 *
 * Kural: üretimde YALNIZCA MongoDB kullanılır (kalıcılık + çok örnekli güvenlik).
 * Geliştirme/testte tek dosyalık depo kullanılır; her ikisi de aynı `StoragePort`
 * sözleşmesini uygular, bu yüzden iş mantığı değişmez.
 */
import { join } from 'node:path';
import { getEnv, type Env } from '../config/env';
import { FileStore } from './file-store';
import { MongoStore } from './mongo-store';
import type { StoragePort } from './ports';

export function createStore(env: Env = getEnv(), fileName = 'kamuradar.json'): StoragePort {
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

export function fileStorePath(env: Env = getEnv(), fileName = 'kamuradar.json'): string {
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
