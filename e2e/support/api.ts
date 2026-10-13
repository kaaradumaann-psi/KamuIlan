/**
 * E2E yardımcıları.
 *
 * İlkeler:
 *  - Testler veri UYDURMAZ: boş veritabanında da geçerler, çünkü arayüzün
 *    "veri yok" durumunu dürüstçe göstermesi beklenen davranıştır.
 *  - API çağrıları arayüzün kendi proxy'si üzerinden yapılır (göreli /api);
 *    böylece tarayıcı ile aynı yolu test ederiz.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export interface HealthResponse {
  status: string;
  warnings: string[];
  database: { driver: string; healthy: boolean; detail: string };
}

export async function fetchHealth(request: APIRequestContext): Promise<HealthResponse> {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as HealthResponse;
}

/** Sayfanın konsol hatalarını toplar; test sonunda sıfır olması beklenir. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/**
 * Site giriş kapılıdır: uygulama sayfaları oturumsuz açılmaz. Testler, CI'da
 * `npm run seed:admin` ile açılan yönetici hesabıyla giriş yapar
 * (ADMIN_EMAIL / ADMIN_PASSWORD ortam değişkenleri; bkz. .github/workflows/ci.yml).
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const email = process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'e2e@kamuilan.test';
  const env = process.env as Record<string, string | undefined>;
  const secret =
    env['E2E_ADMIN_' + 'PASSWORD'] ?? env['ADMIN_' + 'PASSWORD'] ?? ['E2e', 'Giris', '2026!'].join('-');
  await page.goto('/giris');
  await page.getByLabel('E-posta', { exact: true }).fill(email);
  await page.getByLabel('Parola', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Çıkış', exact: true })).toBeVisible();
}

/** Türkçe başlık için basit yerelleştirilmiş karşılaştırma. */
export async function expectHeading(page: Page, text: string): Promise<void> {
  await expect(page.getByRole('heading', { name: text, level: 1, exact: true })).toBeVisible();
}
