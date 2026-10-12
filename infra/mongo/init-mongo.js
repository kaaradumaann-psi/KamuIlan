// Kamuİlan — MongoDB başlangıç betiği (yalnızca geliştirme)
//
// Koleksiyonları ve uygulamanın beklediği indeksleri burada OLUŞTURMAYIZ:
// indeksler `npm run db:indexes` (ve uygulama açılışı) tarafından, şemayla tek
// kaynaktan (src/db/indexes.ts) üretilir. Böylece iki yerde indeks tanımı olmaz.
//
// Bu betik yalnızca veritabanını hazırlar ve doğrulama seviyesini yükseltir.

const dbName = process.env.MONGO_INITDB_DATABASE || 'kamuilan';
const database = db.getSiblingDB(dbName);

// Şemada belgelenen koleksiyonlar (boş olsa bile oluşturulur ki operatör
// backup/restore komutlarında hazır bulsun).
const collections = [
  'sources',
  'jobs',
  'jobSources',
  'jobRevisions',
  'users',
  'sessions',
  'tokens',
  'notificationPreferences',
  'notificationEvents',
  'emailOutbox',
  'scrapeRuns',
  'reviewQueue',
  'auditLogs',
  'scheduledTasks',
  'queueJobs',
  'locks',
  'rateLimits',
  'workerHeartbeats',
  'clusters',
  'savedJobs',
];

for (const name of collections) {
  if (!database.getCollectionNames().includes(name)) {
    database.createCollection(name);
  }
}

// İlanlar ve kaynak bağlantıları için minimal doğrulama (uygulama şeması esas,
// burada yalnızca yanlış koleksiyona yazımı erken yakalarız).
database.createCollection('_kamuilan_init', {
  validator: { $jsonSchema: { bsonType: 'object', required: ['initializedAt'] } },
});
database._kamuilan_init.updateOne({}, { $set: { initializedAt: new Date(), note: 'Kamuİlan init' } }, { upsert: true });

print(`Kamuİlan: ${collections.length} koleksiyon hazır (${dbName}).`);
