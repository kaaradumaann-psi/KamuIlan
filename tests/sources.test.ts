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
import { ResmiGazeteAdapter } from '../src/sources/adapters/resmigazete';
import { FetchError } from '../src/sources/fetcher';
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
      if (source.status === 'needs-manual-method') {
        // JS uygulaması olduğu canlıda doğrulanmış kaynaklar kapalıdır ve nedeni kayıt altındadır.
        expect(source.enabled, source.key).toBe(false);
        expect(source.statusNote.length, source.key).toBeGreaterThan(40);
      } else {
        expect(source.enabled, source.key).toBe(true);
        expect(['method-defined', 'verified'], source.key).toContain(source.status);
      }
    }
    // Planlanan listede artık yalnızca toplu gruplar kalır (üniversite/belediye gibi).
    expect(PLANNED_SOURCES.length).toBeLessThanOrEqual(4);
  });
});

describe('genel kurum adaptörü — doğrulanmış sayfa biçimleri', () => {
  const adapter = () => requireAdapter('kurum-duyuru-listesi');
  const byKey = (key: string) => {
    const found = SOURCE_DEFINITIONS.find((source) => source.key === key);
    if (!found) throw new Error(`kaynak yok: ${key}`);
    return found;
  };
  async function run(key: string, html: string) {
    const source = byKey(key);
    const { http } = fakeHttp((url) => (url === source.listingUrl ? html : undefined));
    return adapter().run(contextFor(source, http, true));
  }

  it('Sağlık (YHGM) TR- kimlikli duyuruları okur', async () => {
    const result = await run(
      'saglik-bakanligi-personel',
      `<html><body><main><div><a href="/TR-120694/131-donem-devlet-hizmeti-yukumlulugu-kurasi-ilani.html">131. Dönem Devlet Hizmeti Yükümlülüğü Kurası İlanı yayımlanmıştır</a></div>
      <div><a href="/TR-120801/personel-alimi-duyurusu.html">Sözleşmeli personel alımı başvuruları başlamıştır duyurusu</a></div></main></body></html>`,
    );
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.institution).toBe('T.C. Sağlık Bakanlığı');
  });

  it('Adalet arşivindeki tek segmentli bağlantıları okur', async () => {
    const result = await run(
      'adalet-bakanligi-duyurular',
      `<html><body><main><div><a href="https://www.adalet.gov.tr/zabit-katibi-personel-alimi-sinav-ilani-yayimlandi">22/07/2026 Zabıt Kâtibi Personel Alımı Sınav İlanı yayımlandı</a></div>
      <div><a href="https://www.adalet.gov.tr/infaz-ve-koruma-memuru-alimi-basvuru-sonuclari-aciklandi">02/07/2026 İnfaz ve Koruma Memuru Alımı Sonuçları</a></div></main></body></html>`,
    );
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.publishedAt).toContain('2026-07-22');
  });

  it('KGM DuyuruDetay.aspx?Parameter= kimliğini ayrıştırır', async () => {
    const result = await run(
      'kgm-duyurular',
      `<html><body><main><ul>
      <li><a href="https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Duyurular/DuyuruDetay.aspx?Parameter=2120">Erzurum İlindeki İş Yerlerimize 1 Engelli İşçi Alınacaktır</a></li>
      <li><a href="https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Duyurular/DuyuruDetay.aspx?Parameter=2119">Ağrı İlindeki İş Yerlerimize 1 Eski Hükümlü İşçi Alınacaktır</a></li>
      </ul></main></body></html>`,
    );
    expect(result.items.length).toBe(2);
    expect(result.items.map((item) => item.sourceItemId)).toEqual(['DuyuruDetay-2120', 'DuyuruDetay-2119']);
  });

  it('TMSF basın listesi ve YÖK announcements biçimini okur', async () => {
    const tmsf = await run(
      'tmsf-duyurular',
      `<html><body><main><a href="https://www.tmsf.org.tr/tr/Basin/List/tmsf-personel-alim-ilani-2026">12.10.2026 TMSF Personel Alım İlanı 2026 yayımlandı</a></main></body></html>`,
    );
    expect(tmsf.items.length).toBe(1);
    expect(tmsf.items[0]?.publishedAt).toContain('2026-10-12');

    const yok = await run(
      'yok-duyurular',
      `<html><body><main><article><h3><a href="https://www.yok.gov.tr/tr/announcements/5-universite-icin-rektor-basvuru-ilani-HhcKv">5 Üniversite için Rektör Adaylığı Başvuru İlanı</a></h3></article></main></body></html>`,
    );
    expect(yok.items.length).toBe(1);
    expect(yok.items[0]?.institution).toBe('Yükseköğretim Kurulu');
  });
});

