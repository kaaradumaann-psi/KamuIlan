/**
 * Kaynak sayfası testleri (kullanıcı tarafı).
 *
 * Sayfa sade bir listedir: kaynak adı, ne tür ilanlar, durum rozeti
 * ("Taranıyor" / "Elle takip" / "Şimdilik kapalı") ve son güncelleme.
 * Teknik ayrıntılar (doğrulama sayıları, tarama süreleri) yalnız yönetim
 * panelindedir; kullanım şartı onayı bekleyen kaynak hata gibi gösterilmez.
 */
import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './support/api';

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

type ApiSource = {
  name: string;
  status: string;
  enabled: boolean;
  termsGated?: boolean;
  health: { lastSuccessAt: string | null };
};

function expectedLabel(source: ApiSource): string {
  if (source.status === 'needs-manual-method') return 'Elle takip';
  if (!source.enabled || source.termsGated || source.status === 'disabled') return 'Şimdilik kapalı';
  return 'Taranıyor';
}

test('her API kaynağı listede tek satır ve doğru durum rozetiyle görünür', async ({ page, request }) => {
  const response = await request.get('/api/sources');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { sources: ApiSource[] };

  await page.goto('/kaynaklar');
  const list = page.getByRole('list', { name: 'Kaynak listesi' });
  await expect(list).toBeVisible();
  await expect(list.locator('.source-item')).toHaveCount(body.sources.length);

  for (const label of ['Taranıyor', 'Elle takip', 'Şimdilik kapalı']) {
    const expected = body.sources.filter((source) => expectedLabel(source) === label).length;
    await expect(list.locator('.tag', { hasText: label })).toHaveCount(expected);
  }
});

test('kaynak sayfasında teknik ayrıntı ve hata dili yoktur', async ({ page }) => {
  await page.goto('/kaynaklar');
  await expect(page.getByRole('list', { name: 'Kaynak listesi' })).toBeVisible();
  await expect(
    page.getByText(/ortalama süre|Sayfa kapsamı|denemenin|uyarlayıcı|adaptör|worker|ulaşılamadı/i),
  ).toHaveCount(0);
  await expect(page.getByText('Durumlar ne demek?')).toHaveCount(0);
});
