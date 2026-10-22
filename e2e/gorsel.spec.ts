/**
 * Görsel regresyon: giriş, ilan listesi, ilan detayı — masaüstü ve mobil.
 *
 * Referans görüntüler YALNIZ Linux'ta (CI) üretilir ve karşılaştırılır: yazı tipi oluşturma
 * işletim sistemine göre değişir (`*-linux.png`). Diğer platformlarda testler atlanır.
 * Tohum (`seed:e2e-jobs`) tarihleri bugüne göre üretir; tarih metinleri görüntüden önce sabitlenir.
 * Yeni/bilinçli değişen görüntü için: CI'daki `playwright-report` yapıtındaki gerçek görüntü
 * incelenir, `npm run test:e2e -- e2e/gorsel.spec.ts --update-snapshots` Linux'ta çalıştırılır.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin } from './support/api';

const seeded = process.env.E2E_JOB_SEED === '1';

const VIEWPORTS = [
  { name: 'masaustu', width: 1280, height: 800 },
  { name: 'mobil', width: 390, height: 844 },
] as const;

/**
 * Tohum tarihleri bugüne göre değişir. Maskelemek yetmez: "5 Kasım" ↔ "15 Aralık" metin genişliğini,
 * dolayısıyla satır kaydırmasını ve alttaki her şeyin konumunu değiştirir. Bu yüzden ekran
 * görüntüsünden önce sayfadaki tarih metinleri aynı uzunlukta sabit bir değerle değiştirilir.
 */
async function freezeDates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const datePattern = /\d{1,2} (?:Oca|Şub|Mar|Nis|May|Haz|Tem|Ağu|Eyl|Eki|Kas|Ara)[a-zçğıöşü]* \d{4}/g;
    const numericPattern = /\d{2}\.\d{2}\.\d{4}/g;
    const relativePattern = /\d+ (gün|saat|dakika) (kaldı|önce|sonra)/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      const frozen = text
        .replace(datePattern, '1 Ocak 2000')
        .replace(numericPattern, '01.01.2000')
        .replace(relativePattern, '9 $1 $2')
        // Tohumun koşulduğu saat ("Burada ilk görülme … 11:10") her koşuda değişir.
        .replace(/\d{2}:\d{2}/g, '12:00');
      if (frozen !== text) node.nodeValue = frozen;
    }
  });
}

async function snap(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await freezeDates(page);
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    // Tarih biçimine uymayan zaman öğeleri için ek güvence.
    mask: [page.locator('time')],
    maxDiffPixelRatio: 0.01,
  });
}

test.describe('görsel regresyon', () => {
  // E2E_VISUAL_LOCAL=1: yerelde (ör. Windows) maske/kararlılık incelemesi; o görüntüler commit edilmez.
  test.skip(process.platform !== 'linux' && process.env.E2E_VISUAL_LOCAL !== '1', 'Referans görüntüler Linux (CI) içindir.');
  test.skip(!seeded, 'E2E ilan tohumu yok: E2E_JOB_SEED=1 ve `npm run seed:e2e-jobs` gerekir.');

  for (const viewport of VIEWPORTS) {
    test.describe(viewport.name, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test('giriş sayfası', async ({ page }) => {
        await page.goto('/giris');
        await expect(page.getByRole('button', { name: 'Giriş yap', exact: true })).toBeVisible();
        await snap(page, `giris-${viewport.name}`);
      });

      test('ilan listesi (arama)', async ({ page }) => {
        await loginAsAdmin(page);
        await page.goto('/ilanlar?q=Zab%C4%B1ta');
        await expect(page.getByRole('link', { name: /Zabıta Memuru Alım İlanı/ })).toBeVisible();
        await snap(page, `ilan-listesi-${viewport.name}`);
      });

      test('ilan detayı', async ({ page }) => {
        await loginAsAdmin(page);
        await page.goto('/ilanlar?q=Bili%C5%9Fim%20Personeli');
        await page.getByRole('link', { name: /Sözleşmeli Bilişim Personeli Alım İlanı/ }).click();
        await expect(page.getByRole('heading', { level: 1, name: /Sözleşmeli Bilişim Personeli/ })).toBeVisible();
        await snap(page, `ilan-detayi-${viewport.name}`);
      });
    });
  }
});
