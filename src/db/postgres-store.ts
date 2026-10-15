/**
 * Postgres (Supabase) depo sürücüsü.
 *
 * Neden JSONB: uygulamanın belge modeli (zod şemaları) tek doğruluk kaynağıdır;
 * şema göçü (migration) gerektirmeden yeni alan eklenebilir. Supabase panelinde
 * her koleksiyon ayrı bir tablo olarak görünür (`kamuilan_<koleksiyon>`), böylece
 * veriyi SQL ile incelemek ve yedeklemek kolaydır.
 *
 * SORGULARDA SESSİZ YANLIŞ SONUÇ OLMAZ — bu sürücünün değişmez kuralı:
 *  1. SQL yalnızca bir ÖN FİLTRE (superset) uygular: eşitlik ve `$in` koşulları
 *     JSONB kapsama (`@>`) ile daraltılır; bilinmeyen koşullarda ön filtre
 *     tamamen atlanır.
 *  2. Nihai filtre kararı `matchesQuery` ile verilir; sıralama varsayılan olarak
 *     `sortDocuments` üzerinden yapılır. Tek istisna, boş filtre + yalnızca `id`
 *     sıralaması + limit içeren tam tablo sayfalarıdır: bu durumda SQL, kararlı
 *     ID sayfalamasını doğrudan uygular (göçler için gerekli).
 *  3. Ön filtre bir üst sınırı aşarsa (`MAX_SCAN_ROWS`) sessizce kırpmak yerine
 *     açık hata verilir.
 *
 * Eşzamanlılık: güncelleme/upsert işlemleri `SELECT … FOR UPDATE` ile satır
 * kilidi altında yapılır; `insertIfAbsent` benzersizlik çakışmasını yakalar ve
 * mevcut kaydı döner (iki worker aynı ilanı işlese bile çift kayıt oluşmaz).
 */
import { Pool, type PoolClient } from 'pg';
import { loadCaStore } from '../lib/tls-trust';
import type { CollectionName, DocumentOf } from './schemas';
import { COLLECTION_SCHEMAS } from './schemas';
import {
  applyPatch,
  getPath,
  isOperatorObject,
  matchesQuery,
  sortDocuments,
  type ConditionOperators,
  type FindOptions,
  type Query,
} from './query';
import type { IndexSpec, InsertIfAbsentResult, StoragePort } from './ports';
import { INDEXES } from './indexes';

/** Ön filtrenin üst sınırı: aşılırsa açık hata (sessiz kırpma yok). */
const MAX_SCAN_ROWS = 20_000;

/**
 * PostgresStore'un `pg` havuzundan beklediği en küçük yüzey.
 *
 * Neden arayüz: sürücü, gerçek Postgres'e bağlanmadan test edilebilmeli. Testler
 * bu arayüzü PGlite (Postgres 16'nın WASM derlemesi) ile uygular; böylece
 * JSONB kapsama ön filtresi, `ON CONFLICT`, `FOR UPDATE` ve ifade indeksleri
 * GERÇEK Postgres davranışıyla doğrulanır — sahte bir SQL motoruyla değil.
 */
export interface PostgresQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresQueryable & { release(): void }>;
  end(): Promise<void>;
}

interface PostgresStoreOptions {
  connectionString: string;
  /** Supabase'de önerilen bağlantı havuzu boyutu. */
  maxConnections?: number;
  ssl?: boolean;
  /**
   * TLS doğrulama kipi. `verify` (varsayılan): sunucu sertifikası doğrulanır;
   * `no-verify` ve `disable` YALNIZCA açık operatör tercihiyle gelir ve ortam
   * denetiminde uyarı/engelleme üretir.
   */
  sslMode?: PostgresTlsMode;
  /** PEM CA sertifikası. Verilirse sunucu sertifikası bu CA ile doğrulanır. */
  caCertificate?: string;
  /** Tablo ön eki: aynı Supabase projesinde birden fazla ortam çalıştırılabilir. */
  tablePrefix?: string;
  /** Testler için enjekte edilebilir havuz (PGlite uyarlaması). */
  pool?: PostgresPoolLike;
}

