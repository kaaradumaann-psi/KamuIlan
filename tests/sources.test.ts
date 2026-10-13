/**
 * Kaynak adaptörleri ve envanter sözleşmesi.
 *
 * `docs/source-onboarding.md` bu dosyayı yeni kaynak ekleme akışının 3. adımı
 * olarak gösterir. Testler dış ağa ÇIKMAZ: sahte HTTP istemcisi ve fixture
 * HTML kullanılır; canlı doğrulama ayrıdır (`npm run test:live`).
 *
 * Denetlenen sözleşme:
 *  - Her adaptör kendisini (anahtar/etiket/yöntem/not) tanımlar ve kayıtlıdır.
 *  - Envanterdeki her `adapterKey` gerçekten kayıtlı bir adaptöre karşılık gelir.
 *  - Canlı erişim kapalıyken (`SOURCE_LIVE_FETCH=0`) hiçbir adaptör ağ
 *    isteği yapmaz ve ilan uydurmaz; gerekçe notu döner.
 *  - Fixture HTML ile çalışan adaptör beklenen alanları çıkarır; sayfa yapısı
 *    bozulunca (ilan satırı yok) hata değil BOŞ liste döner.
 */
import { describe, expect, it } from 'vitest';
import { PLANNED_SOURCES, SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { blockElementText, loadHtml } from '../src/lib/html';
import { createLogger } from '../src/lib/logger';
import { extractReferenceNumbers } from '../src/sources/listing-utils';
import { IlanGovTrAdapter } from '../src/sources/adapters/ilan-gov-tr';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import { getAdapter, listAdapters, requireAdapter } from '../src/sources/registry';
import type { AdapterContext, SourceAdapter } from '../src/sources/types';

/** Yanıt gövdesinden sahte `FetchResponse` üretir. */
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

/**
 * Sahte HTTP istemcisi: istekleri kaydeder, kaydedilen yanıtları döndürür.
 * Ağa çıkmaz; çağrılmayan bir adres için hata fırlatır (yanlış URL'yi yakalar).
 */
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

function contextFor(source: SourceDefinition, http: HttpClient, liveFetch: boolean): AdapterContext {
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch,
    fetchedAt: new Date('2026-10-12T09:00:00.000Z'),
    maxDetailFetches: 5,
  };
}

const ilanGovSource = SOURCE_DEFINITIONS.find((source) => source.adapterKey === 'ilan-gov-tr');

/**
 * Sayfalama yönlendiricisi: ilk sayfa fixture'ı döner, sonraki sayfalar boş
 * liste döndürerek sayfalama döngüsünü sonlandırır (gerçek sitede de böyledir).
 */
function ilanRoutes(listingHtml: string): (url: string) => string | undefined {
  return (url: string) => {
    if (url.includes('currentPage=2')) return '<html><body><ul class="ad-list"></ul></body></html>';
    if (url.includes('ilan.gov.tr/ilanlar') || url.includes('personel-alimi')) return listingHtml;
    return undefined;
  };
}

describe('adaptör kayıt defteri', () => {
  it('her adaptör kendini tanımlar ve anahtarları benzersizdir', () => {
    const adapters = listAdapters();
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      expect(adapter.key.length, `${adapter.key} anahtarı boş`).toBeGreaterThan(0);
      expect(adapter.label.length, `${adapter.key} etiketi boş`).toBeGreaterThan(0);
      expect(adapter.method.length, `${adapter.key} yöntemi boş`).toBeGreaterThan(0);
      expect(getAdapter(adapter.key)).not.toBeNull();
    }
    expect(new Set(adapters.map((adapter) => adapter.key)).size).toBe(adapters.length);
  });

  it('envanterdeki her adapterKey kayıtlıdır', () => {
    for (const source of SOURCE_DEFINITIONS) {
      expect(getAdapter(source.adapterKey), `${source.key} → ${source.adapterKey}`).not.toBeNull();
      expect(() => requireAdapter(source.adapterKey)).not.toThrow();
    }
  });

  it('kayıtlı olmayan adaptör anahtarı açık hata verir', () => {
    expect(getAdapter('bu-adaptor-yok')).toBeNull();
    expect(() => requireAdapter('bu-adaptor-yok')).toThrow(/Adaptör kayıtlı değil/);
  });

  it('envanter anahtarları benzersizdir ve planlanan kaynaklarla çakışmaz', () => {
    const keys = SOURCE_DEFINITIONS.map((source) => source.key);
    expect(new Set(keys).size).toBe(keys.length);
    const plannedKeys = new Set(PLANNED_SOURCES.map((source) => source.name));
    for (const source of SOURCE_DEFINITIONS) {
      // Planlanan kaynaklar "henüz entegre edilmedi" listesidir; aynı adla
      // envanterde de durmamalıdır (çift sayım olur).
      expect(plannedKeys.has(source.name), `${source.name} hem envanterde hem planlı`).toBe(false);
    }
  });

  it('her kaynak izinli alan adlarını ve istek aralığını bildirir', () => {
    for (const source of SOURCE_DEFINITIONS) {
      expect(source.allowedHosts.length, `${source.key} alan adı izin listesi boş`).toBeGreaterThan(0);
      expect(source.minRequestIntervalMs, `${source.key} istek aralığı`).toBeGreaterThan(0);
      expect(source.listingUrl, `${source.key} liste adresi`).toMatch(/^https:\/\//);
    }
  });
});

