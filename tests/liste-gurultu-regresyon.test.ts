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

function contextFor(http: HttpClient): AdapterContext {
  if (!source) throw new Error('sgk-duyurular kaynağı envanterde yok');
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-15T09:00:00.000Z'),
    maxDetailFetches: 5,
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
    expect(message).toContain('Tarayıcı yedeği sonucu: playwright chromium bulunamadı');
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
