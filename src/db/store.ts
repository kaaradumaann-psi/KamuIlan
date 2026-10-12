/**
 * Depo seçimi.
 *
 * MONGODB_URI varsa MongoDB, yoksa kalıcı dosya deposu. Testler `createStore`
 * çağrısına kendi veri dizinini vererek izole çalışır.
 */
import { getEnv } from '../config/env';
import { FileStore } from './file-store';
import { MongoStore } from './mongo-store';
import type { StoragePort } from './ports';

export interface CreateStoreOptions {
  dataDir?: string;
  mongoUri?: string;
  mongoDbName?: string;
  /** Testlerde dosya adını izole etmek için. */
  fileName?: string;
}

export function createStore(options: CreateStoreOptions = {}): StoragePort {
  const env = getEnv();
  const mongoUri = options.mongoUri ?? env.MONGODB_URI;
  if (mongoUri) {
    return new MongoStore({
      uri: mongoUri,
      dbName: options.mongoDbName ?? env.MONGODB_DB,
    });
  }
  return new FileStore(options.dataDir ?? env.DATA_DIR, options.fileName ?? 'kamuradar.json');
}

let singleton: StoragePort | null = null;

/** Süreç genelinde tek depo (API ve worker). */
export function getStore(): StoragePort {
  if (!singleton) singleton = createStore();
  return singleton;
}

export function setStore(store: StoragePort): void {
  singleton = store;
}

export function resetStore(): void {
  singleton = null;
}