interface UniqueIndexInfo {
  name: string;
  fields: string[];
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Geçersiz SQL tanımlayıcısı: ${value}`);
  }
  return value;
}

/**
 * Koleksiyon adını tablo adına çevirir.
 *
 * Koleksiyonlar uygulamada camelCase'dir (`jobSources`, `emailOutbox`), SQL
 * tanımlayıcıları ise küçük harf + alt çizgi olmalıdır (tırnaksız kullanımda
 * Postgres büyük harfli adları katlar). Dönüşüm tek yerde yapılır ki Supabase'de
 * tablolar `kamuilan_job_sources` gibi okunaklı adlarla görünsün.
 */
function tableName(prefix: string, collection: string): string {
  const snake = collection.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return `${prefix}_${safeIdentifier(snake)}`;
}

/** Koleksiyon adından indeks adı üretir (Postgres indeks adları 63 baytla sınırlıdır). */
function indexIdentifier(table: string, rawName: string): string {
  return safeIdentifier(
    `${table}_${rawName}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 60),
  );
}

/**
 * Bir belge alanının olası tiplerini kapsayan JSONB parçaları.
 *
 * `looseEquals` sayı↔metin eşitliğini kabul ettiği için ön filtre de her iki
 * biçimi kapsamalıdır; aksi halde gerçekte eşleşen bir kayıt elenirdi.
 */
function containmentVariants(path: string, value: unknown): string[] {
  const segments = path.split('.');
  const build = (leaf: unknown): string => {
    let json = JSON.stringify(leaf) ?? 'null';
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const key = segments[index] ?? '';
      json = `{${JSON.stringify(key)}:${json}}`;
    }
    return json;
  };

  const variants = new Set<string>();
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    variants.add(build(value));
  }
  if (typeof value === 'number' && Number.isFinite(value)) variants.add(build(String(value)));
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    variants.add(build(Number(value)));
  }
  return [...variants];
}

/**
 * Tek segmentli bir alan için eşitlik ön filtresini üretir.
 *
 * İki eşleşme biçimi kapsanmalıdır (aksi halde doğru kayıt elenir, bkz. query.ts):
 *  1. `{"alan": değer}` kapsama — doğrudan eşitlik ve nesne/dizi eşitliği.
 *  2. Dizi alanının bir elemanı değere eşitse: `data -> 'alan' ? değer`.
 *     Kapsama bu durumu YAKALAMAZ (`["a","b"] @> "b"` doğru değildir), bu yüzden
 *     ayrı bir OR dalı gerekir. Örnek: `jobs.sourceKeys = 'kaynak-x'`.
 */
function scalarEqualityClause(field: string, values: unknown[], params: unknown[]): string | null {
  const ors: string[] = [];
  for (const value of values) {
    for (const variant of containmentVariants(field, value)) {
      params.push(variant);
      ors.push(`data @> $${params.length}::jsonb`);
    }
    if (typeof value === 'string' || typeof value === 'number') {
      // `?` operatörü metin bekler; sayılar metin biçimiyle de aranmalı.
      params.push(typeof value === 'number' ? String(value) : value);
      ors.push(
        `(jsonb_typeof(data -> ${quoteLiteral(field)}) = 'array' AND (data -> ${quoteLiteral(field)}) ? $${params.length}::text)`,
      );
    }
  }
  return ors.length > 0 ? ors.join(' OR ') : null;
}

/** `id` birincil anahtarı doğrudan SQL koşuluna çevrilir (indeks kullanılır). */
function idClause(condition: unknown, params: unknown[]): string | null {
  if (!isOperatorObject(condition)) {
    if (Array.isArray(condition)) {
      params.push(condition.map((value) => String(value)));
      return `id = ANY($${params.length}::text[])`;
    }
    params.push(String(condition));
    return `id = $${params.length}`;
  }
  const operators = condition as ConditionOperators;
  const onlyEquality = Object.keys(operators).every((operator) => operator === '$eq' || operator === '$in');
  if (!onlyEquality) return null;
  if (operators.$in) {
    params.push(operators.$in.map((value) => String(value)));
    return `id = ANY($${params.length}::text[])`;
  }
  if (operators.$eq !== undefined) {
    params.push(String(operators.$eq));
    return `id = $${params.length}`;
  }
  return null;
}

