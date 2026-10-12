/**
 * Yazma öncesi şema doğrulaması.
 *
 * Geliştirme/test ortamında her yazma doğrulanır (hataları erken yakalamak için).
 * Üretimde doğrulama kapalıdır; üretimde güvence MongoDB şema validator'ları ve
 * `npm run db:indexes` ile kurulan indekslerdir.
 */
import { getEnv } from '../config/env';
import { COLLECTION_SCHEMAS, type CollectionName } from './schemas';

export function validateDocument<K extends CollectionName>(
  collection: K,
  doc: unknown,
  mode: 'strict' | 'skip' = 'strict',
): void {
  if (mode === 'skip') return;
  if (getEnv().NODE_ENV === 'production') return;
  const schema = COLLECTION_SCHEMAS[collection];
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || '(kök)'}: ${issue.message}`)
      .join(' | ');
    throw new Error(`[${collection}] belge şeması geçersiz -> ${issues}`);
  }
}