describe('Resmî Gazete adaptörü dayanıklılığı', () => {
  it('tek PDF indirilemezse diğer ilanlar yine de gelir, hata not düşülür', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const sectionHtml = `<html><body><table>
      <tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-1.pdf">(PDF)</a></td></tr>
      <tr><td>ÖRNEK BELEDİYESİ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-2.pdf">(PDF)</a></td></tr>
    </table></body></html>`;
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        // Dünkü nüsha boş: adaptör iki günü de dener, ikincisinde satır bulamaz.
        if (url.includes('20261011')) return htmlResponse(url, '<html><body>ÇEŞİTLİ İLÂNLAR</body></html>');
        return htmlResponse(url, sectionHtml);
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        if (url.endsWith('-4-2.pdf')) {
          throw new FetchError(url, 'UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error', null, true);
        }
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return { ...htmlResponse(url, ''), body, bytes: body.byteLength, contentType: 'application/pdf', decoded: undefined };
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.sourceItemId).toBe('resmigazete:20261012-4-1.pdf');
    expect(result.requestCount).toBe(4);
    expect(result.notes.some((note) => note.includes('PDF indirilemedi'))).toBe(true);
  });

  it('bugünün nüshası çekilemezse dünküne düşer, not düşer', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    const sectionHtml = `<html><body><table>
      <tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261011-4-1.pdf">(PDF)</a></td></tr>
    </table></body></html>`;
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url.includes('20261012')) {
          throw new FetchError(url, 'UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error', null, true);
        }
        return htmlResponse(url, sectionHtml);
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return { ...htmlResponse(url, ''), body, bytes: body.byteLength, contentType: 'application/pdf', decoded: undefined };
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.sourceItemId).toBe('resmigazete:20261011-4-1.pdf');
    expect(result.notes.some((note) => note.includes('önceki gün denenecek'))).toBe(true);
  });
});