/**
 * Sorgunun SQL ön filtresini üretir. Çevrilemeyen koşulda `null` döner ve
 * çağıran taraf ön filtreyi tamamen atlar (doğruluk > hız).
 *
 * Nokta içeren (iç içe) yollar bilinçli olarak ÇEVRİLMEZ: `getPathValues` dizi
 * içindeki nesneleri de gezdiği için (`attachments.url`) JSONB kapsaması bu
 * durumu güvenilir biçimde ifade edemez. Yanlış bir ön filtre kayıt elerdi;
 * bunun yerine tam tarama yapılır ve üst sınır (`MAX_SCAN_ROWS`) aşılırsa açık
 * hata verilir. Sessiz yanlış sonuç hiçbir koşulda üretilmez.
 */
function buildPrefilter(query: Query | undefined, table: string, params: unknown[]): string | null {
  if (!query) return 'TRUE';

  // DEĞİŞMEZ KURAL: `null` dönen bir ön filtre, `params`'ı bulduğu gibi bırakır.
  //
  // Gerekçe: çevrilemeyen koşul (aralık `$lt/$gte`, `$exists`, `$regex`,
  // noktalı yol, `$nor` …) ön filtrenin TAMAMINI düşürür ve çağıran taraf
  // yer tutucusuz `WHERE TRUE` sorgusu çalıştırır. Çeviri sırasında — özellikle
  // `$and`/`$or` kardeş dallarından veya aynı nesnedeki önceki alanlardan —
  // `params`'a yazılmış değerler geri alınmazsa Postgres, yer tutucusu olmayan
  // bir ifadeye parametre bağlandığı için sorguyu reddeder:
  //   "bind message supplies N parameters, but prepared statement \"\" requires 0"
  // Bu hata ilk kez `db:migrate`'ın
  // `{ $or: [{ textNormalized: { $exists: false } }, { textNormalized: '' }] }`
  // sorgusunda görüldü; eşitlik + aralık/noktalı yol karıştıran HER sorgu
  // (zamanlayıcı `listDue`, kuyruk/outbox `claim`, ilan arama/kapatma …)
  // aynı şekilde kırılıyordu. Bu yüzden her vazgeçiş, bu çağrının eklediği
  // parametreleri geri alır (özyinelemeli dallar da kendi payını geri alır,
  // üst katman kardeş dalların payını bu yolla temizler).
  const checkpoint = params.length;
  const abandon = (): null => {
    params.length = checkpoint;
    return null;
  };

  const conditions: string[] = [];
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      const clauses = (condition as Query[]) ?? [];
      if (key === '$nor') return abandon();
      const translated = clauses.map((clause) => buildPrefilter(clause, table, params));
      if (translated.some((clause) => clause === null)) return abandon();
      if (translated.length === 0) continue;
      conditions.push(`(${translated.join(key === '$and' ? ' AND ' : ' OR ')})`);
      continue;
    }

    if (key === 'id') {
      const clause = idClause(condition, params);
      if (clause === null) return abandon();
      conditions.push(clause);
      continue;
    }

    // İç içe yollar (nokta içeren) ön filtreye çevrilmez: bkz. fonksiyon başlığı.
    if (key.includes('.')) return abandon();

    const values: unknown[] = [];
    if (!isOperatorObject(condition)) {
      if (Array.isArray(condition)) values.push(...condition);
      else values.push(condition);
    } else {
      const operators = condition as ConditionOperators;
      const onlyEquality = Object.keys(operators).every(
        (operator) => operator === '$eq' || operator === '$in',
      );
      if (!onlyEquality) return abandon();
      if (operators.$eq !== undefined) values.push(operators.$eq);
      if (operators.$in) values.push(...operators.$in);
    }
    if (values.length === 0) return abandon();

    const clause = scalarEqualityClause(key, values, params);
    if (clause === null) return abandon();
    conditions.push(`(${clause})`);
  }

  return conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
}

