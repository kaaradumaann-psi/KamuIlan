/**
 * Kaynak erişim şartları kapısı.
 *
 * CAPTCHA/WAF/oturum/hız sınırı aşmak yasaktır. Bu modül, canlı koşumdan önce
 * operatörün robots.txt ve kullanım şartlarını gerçekten incelediğini makine
 * tarafından denetlenebilir hâle getirir. Varsayılan durum `unknown`dur ve
 * canlı koşumu durdurur; depo kendi başına "izin var" iddiası üretmez.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const SOURCE_TERMS_PATH = join('config', 'source-terms.json');
/** İnceleme bu süreden eskiyse yeniden doğrulama istenir. */
export const MAX_TERMS_REVIEW_AGE_DAYS = 365;

const termsEntrySchema = z
  .object({
    sourceKey: z.string().min(1),
    decision: z.enum(['allowed', 'blocked', 'unknown']),
    reviewedAt: z.string().nullable().default(null),
    reviewedBy: z.string().nullable().default(null),
    robotsUrl: z.string().url().nullable().default(null),
    termsUrl: z.string().url().nullable().default(null),
    allowsStorage: z.boolean().nullable().default(null),
    notes: z.string().max(2_000).default(''),
  })
  .strict();

export const sourceTermsDocumentSchema = z
  .object({
    version: z.literal(1),
    note: z.string().max(2_000).optional(),
    sources: z.array(termsEntrySchema).max(500),
  })
  .strict();

export type SourceTermsEntry = z.infer<typeof termsEntrySchema>;

export interface SourceTermsLoadResult {
  status: 'missing' | 'invalid' | 'available';
  path: string;
  entries: Map<string, SourceTermsEntry>;
  errors: string[];
}

export function loadSourceTerms(root = process.cwd()): SourceTermsLoadResult {
  const path = resolve(root, SOURCE_TERMS_PATH);
  if (!existsSync(path)) {
    return { status: 'missing', path, entries: new Map(), errors: ['Kaynak şartları dosyası yok.'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return { status: 'invalid', path, entries: new Map(), errors: ['Kaynak şartları dosyası geçerli JSON değil.'] };
  }
  const result = sourceTermsDocumentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: 'invalid',
      path,
      entries: new Map(),
      errors: result.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  const entries = new Map<string, SourceTermsEntry>();
  const errors: string[] = [];
  for (const entry of result.data.sources) {
    if (entries.has(entry.sourceKey)) {
      errors.push(`${entry.sourceKey}: aynı sourceKey birden fazla kez tanımlanmış.`);
      continue;
    }
    entries.set(entry.sourceKey, entry);
  }
  return { status: errors.length > 0 ? 'invalid' : 'available', path, entries, errors };
}

export interface SourceTermsAssessment {
  allowed: boolean;
  reason: string;
  entry: SourceTermsEntry | null;
}

/**
 * Canlı koşum için kapı. Yalnızca açık `allowed` kararı, tarih/kaynak URL'leri,
 * `allowsStorage=true` ve taze bir inceleme birlikte sağlanırsa geçer.
 */
export function assessSourceTerms(
  entry: SourceTermsEntry | null,
  now = new Date(),
  maxAgeDays = MAX_TERMS_REVIEW_AGE_DAYS,
): SourceTermsAssessment {
  if (!entry) {
    return { allowed: false, reason: 'Kaynak için erişim şartları kaydı yok (unknown).', entry };
  }
  if (entry.decision !== 'allowed') {
    return { allowed: false, reason: `Erişim şartları kararı "${entry.decision}".`, entry };
  }
  if (!entry.reviewedBy || entry.reviewedBy.trim().length === 0) {
    return { allowed: false, reason: 'İnceleyen kişi (reviewedBy) yazılmamış.', entry };
  }
  if (!entry.reviewedAt || !Number.isFinite(Date.parse(entry.reviewedAt))) {
    return { allowed: false, reason: 'Geçerli inceleme tarihi (reviewedAt) yok.', entry };
  }
  const ageMs = now.getTime() - Date.parse(entry.reviewedAt);
  if (ageMs > maxAgeDays * 86_400_000) {
    return { allowed: false, reason: `İnceleme ${maxAgeDays} günden eski; yeniden doğrulayın.`, entry };
  }
  if (!entry.robotsUrl || !/^https:\/\//i.test(entry.robotsUrl)) {
    return { allowed: false, reason: 'robots.txt HTTPS adresi yok.', entry };
  }
  if (!entry.termsUrl || !/^https:\/\//i.test(entry.termsUrl)) {
    return { allowed: false, reason: 'Kullanım şartları HTTPS adresi yok.', entry };
  }
  if (entry.allowsStorage !== true) {
    return {
      allowed: false,
      reason: 'Kaynağın verisini saklamaya izin verdiği doğrulanmamış (allowsStorage!=true).',
      entry,
    };
  }
  return { allowed: true, reason: 'Erişim şartları incelenmiş ve saklama izni doğrulanmış.', entry };
}
