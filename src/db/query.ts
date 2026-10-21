/**
 * A deliberately small query language shared by both storage drivers.
 *
 * Semantics follow MongoDB closely because production uses MongoDB:
 *  - dotted paths, including paths that traverse arrays ("attachments.url")
 *  - scalar condition against an array field means "array contains value"
 *  - all values are stored as strings/numbers/booleans, so ISO timestamps can be
 *    compared lexicographically for range queries.
 */

export interface ConditionOperators {
  $eq?: unknown;
  $ne?: unknown;
  $in?: readonly unknown[];
  $nin?: readonly unknown[];
  $lt?: unknown;
  $lte?: unknown;
  $gt?: unknown;
  $gte?: unknown;
  $exists?: boolean;
  $regex?: string;
  $regexFlags?: string;
}

export type FieldCondition = unknown;

export interface Query {
  [field: string]: FieldCondition;
  $and?: Query[];
  $or?: Query[];
  $nor?: Query[];
}

export type SortSpec = ReadonlyArray<readonly [string, 1 | -1]>;

export interface FindOptions {
  sort?: SortSpec;
  limit?: number;
  skip?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOperatorObject(value: unknown): value is ConditionOperators {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((key) => key.startsWith('$'));
}

function expandArrayValues(values: unknown[], out: unknown[]): void {
  for (const value of values) {
    if (Array.isArray(value)) expandArrayValues(value, out);
    else out.push(value);
  }
}

/** Returns every value reachable at `path` (array-aware, Mongo-like). */
export function getPathValues(doc: unknown, path: string): unknown[] {
  const segments = path.split('.');
  let current: unknown[] = [doc];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const item of current) {
      if (Array.isArray(item)) {
        const collected: unknown[] = [];
        for (const element of item) {
          if (isPlainObject(element)) expandArrayValues([element[segment]], collected);
        }
        next.push(...collected);
      } else if (isPlainObject(item)) {
        const value = item[segment];
        if (value !== undefined) next.push(value);
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  const out: unknown[] = [];
  expandArrayValues(current, out);
  return out;
}

export function getPath(doc: unknown, path: string): unknown {
  const values = getPathValues(doc, path);
  return values.length > 0 ? values[0] : undefined;
}

export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string' && Number.isFinite(Number(b))) return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b || a === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => looseEquals(v, b[i]));
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === b;
  return false;
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' && typeof b === 'string' && Number.isFinite(Number(b))) return a - Number(b);
  if (typeof a === 'string' && typeof b === 'number' && Number.isFinite(Number(a))) return Number(a) - b;
  return null;
}

function matchValue(value: unknown, condition: FieldCondition): boolean {
  if (!isOperatorObject(condition)) {
    if (Array.isArray(value) && !Array.isArray(condition)) {
      return value.some((element) => looseEquals(element, condition));
    }
    if (Array.isArray(condition)) {
      return Array.isArray(value) && condition.every((c) => value.some((v) => looseEquals(v, c)));
    }
    return looseEquals(value, condition);
  }

  const maybeArray = Array.isArray(value) ? value : [value];
  const op = condition as ConditionOperators;

  // `$exists` iki yönlü olmalıdır: alan VARSA `$exists:false` eşleşmemeli.
  // Eski kod yalnızca `value === undefined` durumunu ele alıyordu; bu yüzden
  // `{ $exists: false }` koşulu DEĞERİ OLAN belgeleri de eşliyordu (sessizce
  // yanlış sonuç kümesi üretir; ör. "başvuru bağlantısı belirtilmemiş" filtresi).
  if (op.$exists !== undefined) {
    const exists = value !== undefined;
    if (op.$exists !== exists) return false;
  }

  if (op.$eq !== undefined && !maybeArray.some((v) => looseEquals(v, op.$eq))) return false;
  if (op.$ne !== undefined && maybeArray.some((v) => looseEquals(v, op.$ne))) return false;
  if (op.$in !== undefined && !maybeArray.some((v) => (op.$in ?? []).some((candidate) => looseEquals(v, candidate))))
    return false;
  if (op.$nin !== undefined && maybeArray.some((v) => (op.$nin ?? []).some((candidate) => looseEquals(v, candidate))))
    return false;
  if (op.$lt !== undefined && !maybeArray.some((v) => compare(v, op.$lt) !== null && (compare(v, op.$lt) as number) < 0))
    return false;
  if (
    op.$lte !== undefined &&
    !maybeArray.some((v) => compare(v, op.$lte) !== null && (compare(v, op.$lte) as number) <= 0)
  )
    return false;
  if (op.$gt !== undefined && !maybeArray.some((v) => compare(v, op.$gt) !== null && (compare(v, op.$gt) as number) > 0))
    return false;
  if (
    op.$gte !== undefined &&
    !maybeArray.some((v) => compare(v, op.$gte) !== null && (compare(v, op.$gte) as number) >= 0)
  )
    return false;
  if (op.$regex !== undefined) {
    const re = new RegExp(op.$regex, op.$regexFlags ?? 'i');
    if (!maybeArray.some((v) => typeof v === 'string' && re.test(v))) return false;
  }
  return true;
}

export function matchesQuery(doc: unknown, query: Query | undefined): boolean {
  if (!query) return true;
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and') {
      const clauses = (condition as Query[]) ?? [];
      if (!clauses.every((clause) => matchesQuery(doc, clause))) return false;
      continue;
    }
    if (key === '$or') {
      const clauses = (condition as Query[]) ?? [];
      if (clauses.length > 0 && !clauses.some((clause) => matchesQuery(doc, clause))) return false;
      continue;
    }
    if (key === '$nor') {
      const clauses = (condition as Query[]) ?? [];
      if (clauses.some((clause) => matchesQuery(doc, clause))) return false;
      continue;
    }
    const values = getPathValues(doc, key);
    if (values.length === 0) {
      if (isOperatorObject(condition) && (condition as ConditionOperators).$exists === false) continue;
      return false;
    }
    if (!values.some((value) => matchValue(value, condition))) return false;
  }
  return true;
}

