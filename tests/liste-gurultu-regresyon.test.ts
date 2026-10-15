/**
 * Kurum duyuru listesi adaptörünün 2026-10-15 canlı çıktı regresyonu.
 *
 * Canlı koşumda 12/24 kaynak erişilemezdi; "erişilebilir" görünen icisleri/goc/afad
 * ve iskur listeleri ise çerez modali ya da erişilebilirlik araç çubuğu metnini
 * "Sayfa özeti" diye raporlayıp "Liste yapısı tanınmadı" hatası verdi. Bu dosya:
 *  1) iskeletin (modal/araç çubuğu/menü) ne satır taramasına ne özete karışmadığını,
 *  2) satır üretmeyen JS kabuklarında tarayıcı yedeğinin denendiğini,
 *  3) hata mesajının artık sayım + yol dökümü verdiğini doğrular.
 * Ağ yok: sahte HTTP istemcisi ve fixture HTML kullanılır.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ fallback: false, rendered: '', failWith: null as unknown }));

vi.mock('../src/sources/browser-session', () => ({
  isSafeBrowserRequest: () => true,
  browserFallbackEnabled: () => browser.fallback,
  launchChromium: async () => {
    throw new Error('bu testte tarayıcı başlatılmamalı');
  },
  renderPageHtml: async () => '',
  describeBrowserFailure: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  withChromiumPage: async (run: (page: FakePage) => Promise<string>) => {
    if (browser.failWith) throw browser.failWith;
    return run({
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      content: async () => browser.rendered,
    });
  },
}));

import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { isCategoryIndexPath } from '../src/sources/adapters/anchor-list';
import { cleanTitle } from '../src/sources/listing-utils';
import { budgetedTimeoutMs, hasBudgetFor, remainingBudgetMs } from '../src/sources/scan-budget';
import { createLogger } from '../src/lib/logger';
import { requireAdapter } from '../src/sources/registry';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { AdapterContext } from '../src/sources/types';

type FakePage = {
  goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
  waitForTimeout: (timeout: number) => Promise<void>;
  content: () => Promise<string>;
};

const source = SOURCE_DEFINITIONS.find((item) => item.key === 'sgk-duyurular');

const CEREZ_MODALI = `<div class="modal fade show" id="cerezModal" role="dialog" aria-modal="true" style="display: block;">
  <div class="modal-content">Modal content × T.C. İÇİŞLERİ BAKANLIĞI WEB SİTESİ GİZLİLİK VE ÇEREZ POLİTİKASI
    <a href="/gizlilik-politikasi">Gizlilik Politikası</a> <button type="button">Kabul Et</button></div></div>`;

const ERISILEBILIRLIK = `<div id="erisilebilirlikAracCubugu" class="accessibility-toolbar" role="toolbar">
  Erişilebilirlik Menüsü Ekran Okuyucu Seçili Alan Okuyucu Bağlantı Vurgula Büyük Metin</div>`;

const LISTE = `<main id="content"><h1>Duyurular</h1><ul class="duyuru-liste">
  <li><a href="/duyuru/2026-sozlesmeli-personel-alimi-12345">SGK 100 Sözleşmeli Personel Alım İlanı</a> <span>12.10.2026</span></li>
  <li><a href="/duyuru/2026-surekli-isci-alimi-98765">SGK Sürekli İşçi Alımı Kura İlanı</a> <span>11.10.2026</span></li>
</ul></main>`;

const DETAY = `<html><body><main><h1>SGK 100 Sözleşmeli Personel Alım İlanı</h1>
<p>Kurumumuz taşra teşkilatına 100 sözleşmeli personel alınacaktır. Başvurular 12.10.2026-20.10.2026 tarihleri arasında e-Devlet üzerinden yapılır. KPSS puan sıralaması esas alınır.</p>
</main></body></html>`;

const JS_KABUGU = `<html><body>${CEREZ_MODALI}${ERISILEBILIRLIK}<div id="app"></div></body></html>`;

const ARAC_CUBUGU_SAYFASI = `<html><body>${ERISILEBILIRLIK}<nav class="navbar">
<a href="/kurumsal">Kurumsal</a><a href="/mevzuat">Mevzuat</a><a href="/iletisim">İletişim</a></nav><div id="app"></div></body></html>`;

/**
 * EPDK/DSİ biçimi (2026-10-16 canlı koşum): liste bağlantıları beklenen
 * kapsayıcının DIŞINDA. EPDK sayfasında 436 `/Detay` bağlantısı görünürken
 * adaptör 0 satır üretiyordu çünkü satırlar `main`/`#content` içinde değildi.
 */
