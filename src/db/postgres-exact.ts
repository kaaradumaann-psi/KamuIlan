/**
 * Postgres için TAM (eşdeğer) sorgu çevirisi — R-03.
 *
 * `postgres-store.ts` SQL'i varsayılan olarak yalnızca ÜST KÜME ön filtresi
 * olarak kullanır; kesin filtre, sıralama ve sayfalama bellekte yapılır. Bu,
 * tablo büyüdükçe her sorgunun tüm eşleşen satırları belleğe çekmesi ve
 * `MAX_SCAN_ROWS` sınırında hata vermesi demektir (ilan kabul hattı, ilan
 * listesi, tarama geçmişi).
 *
 * Bu modül, sorgu `matchesQuery` ile BİREBİR aynı sonucu veren bir SQL
 * koşuluna çevrilebiliyorsa onu üretir; çevrilemiyorsa `null` döner ve çağıran
 * eski (ön filtre + bellek) yola düşer. Eşdeğerlik ancak alanın JSON tipi
 * biliniyorsa kurulabilir (ör. `looseEquals` sayı↔metin eşitliği, dizilerin
 * düzleştirilmesi); bu yüzden yalnızca zod şemasıyla tipi sabit alanlar
 * (`EXACT_FIELDS`) çevrilir.
 *
 * Şemaya UYMAYAN satırlar (eski/elle yazılmış belge: `quota: "25"`, dizi yerine
 * tek metin) için eşdeğerlik garanti edilmez. Bunlar `deviantPredicate` ile
 * ayrılır, SQL'de karara bağlanmaz; bellekte `matchesQuery`/`sortDocuments` ile
 * değerlendirilir. Koşul koleksiyon başına sabittir ve kısmi indeksle
 * (`ensureIndexes`) karşılanır: normal durumda (sapma yok) maliyeti ~0.
 *
 * Bilinçli sınırlar (hepsi `null` → bellek yolu):
 *  - kayıtlı olmayan alan, dizi koşulu, sayı↔metin karışık karşılaştırma;
 *  - `$regex` yalnızca ASCII düz metin (escapeRegExp çıktısı) + `i` bayrağı;
 *    büyük/küçük harf katlaması ASCII ile sınırlı (`translate`); JS'nin Unicode
 *    olmayan `i` kipi de ASCII dışı harfi ASCII'ye katlamaz (Canonicalize);
 *  - metin sıralaması `COLLATE "C"` (UTF-8 bayt sırası); JS UTF-16 kod birimi
 *    sırasıyla yalnızca BMP üstü karakterlerde ayrışır (tarih/normalize alanlar ASCII).
 *
 * Her yaprak `COALESCE(…, false)` ile iki değerli tutulur: SQL'in üç değerli
 * mantığı `$nor`/`NOT` altında satır kaybettirmesin. Yapraklar sapmalı satırda
 * da HATA vermez (korumasız tip dönüşümü yok); orada yalnızca anlamsızdır.
 */
import type { CollectionName } from './schemas';
import { isOperatorObject, type ConditionOperators, type Query, type SortSpec } from './query';

export type ExactFieldKind = 'string' | 'number' | 'string-array';

/**
 * Tipi şemayla sabit, SQL'e tam çevrilebilen alanlar (src/db/schemas.ts).
 * Yalnızca büyüyen ve sorgu yolu sıcak koleksiyonlar listelenir. Bir alan
 * eklemek kısmi sapma indeksinin koşulunu değiştirir (yeni ad: `sapma_v<n>`).
 */