export function sortDocuments<T>(docs: T[], sort?: SortSpec): T[] {
  if (!sort || sort.length === 0) return docs;
  const copy = [...docs];
  copy.sort((a, b) => {
    for (const entry of sort) {
      const [path, dir] = entry;
      const av = getPath(a, path);
      const bv = getPath(b, path);
      if (av === bv) continue;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      const cmp = compare(av, bv) ?? String(av).localeCompare(String(bv), 'tr');
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
  return copy;
}

/** Translates the shared query language into a MongoDB filter document. */
export function toMongoFilter(query: Query | undefined): Record<string, unknown> {
  if (!query) return {};
  const out: Record<string, unknown> = {};
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      const clauses = ((condition as Query[]) ?? []).map(toMongoFilter);
      if (clauses.length > 0) out[key] = clauses;
      continue;
    }
    if (isOperatorObject(condition)) {
      const converted: Record<string, unknown> = {};
      for (const [op, value] of Object.entries(condition as ConditionOperators)) {
        if (op === '$regex') {
          converted.$regex = value;
          continue;
        }
        if (op === '$regexFlags') continue;
        converted[op] = value;
      }
      const flags = (condition as ConditionOperators).$regexFlags;
      if (flags && converted.$regex) converted.$options = flags;
      out[key] = converted;
      continue;
    }
    if (Array.isArray(condition)) {
      out[key] = { $all: condition };
      continue;
    }
    out[key] = condition;
  }
  return out;
}

/** Sets a dotted path on a plain object, creating intermediate objects. */
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? '';
    const existing = cursor[segment];
    if (isPlainObject(existing)) {
      cursor = existing;
    } else {
      const replacement: Record<string, unknown> = {};
      cursor[segment] = replacement;
      cursor = replacement;
    }
  }
  cursor[segments[segments.length - 1] ?? ''] = value;
}

/** Applies a partial patch (dot-path aware) and returns a new document. */
export function applyPatch<T extends object>(doc: T, patch: Record<string, unknown>): T {
  const next = structuredClone(doc) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) setPath(next, path, value);
  return next as unknown as T;
}

/** Minimal deep-equality check used by dedupe/lock helpers. */
export function deepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