const KAPSAM_DISI_LISTE = `<html><body>
<nav class="navbar"><a href="/Anasayfa">ANASAYFA</a><a href="/kurum-hakkinda">KURUMUMUZ</a></nav>
<main id="content"><h1>Duyurular</h1><p>Kurumumuz duyuruları aşağıdaki listededir.</p></main>
<div class="detay-liste">
  <div class="item"><a href="/Detay/2026-uzman-yardimcisi-giris-sinavi-ilani-12345">EPDK 10 Uzman Yardımcısı Giriş Sınavı İlanı</a><span>12.10.2026</span></div>
  <div class="item"><a href="/Detay/2026-sozlesmeli-personel-alimi-98765">EPDK 5 Sözleşmeli Personel Alımı</a><span>11.10.2026</span></div>
</div>
</body></html>`;

/** Kurum menüleri ve kategori sayfaları: hiçbiri ilan satırı olmamalı. */
const MENU_VE_DIZINLER = `<html><body><main id="content"><ul>
  <li><a href="/haberler">HABERLER &amp; DUYURULAR</a></li>
  <li><a href="/duyurular/basin-duyurulari">Basın Duyuruları</a></li>
  <li><a href="/basin-aciklamalari-yeni">Basın Açıklamaları</a></li>
  <li><a href="/sikca-sorulan-sorular">Sıkça Sorulan Sorular</a></li>
  <li><a href="/">Ana Sayfa</a></li>
  <li><a href="/duyuru/2026-sozlesmeli-personel-alimi-12345">SGK 100 Sözleşmeli Personel Alım İlanı</a><span>12.10.2026</span></li>
</ul></main></body></html>`;

const tamSayfa = `<html><body><nav class="navbar"><a href="/sss">SSS</a></nav>${CEREZ_MODALI}${ERISILEBILIRLIK}${LISTE}<footer><a href="/iletisim">İletişim</a></footer></body></html>`;

function htmlResponse(url: string, html: string): FetchResponse {
  const body = Buffer.from(html, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text: html, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

function fakeHttp(resolve: (url: string) => string | undefined): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];
  const handler = {
    async fetchText(url: string): Promise<FetchResponse> {
      calls.push(url);
      const html = resolve(url);
      if (html === undefined) throw new Error(`Beklenmeyen istek: ${url}`);
      return htmlResponse(url, html);
    },
    async fetchBinary(url: string): Promise<FetchResponse> {
      calls.push(url);
      throw new Error(`İkili istek beklenmiyordu: ${url}`);
    },
    async close(): Promise<void> {
      /* ağ yok */
    },
  };
  return { http: handler as unknown as HttpClient, calls };
}

function contextFor(http: HttpClient, overrides: Partial<AdapterContext> = {}): AdapterContext {
  if (!source) throw new Error('sgk-duyurular kaynağı envanterde yok');
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-15T09:00:00.000Z'),
    maxDetailFetches: 5,
    ...overrides,
  };
}

beforeEach(() => {
  browser.fallback = false;
  browser.rendered = '';
  browser.failWith = null;
});

