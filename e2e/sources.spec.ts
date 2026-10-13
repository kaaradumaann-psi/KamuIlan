/**
 * Kaynak kapsamı testleri.
 *
 * Canlı doğrulama geçmişi ile en son tarama sonucu birbirinden ayrıdır:
 * doğrulanmış bir yöntem, worker'ın şu anda çalıştığı anlamına gelmez.
 * Hazırlanan ama doğrulanmamış kaynaklar da doğrulanmış sayısına eklenemez.
 */
import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './support/api';

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test('doğrulama özeti ile en son başarılı tarama etiketleri birbirinden ayrıdır', async ({ page, request }) => {
  const response = await request.get('/api/sources');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    summary: { verified: number };
    sources: {
      name: string;
      verified: boolean;
      health: { lastSuccessAt: string | null };
      lastRun: { status: string } | null;
    }[];
  };

  await page.goto('/kaynaklar');
  const statCard = page.locator('.stat-item', { hasText: 'Gerçek veriyle doğrulanan' }).first();
  await expect(statCard).toBeVisible();
  const summaryValue = await statCard.locator('.stat-val').innerText();
  const summaryCount = Number(/(\d+)/.exec(summaryValue)?.[1] ?? 'NaN');
  expect(summaryCount).toBe(body.summary.verified);

  const successfulRuns = body.sources.filter((source) => source.lastRun?.status === 'success').length;
  const successfulRunBadges = await page.getByText('son tarama başarılı', { exact: true }).count();
  expect(successfulRunBadges).toBe(successfulRuns);

  // Hiç başarılı taraması olmayan kaynakta doğrulama geçmişi "tarandı" iddiasına dönüşmez.
  const neverSucceeded = body.sources.find((source) => source.health.lastSuccessAt === null);
  if (neverSucceeded) {
    const table = page.getByRole('table', { name: /Kaynak listesi ve son tarama durumu/ });
    const row = table.getByRole('row').filter({ hasText: neverSucceeded.name }).first();
    await expect(row.getByText('Henüz başarılı tarama yok')).toBeVisible();
  }

  await expect(page.getByText(/Her ilanı bulamayabiliriz/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Henüz başlamadığımız kurumlar/ })).toBeVisible();
});

test('her kaynak satırı planlanan aralığı ve son tarama bilgisini taşır', async ({ page }) => {
  await page.goto('/kaynaklar');

  const table = page.getByRole('table', { name: /Kaynak listesi ve son tarama durumu/ });
  await expect(table).toBeVisible();

  const rows = table.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);

  await expect(rows.first().getByText(/\d+ dakikada bir/)).toBeVisible();
  await expect(rows.first().locator('.tag').first()).toBeVisible();
});

test('API kapsam özeti ile arayüz özeti aynı kaynaktan gelir', async ({ page, request }) => {
  const response = await request.get('/api/sources');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    summary: { verified: number; built: number; total: number; enabled: number; planned: number };
    sources: { key: string; verified: boolean; built: boolean }[];
  };

  expect(body.sources.filter((source) => source.verified)).toHaveLength(body.summary.verified);
  expect(body.sources.filter((source) => source.built && !source.verified)).toHaveLength(body.summary.built);

  await page.goto('/kaynaklar');
  const statCard = page.locator('.stat-item', { hasText: 'Toplam kaynak' }).first();
  await expect(statCard).toBeVisible();
  const total = await statCard.locator('.stat-val').innerText();
  expect(Number(/(\d+)/.exec(total)?.[1] ?? 'NaN')).toBe(body.summary.total);
});
