/**
 * Duman testleri: temel sayfalar gerçekten açılıyor mu, konsol hatası var mı,
 * korumalı alanlar oturumsuz kullanıcıya ne gösteriyor?
 *
 * Veritabanı boş olabilir: boş durumda da bu testler geçmelidir. Site GİRİŞ
 * KAPILIDIR: uygulama sayfaları önce yönetici girişiyle açılır; oturumsuz
 * istekler giriş ekranına düşer. Dışarıdan kayıt YOKTUR, hiçbir test
 * "kayıt ol" akışını aramaz (yardımcı: loginAsAdmin, seed:admin hesabı).
 */
import { expect, test } from '@playwright/test';
import { collectPageErrors, expectHeading, loginAsAdmin } from './support/api';

test.describe('temel sayfalar', () => {
  test('ana sayfa açılır, sistem durumunu ve dürüst kapsam notunu gösterir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await page.goto('/');

    await expectHeading(page, 'Kamu personel alım ilanları');
    // Veri olmasa bile durum şeridi görünür olmalı (dürüst boş durum).
    await expect(page.getByText(/İlanlar en son|Henüz başarılı tarama kaydı yok/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'İlanlarda ara', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bu site nasıl çalışıyor?', exact: true })).toBeVisible();
    await expect(page.getByText(/Her ilanı bulamayabiliriz/).first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('ana sayfa araması ilan listesine sorgu parametreleriyle taşınır', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await page.goto('/');

    await page.getByLabel('Arama terimi', { exact: true }).fill('hemşire');
    await page.getByLabel('İl', { exact: true }).fill('Ankara');
    await page.getByRole('button', { name: 'İlanlarda ara', exact: true }).click();

    await expect(page).toHaveURL(/\/ilanlar\?/);
    await expect(page).toHaveURL(/q=hem%C5%9Fire|q=hemşire/);
    await expect(page).toHaveURL(/city=Ankara/);

    expect(errors).toEqual([]);
  });

  test('ilan listesi filtreleri URL üzerinden paylaşılabilir', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await page.goto('/ilanlar');
    await expectHeading(page, 'Kamu personel alım ilanları');

    const form = page.getByRole('form', { name: 'İlan filtreleri', exact: true });
    await expect(form).toBeVisible();
    await page.getByLabel('İl', { exact: true }).fill('Ankara');
    await form.getByRole('button', { name: 'Ara', exact: true }).click();

    // Filtre URL'de kalıcı olmalı: bağlantı kopyalanınca aynı sonuç açılır.
    await expect(page).toHaveURL(/city=Ankara/);
    await page.reload();
    // Filtre etkinken panel kapalı başlar; bağlantı korunmuş olmalı.
    await expect(page).toHaveURL(/city=Ankara/);
    // Etkin filtre sayısı düğmenin adına eklenir ("Filtreler 1"); regex ile karşılanır.
    await page.getByRole('button', { name: /^Filtreler( \d+)?$/ }).click();
    await expect(page.getByLabel('İl', { exact: true })).toHaveValue('Ankara');

    expect(errors).toEqual([]);
  });

  test('dar ekranda sayfa geçişi en üstten açılır; başlık yapışkan üst çubuğun altında kalmaz', async ({
    page,
  }) => {
    // Gerçek veriyle görüldü (390 px): rota odağı <main>'e kaydırıyordu (scrollY=247),
    // durum şeridi atlanıyor ve sayfa başlığı üst çubuğun altında kesiliyordu.
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsAdmin(page);
    await page.goto('/ilanlar');
    await expectHeading(page, 'Kamu personel alım ilanları');

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const header = await page.locator('.app-header').boundingBox();
    const title = await page.getByRole('heading', { level: 1 }).boundingBox();
    expect(header && title && title.y >= header.y + header.height).toBe(true);
    // Odak yine ana içerikte (ekran okuyucu bağlamı korunur).
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');

    expect(errors).toEqual([]);
  });

  test('dar ekranda ana sayfa araması kullanılabilir; durum kartı aramanın üstüne binmez', async ({ page }) => {
    // Gerçek veriyle görüldü (390 px): proje katmanındaki hero ızgarası ortak katmanın
    // tek sütun kuralını eziyordu ("0px 290px"); arama alanı kartın altında kalıyordu.
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsAdmin(page);
    await page.goto('/');
    await expectHeading(page, 'Kamu personel alım ilanları');

    const search = await page.getByLabel('Arama terimi', { exact: true }).boundingBox();
    const card = await page.locator('.desk-now').boundingBox();
    expect(search && search.width > 200).toBe(true);
    // Kart aramanın altında başlar (üst üste binme yok).
    expect(search && card && card.y >= search.y + search.height).toBe(true);
    await page.getByLabel('Arama terimi', { exact: true }).fill('hemşire');
    await page.getByRole('button', { name: 'İlanlarda ara', exact: true }).click();
    await expect(page).toHaveURL(/q=hem%C5%9Fire|q=hemşire/);

    expect(errors).toEqual([]);
  });

  test('kaynaklar sayfası kapsamı ve doğrulama durumunu açıkça yazar', async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAsAdmin(page);
    await page.goto('/kaynaklar');

    await expectHeading(page, 'İlanları nereden alıyoruz?');
    await expect(page.getByRole('table', { name: /Kaynak listesi ve son tarama durumu/ })).toBeVisible();
    // Kapsamın eksik olduğu açıkça yazılır (abartılı iddia yok).
    await expect(page.getByText(/Her ilanı bulamayabiliriz/).first()).toBeVisible();
    // "Gerçek veriyle doğrulanan" ile "hazırlanan" ayrımı korunur.
    await expect(page.getByText('Gerçek veriyle doğrulanan').first()).toBeVisible();
    await expect(page.getByText('Hazırlanan').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('oturumsuz kullanıcı her sayfada giriş ekranına düşer, kayıt bağlantısı sunulmaz', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.goto('/panel');

    await expect(page).toHaveURL(/\/giris/);
    await expectHeading(page, 'Giriş yap');
    await expect(page.getByText('Halka açık kayıt yoktur')).toBeVisible();
    await expect(page.getByText(/Hesabınız yönetici tarafından açılır/)).toBeVisible();
    await expect(page.getByText(/kapalı bir sistemdir/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('yönetim bölümü oturumsuz açılamaz (giriş kapısı + RBAC)', async ({ page }) => {
    await page.goto('/yonetim');
    await expect(page).toHaveURL(/\/giris/);
    await expectHeading(page, 'Giriş yap');
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
    await loginAsAdmin(page);
    await page.goto('/boyle-bir-sayfa-yok');
    await expect(page.getByText('Sayfa bulunamadı')).toBeVisible();
  });

  test('API sağlık ucu ve arayüz aynı adres üzerinden erişilebilir', async ({ page, request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    const body = (await health.json()) as { status: string; database: { healthy: boolean } };
    expect(body.database.healthy).toBe(true);
    expect(['ok', 'degraded']).toContain(body.status);

    await loginAsAdmin(page);
    await page.goto('/');
    // Arayüz de aynı proxy üzerinden veri çekebiliyor (konsol hatası yok).
    await expect(page.getByText(/İlanlar en son|Henüz başarılı tarama kaydı yok/).first()).toBeVisible();
  });
});