describe('MEB RSS beslemesi', () => {
  it('beslemedeki kayıtlar detaylarıyla birlikte kayda dönüşür', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>PERSONEL GENEL MÜDÜRLÜĞÜ</title>
<item><title>Sözleşmeli Bilişim Personeli Alımı</title><link>https://personel.meb.gov.tr/www/sozlesmeli-bilisim-personeli-alimi/icerik/1773</link><pubDate>Tue, 22 Sep 2026 17:31:34 +0300</pubDate><category>2</category></item>
<item><title>Öğretmenlerin İller Arası Yer Değiştirme Duyurusu (2026-2)</title><link>https://personel.meb.gov.tr/www/ogretmenlerin-yer-degistirme-duyurusu/icerik/1774</link><pubDate>Tue, 15 Sep 2026 14:19:28 +0300</pubDate><category>1</category></item>
</channel></rss>`;
    const { http } = fakeHttp((url) => {
      if (url.includes('rss_duyurular.xml')) return rss;
      if (url.includes('/icerik/')) return `<html><body><main><p>${'Detay metni burada yer alır. '.repeat(12)}</p></main></body></html>`;
      return undefined;
    });
    const source = SOURCE_DEFINITIONS.find((entry) => entry.key === 'meb-personel-duyurular');
    const result = await requireAdapter('meb-duyuru-listesi').run(contextFor(source!, http, true));
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.sourceItemId).toBe('1773');
    expect(result.items[0]?.publishedAt).toContain('2026-09-22');
    expect(result.items[0]?.bodyText).toContain('Detay metni');
    expect(result.notes.some((note) => note.includes('RSS beslemesinde 2 kayıt'))).toBe(true);
  });
});

describe('Kariyer Kapısı tablo/detay ayrıştırması (13.10.2026 ekran görüntüsüyle doğrulandı)', () => {
  it('tablo satırlarından ilanları çıkarır: kurum, başlık, bitiş, detay adresi', async () => {
    const { parseKariyerRows } = await import('../src/sources/adapters/kariyerkapisi');
    const html = `<html><body><table>
      <thead><tr><th>Kurum/Birim</th><th>Aktif İlanlar</th><th>Bitiş Tarihi</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td><strong>HAZİNE VE MALİYE BAKANLIĞI</strong> PERSONEL GENEL MÜDÜRLÜĞÜ</td>
          <td>HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</td>
          <td>14 Ekim 2026 Çarşamba</td>
          <td><a href="https://kariyerkapisi.gov.tr/IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390">Başvur</a></td>
        </tr>
        <tr>
          <td>ATATÜRK ÜNİVERSİTESİ REKTÖRLÜĞÜ</td>
          <td>ATATÜRK ÜNİVERSİTESİ REKTÖRLÜĞÜ - SÖZLEŞMELİ PERSONEL ALIM İLANI (2026-1)</td>
          <td>16 Ekim 2026 Cuma</td>
          <td><button type="button">Başvur</button></td>
        </tr>
      </tbody></table></body></html>`;
    const rows = parseKariyerRows(html, 'https://kariyerkapisi.gov.tr/isealim');
    expect(rows.length).toBe(2);
    expect(rows[0]?.sourceItemId).toBe('9b93b57a-1ca8-408d-9b71-1d3dc14ff390');
    expect(rows[0]?.url).toContain('/IlanDetay?i=');
    expect(rows[0]?.title).toContain('MUHASEBE UZMANLIĞI');
    expect(rows[0]?.institution).toContain('MALİYE');
    expect(rows[0]?.applicationEndAt).toContain('2026-10-14');
    expect(rows[1]?.applicationEndAt).toContain('2026-10-16');
    expect(rows[1]?.sourceItemId).not.toBe(rows[0]?.sourceItemId);
  });

  it('tablo öğesi yoksa (div ızgarası) Başvur bağlantılarından satırları kurar', async () => {
    const { parseKariyerRows } = await import('../src/sources/adapters/kariyerkapisi');
    const html = `<html><body><div class="liste">
      <div class="satir">
        <div class="kurum"><div>HAZİNE VE MALİYE BAKANLIĞI <span>PERSONEL GENEL MÜDÜRLÜĞÜ</span></div></div>
        <div class="baslik">HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</div>
        <div class="tarih">14 Ekim 2026 Çarşamba</div>
        <div class="aksiyon"><a href="https://kariyerkapisi.gov.tr/IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390">Başvur</a></div>
      </div>
      <div class="satir">
        <div class="kurum">ATATÜRK ÜNİVERSİTESİ REKTÖRLÜĞÜ</div>
        <div class="baslik">ATATÜRK ÜNİVERSİTESİ REKTÖRLÜĞÜ - SÖZLEŞMELİ PERSONEL ALIM İLANI (2026-1)</div>
        <div class="tarih">16 Ekim 2026 Cuma</div>
        <div class="aksiyon"><a href="/IlanDetay?i=bbed829a-5960-4a8a-b8a3-8c84226efb36">Başvur</a></div>
      </div>
    </div></body></html>`;
    const rows = parseKariyerRows(html, 'https://kariyerkapisi.gov.tr/isealim');
    expect(rows.length).toBe(2);
    expect(rows[0]?.sourceItemId).toBe('9b93b57a-1ca8-408d-9b71-1d3dc14ff390');
    expect(rows[0]?.title).toContain('MUHASEBE UZMANLIĞI');
    expect(rows[0]?.institution).toContain('MALİYE');
    expect(rows[0]?.applicationEndAt).toContain('2026-10-14');
    expect(rows[1]?.url).toBe('https://kariyerkapisi.gov.tr/IlanDetay?i=bbed829a-5960-4a8a-b8a3-8c84226efb36');
    expect(rows[1]?.applicationEndAt).toContain('2026-10-16');
  });

  it('detay sayfasından ilan numarası/tarihler/tür çıkarır', async () => {
    const { parseKariyerDetail } = await import('../src/sources/adapters/kariyerkapisi');
    const html = `<html><body><main>
      <h1>HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</h1>
      <p>${'Hazine ve Maliye Bakanlığı taşra teşkilatında Muhasebe Uzman Yardımcısı kadrosunda bulunanlardan yeterlik sınavı yapılacaktır. '.repeat(4)}</p>
      <aside>İlan Numarası ILN00002860 İlan Türü Yeterlik Sınavı İlanları Başvuru Başlangıç 05.10.2026 Başvuru Bitiş 14.10.2026 Kalan Zaman 1 Gün 4 Saat Kaldı BAŞVUR</aside>
    </main></body></html>`;
    const detail = parseKariyerDetail(html);
    expect(detail.referenceNo).toBe('ILN00002860');
    expect(detail.applicationStartAt).toContain('2026-10-05');
    expect(detail.applicationEndAt).toContain('2026-10-14');
    expect(detail.category).toBe('Yeterlik Sınavı İlanları');
    expect(detail.bodyText).toContain('Muhasebe Uzman Yardımcısı');
  });

  it('gerçek liste düzeni (#pnlIlanlar): Başvur satırı + dış İlana Git satırları', async () => {
    const { parseKariyerRows } = await import('../src/sources/adapters/kariyerkapisi');
    const html = `<html><body><div id="pnlIlanlar">
      <div class="row">
        <div class="col-md-1"><img class="kurum_logolari_icin" src="/Uploads/kurum/hmb.png"></div>
        <div class="col-md-4"><div><b>HAZİNE VE MALİYE BAKANLIĞI</b></div><div>PERSONEL GENEL MÜDÜRLÜĞÜ</div></div>
        <div class="col-md-4">HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</div>
        <div class="col-md-1">14 Ekim 2026 Çarşamba</div>
        <div class="col-md-2"><a class="btn btn-primary" href="IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390">Başvur</a></div>
      </div>
      <div class="row">
        <div class="col-md-1"><img class="kurum_logolari_icin" src="/Uploads/kurum/msb.png"></div>
        <div class="col-md-4"><div><b>MİLLİ SAVUNMA BAKANLIĞI</b></div><div>PERSONEL TEMİN DAİRE BAŞKANLIĞI</div></div>
        <div class="col-md-4">MİLLİ SAVUNMA BAKANLIĞI - SÖZLEŞMELİ PERSONEL TEMİNİ DUYURUSU</div>
        <div class="col-md-1">21 Ekim 2026 Çarşamba</div>
        <div class="col-md-2"><a class="btn btn-warning" href="https://personeltemin.msb.gov.tr/AnaSayfa/DuyuruDetay/?id=f8818dda-1234-4a5b-8c7d-0123456789ab">İlana Git</a></div>
      </div>
      <div class="row">
        <div class="col-md-1"><img class="kurum_logolari_icin" src="/Uploads/kurum/jandarma.png"></div>
        <div class="col-md-4"><div><b>JANDARMA GENEL KOMUTANLIĞI</b></div></div>
        <div class="col-md-4">JANDARMA GENEL KOMUTANLIĞI - SÖZLEŞMELİ PERSONEL ALIM İLANI</div>
        <div class="col-md-1">28 Ekim 2026 Çarşamba</div>
        <div class="col-md-2"><a class="btn btn-warning" href="https://personeltemin.jandarma.gov.tr">İlana Git</a></div>
      </div>
    </div></body></html>`;
    const rows = parseKariyerRows(html, 'https://kariyerkapisi.gov.tr/isealim');
    expect(rows.length).toBe(3);
    expect(rows[0]?.sourceItemId).toBe('9b93b57a-1ca8-408d-9b71-1d3dc14ff390');
    expect(rows[0]?.url).toBe('https://kariyerkapisi.gov.tr/IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390');
    expect(rows[0]?.institution).toContain('MALİYE');
    expect(rows[0]?.applicationEndAt).toContain('2026-10-14');
    expect(rows[0]?.applicationUrl).toBeUndefined();
    // Dış adresli satırlar da ilandır; başvuru adresi dış bağlantının kendisidir.
    expect(rows[1]?.sourceItemId).toBe('f8818dda-1234-4a5b-8c7d-0123456789ab');
    expect(rows[1]?.applicationUrl).toContain('personeltemin.msb.gov.tr');
    expect(rows[1]?.applicationEndAt).toContain('2026-10-21');
    expect(rows[2]?.sourceItemId).toMatch(/^kk-[0-9a-f]{16}$/);
    expect(rows[2]?.applicationUrl).toBe('https://personeltemin.jandarma.gov.tr/');
    expect(rows[2]?.institution).toContain('JANDARMA');
  });

  it('kullanıcının gönderdiği birebir sayfa yapısı: tuzak bağlantılar satır sayılmaz', async () => {
    const { parseKariyerRows } = await import('../src/sources/adapters/kariyerkapisi');
    // 13.10.2026'da kullanıcının gönderdiği gerçek liste HTML'inden birebir kesit:
    // #pnlIlanlar satırları, <hr> ayraçları, bölünmüş tarih hücresi, sayfa
    // chrome'undaki eylem-olmayan bağlantılar (e-Devlet girişi, SSS, RSS).
    const html = `<html><body>
      <nav>
        <a href="https://giris.turkiye.gov.tr/OAuth2AuthorizationServer/AuthorizationController?response_type=code&amp;client_id=887456ea-c32d-446f-8b10-6167e55eaf36&amp;redirect_uri=https://kariyerkapisi.gov.tr/elogin">e-Devlet ile Giriş</a>
        <a href="sss" class="btn iframe">Sıkça Sorulan Sorular</a>
        <a href="#" id="btn_Search"><i class="fa fa-search"></i></a>
      </nav>
      <select id="ddl_Kurum"><option value="0">Kurum Seçiniz</option><option value="9">HAZİNE VE MALİYE BAKANLIĞI(2İLAN)</option></select>
      <div class="row" style="background-color: #033980;color: white;">
        <div class="col-md-1 pt-1">Kurum/Birim</div><div class="col-md-3 pt-1"></div>
        <div class="col-md-4 pt-1">Aktif İlanlar</div><div class="col-md-2 pt-1">Bitiş Tarihi</div><div class="col-md-2 pt-1"></div>
      </div>
      <div id="pnlIlanlar"><div class="row">
          <div class="col-md-1 col-xl-1 col-lg-1" style="padding: 0px;"><img class="kurum_logolari_icin" src="/UPS/38d57cca-b022-47e1-8113-768faac8f241.png" style="margin-top: 5px"></div>
          <div class="col-md-3 col-xl-3 col-lg-3"><span style="color: black; font-size:14px;">
<b>HAZİNE VE MALİYE BAKANLIĞI</b>
<span style="color: black; font-size:14px;">PERSONEL GENEL MÜDÜRLÜĞÜ</span>
</span></div>
          <div class="col-md-4 col-xl-4 col-lg-4 " style=""><span style="color: black;font-weight:600;font-size:14px;">HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><span style="color: black; font-size:14px;"><b>14 Ekim 2026</b>
<b>Çarşamba</b></span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><a href="IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390" class="btn btn-block small" style="width: 100%; background-color: #033980; color: white;">Başvur</a></div>
        </div><hr style="background-color: #ededed !important;"><div class="row">
          <div class="col-md-1 col-xl-1 col-lg-1" style="padding: 0px;"><img class="kurum_logolari_icin" src="/UPS/8115c03a-d2e6-4183-9aa1-9ca9032eaeb6.png" style="margin-top: 5px"></div>
          <div class="col-md-3 col-xl-3 col-lg-3"><span style="color: black; font-size:14px;">
<b>KAMU İHALE KURUMU</b>
<span style="color: black; font-size:14px;">EĞİTİM DAİRESİ BAŞKANLIĞI</span>
</span></div>
          <div class="col-md-4 col-xl-4 col-lg-4 " style=""><span style="color: black;font-weight:600;font-size:14px;">KAMU İHALE KURUMU - Yurtdışı Staj (2026 Yılı)</span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><span style="color: black; font-size:14px;"><b>16 Ekim 2026</b>
<b>Cuma</b></span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><a href="IlanDetay?i=72a90e54-4258-44d9-903d-295baf21f897" class="btn btn-block small" style="width: 100%; background-color: #033980; color: white;">Başvur</a></div>
        </div><hr style="background-color: #ededed !important;"><div class="row">
          <div class="col-md-1 col-xl-1 col-lg-1" style="padding: 0px;"><img class="kurum_logolari_icin" src="/UPS/f9c37947-783d-4a09-8e96-02679218eab8.png" style="margin-top: 5px"></div>
          <div class="col-md-3 col-xl-3 col-lg-3"><span style="color: black; font-size:14px;">
<b>MİLLİ SAVUNMA BAKANLIĞI</b>
<span style="color: black; font-size:14px;">PERSONEL TEMİN DAİRE BAŞKANLIĞI</span>
</span></div>
          <div class="col-md-4 col-xl-4 col-lg-4 " style=""><span style="color: black;font-weight:600;font-size:14px;">MİLLİ SAVUNMA BAKANLIĞI - 2026 YILI MİLLÎ SAVUNMA ÜNİVERSİTESİNE ÖĞRETMEN/MÜHENDİS SINIFI MUVAZZAF SUBAY ADAYI TEMİNİ</span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><span style="color: black; font-size:14px;"><b>20 Ekim 2026</b>
<b>Salı</b></span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><a href="https://personeltemin.msb.gov.tr/AnaSayfa/DuyuruDetay/?id=562e3468-9a94-4cdf-8a55-e54ea447f0af" class="btn btn-block small" style="width: 100%; background-color: #033980; color: white;">İlana Git</a></div>
        </div><hr style="background-color: #ededed !important;"><div class="row">
          <div class="col-md-1 col-xl-1 col-lg-1" style="padding: 0px;"><img class="kurum_logolari_icin" src="/UPS/11ccecda-5dda-4e54-8306-f258a32d237c.png" style="margin-top: 5px"></div>
          <div class="col-md-3 col-xl-3 col-lg-3"><span style="color: black; font-size:14px;">
<b>JANDARMA VE SAHİL GÜVENLİK AKADEMİSİ BAŞKANLIĞI</b>
<span style="color: black; font-size:14px;">PERSONEL TEMİN MERKEZİ KOMUTANLIĞI </span>
</span></div>
          <div class="col-md-4 col-xl-4 col-lg-4 " style=""><span style="color: black;font-weight:600;font-size:14px;">JANDARMA VE SAHİL GÜVENLİK AKADEMİSİ BAŞKANLIĞI - 2027 YILI J.GN.K.LIĞI MUVAZZAF SUBAY TEMİNİ</span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><span style="color: black; font-size:14px;"><b>26 Ekim 2026</b>
<b>Pazartesi</b></span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><a href="https://personeltemin.jandarma.gov.tr" class="btn btn-block small" style="width: 100%; background-color: #033980; color: white;">İlana Git</a></div>
        </div><hr style="background-color: #ededed !important;"><div class="row">
          <div class="col-md-1 col-xl-1 col-lg-1" style="padding: 0px;"><img class="kurum_logolari_icin" src="/UPS/0f1cf613-3639-4673-b85b-4ae336c3db08.png" style="margin-top: 5px"></div>
          <div class="col-md-3 col-xl-3 col-lg-3"><span style="color: black; font-size:14px;">
<b>ADALET BAKANLIĞI</b>
<span style="color: black; font-size:14px;">İCRA İŞLERİ DAİRESİ BAŞKANLIĞI</span>
</span></div>
          <div class="col-md-4 col-xl-4 col-lg-4 " style=""><span style="color: black;font-weight:600;font-size:14px;">ADALET BAKANLIĞI - 2026 Yılı Açıktan İcra Müdür ve İcra Müdür Yardımcılığı Sınav İlanı</span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><span style="color: black; font-size:14px;"><b>05 Kasım 2026</b>
<b>Perşembe</b></span></div>
          <div class="col-md-2 col-xl-2 col-lg-2"><a href="https://iidb.adalet.gov.tr/Home/SayfaDetay/2026-yili-aciktan-icra-mudur-ve-icra-mudur-yardimciligi-sinav-ilani02102026113030" class="btn btn-block small" style="width: 100%; background-color: #033980; color: white;">İlana Git</a></div>
        </div><hr style="background-color: #ededed !important;"></div>
      <div class="card-body d-none" id="kayityok"><b>Şu an aktif bir ilan bulunmamaktadır.</b></div>
      <footer>
        <a class="navbar-brand beyazrenk" href="https://kariyerkapisi.gov.tr/RSS/RssLinkiAl" target="_blank"><i class="fa fa-rss-square"></i></a>
        <a class="navbar-brand beyazrenk" href="https://twitter.com/kariyerkapisi" target="_blank"><i class="fab fa-twitter"></i></a>
      </footer>
    </body></html>`;
    const rows = parseKariyerRows(html, 'https://kariyerkapisi.gov.tr/isealim');
    // Yalnızca 5 gerçek ilan satırı; e-Devlet/SSS/RSS/arama bağlantıları satır değil.
    expect(rows.length).toBe(5);
    expect(rows[0]?.sourceItemId).toBe('9b93b57a-1ca8-408d-9b71-1d3dc14ff390');
    expect(rows[0]?.institution).toContain('MALİYE');
    expect(rows[0]?.title).toContain('MUHASEBE UZMANLIĞI');
    expect(rows[0]?.applicationEndAt).toContain('2026-10-14');
    expect(rows[1]?.title).toContain('Yurtdışı Staj');
    expect(rows[1]?.applicationEndAt).toContain('2026-10-16');
    expect(rows[2]?.sourceItemId).toBe('562e3468-9a94-4cdf-8a55-e54ea447f0af');
    expect(rows[2]?.applicationUrl).toContain('personeltemin.msb.gov.tr');
    expect(rows[2]?.applicationEndAt).toContain('2026-10-20');
    expect(rows[3]?.sourceItemId).toMatch(/^kk-[0-9a-f]{16}$/);
    expect(rows[3]?.applicationUrl).toContain('personeltemin.jandarma.gov.tr');
    expect(rows[3]?.institution).toContain('JANDARMA');
    // Adalet satırı: kimlik, dış adresteki sondaki sayıdan (URL hash değil).
    expect(rows[4]?.sourceItemId).toBe('02102026113030');
    expect(rows[4]?.applicationUrl).toContain('iidb.adalet.gov.tr');
    expect(rows[4]?.applicationEndAt).toContain('2026-11-05');
  });

  it('gerçek detay düzeni: kararlı öğe kimliklerinden numara/tarih/kontenjan/başvuru adresi', async () => {
    const { parseKariyerDetail } = await import('../src/sources/adapters/kariyerkapisi');
    const html = `<html><body>
      <span id="lbl_KurumAdi">HAZİNE VE MALİYE BAKANLIĞI</span>
      <span id="lbl_BirimAdi">PERSONEL GENEL MÜDÜRLÜĞÜ</span>
      <h1 id="lbl_IlanBaslik">HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</h1>
      <div id="lbl_anailanmetni">${'Hazine ve Maliye Bakanlığı taşra teşkilatında Muhasebe Uzman Yardımcısı kadrosunda bulunanlardan yeterlik sınavı yapılacaktır. Başvurular Kariyer Kapısı üzerinden alınacaktır. '.repeat(3)}</div>
      <div id="div_AltIlan"><div>Unvan (MUHASEBE UZMANI)</div><div>TÜRKİYE GENELİ Kontenjan (120)</div></div>
      <aside>
        <span id="lbl_ILN_NO">ILN00002860</span>
        <span id="lbl_IlanTuru">Yeterlik Sınavı İlanları</span>
        <span id="lbl_BasDate">05.10.2026</span>
        <span id="lbl_BitDate">14.10.2026</span>
        <a id="href_BasvuruLinki" href="https://www.turkiye.gov.tr/hazine-ve-maliye-kariyer-kapisi-kamu-ise-alim">BAŞVUR</a>
      </aside>
    </body></html>`;
    const detail = parseKariyerDetail(html);
    expect(detail.referenceNo).toBe('ILN00002860');
    expect(detail.applicationStartAt).toContain('2026-10-05');
    expect(detail.applicationEndAt).toContain('2026-10-14');
    expect(detail.category).toBe('Yeterlik Sınavı İlanları');
    expect(detail.applicationUrl).toBe('https://www.turkiye.gov.tr/hazine-ve-maliye-kariyer-kapisi-kamu-ise-alim');
    expect(detail.quota).toBe(120);
    expect(detail.bodyText).toContain('Muhasebe Uzman Yardımcısı');
  });
});

describe('ilan.gov.tr tarayıcı yedeği', () => {
  it('HTTP listesi kabuksa tarayıcı çıktısındaki kartları okur', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'ilan-gov-tr');
    const card = `<html><body><a href="https://www.ilan.gov.tr/ilan/2254672/kamu-akademik-personel-necmettin-erbakan-universitesi-ogretim-gorevlisi-alim-ilani"><div>NECMETTİN ERBAKAN ÜNİVERSİTESİ REKTÖRLÜĞÜ</div><div>Necmettin Erbakan Üniversitesi Öğretim Görevlisi Alım İlanı</div><div>YOK853485</div><div>KONYA</div></a></body></html>`;
    const { http } = fakeHttp((url) => {
      if (url.includes('/ilan/2254672')) {
        return `<html><body><main><p>${'Öğretim görevlisi alım ilanı detay metni burada yer alır. '.repeat(6)}</p></main></body></html>`;
      }
      return '<html><body><div id="app">Yükleniyor…</div></body></html>';
    });
    const result = await new IlanGovTrAdapter(async () => card).run(contextFor(source!, http, true));
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.sourceItemId).toBe('2254672');
    expect(result.items[0]?.title).toContain('Öğretim Görevlisi Alım İlanı');
    expect(result.notes.some((note) => note.includes('tarayıcı ile 1 ilan'))).toBe(true);
  });
});

describe('Resmî Gazete tarayıcı yedeği', () => {
  it('HTTP cevap vermezse bölüm ve PDF tarayıcı oturumundan okunur', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    const sectionHtml = `<html><body><table>
      <tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-1.pdf">(PDF)</a></td></tr>
    </table></body></html>`;
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        throw new FetchError(url, 'UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error', null, true);
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('HTTP yolu kullanılmamalı');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;
    const browser = {
      async open() {
        return {
          async fetchHtml(url: string): Promise<string> {
            return url.includes('20261012') ? sectionHtml : '<html><body>ÇEŞİTLİ İLÂNLAR</body></html>';
          },
          async fetchBytes(): Promise<Buffer> {
            return Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
          },
          async close(): Promise<void> {
            /* oturum yok */
          },
        };
      },
    };

    const result = await new ResmiGazeteAdapter(browser).run(contextFor(source!, http, true));
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.sourceItemId).toBe('resmigazete:20261012-4-1.pdf');
    expect(result.notes.some((note) => note.includes('tarayıcı ile okundu'))).toBe(true);
  });
});
