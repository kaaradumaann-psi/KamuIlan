/**
 * Veritabanı indekslerini oluşturur: `npm run db:indexes`
 *
 * - Benzersiz indeksler (tekilleştirme ve bildirim idempotency'si için) burada kurulur.
 * - Idempotenttir: var olan indeks yeniden oluşturulmaz.
 * - Çok örnekli çalıştırmada (API + worker) yarış koruması indeksten gelir.
 */
import { initStore, closeStore } from '../src/db/store';
import { INDEXES } from '../src/db/indexes';
import { createLogger } from '../src/lib/logger';

async function main(): Promise<void> {
  const logger = createLogger('db-indexes', { level: 'info' });
  const store = await initStore(undefined, { ensureIndexes: false });
  const results = await store.ensureIndexes();
  for (const result of results) {
    logger.info(
      { collection: result.collection, name: result.name, created: result.created },
      result.created ? 'indeks oluşturuldu' : 'indeks zaten var',
    );
  }
  logger.info(
    { driver: store.driver, total: results.length, created: results.filter((result) => result.created).length },
    'indeksler hazır',
  );
  console.log(`Tanımlı indeks sayısı: ${INDEXES.length} (benzersiz: ${INDEXES.filter((index) => index.unique).length})`);
  await closeStore();
}

main().catch(async (error: unknown) => {
  console.error('İndeksler oluşturulamadı:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