describe('canlı erişim kapalıyken davranış', () => {
  const adapters: SourceAdapter[] = listAdapters()
    .map((entry) => requireAdapter(entry.key))
    .filter((adapter) => adapter.key !== 'manual-entry');

  it('hiçbir adaptör ağ isteği yapmaz ve ilan üretmez', async () => {
    for (const adapter of adapters) {
      const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === adapter.key);
      if (!source) continue;
      const { http, calls } = fakeHttp(() => undefined);
      const result = await adapter.run(contextFor(source, http, false));

      expect(calls, `${adapter.key} canlı erişim kapalıyken istek yaptı`).toEqual([]);
      expect(result.items, `${adapter.key} doğrulama modunda ilan üretti`).toEqual([]);
      expect(result.requestCount).toBe(0);
      expect(result.notes.join(' ')).toMatch(/Canlı erişim kapalı|doğrulama/i);
    }
  });
});

describe('liste yardımcıları', () => {
  it('resmî ilan numarasını Türkçe "İlan No:" biçiminden de çıkarır', () => {
    // `\b` + "İ" birleşimi ASCII modda eşleşmez; kalıp `u` bayrağı taşımalıdır.
    expect(extractReferenceNumbers('İlan No: YOK-2026-482311')).toContain('YOK-2026-482311');
    expect(extractReferenceNumbers('12.10.2026\nİlan No: ILN-2026-482312')).toContain('ILN-2026-482312');
    expect(extractReferenceNumbers('YOK853479 sayılı ilan')).toContain('YOK853479');
  });

  it('blok sınırları korunarak okunan kart alanları ayrı satırlara düşer', () => {
    const $ = loadHtml(
      '<li><a href="/ilan/1"><h3>Örnek Kurum 10 Memur Alım İlanı</h3></a>' +
        '<div>Örnek Kurum\nAnkara\n12.10.2026</div></li>',
    );
    const text = blockElementText($('a[href]').closest('li'));
    const lines = text.split(/\s{2,}|\n/).map((line) => line.trim());
    expect(lines).toContain('Ankara');
    expect(lines).toContain('12.10.2026');
    expect(lines).toContain('Örnek Kurum');
  });
});