export const EXACT_FIELDS: Partial<Record<CollectionName, Readonly<Record<string, ExactFieldKind>>>> = {
  jobs: {
    id: 'string',
    dedupeKey: 'string',
    normalizedUrl: 'string',
    title: 'string',
    titleNormalized: 'string',
    institution: 'string',
    institutionNormalized: 'string',
    employmentType: 'string',
    status: 'string',
    city: 'string',
    cityNormalized: 'string',
    applicationUrl: 'string',
    applicationEndDate: 'string',
    publishedAt: 'string',
    originalRefNo: 'string',
    primarySourceKey: 'string',
    provenance: 'string',
    textNormalized: 'string',
    createdAt: 'string',
    updatedAt: 'string',
    firstSeenAt: 'string',
    lastSeenAt: 'string',
    'classification.decision': 'string',
    'classification.kind': 'string',
    quota: 'number',
    version: 'number',
    'requirements.kpssMinScore': 'number',
    sourceKeys: 'string-array',
    'requirements.educationLevels': 'string-array',
    'requirements.departments': 'string-array',
    'requirements.kpssScoreTypes': 'string-array',
  },
  jobSources: {
    id: 'string',
    jobId: 'string',
    sourceKey: 'string',
    sourceItemId: 'string',
    firstSeenAt: 'string',
    lastSeenAt: 'string',
  },
  sourceItemDecisions: {
    id: 'string',
    sourceKey: 'string',
    sourceItemId: 'string',
    decision: 'string',
    firstSeenAt: 'string',
    lastSeenAt: 'string',
  },
  scrapeRuns: {
    id: 'string',
    sourceKey: 'string',
    status: 'string',
    trigger: 'string',
    startedAt: 'string',
    finishedAt: 'string',
  },
  // Egress (27.10.2026): aşağıdaki koleksiyonlar tam çeviri listesinde değilken `count` ve
  // `find` eşleşen TÜM satırların `data` belgesini Supabase'ten çekip bellekte sayıyordu.
  // Kuyruk istatistiği her kalp atışında (30 sn) 5 kez çalışıyor ve tamamlanmış işler hiç
  // silinmediği için her çağrıda tablonun tamamı aktarılıyordu (pg_stat_statements: 85.815
  // çağrı / 11 milyon satır ≈ 7 GB). Tam çeviriyle sayım `count(*)`, liste LIMIT'li SQL olur.
  queueJobs: {
    id: 'string',
    queue: 'string',
    name: 'string',
    dedupeKey: 'string',
    status: 'string',
    runAt: 'string',
    lockedBy: 'string',
    lockedUntil: 'string',
    createdAt: 'string',
    updatedAt: 'string',
    completedAt: 'string',
    attempts: 'number',
  },
  reviewQueue: {
    id: 'string',
    kind: 'string',
    sourceKey: 'string',
    status: 'string',
    title: 'string',
    url: 'string',
    createdAt: 'string',
    resolvedAt: 'string',
  },
  emailOutbox: {
    id: 'string',
    channel: 'string',
    eventId: 'string',
    jobId: 'string',
    userId: 'string',
    kind: 'string',
    status: 'string',
    idempotencyKey: 'string',
    nextAttemptAt: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  },
  workerHeartbeats: {
    id: 'string',
    workerId: 'string',
    role: 'string',
    status: 'string',
    startedAt: 'string',
    lastHeartbeatAt: 'string',
  },
  scheduledTasks: {
    id: 'string',
    kind: 'string',
    sourceKey: 'string',
    nextRunAt: 'string',
    updatedAt: 'string',
  },
  llmAnalyses: {
    id: 'string',
    cacheKey: 'string',
    contentKey: 'string',
    url: 'string',
    sourceKey: 'string',
    model: 'string',
    status: 'string',
    createdAt: 'string',
  },
};

/** Sapma koşulunun sürümü: EXACT_FIELDS değişince artırılır (kısmi indeks yeniden kurulur). */
export const DEVIANT_INDEX_VERSION = 1;

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `data #> '{a,b}'` (jsonb) ve `data #>> '{a,b}'` (text) ifadeleri. */
function pathExpressions(path: string): { json: string; text: string } {
  const segments = path.split('.');
  if (segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(segment))) {
    throw new Error(`Geçersiz alan yolu: ${path}`);
  }
  const array = literal(`{${segments.join(',')}}`);
  return { json: `(data #> ${array})`, text: `(data #>> ${array})` };
}

