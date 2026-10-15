/**
 * Tarama zaman bütçesi (deadline) yardımcıları.
 *
 * Sorun (2026-10-16 canlı koşum): Resmî Gazete taraması 60 sn'lik
 * `SCRAPE_TIMEOUT_MS` bütçesini aştığında `pipeline` yarışı kaybeden tarafı
 * reddediyor ve adaptörün o ana kadar topladığı HER ŞEY çöpe gidiyordu. Kaynak
 * "üst üste 21 hata / %0 başarı" durumunda kalıyor, bir tek yavaş PDF tüm
 * nüshayı düşürüyordu. `live-check` ise hiç sınır koymadığı için tek kaynak
 * 560 sn sürüyordu.
 *
 * Çözüm: adaptöre bütçenin SON ANI bildirilir (`AdapterContext.deadlineAt`).
 * Adaptör pahalı bir indirmeye başlamadan önce kalan süreye bakar; yetmiyorsa
 * DURUR, elindeki kayıtları ve "kalan belgeler sonraki taramaya" notunu
 * döndürür. Böylece zaman aşımı "toplam kayıp" değil "kısmi kapsam" olur ve
 * sert `withTimeout` reddi yalnızca gerçekten takılan koşumlarda tetiklenir.
 */

/** Bütçe farkındalığı olan bağlam (AdapterContext'in ilgili alt kümesi). */
export interface ScanBudgetContext {
  /** Tarama bütçesinin son anı; yoksa süre sınırı uygulanmaz. */
  deadlineAt?: Date | null;
  /** İptal sinyali (pipeline zaman aşımında da tetiklenir). */
  signal?: AbortSignal;
}

/** Bütçe tükendiğinde indirmelerin yarıda kesilmemesi için ayrılan pay. */
export const BUDGET_RESERVE_MS = 2_000;

/**
 * Kalan bütçe (ms). Süre tanımı yoksa `null` (sınırsız).
 * Negatif değer bütçenin aşıldığını gösterir.
 */
export function remainingBudgetMs(ctx: ScanBudgetContext, now: Date = new Date()): number | null {
  if (!ctx.deadlineAt) return null;
  const deadline = ctx.deadlineAt.getTime();
  if (!Number.isFinite(deadline)) return null;
  return deadline - now.getTime();
}

/** İptal edildi mi? (sinyal varsa önceliklidir) */
export function isScanCancelled(ctx: ScanBudgetContext): boolean {
  return ctx.signal?.aborted === true;
}

/**
 * `neededMs` sürecek bir iş için bütçe var mı?
 * Süre tanımı yoksa `true` (geriye dönük uyumluluk: eski davranış korunur).
 */
export function hasBudgetFor(ctx: ScanBudgetContext, neededMs: number, now: Date = new Date()): boolean {
  if (isScanCancelled(ctx)) return false;
  const remaining = remainingBudgetMs(ctx, now);
  if (remaining === null) return true;
  return remaining >= Math.max(0, neededMs);
}

/**
 * Kalan bütçeye sığan zaman aşımı: `min(istenen, kalan - pay)`.
 * Bütçe yoksa istenen değer aynen döner. Sonuç her zaman ≥ `floorMs` olur ki
 * "0 ms zaman aşımı" gibi anlamsız bir istek üretilmesin.
 */
export function budgetedTimeoutMs(
  ctx: ScanBudgetContext,
  requestedMs: number,
  floorMs = 5_000,
  now: Date = new Date(),
): number {
  const remaining = remainingBudgetMs(ctx, now);
  if (remaining === null) return requestedMs;
  return Math.max(floorMs, Math.min(requestedMs, remaining - BUDGET_RESERVE_MS));
}