/**
 * TLS yapılandırması (güvenli varsayılan: DOĞRULAMA AÇIK).
 *
 * Sıra:
 *  1. `mode: 'disable'` → TLS hiç kullanılmaz (yalnızca açık tercih; yerel Postgres).
 *  2. `mode: 'no-verify'` → eldiven imzalı sertifika kabulü (AÇIK risk kabulü; panel/CLI uyarır).
 *  3. CA verildiyse → sunucu sertifikası yalnızca bu CA ile doğrulanır.
 *  4. CA yoksa → Node'un varsayılan + işletim sisteminin kök depolarıyla doğrulanır.
 *     Supabase uç noktası özel bir CA kullanıyorsa panelden indirilen proje
 *     CA'sı gerekir (POSTGRES_SSL_CA_FILE); sistem deposu tek başına yetmez.
 *
 * Bağlantı dizesindeki `sslmode`/`sslrootcert` gibi TLS parametreleri burada
 * yorumlanmaz; onlar `postgresUrl()` (src/config/env.ts) içinde REDDEDİLİR.
 * Nedeni: pg, URL'yi buradaki açık `ssl` nesnesinin ÜZERİNE yazar; URL'deki
 * `sslmode=disable`, `verify` kararını sessizce ezip TLS'i kapatabilirdi.
 * Tek yetkili, bu fonksiyona gelen `mode`/`caCertificate` değerleridir
 * (POSTGRES_SSL_MODE / POSTGRES_SSL_CA_FILE). Sürücü davranışı
 * `tests/postgres-tls-config.test.ts` içinde doğrulanmıştır.
 */
export type PostgresTlsMode = 'disable' | 'no-verify' | 'verify';

export type PostgresSslConfig =
  | false
  | { ca: string; rejectUnauthorized: true }
  | { ca: string[]; rejectUnauthorized: true }
  /** Sistem kök deposu okunamıyorsa Node'un kendi varsayılan (gömülü) deposu kullanılır. */
  | { rejectUnauthorized: true }
  | { rejectUnauthorized: false };

export function sslConfigFor(
  caCertificate?: string,
  options: { mode?: PostgresTlsMode; systemCaStore?: string[] } = {},
): PostgresSslConfig {
  const mode = options.mode ?? 'verify';
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  if (caCertificate && caCertificate.trim().length > 0) {
    return { ca: caCertificate, rejectUnauthorized: true };
  }
  // `systemCaStore` verilmemişse gerçek sistem deposu okunur; açıkça `undefined`
  // verildiğinde (ör. Node sistem deposunu desteklemiyor) gömülü kökler kullanılır.
  const systemCaStore = 'systemCaStore' in options ? options.systemCaStore : loadCaStore();
  return systemCaStore
    ? { ca: systemCaStore, rejectUnauthorized: true }
    : { rejectUnauthorized: true };
}

/** Bu yapılandırma sunucu sertifikasını DOĞRULUYOR mu? (tanı/uyarı metinleri kullanır) */
export function verifiesServerCertificate(config: PostgresSslConfig): boolean {
  return config !== false && config.rejectUnauthorized === true;
}

export class PostgresStore implements StoragePort {
  readonly driver = 'postgres' as const;

  private readonly pool: PostgresPoolLike;
  private prefix: string;
  private uniqueIndexes = new Map<CollectionName, UniqueIndexInfo[]>();

  constructor(options: PostgresStoreOptions) {
    this.prefix = options.tablePrefix ?? 'kamuilan';
    this.pool =
      options.pool ??
      new Pool({
        connectionString: options.connectionString,
        max: options.maxConnections ?? 10,
        ...(options.ssl === false
          ? {}
          : { ssl: sslConfigFor(options.caCertificate, { mode: options.sslMode }) }),
      });
  }

