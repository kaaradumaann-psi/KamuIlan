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
 *     `sortDocuments` üzerinden yapılır. İstisnalar:
 *     - boş filtre + yalnızca `id` sıralaması + limit: kararlı ID sayfalaması SQL'de
 *       (göçler için gerekli);
 *     - sorgu ve sıralama şeması sabit alanlarda TAM çevrilebiliyorsa
 *       (`postgres-exact.ts`, R-03): filtre, ORDER BY, LIMIT/OFFSET ve COUNT SQL'de.
 *       Satırlar yine `matchesQuery`'den geçirilir; çeviri hatası yanlış satır
 *       döndüremez (karşılaştırma: tests/r03-sql-tam-ceviri.test.ts).
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
import { DEVIANT_INDEX_VERSION, EXACT_FIELDS, deviantPredicate, exactPlan, textSortExpression } from './postgres-exact';

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
  /**
   * CA dosyası sistem kökleriyle BİRLEŞTİRİLSİN mi? (POSTGRES_SSL_CA_MERGE_SYSTEM)
   *
   * Varsayılan `false`: sunucu sertifikası YALNIZCA CA dosyasındaki köklerle
   * doğrulanır (pinning). `true` olduğunda dosya kökleri Node'un gömülü Mozilla
   * kökleri + işletim sistemi deposu + NODE_EXTRA_CA_CERTS ile birleştirilir;
   * doğrulama yine AÇIKTIR, yalnızca güven kümesi genişler. Gerekçe: aynı anda
   * hem Supabase proje CA'sına hem kurumsal TLS denetimi köküne güvenmek
   * gerektiğinde tek dosya yetmez ve kullanıcı doğrulamayı kapatmaya zorlanamaz.
   */
  mergeSystemCa?: boolean;
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

/**
 * Noktalı yol (`classification.decision`) için eşitlik ön filtresi.
 *
 * JSONB kapsaması (`@>`) burada ÜST KÜME vermez: `getPathValues` ara dizilerin
 * nesne elemanlarını gezer ve yaprakta iç içe dizileri düzleştirir
 * (`{a:{b:[["x"]]}}` → `a.b = "x"` eşleşir), kapsama ise bunu kaçırır. Bu yüzden
 * lax JSONPath kullanılır: her erişimci bir dizi düzeyini açar, yapraktaki `.**`
 * tüm iç içe değerleri kapsar. Fazladan eşleşmeler `matchesQuery`'de elenir.
 *
 * Yalnızca metin/sayı/mantıksal değerler çevrilir: `null` eşitliği eksik alanı da
 * eşlediği için JSONPath ile güvenle ifade edilemez → çağıran bağlacı atlar.
 * Değerler parametre (`vars`) olarak geçer; yol parçaları JSON dizesi olarak alıntılanır.
 */
