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

/**
 * Depo sürücüsünün insan okunur adı.
 *
 * "Hesabım nerede?" sorusunun tek cevabı budur: API de, kurulum betikleri de
 * aynı metni kullanır ki kullanıcı giriş ekranındaki tanılamayı komut
 * çıktısıyla karşılaştırabilsin (yanlış veritabanına eklenen hesap, girişte
 * anlaşılması en zor 401 nedenidir).
 */
export function describeDriver(driver: string): string {
  if (driver === 'postgres') return 'Supabase (PostgreSQL)';
  if (driver === 'mongodb') return 'MongoDB';
  return 'yerel dosya deposu (geliştirme)';
}

/**
 * Etkin depo sürücüsü.
 *
 * Tek karar noktası: `createStore` ve tanılama çıktıları (giriş ekranı, dev
 * günlüğü, kurulum betikleri) aynı sonucu görmelidir. Kural:
 *  - `DATABASE_DRIVER=file` açıkça seçildiyse → dosya deposu (POSTGRES_URL olsa bile).
 *  - `DATABASE_DRIVER=postgres|supabase` İSE ya da POSTGRES_URL/DATABASE_URL
 *    tanımlıysa (mongo seçilmediği sürece) → Supabase/Postgres.
 *  - `DATABASE_DRIVER=mongo` ya da MONGODB_URI tanımlıysa → MongoDB.
 *  - Aksi halde geliştirme dosya deposu.
 */
export function effectiveDriver(env: Env = getEnv()): StoragePort['driver'] {
  // Açık `file` seçimi her şeyi geçersiz kılar: yerel çalıştırmada yanlışlıkla bulut veritabanına yazılmasın.
  if (env.DATABASE_DRIVER === 'file') return 'file';
  const wantsPostgres = env.DATABASE_DRIVER === 'postgres' || env.DATABASE_DRIVER === 'supabase';
  if (wantsPostgres || (hasPostgresConfig(env) && env.DATABASE_DRIVER !== 'mongo')) return 'postgres';
  if (env.DATABASE_DRIVER === 'mongo' || env.MONGODB_URI) return 'mongodb';
  return 'file';
}

export function createStore(env: Env = getEnv(), fileName = DEFAULT_STORE_FILE): StoragePort {
  const driver = effectiveDriver(env);
  if (driver === 'postgres') {
    if (!hasPostgresConfig(env)) {
      throw new Error(
        'DATABASE_DRIVER=postgres/supabase için POSTGRES_URL (Supabase bağlantı dizesi) zorunludur.',
      );
    }
    return new PostgresStore({
      connectionString: postgresUrl(env),
      maxConnections: env.POSTGRES_MAX_CONNECTIONS,
      ssl: env.POSTGRES_SSL,
    });
  }
  if (driver === 'mongodb') {
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

/** Depoyu hazırlar (indeksler varsayılan olarak dahil). Uygulama başlangıcında bir kez çağrılır. */
export async function initStore(
  store?: StoragePort,
  options: { ensureIndexes?: boolean } = {},
): Promise<StoragePort> {
  if (singleton && !store) return singleton;
  const instance = store ?? createStore();
  await instance.init();
  if (options.ensureIndexes !== false) await instance.ensureIndexes();
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