  private table(collection: CollectionName): string {
    return tableName(this.prefix, collection);
  }

  private get collections(): CollectionName[] {
    return Object.keys(COLLECTION_SCHEMAS) as CollectionName[];
  }

  async init(): Promise<void> {
    this.prefix = safeIdentifier(this.prefix);
    // Şemada koleksiyon başına bağımsız DDL var. Uzak Supabase bağlantısında
    // seri gidiş-dönüşleri azaltmak için havuzun sınırlı eşzamanlılığını kullan.
    await Promise.all(
      this.collections.map(async (collection) => {
        const table = this.table(collection);
        await this.pool.query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             id text PRIMARY KEY,
             data jsonb NOT NULL,
             updated_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
        await this.pool.query(`CREATE INDEX IF NOT EXISTS ${table}_data_gin ON ${table} USING gin (data jsonb_path_ops)`);
      }),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<{ ok: boolean; driver: string; detail: string }> {
    try {
      const result = await this.pool.query<{ version: string }>('SELECT version() AS version');
      return {
        ok: true,
        driver: 'postgres',
        detail: (result.rows[0]?.version ?? 'Postgres').split(' ').slice(0, 2).join(' '),
      };
    } catch (error) {
      return { ok: false, driver: 'postgres', detail: (error as Error).message };
    }
  }

  async ensureIndexes(indexes?: readonly IndexSpec[]): Promise<{ collection: string; name: string; created: boolean }[]> {
    // Diğer sürücülerle (dosya/Mongo) aynı sözleşme: argümansız çağrı
    // varsayılan `INDEXES` kümesini kurar. Varsayılan boş olursa Postgres'te
    // benzersizler dahil hiçbir ek indeks kurulmaz ve atomik ekleme bozulur.
    const specs = (indexes ?? INDEXES).filter((spec) => spec.keys.length > 0);
    const ensured = await Promise.all(
      specs.map(async (spec) => {
        const table = this.table(spec.collection);
        const expression = spec.keys
          .map(([path]) => `(data -> ${quoteLiteral(path)})`)
          .join(', ');
        const name = indexIdentifier(table, `${spec.unique ? 'uniq' : 'idx'}_${spec.name}`);
        await this.pool.query(
          `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${expression})`,
        );
        return { spec, result: { collection: spec.collection, name, created: true } };
      }),
    );

    for (const { spec, result } of ensured) {
      if (!spec.unique) continue;
      const existing = this.uniqueIndexes.get(spec.collection) ?? [];
      const fields = spec.keys.map(([path]) => path);
      if (!existing.some((entry) => entry.name === result.name)) existing.push({ name: result.name, fields });
      this.uniqueIndexes.set(spec.collection, existing);
    }
    return ensured.map(({ result }) => result);
  }

  /** Ön filtre + doğrulama: nihai karar `matchesQuery` ile verilir. */
  private async selectMatching<K extends CollectionName>(
    collection: K,
    filter?: Query,
  ): Promise<DocumentOf<K>[]> {
    const table = this.table(collection);
    const params: unknown[] = [];
    const prefilter = buildPrefilter(filter, table, params);
    const where = prefilter === null ? 'TRUE' : prefilter;
    const result = await this.pool.query<{ data: unknown }>(
      `SELECT data FROM ${table} WHERE ${where} LIMIT ${MAX_SCAN_ROWS + 1}`,
      // Savunma katmanı: ön filtre yoksa SQL'de yer tutucu da yoktur; parametre
      // GÖNDERİLMEZ. `buildPrefilter` zaten vazgeçişte parametreleri geri alır,
      // ancak "yer tutucu sayısı = parametre sayısı" eşitliği bu son noktada da
      // garanti edilir ki aynı bind hatası başka bir çeviri yolundan geri
      // gelemesin.
      prefilter === null ? [] : params,
    );
    if (result.rows.length > MAX_SCAN_ROWS) {
      throw new Error(
        `Sorgu ön filtresi ${MAX_SCAN_ROWS} satırı aştı; sorguya daha seçici bir koşul ekleyin ` +
          `(koleksiyon: ${collection}). Sessiz kırpma yapılmaz.`,
      );
    }
    const docs = result.rows.map((row) => row.data as DocumentOf<K>);
    return docs.filter((doc) => matchesQuery(doc, filter));
  }

  private async findById<K extends CollectionName>(
    collection: K,
    id: string,
    client?: PoolClient,
  ): Promise<DocumentOf<K> | null> {
    const table = this.table(collection);
    const query = await this.queryRunner(client)(`SELECT data FROM ${table} WHERE id = $1`, [id]);
    const row = query.rows[0] as { data: unknown } | undefined;
    return row ? (row.data as DocumentOf<K>) : null;
  }

  /** Havuz ya da işlem bağlamında sorgu çalıştırıcı. */
  private queryRunner(client?: PoolClient) {
    return (text: string, values: unknown[]) =>
      client ? client.query(text, values) : this.pool.query(text, values);
  }

  async insertOne<K extends CollectionName>(collection: K, doc: DocumentOf<K>): Promise<DocumentOf<K>> {
    const table = this.table(collection);
    const id = String((doc as { id: string }).id);
    await this.pool.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)`, [
      id,
      JSON.stringify(doc),
    ]);
    return doc;
  }

  async insertMany<K extends CollectionName>(collection: K, docs: DocumentOf<K>[]): Promise<number> {
    if (docs.length === 0) return 0;
    const table = this.table(collection);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const doc of docs) {
        const id = String((doc as { id: string }).id);
        await client.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)`, [
          id,
          JSON.stringify(doc),
        ]);
      }
      await client.query('COMMIT');
      return docs.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findOne<K extends CollectionName>(collection: K, filter: Query): Promise<DocumentOf<K> | null> {
    const docs = await this.selectMatching(collection, filter);
    return docs[0] ?? null;
  }

