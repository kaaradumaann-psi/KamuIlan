/**
 * Duman testleri: temel sayfalar gerçekten açılıyor mu, konsol hatası var mı,
 * korumalı alanlar oturumsuz kullanıcıya ne gösteriyor?
 *
 * Veritabanı boş olabilir: boş durumda da bu testler geçmelidir. Testler
 * Kamuİlan'ın kuralına uyar: dışarıdan kayıt YOKTUR, bu yüzden hiçbir test
 * "kayıt ol" akışını aramaz; oturum gerektiren sayfalar giriş kartı gösterir.
 */
import { expect, test } from '@playwright/test';
import { collectPageErrors, expectHeading } from './support/api';

test.describe('temel sayfalar', () => {
  test('ana sayfa açılır, sistem durumunu ve dürüst kapsam notunu gösterir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');

    await expectHeading(page, 'Kamu personel alım ilanları — kaynaklı, tekilleştirilmiş, takvime bağlı');
    // Veri olmasa bile durum şeridi görünür olmalı (dürüst boş durum).
    await expect(page.getByText(/Son başarılı tarama|Henüz başarılı tarama kaydı yok/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'İlanlarda ara' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sistem nasıl çalışıyor?' })).toBeVisible();
    await expect(page.getByText(/Kapsam eksiktir/).first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('ana sayfa araması ilan listesine sorgu parametreleriyle taşınır', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/');

    await page.getByLabel('Arama terimi', { exact: true }).fill('hemşire');
    await page.getByLabel('İl', { exact: true }).fill('Ankara');
    await page.getByRole('button', { name: 'İlanlarda ara' }).click();

    await expect(page).toHaveURL(/\/ilanlar\?/);
    await expect(page).toHaveURL(/q=hem%C5%9Fire|q=hemşire/);
    await expect(page).toHaveURL(/city=Ankara/);

    expect(errors).toEqual([]);
  });

  test('ilan listesi filtreleri URL üzerinden paylaşılabilir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/ilanlar');
    await expectHeading(page, 'Kamu personel alım ilanları');

    const form = page.getByRole('form', { name: 'İlan filtreleri' });
    await expect(form).toBeVisible();
    await page.getByLabel('İl', { exact: true }).fill('Ankara');
    await form.getByRole('button', { name: 'Filtrele' }).click();

    // Filtre URL'de kalıcı olmalı: bağlantı kopyalanınca aynı sonuç açılır.
    await expect(page).toHaveURL(/city=Ankara/);
    await page.reload();
    // Filtre etkinken panel kapalı başlar; bağlantı korunmuş olmalı.
    await expect(page).toHaveURL(/city=Ankara/);
    await page.getByRole('button', { name: /Filtreler/ }).click();
    await expect(page.getByLabel('İl', { exact: true })).toHaveValue('Ankara');

    expect(errors).toEqual([]);
  });

  test('kaynaklar sayfası kapsamı ve doğrulama durumunu açıkça yazar', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/kaynaklar');

    await expectHeading(page, 'Kaynaklar ve kapsam');
    await expect(page.getByRole('table', { name: /Kaynak listesi ve sağlık durumu/ })).toBeVisible();
    // Kapsamın eksik olduğu açıkça yazılır (abartılı iddia yok).
    await expect(page.getByText(/Kapsam eksiktir/).first()).toBeVisible();
    // "Canlı doğrulanmış" ile "adaptörü yazılmış" ayrımı korunur.
    await expect(page.getByText('Canlı doğrulanmış').first()).toBeVisible();
    await expect(page.getByText('Adaptörü yazılmış').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('panel oturumsuz açıldığında giriş kartı gösterir, kayıt bağlantısı sunmaz', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/panel');

    await expectHeading(page, 'Giriş yap');
    await expect(page.getByText('Halka açık kayıt yoktur')).toBeVisible();
    await expect(page.getByText(/Hesabınız yönetici tarafından açılır/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('yönetim bölümü RBAC ile korunur', async ({ page }) => {
    await page.goto('/yonetim');
    await expectHeading(page, 'Giriş yap');
    await expect(page.getByText(/Yönetim paneli yalnızca yönetici hesaplarına açıktır/)).toBeVisible();
  });

  test('bilgi sayfaları (SSS, gizlilik, kullanım) oturumsuz açılır', async ({ page }) => {
    await page.goto('/sss');
    await expectHeading(page, 'Sıkça sorulan sorular');

    await page.goto('/gizlilik');
    await expectHeading(page, 'Gizlilik ve KVKK Politikası');

    await page.goto('/kullanim');
    await expectHeading(page, 'Kullanım Koşulları');
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
    await expect(page.getByText(/Son başarılı tarama/).first()).toBeVisible();
  });
});