/** Metin sıralama/aralık ifadesi; indeks ifadesiyle (ensureIndexes) birebir aynı olmalı. */
export function textSortExpression(path: string): string {
  return `(${pathExpressions(path).text} COLLATE "C")`;
}

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** `escapeRegExp` çıktısını düz metne geri çevirir; düz metin değilse `null`. */
function regexLiteral(pattern: string): string | null {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined || !/[.*+?^${}()|[\]\\-]/.test(escaped)) return null;
      out += escaped;
      index += 1;
      continue;
    }
    if (/[.*+?^${}()|[\]]/.test(char)) return null;
    out += char;
  }
  return /^[\x20-\x7e]*$/.test(out) ? out : null;
}

const leaf = (sql: string): string => `COALESCE((${sql}), false)`;

/** Sayı alanı: korumalı dönüşüm (sapmalı satırda metin → numeric hatası olmasın). */
const numeric = (json: string, text: string): string =>
  `(CASE WHEN jsonb_typeof(${json}) = 'number' THEN ${text}::numeric END)`;

class ExactBuilder {
  constructor(
    private readonly fields: Readonly<Record<string, ExactFieldKind>>,
    readonly params: unknown[],
  ) {}

  private param(value: unknown, cast: string): string {
    this.params.push(value);
    return `$${this.params.length}::${cast}`;
  }

  query(query: Query): string | null {
    const parts: string[] = [];
    for (const [key, condition] of Object.entries(query)) {
      if (condition === undefined) return null;
      if (key === '$and' || key === '$or' || key === '$nor') {
        const clauses = (condition as Query[] | undefined) ?? [];
        const translated: string[] = [];
        for (const clause of clauses) {
          const sql = this.query(clause);
          if (sql === null) return null;
          translated.push(sql);
        }
        if (translated.length === 0) continue; // boş bağlaç: kısıt yok (matchesQuery ile aynı)
        if (key === '$and') parts.push(translated.join(' AND '));
        else if (key === '$or') parts.push(`(${translated.join(' OR ')})`);
        else parts.push(`NOT (${translated.join(' OR ')})`);
        continue;
      }
      const kind = this.fields[key];
      if (!kind) return null;
      const sql = this.field(key, kind, condition);
      if (sql === null) return null;
      parts.push(sql);
    }
    return parts.length > 0 ? `(${parts.join(' AND ')})` : 'TRUE';
  }

