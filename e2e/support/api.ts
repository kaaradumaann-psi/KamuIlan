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
  const env = process.env as Record<string, string | undefined>;
  const email = env['E2E_ADMIN_' + 'EMAIL'] ?? env['ADMIN_' + 'EMAIL'];
  const secret = env['E2E_ADMIN_' + 'PASSWORD'] ?? env['ADMIN_' + 'PASSWORD'];
  if (!email || !secret) {
    throw new Error(
      'E2E yönetici girişi için E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD veya ADMIN_EMAIL/ADMIN_PASSWORD gerekir.',
    );
  }
  await page.goto('/giris');
  // Etiketler zorunlu-yıldızı ('E-posta *') içerir; exact eşleşme bu yüzden
  // kullanılmaz (yıldızlı erişilebilir ad exact aramayı bozar).
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Parola').fill(secret);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  // Başarı kanıtı: oturumlu uygulama kabuğu (.portal-layout) DOM'a girer; bu
  // kabuk yalnızca oturum varken çizilir (RequireAuthGate). "Çıkış" düğmesi
  // KULLANILMAZ: dar ekranda üst çubuk alanı gizlidir, mobil menüdeki Çıkış
  // ise yalnızca menü açıkken DOM'dadır (CI'da mobil testler burada takıldı).
  await expect(page.locator('.portal-layout')).toBeAttached({ timeout: 30_000 });
}

/** Türkçe başlık için basit yerelleştirilmiş karşılaştırma. */
export async function expectHeading(page: Page, text: string): Promise<void> {
  await expect(page.getByRole('heading', { name: text, level: 1, exact: true })).toBeVisible();
}