describe('kurum duyuru listesi — iskelet gürültüsü', () => {
  it('çerez modali ve erişilebilirlik araç çubuğu satırları engellemez', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => {
      if (url === source.listingUrl) return tamSayfa;
      if (url.includes('/duyuru/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http));

    expect(result.items.length).toBe(2);
    expect(result.items[0]?.title).toContain('Sözleşmeli Personel Alım');
    // Modaldaki/menüdeki bağlantılar ilan satırı sayılmaz.
    expect(result.items.map((item) => item.url).join(' ')).not.toContain('gizlilik-politikasi');
    expect(result.items.map((item) => item.url).join(' ')).not.toContain('/sss');
  });

  it('yapı hatası özeti iskelet metnini değil gerçek sayfayı gösterir', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? ARAC_CUBUGU_SAYFASI : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('Liste yapısı tanınmadı');
    expect(message).not.toContain('Erişilebilirlik Menüsü');
    expect(message).not.toContain('Ekran Okuyucu');
    // Sayım + yol dökümü: operatör seçiciyi tahminle değil veriyle düzeltir.
    expect(message).toContain('Sayfa yapısı:');
    expect(message).toContain('bağlantı');
    expect(message).toContain('sık geçen yollar');
    expect(message).toMatch(/pathPattern\/listContainers/);
  });

  it('hiç bağlantı olmayan JS kabuğunda tarayıcı gereksinimi açıkça yazılır', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? '<html><body><div id="app"></div></body></html>' : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('sayfada hiç bağlantı yok');
    expect(message).toContain('SOURCE_BROWSER_FALLBACK=1');
    expect(message).not.toContain('Modal content');
  });
});