  async find<K extends CollectionName>(
    collection: K,
    filter?: Query,
    options?: FindOptions,
  ): Promise<DocumentOf<K>[]> {
    const sort = options?.sort;
    const isUnfiltered = !filter || Object.keys(filter).length === 0;
    const idSort = sort?.length === 1 && sort[0]?.[0] === 'id' ? sort[0][1] : undefined;
    const limit = options?.limit;
    const skip = options?.skip ?? 0;

    // Migrations and other bounded full scans read deterministic ID pages.
    // Apply pagination in SQL for this exact case; otherwise selectMatching's
    // MAX_SCAN_ROWS guard would reject collections over 20,000 rows before the
    // caller could fetch page two. C collation keeps page order deterministic
    // regardless of the database's locale; application-generated IDs are ASCII.
    if (
      isUnfiltered &&
      (idSort === 1 || idSort === -1) &&
      limit !== undefined &&
      Number.isSafeInteger(limit) &&
      limit >= 0 &&
      Number.isSafeInteger(skip) &&
      skip >= 0
    ) {
      const direction = idSort === 1 ? 'ASC' : 'DESC';
      const result = await this.pool.query<{ data: unknown }>(
        `SELECT data FROM ${this.table(collection)} ORDER BY id COLLATE "C" ${direction} LIMIT $1 OFFSET $2`,
        [limit, skip],
      );
      return result.rows.map((row) => row.data as DocumentOf<K>);
    }

    const docs = await this.selectMatching(collection, filter);
    const sorted = sortDocuments(docs, options?.sort);
    const limited =
      options?.limit !== undefined ? sorted.slice(skip, skip + options.limit) : sorted.slice(skip);
    return limited;
  }

  async count<K extends CollectionName>(collection: K, filter?: Query): Promise<number> {
    const docs = await this.selectMatching(collection, filter);
    return docs.length;
  }