  private field(path: string, kind: ExactFieldKind, condition: unknown): string | null {
    const { json, text } = pathExpressions(path);

    if (!isOperatorObject(condition)) {
      if (Array.isArray(condition)) return null;
      return this.equality(kind, json, text, [condition]);
    }

    const ops = condition as ConditionOperators;
    const parts: string[] = [];
    // Eksik alan: matchesQuery'de yalnızca $exists:false / $ne:<null değil> / $nin:<null yok> eşler.
    let missingOk = true;

    for (const [operator, value] of Object.entries(ops)) {
      switch (operator) {
        case '$regexFlags':
          continue;
        case '$eq':
        case '$in': {
          missingOk = false;
          if (operator === '$in' && !Array.isArray(value)) return null;
          const values = operator === '$in' ? (value as unknown[]) : [value];
          if (values.some((entry) => Array.isArray(entry))) return null;
          const sql = this.equality(kind, json, text, values);
          if (sql === null) return null;
          parts.push(sql);
          continue;
        }
        case '$ne':
        case '$nin': {
          if (operator === '$nin' && !Array.isArray(value)) return null;
          const values = operator === '$nin' ? (value as unknown[]) : [value];
          if (values.some((entry) => entry === null)) missingOk = false;
          if (kind === 'string-array') return null;
          const positive = this.equality(kind, json, text, values);
          if (positive === null) return null;
          parts.push(`(${json} IS NULL OR NOT ${positive})`);
          continue;
        }
        case '$exists':
          if (kind === 'string-array') return null;
          if (value === true) {
            missingOk = false;
            parts.push(`(${json} IS NOT NULL)`);
          } else if (value === false) {
            parts.push(`(${json} IS NULL)`);
          } else return null;
          continue;
        case '$lt':
        case '$lte':
        case '$gt':
        case '$gte': {
          missingOk = false;
          const sqlOp = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' }[operator];
          if (kind === 'string' && typeof value === 'string') {
            parts.push(leaf(`${textSortExpression(path)} ${sqlOp} ${this.param(value, 'text')} COLLATE "C"`));
          } else if (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
            parts.push(leaf(`${numeric(json, text)} ${sqlOp} ${this.param(value, 'numeric')}`));
          } else return null;
          continue;
        }
        case '$regex': {
          missingOk = false;
          const flags = ops.$regexFlags ?? 'i';
          if (kind !== 'string' || flags !== 'i' || typeof value !== 'string') return null;
          const needle = regexLiteral(value);
          if (needle === null) return null;
          parts.push(
            leaf(
              `strpos(translate(${text}, '${ASCII_UPPER}', '${ASCII_LOWER}'), ${this.param(needle.toLowerCase(), 'text')}) > 0`,
            ),
          );
          continue;
        }
        default:
          return null;
      }
    }

    if (parts.length === 0) return missingOk ? 'TRUE' : null;
    const all = parts.join(' AND ');
    // `$ne`/`$nin`/`$exists:false` dalları eksik alanı zaten kapsar; diğerleri eksik alanı dışlar.
    return missingOk ? `(${all})` : `(${json} IS NOT NULL AND ${all})`;
  }

  /** Değerlerden herhangi birine eşitlik (matchesQuery + looseEquals), şemaya uyan satırda. */
  private equality(kind: ExactFieldKind, json: string, text: string, values: readonly unknown[]): string | null {
    const strings: string[] = [];
    const numbers: number[] = [];
    let includesNull = false;
    for (const value of values) {
      if (value === null) includesNull = true;
      else if (typeof value === 'string') strings.push(value);
      else if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
      else return null;
    }
    const ors: string[] = [];
    if (kind === 'string') {
      // looseEquals(metin, sayı): Number(a) === b — metin alanında sayı koşulu çevrilmez.
      if (numbers.length > 0) return null;
      if (strings.length > 0) ors.push(leaf(`${text} = ANY(${this.param(strings, 'text[]')})`));
      if (includesNull) ors.push(leaf(`jsonb_typeof(${json}) = 'null'`));
    } else if (kind === 'number') {
      // looseEquals(sayı, metin) sayısal metni de eşler; metin koşulu çevrilmez.
      if (strings.length > 0) return null;
      if (numbers.length > 0) ors.push(leaf(`${numeric(json, text)} = ANY(${this.param(numbers, 'numeric[]')})`));
      if (includesNull) ors.push(leaf(`jsonb_typeof(${json}) = 'null'`));
    } else {
      // Metin dizisi: değerlerden biri dizinin bir elemanı. `null` eleman şemada yok.
      if (numbers.length > 0 || includesNull) return null;
      if (strings.length > 0) ors.push(leaf(`${json} ?| ${this.param(strings, 'text[]')}`));
    }
    if (ors.length === 0) return 'FALSE';
    return ors.length === 1 ? (ors[0] as string) : `(${ors.join(' OR ')})`;
  }
}

/**
 * Kayıtlı alanlardan herhangi biri şemadaki JSON tipinden SAPIYOR mu?
 * Koleksiyon başına sabittir (parametre yok) ki kısmi indeksin koşuluyla
 * metin olarak aynı olsun ve planlayıcı indeksi kullanabilsin.
 */