describe('ilan.gov.tr adaptörü (fixture HTML, ağ yok)', () => {
  const LISTING_URL = ilanGovSource?.listingUrl ?? 'https://ilan.gov.tr/ilanlar?ats=5';

  /** Gerçek liste yapısına uygun fixture: kart + bağlantı + kurum/il/tarih. */
  const FIXTURE = [
    '<!doctype html><html lang="tr"><body>',
    '<ul class="ad-list">',
    '  <li class="ad-list-item">',
    '    <a href="/ilan/482311">',
    '      <h3>Örnek Sağlık Bakanlığı 25 Sözleşmeli Sağlık Teknikeri Alım İlanı</h3>',
    '    </a>',
    '    <div class="ad-meta">Örnek Sağlık Bakanlığı\nAnkara\n12.10.2026\nİlan No: YOK-2026-482311</div>',
    '  </li>',
    '  <li class="ad-list-item">',
    '    <a href="/ilan/482312">',
    '      <h3>Örnek Belediyesi Zabıta Memuru ve İtfaiye Eri Alım İlanı Duyurusu</h3>',
    '    </a>',
    '    <div class="ad-meta">Örnek Belediyesi\nİzmir\n11.10.2026\nİlan No: ILN-2026-482312</div>',
    '  </li>',
    '</ul>',
    '</body></html>',
  ].join('\n');

  it('envanterde tanımlıdır ve canlı doğrulanmış kaynaktır', () => {
    expect(ilanGovSource).toBeDefined();
    expect(ilanGovSource?.status).toBe('verified');
    expect(ilanGovSource?.lastVerifiedAt).not.toBeNull();
    expect(ilanGovSource?.verificationEvidence.length ?? 0).toBeGreaterThan(20);
  });

  it('liste sayfasından ilanları, kurumu, ili ve tarihi çıkarır', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http, calls } = fakeHttp(ilanRoutes(FIXTURE));

    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(calls[0]).toBe(LISTING_URL);
    expect(result.items.length).toBe(2);

    const first = result.items[0];
    expect(first?.sourceKey).toBe(ilanGovSource.key);
    expect(first?.sourceItemId).toBe('482311');
    expect(first?.url).toBe('https://ilan.gov.tr/ilan/482311');
    expect(first?.title).toContain('Sözleşmeli Sağlık Teknikeri');
    expect(first?.city).toBe('Ankara');
    expect(first?.publishedAt).toBe('2026-10-12');
    expect(first?.institution).toContain('Bakanlığı');
    expect(first?.referenceNo).toBeTruthy();

    const second = result.items[1];
    expect(second?.city).toBe('İzmir');
    expect(second?.publishedAt).toBe('2026-10-11');
  });

  it('sayfa yapısı bozulunca hata değil boş liste döner (gürültü yapmaz)', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http } = fakeHttp(ilanRoutes('<html><body><p>Bakım çalışması</p></body></html>'));

    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(result.items).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/0 ilan satırı/);
  });

  it('daha önce görülen ilanları yinelenmez (idempotent tarama)', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http } = fakeHttp(ilanRoutes(FIXTURE));
    const base = contextFor(ilanGovSource, http, true);

    const result = await adapter.run({ ...base, knownItemIds: new Set(['482311', '482312']) });

    expect(result.items).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/Yeni ilan yok/);
  });

  it('detay sayfası erişilemezse liste bilgisiyle devam eder', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http } = fakeHttp(ilanRoutes(FIXTURE));

    // Detay isteği sahte istemcide tanımlı değil → hata fırlatır; adaptör bunu
    // yutup ilanı liste alanlarıyla kaydetmelidir.
    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(result.items.length).toBe(2);
    expect(result.items[0]?.bodyText).toBeUndefined();
    expect(result.items[0]?.attachments).toEqual([]);
  });
});

describe('genel kurum duyuru adaptörü', () => {
  const kurumSource = SOURCE_DEFINITIONS.find((source) => source.key === 'sgk-duyurular');

  it('kurum duyuru listesinden ilan çıkarır, kurum adını kaynak kaydından alır', async () => {
    expect(kurumSource).toBeDefined();
    if (!kurumSource) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const listing = `<html><body><ul>
      <li><a href="/duyuru/2026-personel-alimi-12345">SGK 100 Personel Alım İlanı yayımlandı</a> <span>10.10.2026</span></li>
      <li><a href="/duyuru/ihale-duyurusu-98765">Bilgisayar alımı ihale duyurusu metni</a> <span>09.10.2026</span></li>
    </ul></body></html>`;
    const { http } = fakeHttp((url) => (url === kurumSource.listingUrl ? listing : undefined));
    const result = await adapter.run(contextFor(kurumSource, http, true));
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.institution).toBe('Sosyal Güvenlik Kurumu');
    expect(result.items[0]?.title).toContain('Personel Alım İlanı');
    expect(result.items[0]?.publishedAt).toContain('2026-10-10');
  });

  it('sayfa yapısı uymazsa boş dönmez, yapı hatası fırlatır', async () => {
    if (!kurumSource) return;
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const { http } = fakeHttp(() => '<html><body><p>Portal yenilendi</p></body></html>');
    await expect(adapter.run(contextFor(kurumSource, http, true))).rejects.toThrow(/Liste yapısı tanınmadı/);
  });

  it('envanterdeki tüm kurum kaynakları kayıtlı adaptörü kullanır', () => {
    const kurumSources = SOURCE_DEFINITIONS.filter((source) => source.adapterKey === 'kurum-duyuru-listesi');
    expect(kurumSources.length).toBeGreaterThanOrEqual(18);
    for (const source of kurumSources) {
      expect(source.enabled, source.key).toBe(true);
      expect(source.status, source.key).toBe('method-defined');
    }
    // Planlanan listede artık yalnızca toplu gruplar kalır (üniversite/belediye gibi).
    expect(PLANNED_SOURCES.length).toBeLessThanOrEqual(4);
  });
});
