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

/** Türkçe başlık için basit yerelleştirilmiş karşılaştırma. */
export async function expectHeading(page: Page, text: string): Promise<void> {
  await expect(page.getByRole('heading', { name: text, level: 1 })).toBeVisible();
}