export function deviantPredicate(collection: CollectionName): string | null {
  const fields = EXACT_FIELDS[collection];
  if (!fields) return null;
  const ors = new Set<string>();
  for (const [path, kind] of Object.entries(fields)) {
    const segments = path.split('.');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const prefix = `(data #> ${literal(`{${segments.slice(0, depth).join(',')}}`)})`;
      ors.add(`jsonb_typeof(${prefix}) NOT IN ('object')`);
    }
    const { json } = pathExpressions(path);
    const type = `jsonb_typeof(${json})`;
    if (kind === 'string') ors.add(`${type} NOT IN ('string', 'null')`);
    else if (kind === 'number') ors.add(`${type} NOT IN ('number', 'null')`);
    else {
      ors.add(`${type} NOT IN ('array')`);
      // `silent`: dizi olmayan değerde strict yol hata vermez (o durum üstteki tip denetiminde).
      ors.add(`jsonb_path_exists(${json}, 'strict $[*] ? (@.type() != "string")', '{}', true)`);
    }
  }
  // Eksik alanda jsonb_typeof NULL → `NOT IN` NULL → COALESCE ile false.
  return `COALESCE((${[...ors].join(' OR ')}), false)`;
}

export interface ExactPlan {
  /** Şemaya uyan satırlarda `matchesQuery` ile eşdeğer koşul. */
  where: string;
  /** `sortDocuments` ile eşdeğer ORDER BY (sıralama istenmediyse `null`). */
  orderBy: string | null;
  /** Tip sapmalı satırlar: SQL'de karara bağlanmaz, bellekte değerlendirilir. */
  deviant: string;
}

/** Sorgu ve sıralama SQL'e tam çevrilebiliyorsa plan; değilse `null` (parametreler geri alınır). */
export function exactPlan(
  collection: CollectionName,
  query: Query | undefined,
  sort: SortSpec | undefined,
  params: unknown[],
): ExactPlan | null {
  const fields = EXACT_FIELDS[collection];
  const deviant = deviantPredicate(collection);
  if (!fields || !deviant) return null;
  const checkpoint = params.length;
  const where = query ? new ExactBuilder(fields, params).query(query) : 'TRUE';
  const orderBy = sort && sort.length > 0 ? exactOrderBy(fields, sort) : null;
  if (where === null || (sort && sort.length > 0 && orderBy === null)) {
    params.length = checkpoint;
    return null;
  }
  return { where, orderBy, deviant };
}

/**
 * `sortDocuments` ile aynı sırayı veren ORDER BY; çevrilemiyorsa `null`.
 *
 * `sortDocuments`: eksik/null değer yönden BAĞIMSIZ olarak sona gider (`NULLS
 * LAST`; şemaya uyan satırda `#>>` JSON null ve eksik alan için NULL verir);
 * eşit değerlerde sıradaki anahtara geçilir. `sortDocuments` tam eşitlikte giriş
 * sırasını korur (dosya sürücüsünde ekleme sırası); Postgres'te satır sırası
 * tanımsız olduğu için son eşitlik `id` ile kırılır (kararlı sayfalama).
 * İfade, `ensureIndexes`'in kurduğu metin indeksiyle birebir aynıdır.
 */
function exactOrderBy(fields: Readonly<Record<string, ExactFieldKind>>, sort: SortSpec): string | null {
  const parts: string[] = [];
  for (const [path, direction] of sort) {
    const kind = fields[path];
    if (kind !== 'string' && kind !== 'number') return null;
    const dir = direction === -1 ? 'DESC' : 'ASC';
    const { json, text } = pathExpressions(path);
    const expression = kind === 'string' ? textSortExpression(path) : numeric(json, text);
    parts.push(`${expression} ${dir} NULLS LAST`);
  }
  parts.push('id COLLATE "C" ASC');
  return parts.join(', ');
}
