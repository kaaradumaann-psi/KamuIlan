/**
 * İlan akışı (tarayıcı): arama → liste kartı → detay (kontenjan, il, tarihler, kadro kırılımı)
 * ve reddedilen haberin hiç görünmemesi.
 *
 * Veri: `npm run seed:e2e-jobs` — gerçek ilan hattından geçen ÖRNEK kayıtlar (`sample`;
 * arayüzde "örnek veri" etiketi). Bu bir mock E2E'dir: gerçek kaynak ya da gerçek AI testi değildir.
 * CI `E2E_JOB_SEED=1` verir ve tohum zorunludur; yerelde tohum yoksa testler atlanır.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectPageErrors, loginAsAdmin } from './support/api';

const seeded = process.env.E2E_JOB_SEED === '1';

/** Arayüz tarih biçimi ("21 Eki 2026"), bugüne göre `offsetDays` gün, İstanbul saati. */
function trDay(offsetDays: number): string {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Istanbul' }).format(
    new Date(Date.now() + offsetDays * 24 * 3_600_000),
  );
}

test.describe('ilan akışı (örnek tohum)', () => {
  test.skip(!seeded, 'E2E ilan tohumu yok: E2E_JOB_SEED=1 ve `npm run seed:e2e-jobs` gerekir.');

  async function openFromSearch(page: Page, query: string, title: RegExp): Promise<void> {
    await page.goto(`/ilanlar?q=${encodeURIComponent(query)}`);
    const card = page.getByRole('link', { name: title });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(/\/ilanlar\/[^/?]+$/);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  }

  /** Tanım listesinde terimin değerini döner ("Kontenjan" → "12"). */
  async function definition(page: Page, term: string): Promise<string> {
    return (await page.locator('dt', { hasText: new RegExp(`^${term}$`) }).first().locator('xpath=following-sibling::dd[1]').innerText()).trim();
  }

  test('arama ilanı bulur; detay kontenjanı, ili ve başvuru tarihlerini kaynaktan gösterir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await openFromSearch(page, 'Zabıta', /Zabıta Memuru Alım İlanı/);

    await expect(page.getByText('örnek veri (gerçek ilan değil)')).toBeVisible();
    expect(await definition(page, 'Kontenjan')).toMatch(/^12\b/);
    expect(await definition(page, 'İl / İlçe')).toMatch(/^İzmir/);
    // Tohum: başlangıç bugün −1 gün 09:00, bitiş bugün +14 gün 23:59 (İstanbul); kanıt ilan metninden.
    const start = await definition(page, 'Başvuru başlangıcı');
    expect(start).toContain(`${trDay(-1)} 09:00`);
    expect(start).toContain('Kaynak: ilan metni');
    expect(await definition(page, 'Son başvuru')).toContain(trDay(14));
    expect(errors).toEqual([]);
  });

  test('çok pozisyonlu ilanda kadro tablosu pozisyon başına kişiyi ve toplamı gösterir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await openFromSearch(page, 'Bilişim Personeli', /Sözleşmeli Bilişim Personeli Alım İlanı/);

    const table = page.locator('table.openings-table');
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tbody tr').nth(0)).toContainText('Kıdemli Yazılım Geliştirme Uzmanı (B Grubu)');
    await expect(table.locator('tbody tr').nth(1)).toContainText('Sistem Uzmanı (D Grubu)');
    await expect(table.locator('tfoot')).toContainText('2');
    expect(await definition(page, 'Kontenjan')).toMatch(/^2\b/);
    expect(errors).toEqual([]);
  });

  test('reddedilen haber metni listede ve aramada görünmez', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await page.goto(`/ilanlar?q=${encodeURIComponent('Örnekdiyar')}`);
    await expect(page.getByText('Bu filtrelerle ilan bulunamadı')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('dar ekranda (390 px) liste ve detay yatay taşmaz', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsAdmin(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.goto(`/ilanlar?q=${encodeURIComponent('Bilişim Personeli')}`);
    await expect(page.getByRole('link', { name: /Sözleşmeli Bilişim Personeli/ })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole('link', { name: /Sözleşmeli Bilişim Personeli/ }).click();
    await expect(page.locator('table.openings-table')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});
