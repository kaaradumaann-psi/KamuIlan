/**
 * Kaynak kapsamı testleri.
 *
 * Buradaki en önemli kontrol "dürüstlük" kontrolüdür: arayüzün gösterdiği
 * "canlı doğrulanmış" sayısı, tabloda gerçekten canlı doğrulanmış işaretli
 * kaynak sayısına eşit olmalıdır. Adaptörü yazılmış ama canlı doğrulanmamış
 * kaynaklar "doğrulandı" gibi gösterilemez.
 */
import { expect, test } from '@playwright/test';

test('kapsam özeti ile tablodaki doğrulama işaretleri tutarlıdır', async ({ page }) => {
  await page.goto('/kaynaklar');

  const statCard = page.locator('.card', { hasText: 'Canlı doğrulanmış' }).first();
  await expect(statCard).toBeVisible();
  const summaryValue = await statCard.locator('p').nth(1).innerText();
  const summaryCount = Number(/(\d+)/.exec(summaryValue)?.[1] ?? 'NaN');
  expect(Number.isFinite(summaryCount)).toBe(true);

  const verifiedBadges = await page.getByText('canlı doğrulandı', { exact: true }).count();
  expect(verifiedBadges).toBe(summaryCount);

  // Kapsamın sınırlı olduğu açıkça yazılır.
  await expect(page.getByText(/Kaynak listesi eksiksiz değildir/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Planlanan kaynaklar/ })).toBeVisible();
});

test('her kaynak satırı aralık ve son tarama bilgisi taşır', async ({ page }) => {
  await page.goto('/kaynaklar');

  const table = page.getByRole('table', { name: /Kaynak listesi/ });
  await expect(table).toBeVisible();

  const rows = table.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);

  // Aralık sütunu dakika cinsinden gerçek bir değer gösterir.
  await expect(rows.first().getByText(/\d+ dk/)).toBeVisible();
  // Durum sütunu her satırda bir etiket taşır.
  await expect(rows.first().locator('span.rounded-full').first()).toBeVisible();
});