function dottedEqualityClause(path: string, values: unknown[], params: unknown[]): string | null {
  const vars: Record<string, unknown> = {};
  const add = (value: unknown): void => {
    vars[`v${Object.keys(vars).length}`] = value;
  };
  for (const value of values) {
    if (typeof value === 'boolean') add(value);
    else if (typeof value === 'number' && Number.isFinite(value)) {
      add(value);
      add(String(value));
    } else if (typeof value === 'string') {
      add(value);
      if (value.trim() !== '' && Number.isFinite(Number(value))) add(Number(value));
    } else return null;
  }
  const names = Object.keys(vars);
  if (names.length === 0) return null;
  const accessor = path
    .split('.')
    .map((segment) => `.${JSON.stringify(segment)}`)
    .join('');
  params.push(`lax $${accessor}.** ? (${names.map((name) => `@ == $${name}`).join(' || ')})`);
  const pathIndex = params.length;
  params.push(JSON.stringify(vars));
  return `jsonb_path_exists(data, $${pathIndex}::jsonpath, $${params.length}::jsonb)`;
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
 * Sorgunun SQL ön filtresini üretir; hiçbir koşul çevrilemezse `TRUE` döner.
 * Ön filtre her zaman nihai sonucun ÜST KÜMESİDİR; kesin karar `matchesQuery`'dedir.
 *
 * Nokta içeren (iç içe) yollar JSONB kapsamasıyla DEĞİL, lax JSONPath ile
 * çevrilir (`dottedEqualityClause`): `getPathValues` dizi içindeki nesneleri de
 * gezdiği için (`attachments.url`) kapsama kayıt elerdi. Çevrilemeyen koşul ön
 * filtreden çıkarılır; üst sınır (`MAX_SCAN_ROWS`) aşılırsa açık hata verilir.
 * Sessiz yanlış sonuç hiçbir koşulda üretilmez.
 */
function buildPrefilter(query: Query | undefined, params: unknown[]): string {
  if (!query) return 'TRUE';
  return relaxedPrefilter(query, params) ?? 'TRUE';
}

/**
 * Gevşetilmiş ön filtre: ÜST KÜME garantisiyle mümkün olan en dar SQL koşulu.
 *
 * `null` = "kısıt yok" (TRUE). Eski davranış tek bir çevrilemeyen koşulda
 * (aralık, `$exists`, `$regex`, noktalı yol…) ön filtrenin TAMAMINI düşürüyordu;
 * bu yüzden `{ status: 'active', applicationEndDate: { $lt: … } }` ve ilan listesinin
 * her sorguda eklediği `classification.decision` gibi koşullar
 * tüm tabloyu tarıyor ve tablo 20.000 satırı geçince hata veriyordu (R-03).
 *
 * Kural (her adım nihai sonucun üst kümesini korur; kesin karar `matchesQuery`):
 *  - VE bağlamı (nesne alanları, `$and`): çevrilemeyen bağlaç atlanır.
 *  - VEYA (`$or`): tek bir dal çevrilemezse `$or`'un tamamı kısıtsız sayılır.
 *  - `$nor`: kısıtsız sayılır.
 *  - Alan operatörleri: yalnızca `$eq`/`$in` kısmı kullanılır; diğerleri atlanır.
 * Her vazgeçiş kendi yazdığı parametreleri geri alır (bind hatası değişmezi).
 */
function relaxedPrefilter(query: Query, params: unknown[]): string | null {
  const conditions: string[] = [];
  const attempt = (build: () => string | null): void => {
    const checkpoint = params.length;
    const clause = build();
    if (clause === null) params.length = checkpoint;
    else conditions.push(clause);
  };

  for (const [key, condition] of Object.entries(query)) {
    if (key === '$nor') continue;
    if (key === '$and') {
      for (const clause of (condition as Query[]) ?? []) attempt(() => relaxedPrefilter(clause, params));
      continue;
    }
    if (key === '$or') {
      attempt(() => {
        const clauses = (condition as Query[]) ?? [];
        if (clauses.length === 0) return null;
        const translated: string[] = [];
        for (const clause of clauses) {
          const branch = relaxedPrefilter(clause, params);
          if (branch === null) return null;
          translated.push(branch);
        }
        return `(${translated.join(' OR ')})`;
      });
      continue;
    }
    if (key === 'id') {
      attempt(() => idClause(condition, params));
      continue;
    }
    attempt(() => {
      const values: unknown[] = [];
      if (!isOperatorObject(condition)) {
        if (Array.isArray(condition)) values.push(...condition);
        else values.push(condition);
      } else {
        const operators = condition as ConditionOperators;
        if (operators.$eq !== undefined) values.push(operators.$eq);
        if (operators.$in) values.push(...operators.$in);
        // `$eq` ve `$in` birlikteyse kesişim gerekir; birleşim üst küme olarak yeterli.
      }
      if (values.length === 0) return null;
      const clause = key.includes('.')
        ? dottedEqualityClause(key, values, params)
        : scalarEqualityClause(key, values, params);
      return clause === null ? null : `(${clause})`;
    });
  }

  return conditions.length > 0 ? conditions.join(' AND ') : null;
}

/**
 * TLS yapılandırması (güvenli varsayılan: DOĞRULAMA AÇIK).
 *
 * Sıra:
 *  1. `mode: 'disable'` → TLS hiç kullanılmaz (yalnızca açık tercih; yerel Postgres).
 *  2. `mode: 'no-verify'` → eldiven imzalı sertifika kabulü (AÇIK risk kabulü; panel/CLI uyarır).
 *  3. CA verildiyse → sunucu sertifikası yalnızca bu CA ile doğrulanır
 *     (POSTGRES_SSL_CA_MERGE_SYSTEM=1 ise sistem kökleriyle BİRLEŞTİRİLİR).
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
  options: { mode?: PostgresTlsMode; systemCaStore?: string[]; mergeSystemCa?: boolean } = {},
): PostgresSslConfig {
  const mode = options.mode ?? 'verify';
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  // `systemCaStore` verilmemişse gerçek sistem deposu okunur; açıkça `undefined`
  // verildiğinde (ör. Node sistem deposunu desteklemiyor) gömülü kökler kullanılır.
  const systemCaStore = 'systemCaStore' in options ? options.systemCaStore : loadCaStore();
  const hasFileCa = Boolean(caCertificate && caCertificate.trim().length > 0);

  if (hasFileCa && options.mergeSystemCa) {
    // POSTGRES_SSL_CA_MERGE_SYSTEM=1: dosya kökleri + sistem kökleri birlikte.
    // Tekilleştirme PEM bloğu düzeyinde yapılır; aynı kök iki kez listelenmez.
    const merged = new Set<string>(splitPemCertificates(caCertificate ?? ''));
    for (const cert of systemCaStore ?? []) merged.add(cert.trim());
    return { ca: [...merged], rejectUnauthorized: true };
  }
  if (hasFileCa) {
    return { ca: caCertificate as string, rejectUnauthorized: true };
  }
  return systemCaStore
    ? { ca: systemCaStore, rejectUnauthorized: true }
    : { rejectUnauthorized: true };
}

/** PEM metnindeki CERTIFICATE bloklarını ayırır (tek dosyada tam zincir olabilir). */
function splitPemCertificates(pem: string): string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) return [pem.trim()].filter((block) => block.length > 0);
  return blocks.map((block) => block.trim()).filter((block) => block.length > 0);
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
          : {
              ssl: sslConfigFor(options.caCertificate, {
                mode: options.sslMode,
                mergeSystemCa: options.mergeSystemCa,
              }),
            }),
      });
  }

  private table(collection: CollectionName): string {
    return tableName(this.prefix, collection);
  }

  private get collections(): CollectionName[] {
    return Object.keys(COLLECTION_SCHEMAS) as CollectionName[];
  }

  async init(): Promise<void> {
    // Bağlantı başlatımı salt okunur olmalı: read-only tanı/rapor komutları
    // ensureIndexes:false ile production DB'ye DDL yazmadan SELECT yapabilsin.
    this.prefix = safeIdentifier(this.prefix);
    await this.pool.query('SELECT 1');
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
    // Schema DDL is deliberately here, not init(): initStore(..., {ensureIndexes:false})
    // must be safe for read-only diagnostics against a production database.
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
        // Tam çeviri (R-03) metin ifadesiyle süzer/sıralar: `data -> 'alan'` (jsonb)
        // indeksi o ifadede kullanılamaz. Aynı ifadeyle ikinci bir indeks kurulur;
        // ad ayrı tutulur ki eski kurulumlarda IF NOT EXISTS mevcut indeksi atlamasın.
        const exactFields = EXACT_FIELDS[spec.collection];
        if (!spec.unique && exactFields && spec.keys.every(([path]) => exactFields[path] === 'string')) {
          const textName = indexIdentifier(table, `txt_${spec.name}`);
          const textExpression = spec.keys
            .map(([path, direction]) => `${textSortExpression(path)} ${direction === -1 ? 'DESC' : 'ASC'} NULLS LAST`)
            .join(', ');
          await this.pool.query(`CREATE INDEX IF NOT EXISTS ${textName} ON ${table} (${textExpression})`);
        }
        return { spec, result: { collection: spec.collection, name, created: true } };
      }),
    );

    // Tip sapmalı satırlar için kısmi indeks (R-03): koşul `deviantPredicate` ile
    // metin olarak aynıdır; normal durumda indeks boştur ve sorgu ~0 maliyetlidir.
    await Promise.all(
      this.collections.map(async (collection) => {
        const deviant = deviantPredicate(collection);
        if (!deviant) return;
        const table = this.table(collection);
        const name = indexIdentifier(table, `sapma_v${DEVIANT_INDEX_VERSION}`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (id) WHERE ${deviant}`);
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
    const plan = exactPlan(collection, filter, undefined, params);
    // Tam çeviri varsa koşul ön filtreden daha dardır (eşleşen satırların kendisi);
    // tip sapmalı satırlar ayrıca çekilip bellekte değerlendirilir.
    const where = plan ? plan.where : buildPrefilter(filter, params);
    const result = await this.pool.query<{ data: unknown }>(
      `SELECT data FROM ${table} WHERE ${where} LIMIT ${MAX_SCAN_ROWS + 1}`,
      // Savunma katmanı: ön filtre yoksa SQL'de yer tutucu da yoktur; parametre
      // GÖNDERİLMEZ. `relaxedPrefilter` zaten vazgeçişte parametreleri geri alır,
      // ancak "yer tutucu sayısı = parametre sayısı" eşitliği bu son noktada da
      // garanti edilir ki aynı bind hatası başka bir çeviri yolundan geri
      // gelemesin.
      where === 'TRUE' ? [] : params,
    );
    if (result.rows.length > MAX_SCAN_ROWS) {
      throw new Error(
        `Sorgu ön filtresi ${MAX_SCAN_ROWS} satırı aştı; sorguya daha seçici bir koşul ekleyin ` +
          `(koleksiyon: ${collection}). Sessiz kırpma yapılmaz.`,
      );
    }
    const docs = result.rows.map((row) => row.data as DocumentOf<K>);
    if (plan) {
      const byId = new Map(docs.map((doc) => [String((doc as { id: string }).id), doc]));
      for (const doc of await this.deviantRows(collection, plan.deviant)) {
        byId.set(String((doc as { id: string }).id), doc);
      }
      return [...byId.values()].filter((doc) => matchesQuery(doc, filter));
    }
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
    const exact = await this.exactFind(collection, filter, { limit: 1 });
    if (exact) return exact[0] ?? null;
    const docs = await this.selectMatching(collection, filter);
    return docs[0] ?? null;
  }

  /**
   * Filtre + sıralama + sayfalama SQL'de (R-03). Sorgu ya da sıralama tam
   * çevrilemiyorsa `null` döner; çağıran bellek yoluna düşer.
   *
   * Şemaya uyan satırlar SQL'de süzülür, sıralanır ve sayfalanır. Tip sapmalı
   * satırlar (`plan.deviant`, normalde yok) ayrıca çekilip bellekte karara
   * bağlanır ve aynı karşılaştırıcıyla (`sortDocuments`) sayfaya katılır.
   */
  private async exactFind<K extends CollectionName>(
    collection: K,
    filter: Query | undefined,
    options: FindOptions | undefined,
  ): Promise<DocumentOf<K>[] | null> {
    const limit = options?.limit;
    const skip = options?.skip ?? 0;
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0)) return null;
    if (!(Number.isSafeInteger(skip) && skip >= 0)) return null;
    const params: unknown[] = [];
    const plan = exactPlan(collection, filter, options?.sort, params);
    if (!plan) return null;

    const deviantRows = await this.deviantRows(collection, plan.deviant);
    const uncertain = deviantRows.filter((doc) => matchesQuery(doc, filter));
    const table = this.table(collection);
    const order = plan.orderBy ? ` ORDER BY ${plan.orderBy}` : '';
    // Sapmalı satır yoksa (normal durum) koşul sade kalır: sıralama indeksi kullanılabilir.
    const where = deviantRows.length > 0 ? `${plan.where} AND NOT ${plan.deviant}` : plan.where;
    // Limitsiz istekte bellek sınırı korunur: sessiz kırpma yerine açık hata.
    const window = limit === undefined ? MAX_SCAN_ROWS + 1 : uncertain.length > 0 ? skip + limit : limit;
    const offset = limit !== undefined && uncertain.length === 0 ? skip : 0;
    params.push(window, offset);
    const result = await this.pool.query<{ data: unknown }>(
      `SELECT data FROM ${table} WHERE ${where}${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    if (limit === undefined && result.rows.length > MAX_SCAN_ROWS) {
      throw new Error(
        `Sorgu ${MAX_SCAN_ROWS} satırı aştı; sorguya limit ya da daha seçici bir koşul ekleyin ` +
          `(koleksiyon: ${collection}). Sessiz kırpma yapılmaz.`,
      );
    }
    const certain = result.rows.map((row) => row.data as DocumentOf<K>).filter((doc) => matchesQuery(doc, filter));
    if (offset > 0 || (uncertain.length === 0 && limit !== undefined)) return certain;
    const combined = sortDocuments([...certain, ...uncertain], options?.sort);
    return limit === undefined ? combined.slice(skip) : combined.slice(skip, skip + limit);
  }

  /**
   * Tip sapmalı satırların tamamı (filtreden bağımsız; kısmi indeksle normalde
   * boş ve ~0 maliyetli). Çağıran bunları bellekte `matchesQuery` ile değerlendirir.
   */
  private async deviantRows<K extends CollectionName>(collection: K, deviant: string): Promise<DocumentOf<K>[]> {
    const result = await this.pool.query<{ data: unknown }>(
      `SELECT data FROM ${this.table(collection)} WHERE ${deviant} LIMIT ${MAX_SCAN_ROWS + 1}`,
    );
    if (result.rows.length > MAX_SCAN_ROWS) {
      throw new Error(
        `Şemaya uymayan ${MAX_SCAN_ROWS}+ satır var (koleksiyon: ${collection}); veri onarımı gerekir. Sessiz kırpma yapılmaz.`,
      );
    }
    return result.rows.map((row) => row.data as DocumentOf<K>);
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

    const exact = await this.exactFind(collection, filter, options);
    if (exact) return exact;

    const docs = await this.selectMatching(collection, filter);
    const sorted = sortDocuments(docs, options?.sort);
    const limited =
      options?.limit !== undefined ? sorted.slice(skip, skip + options.limit) : sorted.slice(skip);
    return limited;
  }

  async count<K extends CollectionName>(collection: K, filter?: Query): Promise<number> {
    const params: unknown[] = [];
    const plan = exactPlan(collection, filter, undefined, params);
    if (plan) {
      const deviantRows = await this.deviantRows(collection, plan.deviant);
      const where = deviantRows.length > 0 ? `${plan.where} AND NOT ${plan.deviant}` : plan.where;
      const result = await this.pool.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM ${this.table(collection)} WHERE ${where}`,
        params,
      );
      return Number(result.rows[0]?.count ?? 0) + deviantRows.filter((doc) => matchesQuery(doc, filter)).length;
    }
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

  async incrementOne<K extends CollectionName>(
    collection: K,
    filter: Query,
    field: string,
    amount = 1,
  ): Promise<DocumentOf<K> | null> {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw new Error('Sayaç alanı tek bir belge alanı olmalıdır.');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Sayaç artışı pozitif güvenli tamsayı olmalıdır.');
    const target = (await this.selectMatching(collection, filter))[0];
    if (!target) return null;
    const id = String((target as { id: string }).id);
    const result = await this.pool.query<{ data: unknown }>(
      `UPDATE ${this.table(collection)}
       SET data = jsonb_set(
         data,
         $1::text[],
         to_jsonb(COALESCE((data #>> $1::text[])::numeric, 0::numeric) + $2::numeric),
         true
       ), updated_at = now()
       WHERE id = $3
       RETURNING data`,
      [[field], amount, id],
    );
    const row = result.rows[0] as { data: unknown } | undefined;
    return row ? (row.data as DocumentOf<K>) : null;
  }

  async incrementOneIfBelow<K extends CollectionName>(
    collection: K,
    filter: Query,
    field: string,
    amount: number,
    maximum: number,
  ): Promise<DocumentOf<K> | null> {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw new Error('Sayaç alanı tek bir belge alanı olmalıdır.');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Sayaç artışı pozitif güvenli tamsayı olmalıdır.');
    if (!Number.isSafeInteger(maximum) || maximum < amount) throw new Error('Sayaç üst sınırı geçersiz.');
    const target = (await this.selectMatching(collection, filter))[0];
    if (!target) return null;
    const id = String((target as { id: string }).id);
    const result = await this.pool.query<{ data: unknown }>(
      `UPDATE ${this.table(collection)}
       SET data = jsonb_set(
         data,
         $1::text[],
         to_jsonb(COALESCE((data #>> $1::text[])::numeric, 0::numeric) + $2::numeric),
         true
       ), updated_at = now()
       WHERE id = $3
         AND COALESCE((data #>> $1::text[])::numeric, 0::numeric) + $2::numeric <= $4::numeric
       RETURNING data`,
      [[field], amount, id, maximum],
    );
    const row = result.rows[0] as { data: unknown } | undefined;
    return row ? (row.data as DocumentOf<K>) : null;
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