describe('kurum duyuru listesi — tarayıcı yedeği', () => {
  it('HTTP listesi satır üretmezse tarayıcı çizimi kullanılır', async () => {
    if (!source) return;
    browser.fallback = true;
    browser.rendered = `<html><body>${CEREZ_MODALI}${ERISILEBILIRLIK}${LISTE}</body></html>`;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => {
      if (url === source.listingUrl) return JS_KABUGU;
      if (url.includes('/duyuru/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http));

    expect(result.items.length).toBe(2);
    expect(result.notes.join(' | ')).toContain('sayfa tarayıcıda çizildi');
    expect(result.notes.join(' | ')).toContain('2 ilan bağlantısı bulundu');
  });

  it('tarayıcı çizimi de satır üretmezse yapı hatası korunur', async () => {
    if (!source) return;
    browser.fallback = true;
    browser.rendered = JS_KABUGU;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? JS_KABUGU : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('Liste yapısı tanınmadı');
    expect(message).not.toContain('ÇEREZ POLİTİKASI');
    expect(message).not.toContain('Erişilebilirlik Menüsü');
  });

  it('tarayıcı başlatılamazsa neden yapı hatasında da görünür', async () => {
    if (!source) return;
    browser.fallback = true;
    browser.failWith = new Error('playwright chromium bulunamadı');
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? JS_KABUGU : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    // Notlar hata fırlatılınca operatöre ulaşmadığı için gerekçe mesajda taşınır.
    expect(message).toContain('Liste yapısı tanınmadı');
    expect(message).toContain('Tarayıcı yedeği: kullanılamadı: playwright chromium bulunamadı');
  });

  it('liste zaten satır üretiyorsa tarayıcı hiç başlatılmaz', async () => {
    if (!source) return;
    browser.fallback = true;
    browser.failWith = new Error('tarayıcı çağrılmamalıydı');
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const listing = `<html><body>${LISTE}</body></html>`;
    const { http } = fakeHttp((url) => {
      if (url === source.listingUrl) return listing;
      if (url.includes('/duyuru/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http));

    expect(result.items.length).toBe(2);
    expect(result.notes.join(' | ')).not.toContain('Tarayıcı yedeği');
  });

  it('yedek kapalıyken tarayıcı hiç çağrılmaz', async () => {
    if (!source) return;
    browser.fallback = false;
    browser.rendered = `<html><body>${LISTE}</body></html>`;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? JS_KABUGU : undefined));

    await expect(adapter.run(contextFor(http))).rejects.toThrow(/Liste yapısı tanınmadı/);
  });
});

/**
 * 2026-10-16 canlı koşum bulguları: kapsam dışında kalan listeler, menü/kategori
 * bağlantılarının ilan diye toplanması, tarayıcı sonucunun hata metnine
 * yansımaması ve zaman bütçesi dolunca tüm koşumun çöpe gitmesi.
 */
describe('kurum duyuru listesi — kapsam dışı liste (EPDK/DSİ biçimi)', () => {
  it('liste beklenen kapsayıcıda yoksa belge geneline düşer ve satırları bulur', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http, calls } = fakeHttp((url) => {
      if (url === source.listingUrl) return KAPSAM_DISI_LISTE;
      if (url.includes('/Detay/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http));

    expect(result.items.map((item) => item.title).join(' | ')).toContain('Uzman Yardımcısı');
    expect(result.items.length).toBe(2);
    expect(result.notes.join(' | ')).toContain('tüm belge tarandı');
    expect(calls.some((url) => url.includes('/Detay/'))).toBe(true);
  });

  it('desen eşleşmesi yoksa yapı hatası sayımla gerekçelenir', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? ARAC_CUBUGU_SAYFASI : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('Ayrıştırma teşhisi:');
    expect(message).toContain('desen eşleşmesi kapsamda 0 / belgede 0');
  });
});

describe('kurum duyuru listesi — menü ve kategori sayfaları', () => {
  it('dizin/kategori bağlantıları ilan satırı sayılmaz', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => {
      if (url === source.listingUrl) return MENU_VE_DIZINLER;
      if (url.includes('/duyuru/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http));

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.title).toContain('Sözleşmeli Personel Alım');
    const urls = result.items.map((item) => item.url).join(' ');
    expect(urls).not.toContain('/haberler');
    expect(urls).not.toContain('basin-duyurulari');
    expect(urls).not.toContain('basin-aciklamalari-yeni');
  });

  it('isCategoryIndexPath gerçek ilan adreslerini elemez', () => {
    // Dizin/kategori: elenmeli.
    for (const path of ['/haberler', '/duyurular', '/duyurular/basin-duyurulari', '/basin-aciklamalari-yeni', '/', '/proje', '/tum-duyurular']) {
      expect(isCategoryIndexPath(path), path).toBe(true);
    }
    // Gerçek ilan adresleri: korunmalı.
    for (const path of [
      '/duyuru/2026-sozlesmeli-personel-alimi-12345',
      '/Detay/2026-uzman-yardimcisi-giris-sinavi-ilani-12345',
      '/Sayfa/Detay/745',
      '/Sayfalar/KGM/SiteTr/Duyurular/DuyuruDetay.aspx',
      '/TR-11622/duyuru',
      '/gorevde-yukselme-ve-unvan-degisikligi-sinavi-hakkinda',
      '/duyurular/satis-islemlerinde-zorunlu-deprem-sigortasi-hakkinda-duyuru',
      '/sikca-sorulan-sorular',
    ]) {
      expect(isCategoryIndexPath(path), path).toBe(false);
    }
  });
});

describe('kurum duyuru listesi — tarayıcı sonucu hata metninde', () => {
  it('çizim başarılı ama satır yoksa sonuç yapı hatasında görünür', async () => {
    if (!source) return;
    browser.fallback = true;
    browser.rendered = '<html><body><main id="content"><p>Yükleniyor…</p></main></body></html>';
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? JS_KABUGU : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('Liste yapısı tanınmadı');
    expect(message).toContain('Tarayıcı yedeği: tarayıcı çizimi de satır üretmedi');
  });

  it('yedek kapalıyken hata metni nedenini söyler', async () => {
    if (!source) return;
    browser.fallback = false;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp((url) => (url === source.listingUrl ? JS_KABUGU : undefined));

    const error = await adapter.run(contextFor(http)).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('Tarayıcı yedeği: kapalı');
  });
});

describe('kurum duyuru listesi — tarama zaman bütçesi', () => {
  it('bütçe dolduysa detay indirilmez, koşum KISMİ sonuçla döner', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http, calls } = fakeHttp((url) => {
      if (url === source.listingUrl) return tamSayfa;
      if (url.includes('/duyuru/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http, { deadlineAt: new Date(Date.now() - 1_000) }));

    // Eski davranış: sert zaman aşımı → 0 kayıt + başarısız tarama.
    expect(result.items.length).toBe(2);
    expect(calls.filter((url) => url.includes('/duyuru/')).length).toBe(0);
    expect(result.notes.join(' | ')).toContain('Tarama zaman bütçesi doldu');
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('ZAMAN bütçesi');
  });

  it('bütçe yeterliyse detaylar okunur (davranış değişmez)', async () => {
    if (!source) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http, calls } = fakeHttp((url) => {
      if (url === source.listingUrl) return tamSayfa;
      if (url.includes('/duyuru/')) return DETAY;
      return undefined;
    });

    const result = await adapter.run(contextFor(http, { deadlineAt: new Date(Date.now() + 600_000) }));

    expect(result.items.length).toBe(2);
    expect(calls.filter((url) => url.includes('/duyuru/')).length).toBe(2);
    expect(result.notes.join(' | ')).not.toContain('zaman bütçesi doldu');
  });
});

describe('tarama bütçesi yardımcıları', () => {
  it('süre tanımı yoksa davranış değişmez (sınırsız bütçe)', () => {
    expect(remainingBudgetMs({})).toBeNull();
    expect(hasBudgetFor({}, 60_000)).toBe(true);
    expect(budgetedTimeoutMs({}, 25_000)).toBe(25_000);
  });

  it('kalan bütçeye göre zaman aşımı kısaltılır ve tabana saygı gösterilir', () => {
    const ctx = { deadlineAt: new Date(Date.now() + 12_000) };
    expect(budgetedTimeoutMs(ctx, 25_000)).toBeLessThanOrEqual(12_000);
    expect(budgetedTimeoutMs({ deadlineAt: new Date(Date.now() - 5_000) }, 25_000)).toBe(5_000);
  });

  it('iptal sinyali bütçeyi her zaman kapatır', () => {
    const controller = new AbortController();
    controller.abort(new Error('dur'));
    expect(hasBudgetFor({ signal: controller.signal }, 1)).toBe(false);
  });
});

describe('başlık temizliği (panelde görünen metin)', () => {
  it('satıra yapışan kategori rozeti ve tarih başlıktan düşer', () => {
    expect(cleanTitle('Satış İşlemlerinde Zorunlu Deprem Sigortası Hakkında DuyuruDuyuru07 Eylül 2026')).toBe(
      'Satış İşlemlerinde Zorunlu Deprem Sigortası Hakkında Duyuru',
    );
    expect(cleanTitle('Tapu ve Kadastro Genel Müdürlüğü Sözleşmeli Bilişim Personel Alım İlanıDuyuru28 Eylül 2026')).toBe(
      'Tapu ve Kadastro Genel Müdürlüğü Sözleşmeli Bilişim Personel Alım İlanı',
    );
  });

  it('baştaki yapışık rozet ve kırıntı (Ana Sayfa) temizlenir', () => {
    expect(cleanTitle('GüncelTapu Arşivleri Dijital Dönüşüm (TADD) Projesi')).toBe('Tapu Arşivleri Dijital Dönüşüm (TADD) Projesi');
    expect(cleanTitle('Güncel3 Boyutlu Taşınmaz Yönetim Bilgi Sistemi')).toBe('3 Boyutlu Taşınmaz Yönetim Bilgi Sistemi');
    expect(cleanTitle('Ana Sayfa İlanlar Kamu Memur Alım İlanları')).toBe('İlanlar Kamu Memur Alım İlanları');
  });

  it('gerçek başlıklar bozulmaz', () => {
    expect(cleanTitle('2026 Yılı İçişleri Uzman Yardımcısı Giriş (Sözlü) Sınavı Asıl/Yedek Bilgisine İlişkin Duyuru')).toBe(
      '2026 Yılı İçişleri Uzman Yardımcısı Giriş (Sözlü) Sınavı Asıl/Yedek Bilgisine İlişkin Duyuru',
    );
    expect(cleanTitle('DÜZCE ÜNİVERSİTESİ REKTÖRLÜĞÜ - 2026 / 3 SÖZLEŞMELİ PERSONEL ALIM İLANI')).toBe(
      'DÜZCE ÜNİVERSİTESİ REKTÖRLÜĞÜ - 2026 / 3 SÖZLEŞMELİ PERSONEL ALIM İLANI',
    );
    expect(cleanTitle('Hemşire, Ebe ve Sağlık Teknikeri Alımı - 07.11.2026')).toBe('Hemşire, Ebe ve Sağlık Teknikeri Alımı');
  });
});
