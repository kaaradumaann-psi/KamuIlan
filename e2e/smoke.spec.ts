/**
 * Duman testleri: temel sayfalar gerçekten açılıyor mu, konsol hatası var mı,
 * korumalı alanlar yetkisiz kullanıcıya ne gösteriyor?
 *
 * Veritabanı boş olabilir: boş durumda da bu testler geçmelidir.
 */
import { expect, test } from '@playwright/test';
import { collectPageErrors, expectHeading } from './support/api';

test.describe('temel sayfalar', () => {
  test('ana sayfa açılır ve sistem durumunu gösterir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');

    await expectHeading(page, 'Kamu personel alım ilanları — tek yerde, kaynaklı');
    // Veri olmasa bile sistem durumu bölümü görünür olmalı (dürüst boş durum).
    await expect(page.getByRole('heading', { name: 'Sistem durumu' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'İlanları ara' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('ilan listesi filtreleri URL üzerinden paylaşılabilir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/ilanlar');
    await expectHeading(page, 'İlanlar');

    const form = page.getByRole('form', { name: 'İlan filtreleri' });
    await expect(form).toBeVisible();
    await page.getByLabel('İl').fill('Ankara');
    await form.getByRole('button', { name: 'Filtrele' }).click();

    // Filtre URL'de kalıcı olmalı: bağlantı kopyalanınca aynı sonuç açılır.
    await expect(page).toHaveURL(/city=Ankara/);
    await page.reload();
    await expect(page.getByLabel('İl')).toHaveValue('Ankara');

    expect(errors).toEqual([]);
  });

  test('kaynaklar sayfası kapsamı ve doğrulama durumunu açıkça yazar', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/kaynaklar');

    await expectHeading(page, 'Kaynaklar ve kapsam');
    await expect(page.getByRole('table', { name: /Kaynak listesi/ }).or(page.getByText('Kaynak listesi'))).toBeVisible();
    // Kapsamın eksik olduğu açıkça yazılır (abartılı iddia yok).
    await expect(page.getByText(/Kapsam eksiktir ve bunu saklamıyoruz/)).toBeVisible();
    await expect(page.getByText(/Canlı doğrulanmış/).first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('panel oturum yokken yetki istemez, oturum uyarısı gösterir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/panel');

    await expect(page.getByText('Oturum gerekli')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('yönetim bölümü RBAC ile korunur', async ({ page }) => {
    await page.goto('/yonetim');
    await expect(page.getByText('Yetki gerekli')).toBeVisible();
    await expect(page.getByText('Bu bölüm yalnızca yönetici hesaplarına açıktır.')).toBeVisible();
  });

  test('bilinmeyen yol 404 sayfasına düşer', async ({ page }) => {
    await page.goto('/boyle-bir-sayfa-yok');
    await expect(page.getByText('Sayfa bulunamadı')).toBeVisible();
  });

  test('API sağlık ucu ve arayüz aynı adres üzerinden erişilebilir', async ({ page, request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    const body = (await health.json()) as { status: string; database: { healthy: boolean } };
    expect(body.database.healthy).toBe(true);
    expect(['ok', 'degraded']).toContain(body.status);

    await page.goto('/');
    // Arayüz de aynı proxy üzerinden veri çekebiliyor (konsol hatası yok).
    await expect(page.getByText(/Son başarılı tarama/)).toBeVisible();
  });
});
