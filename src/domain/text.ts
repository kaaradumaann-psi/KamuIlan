/**
 * Turkish text helpers.
 *
 * Sources publish with mixed casing, missing diacritics, NBSP and soft hyphens.
 * All comparisons in classification/dedupe run on `normalizeTr` output.
 */

const TR_LOWER: Record<string, string> = { I: 'ı', İ: 'i', Ş: 'ş', Ğ: 'ğ', Ü: 'ü', Ö: 'ö', Ç: 'ç' };

/** Lowercases with Turkish casing rules (I -> ı, İ -> i). */
export function lowerTr(value: string): string {
  let out = '';
  for (const ch of value) out += TR_LOWER[ch] ?? ch.toLowerCase();
  return out;
}

export function upperTr(value: string): string {
  return value.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
}

const FOLD: Record<string, string> = {
  ı: 'i',
  İ: 'i',
  ş: 's',
  Ş: 's',
  ğ: 'g',
  Ğ: 'g',
  ü: 'u',
  Ü: 'u',
  ö: 'o',
  Ö: 'o',
  ç: 'c',
  Ç: 'c',
  â: 'a',
  î: 'i',
  û: 'u',
};

/** Folds Turkish diacritics so "ŞÖLEN"/"Solen" compare equal. */
export function foldTr(value: string): string {
  let out = '';
  for (const ch of value) out += FOLD[ch] ?? ch;
  return out;
}

/** Canonical comparison form: lowercase, diacritics folded, punctuation collapsed. */
export function normalizeTr(value: string): string {
  return collapseWhitespace(
    foldTr(lowerTr(value))
      .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
      .replace(/[’'`´]/g, '')
      // Cümle sonu noktası boşluğa çevrilir; sayı içindeki nokta (12.10.2026) korunur.
      .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
      .replace(/[^\p{L}\p{N}+./%()\-\s]/gu, ' ')
      // Yalnızca sayı/ifade bağlayan işaretlerin çevresi sadeleşir (parantez boşlukları korunur).
      .replace(/\s*([+/%\-])\s*/g, '$1'),
  );
}

export function collapseWhitespace(value: string): string {
  return value.replace(/[\s\u00A0\u2028\u2029]+/g, ' ').trim();
}

/**
 * HTML etiketlerini ayıklayıp düz metin döndürür.
 *
 * Blok sınırları (`<br>`, `</p>`, `</div>`, `</li>`, `</tr>`, başlık kapanışları)
 * SATIR SONU OLARAK KORUNUR. Bu ayrım liste ayrıştırıcıları için zorunludur:
 * bir ilan kartında kurum, il ve tarih ayrı bloklarda durur; satır sonları
 * kaybolursa alanlar tek paragrafta birleşir ve hiçbiri güvenle çıkarılamaz.
 * Satır İÇİ boşluklar (birden fazla boşluk, sekme, nbsp) sadeleştirilir.
 */
export function stripHtmlTags(html: string): string {
  const withoutMarkup = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

  return withoutMarkup
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function tokenize(value: string, minLength = 2): string[] {
  return normalizeTr(value)
    .split(' ')
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length >= minLength);
}

export function slugifyTr(value: string): string {
  return foldTr(lowerTr(value))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Token-set Jaccard similarity on tokens of length >= 3. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenizeShingles(a));
  const setB = new Set(tokenizeShingles(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Character n-gram (shingle) similarity — robust for short titles where token
 * overlap is too coarse ("Vakıf Uzman Yardımcılığı Sınav İlanı" variants).
 */
export function diceSimilarity(a: string, b: string, n = 3): number {
  const gramsA = shingles(normalizeTr(a), n);
  const gramsB = shingles(normalizeTr(b), n);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let intersection = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) intersection += 1;
  return (2 * intersection) / (gramsA.size + gramsB.size);
}

function shingles(value: string, n: number): Set<string> {
  const compact = value.replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  if (compact.length <= n) {
    if (compact.length > 0) out.add(compact);
    return out;
  }
  for (let i = 0; i + n <= compact.length; i += 1) out.add(compact.slice(i, i + n));
  return out;
}

function tokenizeShingles(value: string): string[] {
  return tokenize(value, 3);
}

/** Extracts a Turkish phone/e-mail-free readable excerpt of at most `max` chars. */
export function makeExcerpt(value: string, max = 1200): string {
  const clean = collapseWhitespace(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function uniquePreserve<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Masks an e-mail address for logs: a***@example.com */
/**
 * Kullanıcı/kaynak içeriğini düzenli ifade KAYNAĞI olarak güvenli hâle getirir.
 *
 * Arama kutusuna `(((((((a)+)+)` yazan bir kullanıcı (ya da başlığında regex
 * karakteri geçen taranmış bir ilan) aksi hâlde ya isteği 500'e düşürür ya da
 * düzenli ifade motorunu kilitler (ReDoS). Arama daima DÜZ METİN eşleşmesidir;
 * `%`, `*` gibi karakterler özel anlam taşımaz.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}