  async updateOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<DocumentOf<K> | null> {
    const table = this.table(collection);
    const candidates = await this.selectMatching(collection, filter);
    const target = candidates[0];
    if (!target) return null;
    const id = String((target as { id: string }).id);
    const next = applyPatch(target as unknown as Record<string, unknown>, patch) as unknown as DocumentOf<K>;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT data FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      const current = (locked.rows[0] as { data: unknown } | undefined)?.data;
      const base = (current ?? target) as unknown as Record<string, unknown>;
      const merged = applyPatch(base, patch) as unknown as DocumentOf<K>;
      const result = await client.query(
        `UPDATE ${table} SET data = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING data`,
        [id, JSON.stringify(merged)],
      );
      await client.query('COMMIT');
      const row = result.rows[0] as { data: unknown } | undefined;
      return row ? (row.data as DocumentOf<K>) : next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    doc: DocumentOf<K>,
    patch?: Record<string, unknown>,
  ): Promise<{ document: DocumentOf<K>; created: boolean }> {
    const existing = await this.findOne(collection, filter);
    if (existing) {
      const id = String((existing as { id: string }).id);
      const updated = await this.updateOne(collection, { id }, patch ?? {});
      return { document: updated ?? existing, created: false };
    }
    const inserted = await this.insertIfAbsent(collection, doc);
    return { document: inserted.document, created: inserted.inserted };
  }

  async insertIfAbsent<K extends CollectionName>(
    collection: K,
    doc: DocumentOf<K>,
  ): Promise<InsertIfAbsentResult<K>> {
    const table = this.table(collection);
    const id = String((doc as { id: string }).id);
    const result = await this.pool.query<{ data: unknown }>(
      `INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT DO NOTHING RETURNING data`,
      [id, JSON.stringify(doc)],
    );
    const row = result.rows[0] as { data: unknown } | undefined;
    if (row) return { inserted: true, document: row.data as DocumentOf<K> };

    // Çakışma id üzerinden değil de benzersiz ifade indeksi üzerinden olabilir
    // (ör. sources.key). Mevcut kaydı benzersiz alanlardan bulup döneriz.
    const found = await this.findById(collection, id);
    if (found) return { inserted: false, document: found };

    for (const index of this.uniqueIndexes.get(collection) ?? []) {
      const filter: Query = {};
      let usable = true;
      for (const field of index.fields) {
        const value = getPath(doc, field);
        if (value === undefined) {
          usable = false;
          break;
        }
        filter[field] = value;
      }
      if (!usable) continue;
      const existing = await this.findOne(collection, filter);
      if (existing) return { inserted: false, document: existing as DocumentOf<K> };
    }
    throw new Error(`Kayıt eklenemedi ve mevcut kayıt bulunamadı (koleksiyon: ${collection}, id: ${id}).`);
  }

  async updateMany<K extends CollectionName>(
    collection: K,
    filter: Query,
    patch: Record<string, unknown>,
  ): Promise<number> {
    const targets = await this.selectMatching(collection, filter);
    let updated = 0;
    for (const target of targets) {
      const id = String((target as { id: string }).id);
      const result = await this.updateOne(collection, { id }, patch);
      if (result) updated += 1;
    }
    return updated;
  }

  async deleteOne<K extends CollectionName>(collection: K, filter: Query): Promise<boolean> {
    const target = await this.findOne(collection, filter);
    if (!target) return false;
    const table = this.table(collection);
    const id = String((target as { id: string }).id);
    const result = await this.pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteMany<K extends CollectionName>(collection: K, filter: Query): Promise<number> {
    const targets = await this.selectMatching(collection, filter);
    if (targets.length === 0) return 0;
    const table = this.table(collection);
    const ids = targets.map((target) => String((target as { id: string }).id));
    const result = await this.pool.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
    return result.rowCount ?? 0;
  }

  async truncate(collection: CollectionName): Promise<void> {
    await this.pool.query(`TRUNCATE TABLE ${this.table(collection)}`);
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
