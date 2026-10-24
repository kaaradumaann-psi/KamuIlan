/**
 * Tekilleştirme incelemesi kararları (yönetici).
 *
 * İnceleme kaydı her zaman "YENİ gelen kayıt ↔ var olan aday ilan(lar)" durumudur;
 * yeni kayıt için ilan oluşturulmamıştır ve tarama belleği onu "görüldü" saydığından
 * kaynak bir daha vermez. Bu yüzden karar burada UYGULANMALIDIR:
 *  - "ayrı bırak": yeni kayıt ayrı ilan olarak yayımlanır,
 *  - "aynı ilan": yeni kayıt seçilen aday ilana kaynak olarak bağlanır.
 * Önceden "ayrı bırak" yalnız kaydı kapatıyordu (ilan kalıcı kayboluyordu); "birleştir"
 * ise iki VAR OLAN ilanı birleştirip birini kapatıyordu.
 *
 * Geri çekme/düzeltme duyurusu için açılan kayıtta (hedef ilan bulunamadı) duyuru
 * ilan değildir: karar yalnız kaydı kapatır.
 */
import type { Repos } from '../db/repos';
import type { ReviewQueueDoc } from '../db/schemas';
import type { ClassificationResult, RawAnnouncement } from '../domain';
import { classify } from '../classification/engine';
import { applyRawAnnouncement, type DedupeOverride } from './jobs-service';

export interface DedupeReviewOutcome {
  /** Oluşturulan ya da bağlanılan ilan; geri çekme kaydında null. */
  jobId: string | null;
  action: 'created' | 'merged' | 'closed-only';
}

export function isWithdrawalReview(item: Pick<ReviewQueueDoc, 'payload'>): boolean {
  return typeof item.payload.withdrawal === 'string' && item.payload.withdrawal.length > 0;
}

function isRawSnapshot(value: unknown): value is RawAnnouncement {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<RawAnnouncement>;
  return (
    typeof raw.sourceKey === 'string' &&
    typeof raw.sourceItemId === 'string' &&
    typeof raw.url === 'string' &&
    typeof raw.title === 'string'
  );
}

/** Anlık görüntüsü olmayan eski kayıtlar: saklanan özetten kurulur (alanlar özetten çıkarılır). */
function rawFromLegacyPayload(item: ReviewQueueDoc): RawAnnouncement | null {
  const sourceItemId = item.payload.sourceItemId;
  if (typeof sourceItemId !== 'string' || sourceItemId.length === 0) return null;
  const excerpt = typeof item.payload.excerpt === 'string' ? item.payload.excerpt : '';
  return {
    sourceKey: item.sourceKey,
    sourceItemId,
    url: item.url,
    title: item.title,
    ...(excerpt ? { bodyText: excerpt, rawExcerpt: excerpt.slice(0, 400) } : {}),
    attachments: [],
    extractionConfidence: Math.min(item.confidence, 0.5),
    notes: ['Yönetici kararıyla inceleme kaydının özetinden oluşturuldu; ayrıntılar sonraki taramada güncellenir.'],
  };
}

function acceptedClassification(item: ReviewQueueDoc, raw: RawAnnouncement): ClassificationResult {
  const stored = item.payload.classification as ClassificationResult | undefined;
  // Tekilleştirme incelemesine yalnız sınıflandırması KABUL olan kayıt düşer.
  if (stored && typeof stored === 'object' && stored.decision === 'accept') return stored;
  const fresh = classify({
    title: raw.title,
    body: raw.bodyText ?? '',
    sourceCategory: raw.sourceCategory ?? null,
    sourceKey: raw.sourceKey,
  });
  return {
    ...fresh,
    decision: 'accept',
    kind: fresh.kind ?? 'job',
    reasons: [...fresh.reasons, 'Yönetici kararıyla ilan olarak işlendi'],
  };
}

export async function applyDedupeReviewDecision(
  repos: Repos,
  item: ReviewQueueDoc,
  decision: { action: 'keep-separate' } | { action: 'merge'; targetJobId: string },
  adminId: string,
): Promise<DedupeReviewOutcome> {
  if (item.kind !== 'dedupe' || isWithdrawalReview(item)) return { jobId: null, action: 'closed-only' };
  const raw = isRawSnapshot(item.payload.raw) ? item.payload.raw : rawFromLegacyPayload(item);
  if (!raw) throw new Error('İnceleme kaydında kaynak kimliği yok; ilan oluşturulamadı.');

  const override: DedupeOverride =
    decision.action === 'merge' ? { action: 'merge', jobId: decision.targetJobId } : { action: 'create' };
  const outcome = await applyRawAnnouncement(
    raw,
    { repos, now: repos.clock.now(), workerId: `admin:${adminId}`, provenance: 'scraped' },
    { classificationOverride: acceptedClassification(item, raw), dedupeOverride: override },
  );
  if (!outcome.jobId) throw new Error(`İnceleme kararı uygulanamadı (${outcome.action}).`);
  return { jobId: outcome.jobId, action: outcome.action === 'created' ? 'created' : 'merged' };
}
