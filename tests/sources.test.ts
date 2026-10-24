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
 *  - Fixture HTML ile çalışan adaptör beklenen alanları çıkarır; satır
 *    bulunmaması sessizce tam/başarılı kapsam sayılmaz, açık hata veya
 *    `unknown` kapsamı üretir.
 */
import { describe, expect, it } from 'vitest';
import { PLANNED_SOURCES, SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { blockElementText, loadHtml } from '../src/lib/html';
import { createLogger } from '../src/lib/logger';
import { extractReferenceNumbers } from '../src/sources/listing-utils';
import { IlanGovTrAdapter } from '../src/sources/adapters/ilan-gov-tr';
import { ResmiGazeteAdapter } from '../src/sources/adapters/resmigazete';
import { OsymAdapter } from '../src/sources/adapters/osym';
import { SbbKamuIlanAdapter } from '../src/sources/adapters/sbb-kamuilan';
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
    if (url.includes('currentPage=2'))
      return '<html><body><ul class="ad-list"><li class="no-results">Sonuç bulunamadı</li></ul></body></html>';
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

describe('Kamu İlan (SBB) sayfalama kapsamı', () => {
  it('ilan ayrıntısı gibi görünen başka host bağlantılarını listeye almaz', () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'sbb-kamuilan');
    if (!source) throw new Error('SBB kaynağı envanterde yok');
    const html = `<main><a href="https://attacker.example/ilan/123456/kamu-personel-alim-ilani">Kamu kurumunda personel alımı için ilan metni</a></main>`;
    const rows = new SbbKamuIlanAdapter().parseListing(
      loadHtml(html),
      source.listingUrl,
      source.allowedHosts,
    );
    expect(rows).toEqual([]);
  });

  it('sayfa bağlantılarını takip eder ve son sayfayı doğrular', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'sbb-kamuilan');
    if (!source) throw new Error('SBB kaynağı envanterde yok');
    const row = (id: string, title: string): string => `<article><a href="/ilan/${id}">
      <div><span>ANKARA ÜNİVERSİTESİ REKTÖRLÜĞÜ</span><h3>${title}</h3><p>İl: Ankara 12.10.2026</p></div>
    </a></article>`;
    const pageOne = `<html><body><main>${row('bir', 'Ankara Üniversitesi sözleşmeli personel alım ilanı')}
      <nav class="pagination"><a rel="next" href="?page=2">Sonraki</a></nav></main></body></html>`;
    const pageTwo = `<html><body><main>${row('iki', 'Ankara Üniversitesi sağlık personeli alım ilanı')}
      <nav class="pagination"><a href="?page=2" aria-current="page">2</a>
      <a rel="next" href="?page=3" aria-disabled="true" class="disabled">Sonraki</a></nav></main></body></html>`;
    const { http, calls } = fakeHttp((url) => {
      if (url.includes('page=2')) return pageTwo;
      if (url === source.listingUrl) return pageOne;
      return undefined;
    });
    const result = await new SbbKamuIlanAdapter().run(contextFor(source, http, true));
    expect(calls.some((url) => url.includes('page=2'))).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.coverage?.status).toBe('complete');
  });
});

describe('ÖSYM liste sayfalama kapsamı', () => {
  it('sonraki bağlantıyı izler ve yalnız son sayfa işaretiyle kapsamı tam sayar', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'osym-duyuru');
    if (!source) throw new Error('ÖSYM kaynağı envanterde yok');
    const listingPage = (slug: string, title: string, date: string, page: number): string => `
      <html><body><main><article><a href="/${slug}">${title}</a><time>${date}</time></article>
      <nav class="pagination">
        <a href="?page=1">1</a>
        <a href="?page=2" class="${page === 2 ? 'active' : ''}" ${page === 2 ? 'aria-current="page"' : ''}>2</a>
        ${
          page === 1
            ? '<a rel="next" href="?page=2">Sonraki</a>'
            : '<a rel="next" href="?page=3" aria-disabled="true" class="disabled">Sonraki</a>'
        }
      </nav></main></body></html>`;
    const detail = `<html><body><main><p>${'ÖSYM duyuru metni, başvuru koşulları ve takvim bilgisi. '.repeat(5)}</p></main></body></html>`;
    const { http, calls } = fakeHttp((url) => {
      if (url.includes('personel-duyurusu-bir')) return detail;
      if (url.includes('personel-duyurusu-iki')) return detail;
      if (url.includes('page=2'))
        return listingPage(
          'personel-duyurusu-iki',
          'ÖSYM personel alım duyurusu ikinci kayıt',
          '13.10.2026',
          2,
        );
      if (url === source.listingUrl)
        return listingPage('personel-duyurusu-bir', 'ÖSYM personel alım duyurusu ilk kayıt', '12.10.2026', 1);
      return undefined;
    });
    const result = await new OsymAdapter().run(contextFor(source, http, true));
    expect(calls.some((url) => url.includes('page=2'))).toBe(true);
    expect(result.items.map((item) => item.sourceItemId)).toEqual([
      'personel-duyurusu-bir',
      'personel-duyurusu-iki',
    ]);
    expect(result.coverage?.status).toBe('complete');
    expect(result.coverage?.note).toContain('son sayfayı doğruladı');
  });

  it('başarısız detay isteğini HTTP durumuyla kaydeder ve kapsamı kısmi bildirir', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'osym-duyuru');
    if (!source) throw new Error('ÖSYM kaynağı envanterde yok');
    const listingHtml = `<html><body><main><article>
      <a href="/kamu-personel-alim-duyurusu-2026">ÖSYM kamu personel alım duyurusu</a>
      <time>12.10.2026</time>
    </article><nav class="pagination">
      <a rel="next" aria-disabled="true" class="disabled" href="?page=2">Sonraki</a>
    </nav></main></body></html>`;
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url === source.listingUrl) return htmlResponse(url, listingHtml);
        throw new FetchError(url, 'Erişim reddedildi (HTTP 403).', 403, false);
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('binary request not expected');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new OsymAdapter().run(contextFor(source, http, true));

    expect(result.items).toHaveLength(1);
    expect(result.httpStatuses).toContain(403);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('1 detay isteği başarısız oldu');
  });

  it('başka hosttaki duyuru ve sayfalama bağlantılarını izlemez', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'osym-duyuru');
    if (!source) throw new Error('ÖSYM kaynağı envanterde yok');
    const html = `<main><a href="https://attacker.example/2026-kamu-personel-alim-duyurusu">ÖSYM personel alım başvuru duyurusu</a>
      <nav class="pagination"><a rel="next" href="https://attacker.example/?page=2">Sonraki</a></nav></main>`;
    const { http, calls } = fakeHttp((url) => (url === source.listingUrl ? html : undefined));
    const result = await new OsymAdapter().run(contextFor(source, http, true));
    expect(result.items).toEqual([]);
    expect(calls).toEqual([source.listingUrl]);
    expect(result.coverage?.status).toBe('unknown');
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

  it('envanterde tanımlıdır; HTML adapter canlı doğrulanana kadar scraper-built kalır', () => {
    expect(ilanGovSource).toBeDefined();
    expect(ilanGovSource?.status).toBe('scraper-built');
    expect(ilanGovSource?.lastVerifiedAt).toBeNull();
    expect(ilanGovSource?.statusNote).toMatch(/scraper-built/);
  });

  it('liste sayfasından ilanları, kurumu, ili ve tarihi çıkarır', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const detailText = 'Başvuru koşulları ve ilan takvimi. '.repeat(5);
    const { http, calls } = fakeHttp((url) => {
      if (url === LISTING_URL) return FIXTURE;
      if (url.includes('/ilan/482311') || url.includes('/ilan/482312'))
        return `<html><body><main><p>${detailText}</p></main></body></html>`;
      return ilanRoutes(FIXTURE)(url);
    });

    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(calls[0]).toBe(LISTING_URL);
    expect(result.items.length).toBe(2);
    expect(result.coverage?.status).toBe('complete');

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

  it('boş liste kapsayıcısı tek başına son sayfanın kanıtı değildir', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http } = fakeHttp((url) => {
      if (url.includes('currentPage=2')) return '<html><body><ul class="ad-list"></ul></body></html>';
      return url === LISTING_URL ? FIXTURE : undefined;
    });

    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(result.items).toHaveLength(2);
    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('boş liste durumu doğrulanamadı');
  });

  it('ilk liste sayfası okunamayan boş şablon döndürürse kapsamı bilinmiyor bırakır', async () => {
    const adapter = new IlanGovTrAdapter(async () => '<html><body><p>Bakım çalışması</p></body></html>');
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http } = fakeHttp(ilanRoutes('<html><body><p>Bakım çalışması</p></body></html>'));

    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(result.items).toEqual([]);
    expect(result.coverage?.status).toBe('unknown');
    expect(result.notes.join(' ')).toMatch(/0 ilan satırı/);
  });

  it('sonraki liste sayfası hata verirse önceki kayıtları korur ve kapsamı kısmi bildirir', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http, calls } = fakeHttp((url) => {
      if (url === LISTING_URL) return FIXTURE;
      if (url.includes('currentPage=2')) throw new Error('geçici sayfa hatası');
      return undefined;
    });

    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(calls).toEqual([LISTING_URL, expect.stringContaining('currentPage=2')]);
    expect(result.items).toHaveLength(2);
    expect(result.requestCount).toBe(2);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('Sayfa 2 alınamadı');
  });

  it('başka hosttaki ilan benzeri bağlantıyı işleme veya ayrıntı için kullanmaz', async () => {
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const external = `<ul class="ad-list"><li><a href="https://attacker.example/ilan/123456">
      <h3>Örnek kurum için kamu personel alımı duyurusu</h3></a><div>12.10.2026</div></li></ul>`;
    const { http, calls } = fakeHttp((url) => (url === LISTING_URL ? external : undefined));
    const result = await new IlanGovTrAdapter(async () => external).run(
      contextFor(ilanGovSource, http, true),
    );
    expect(result.items).toEqual([]);
    expect(calls).toEqual([LISTING_URL]);
    expect(result.coverage?.status).toBe('unknown');
  });

  it('daha önce görülen ilanları yinelenmez (idempotent tarama)', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const { http } = fakeHttp(ilanRoutes(FIXTURE));
    const base = contextFor(ilanGovSource, http, true);

    const result = await adapter.run({
      ...base,
      knownItemIds: new Set(['482311', '482312']),
      knownItemIdsWithDetail: new Set(['482311', '482312']),
    });

    expect(result.items).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/Yeni ilan yok/);
  });

  it('detay sayfası erişilemezse liste bilgisiyle devam eder', async () => {
    const adapter = new IlanGovTrAdapter();
    if (!ilanGovSource) throw new Error('ilan.gov.tr kaynağı envanterde yok');
    const detailFixture = FIXTURE.replace(
      'href="/ilan/482311"',
      'href="/ilan/482311/IlanDetay?i=11111111-1111-4111-8111-111111111111"',
    ).replace('href="/ilan/482312"', 'href="/ilan/482312/IlanDetay?i=22222222-2222-4222-8222-222222222222"');
    const { http } = fakeHttp(ilanRoutes(detailFixture));

    // Detay isteği sahte istemcide tanımlı değil → ilan liste alanlarıyla kalır,
    // ancak başarısız ayrıntı isteği kapsam/sağlık notunda görünür olmalıdır.
    const result = await adapter.run(contextFor(ilanGovSource, http, true));

    expect(result.items.length).toBe(2);
    expect(result.items[0]?.bodyText).toBeUndefined();
    expect(result.items[0]?.attachments).toEqual([]);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('2 detay isteği başarısız oldu');
    expect(result.notes.some((note) => note.includes('Detay isteği başarısız'))).toBe(true);
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

  it('script içindeki boş-sonuç ifadesini görünür sayfa sinyali saymaz', async () => {
    if (!kurumSource) throw new Error('Kurum duyuru kaynağı envanterde yok');
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const pageWithScriptOnly =
      '<html><body><main><script>const notice = "aktif ilan yok";</script><p>Portal yenilendi</p></main></body></html>';
    const { http } = fakeHttp((url) => (url === kurumSource.listingUrl ? pageWithScriptOnly : undefined));

    await expect(adapter.run(contextFor(kurumSource, http, true))).rejects.toThrow(/Liste yapısı tanınmadı/);
  });

  it('açık boş liste mesajını hata yerine bilinmeyen kapsamla bildirir', async () => {
    if (!kurumSource) throw new Error('Kurum duyuru kaynağı envanterde yok');
    const adapter = requireAdapter('kurum-duyuru-listesi');
    const emptyPage = '<html><body><main><p>Şu an aktif ilan bulunmamaktadır.</p></main></body></html>';
    const { http } = fakeHttp((url) => (url === kurumSource.listingUrl ? emptyPage : undefined));

    const result = await adapter.run(contextFor(kurumSource, http, true));

    expect(result.items).toEqual([]);
    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('açıkça boş sonuç bildirdi');
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
        expect(['method-defined', 'verified', 'scraper-built'], source.key).toContain(source.status);
        // Doğrulanmış sayılmayan kaynak, nedenini durum notunda açıkça yazmak zorundadır.
        if (source.status !== 'verified') {
          expect(source.statusNote, source.key).toMatch(
            /başarısız|doğrulanmadı|doğrulanmamış|doğrulanmış sayılmaz/,
          );
        }
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

describe('ortak bağlantı listesi detay kapsamı', () => {
  it('farklı URL ile yinelenen ilan kimlikleri varsa kapsamı bilinmiyor olarak bırakır', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.key === 'iskur-kamu-memur-alim');
    expect(source).toBeDefined();
    const firstRow =
      '<li><a href="/ilanlar/2026/123456?tracking=first">Ankara Üniversitesi sözleşmeli personel alım ilanı</a></li>';
    const secondRow =
      '<li><a href="/ilanlar/2026/123456?tracking=second">Ankara Üniversitesi sözleşmeli personel alım ilanı</a></li>';
    const firstPage = `<html><body><main><ul>${firstRow}</ul><nav class="pagination"><a rel="next" href="?page=2">Sonraki</a></nav></main></body></html>`;
    const secondPage = `<html><body><main><ul>${secondRow}</ul><nav class="pagination"><a rel="next" aria-disabled="true" class="disabled" href="?page=3">Sonraki</a></nav></main></body></html>`;
    const { http } = fakeHttp((url) =>
      url.includes('page=2') ? secondPage : url === source?.listingUrl ? firstPage : undefined,
    );
    const { createIskurAdapter } = await import('../src/sources/adapters/anchor-list');

    const result = await createIskurAdapter().run({
      ...contextFor(source!, http, true),
      knownItemIds: new Set(['123456']),
      knownItemIdsWithDetail: new Set(['123456']),
    });

    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('önceki sayfalardaki aynı ilan kimliklerini tekrarladı');
    expect(result.items).toEqual([]);
  });

  it('başarısız detay isteğini görünür kılar ve kapsamı tam saymaz', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.key === 'iskur-kamu-memur-alim');
    expect(source).toBeDefined();
    const html = `<html><body><main><ul><li>
      <a href="/ilanlar/2026/123456">Ankara Üniversitesi sözleşmeli personel alım ilanı</a>
      <time>12.10.2026</time>
    </li></ul><nav class="pagination">
      <a rel="next" aria-disabled="true" class="disabled" href="?page=2">Sonraki</a>
    </nav></main></body></html>`;
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url === source!.listingUrl) return htmlResponse(url, html);
        throw new FetchError(url, 'Erişim reddedildi (HTTP 403).', 403, false);
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('binary request not expected');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;
    const { createIskurAdapter } = await import('../src/sources/adapters/anchor-list');

    const result = await createIskurAdapter().run(contextFor(source!, http, true));

    expect(result.items).toHaveLength(1);
    expect(result.httpStatuses).toContain(403);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('1 detay isteği başarısız oldu');
    expect(result.notes.some((note) => note.includes('Detay isteği başarısız'))).toBe(true);
  });
});

describe('Resmî Gazete adaptörü dayanıklılığı', () => {
  it('PDF olarak görünen başka-host bağlantısını indirme kuyruğuna almaz', () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    if (!source) throw new Error('Resmî Gazete kaynağı envanterde yok');
    const pageUrl = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4.htm';
    const html = `<table><tr><td>ÖRNEK ÜNİVERSİTESİ
      <a href="https://attacker.example/ilanlar/eskiilanlar/2026/10/20261012-4-1.pdf">PDF</a>
      <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-2.pdf">PDF</a>
    </td></tr></table>`;
    const rows = new ResmiGazeteAdapter().parseSectionRows(loadHtml(html), pageUrl, source.allowedHosts);
    expect(rows.map((row) => row.pdfUrl)).toEqual([
      'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-2.pdf',
    ]);
  });

  it('sayfaları izler, yinelenen ilanları tekilleştirir ve açık son-sayfa işaretini doğrular', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const sectionUrl = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4.htm';
    const pageOne = `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1>
      <div class="pagination"><a rel="next" href="?page=2">Sonraki</a></div>
      <table><tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-1.pdf">(PDF)</a></td></tr></table>
    </body></html>`;
    const pageTwo = `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1>
      <div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=3">Sonraki</a></div>
      <table>
        <tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-1.pdf">(PDF)</a></td></tr>
        <tr><td>ÖRNEK BELEDİYESİ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-2.pdf">(PDF)</a></td></tr>
      </table>
    </body></html>`;
    const emptyFinalPage = `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1>
      <div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div>
    </body></html>`;
    const textCalls: string[] = [];
    const binaryCalls: string[] = [];
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        textCalls.push(url);
        if (url === sectionUrl) return htmlResponse(url, pageOne);
        if (new URL(url).searchParams.get('page') === '2' && url.includes('20261012-4.htm'))
          return htmlResponse(url, pageTwo);
        if (url.includes('20261011-4.htm')) return htmlResponse(url, emptyFinalPage);
        throw new Error(`Beklenmeyen sayfa isteği: ${url}`);
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        binaryCalls.push(url);
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return {
          ...htmlResponse(url, ''),
          body,
          bytes: body.byteLength,
          contentType: 'application/pdf',
          decoded: undefined,
        };
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(textCalls[0]).toBe(sectionUrl);
    expect(textCalls[1]).toBe(`${sectionUrl}?page=2`);
    expect(textCalls[2]).toContain('20261011-4.htm');
    expect(result.items.map((item) => item.sourceItemId)).toEqual([
      'resmigazete:20261012-4-1.pdf',
      'resmigazete:20261012-4-2.pdf',
    ]);
    expect(binaryCalls).toHaveLength(2);
    expect(result.coverage?.status).toBe('complete');
    expect(result.coverage?.note).toContain('açık son-sayfa göstergesiyle');
    expect(result.notes.some((note) => note.includes('yinelenen kayıt atlandı'))).toBe(true);
  });

  it('bölüm sayfası isteği tarama bütçesinin tamamını alamaz (askıda kalan sunucu taramayı düşürmesin)', async () => {
    // 22.10.2026 üretim provası: timeoutMs verilmediği için tek istek SCRAPE_TIMEOUT_MS (120 sn) bekliyordu.
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    const timeouts: (number | undefined)[] = [];
    const http = {
      async fetchText(url: string, options?: { timeoutMs?: number }): Promise<FetchResponse> {
        timeouts.push(options?.timeoutMs);
        return htmlResponse(url, '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1></body></html>');
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('PDF isteği beklenmiyordu');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((value) => typeof value === 'number' && value <= 20_000)).toBe(true);

    timeouts.length = 0;
    const tight = { ...contextFor(source!, http, true), deadlineAt: new Date(Date.now() + 12_000) };
    await new ResmiGazeteAdapter().run(tight);
    expect(timeouts.every((value) => typeof value === 'number' && value < 12_000)).toBe(true);
  });

  it('son sayfa işareti yoksa kapsamı bilinmiyor olarak bildirir', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        return htmlResponse(url, '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1></body></html>');
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('PDF isteği beklenmiyordu');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('tamlık bilinmiyor');
  });

  it('bir günün son sayfa işareti eksikse diğer gün doğrulansa bile birleşik kapsam bilinmiyor kalır', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url.includes('20261012-4.htm')) {
          return htmlResponse(url, '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1></body></html>');
        }
        return htmlResponse(
          url,
          '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div></body></html>',
        );
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('PDF isteği beklenmiyordu');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('tamlık bilinmiyor');
    expect(result.coverage?.note).not.toContain('tüm sayfaları');
  });

  it('sayfa üst sınırında durur ve kapsamı kısmi bildirir', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const textCalls: string[] = [];
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        textCalls.push(url);
        if (url.includes('20261011-4.htm')) {
          return htmlResponse(
            url,
            '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div></body></html>',
          );
        }
        const page = Number(new URL(url).searchParams.get('page') ?? 1);
        return htmlResponse(
          url,
          `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><div class="pagination"><a rel="next" href="?page=${page + 1}">Sonraki</a></div></body></html>`,
        );
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('PDF isteği beklenmiyordu');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    const todayPages = textCalls.filter((url) => url.includes('20261012-4.htm'));
    expect(todayPages).toHaveLength(10);
    expect(todayPages.some((url) => new URL(url).searchParams.get('page') === '11')).toBe(false);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('10 sayfalık üst sınıra ulaştı');
  });

  it('sonraki sayfa alınamazsa önceki kayıtları korur ve kapsamı kısmi bildirir', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const sectionUrl = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4.htm';
    const pageOne = `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1>
      <div class="pagination"><a rel="next" href="?page=2">Sonraki</a></div>
      <table><tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-1.pdf">(PDF)</a></td></tr></table>
    </body></html>`;
    const emptyFinalPage =
      '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div></body></html>';
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url === sectionUrl) return htmlResponse(url, pageOne);
        if (url.includes('20261011-4.htm')) return htmlResponse(url, emptyFinalPage);
        throw new FetchError(url, 'fixture: transient second-page network failure', null, true);
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return {
          ...htmlResponse(url, ''),
          body,
          bytes: body.byteLength,
          contentType: 'application/pdf',
          decoded: undefined,
        };
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;
    let browserClosed = false;
    const browser = {
      async open() {
        return {
          async fetchHtml(): Promise<string> {
            throw new Error('fixture: browser fallback failed');
          },
          async fetchBytes(): Promise<Buffer> {
            throw new Error('PDF should use the HTTP client');
          },
          async close(): Promise<void> {
            browserClosed = true;
          },
        };
      },
    };

    const result = await new ResmiGazeteAdapter(browser).run(contextFor(source!, http, true));
    expect(result.items.map((item) => item.sourceItemId)).toEqual(['resmigazete:20261012-4-1.pdf']);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('sonraki sayfa alınamadı');
    expect(result.notes.some((note) => note.includes('daha önce işlenen sayfalar korundu'))).toBe(true);
    expect(browserClosed).toBe(true);
  });

  it('kimlik bilgisi içeren sayfalama URL’sini izlemez', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const sectionUrl = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4.htm';
    const textCalls: string[] = [];
    const maliciousNext =
      'https://attacker@www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-2.htm';
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        textCalls.push(url);
        if (url.includes('20261011-4.htm')) {
          return htmlResponse(
            url,
            '<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div></body></html>',
          );
        }
        return htmlResponse(
          url,
          `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><div class="pagination"><a rel="next" href="${maliciousNext}">Sonraki</a></div></body></html>`,
        );
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('PDF isteği beklenmiyordu');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));
    expect(textCalls).toHaveLength(2);
    expect(textCalls.some((url) => url.includes('attacker@'))).toBe(false);
    expect(result.coverage?.status).toBe('partial');
    expect(result.notes.some((note) => note.includes('izin verilen Resmî Gazete bölümüyle eşleşmedi'))).toBe(
      true,
    );
    expect(result.notes.some((note) => note.includes('Bağlantı:'))).toBe(true);
    expect(textCalls[0]).toBe(sectionUrl);
  });

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
        return {
          ...htmlResponse(url, ''),
          body,
          bytes: body.byteLength,
          contentType: 'application/pdf',
          decoded: undefined,
        };
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

  it('bugünün nüshası 404 ise dünküne düşer ve bugünkü kapsamı kısmi sayar', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();
    const sectionHtml = `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1><table>
      <tr><td>ÖRNEK ÜNİVERSİTESİ REKTÖRLÜĞÜ <a href="https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261011-4-1.pdf">(PDF)</a></td></tr>
    </table></body></html>`;
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url.includes('20261012-4.htm')) throw new FetchError(url, 'HTTP 404', 404, false);
        return htmlResponse(url, sectionHtml);
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        const body = Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
        return {
          ...htmlResponse(url, ''),
          body,
          bytes: body.byteLength,
          contentType: 'application/pdf',
          decoded: undefined,
        };
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;

    const result = await new ResmiGazeteAdapter().run(contextFor(source!, http, true));

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sourceItemId).toBe('resmigazete:20261011-4-1.pdf');
    expect(result.coverage?.status).toBe('partial');
    expect(result.notes.some((note) => note.includes('önceki gün denenecek'))).toBe(true);
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
        return {
          ...htmlResponse(url, ''),
          body,
          bytes: body.byteLength,
          contentType: 'application/pdf',
          decoded: undefined,
        };
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
  it('yapısal olarak geçerli ama boş RSS beslemesini unknown kapsamla bildirir', async () => {
    const rss =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>Personel duyuruları</title></channel></rss>';
    const { http, calls } = fakeHttp((url) => (url.includes('rss_duyurular.xml') ? rss : undefined));
    const source = SOURCE_DEFINITIONS.find((entry) => entry.key === 'meb-personel-duyurular');
    if (!source) throw new Error('MEB Personel kaynağı envanterde yok');

    const result = await requireAdapter('meb-duyuru-listesi').run(contextFor(source, http, true));

    expect(calls).toHaveLength(1);
    expect(result.items).toEqual([]);
    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('geçerli RSS beslemesi');
  });

  it('beslemedeki kayıtlar detaylarıyla birlikte kayda dönüşür', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>PERSONEL GENEL MÜDÜRLÜĞÜ</title>
<item><title>Sözleşmeli Bilişim Personeli Alımı</title><link>https://personel.meb.gov.tr/www/sozlesmeli-bilisim-personeli-alimi/icerik/1773</link><pubDate>Tue, 22 Sep 2026 17:31:34 +0300</pubDate><category>2</category></item>
<item><title>Öğretmenlerin İller Arası Yer Değiştirme Duyurusu (2026-2)</title><link>https://personel.meb.gov.tr/www/ogretmenlerin-yer-degistirme-duyurusu/icerik/1774</link><pubDate>Tue, 15 Sep 2026 14:19:28 +0300</pubDate><category>1</category></item>
</channel></rss>`;
    const { http } = fakeHttp((url) => {
      if (url.includes('rss_duyurular.xml')) return rss;
      if (url.includes('/icerik/'))
        return `<html><body><main><p>${'Detay metni burada yer alır. '.repeat(12)}</p></main></body></html>`;
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

  it('RSS öğe kimliğini tekilleştirip aynı detay sayfasını iki kez çekmez', async () => {
    const rss = `<rss version="2.0"><channel>
      <item><title>Sözleşmeli Bilişim Personeli Alımı</title><link>https://personel.meb.gov.tr/www/alım/icerik/1773</link></item>
      <item><title>Aynı ilanın yinelenen RSS kopyası</title><link>https://personel.meb.gov.tr/www/alım/icerik/1773</link></item>
    </channel></rss>`;
    const { http, calls } = fakeHttp((url) => {
      if (url.includes('rss_duyurular.xml')) return rss;
      if (url.includes('/icerik/1773'))
        return `<html><body><main><p>${'Detay metni burada yer alır. '.repeat(8)}</p></main></body></html>`;
      return undefined;
    });
    const source = SOURCE_DEFINITIONS.find((entry) => entry.key === 'meb-personel-duyurular');
    const result = await requireAdapter('meb-duyuru-listesi').run(contextFor(source!, http, true));

    expect(result.items).toHaveLength(1);
    expect(calls.filter((url) => url.includes('/icerik/1773'))).toHaveLength(1);
    expect(result.notes.some((note) => note.includes('yinelenen/geçersiz bağlantı tekilleştirildi'))).toBe(
      true,
    );
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
    expect(rows[1]?.url).toBe(
      'https://kariyerkapisi.gov.tr/IlanDetay?i=bbed829a-5960-4a8a-b8a3-8c84226efb36',
    );
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
    expect(rows[0]?.url).toBe(
      'https://kariyerkapisi.gov.tr/IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390',
    );
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

  it('başka hostta görünen IlanDetay bağlantısını ilan detayı olarak kabul etmez', async () => {
    const { parseKariyerRows } = await import('../src/sources/adapters/kariyerkapisi');
    const html = `<div id="pnlIlanlar"><div class="row">
      <div>ÖRNEK KURUM</div><div>ÖRNEK KURUM İÇİN PERSONEL ALIM İLANI</div><div>21 Ekim 2026</div>
      <a href="https://attacker.example/IlanDetay?i=9b93b57a-1ca8-408d-9b71-1d3dc14ff390">Başvur</a>
    </div></div>`;
    expect(parseKariyerRows(html, 'https://kariyerkapisi.gov.tr/isealim')).toEqual([]);
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
    expect(detail.applicationUrl).toBe(
      'https://www.turkiye.gov.tr/hazine-ve-maliye-kariyer-kapisi-kamu-ise-alim',
    );
    expect(detail.quota).toBe(120);
    expect(detail.bodyText).toContain('Muhasebe Uzman Yardımcısı');
  });
});

describe('Kariyer Kapısı tarama akışı (run)', () => {
  const LIST_HTML = `<html><head><title>Kariyer Kapısı - Anasayfa</title></head><body><div id="pnlIlanlar">
    <div class="row">
      <div class="col-md-1"><img class="kurum_logolari_icin" src="/UPS/a.png"></div>
      <div class="col-md-3"><span><b>HAZİNE VE MALİYE BAKANLIĞI</b> <span>PERSONEL GENEL MÜDÜRLÜĞÜ</span></span></div>
      <div class="col-md-4"><span>HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU</span></div>
      <div class="col-md-2"><span><b>14 Ekim 2026</b> <b>Çarşamba</b></span></div>
      <div class="col-md-2"><a href="IlanDetay?i=11111111-1111-4111-8111-111111111111">Başvur</a></div>
    </div>
    <div class="row">
      <div class="col-md-1"><img class="kurum_logolari_icin" src="/UPS/b.png"></div>
      <div class="col-md-3"><span><b>ANKARA ÜNİVERSİTESİ REKTÖRLÜĞÜ</b> <span>PERSONEL DAİRE BAŞKANLIĞI</span></span></div>
      <div class="col-md-4"><span>ANKARA ÜNİVERSİTESİ REKTÖRLÜĞÜ - SÖZLEŞMELİ PERSONEL İLANI 2026</span></div>
      <div class="col-md-2"><span><b>16 Ekim 2026</b> <b>Cuma</b></span></div>
      <div class="col-md-2"><a href="IlanDetay?i=22222222-2222-4222-8222-222222222222">Başvur</a></div>
    </div>
    <div class="row">
      <div class="col-md-1"><img class="kurum_logolari_icin" src="/UPS/c.png"></div>
      <div class="col-md-3"><span><b>MİLLİ SAVUNMA BAKANLIĞI</b> <span>PERSONEL TEMİN DAİRE BAŞKANLIĞI</span></span></div>
      <div class="col-md-4"><span>MİLLİ SAVUNMA BAKANLIĞI - SÖZLEŞMELİ PERSONEL TEMİNİ DUYURUSU</span></div>
      <div class="col-md-2"><span><b>20 Ekim 2026</b> <b>Salı</b></span></div>
      <div class="col-md-2"><a href="https://personeltemin.msb.gov.tr/AnaSayfa/DuyuruDetay/?id=33333333-3333-4333-8333-333333333333">İlana Git</a></div>
    </div>
  </div></body></html>`;

  const detailHtml = (no: string): string => `<html><body>
    <span id="lbl_ILN_NO">${no}</span>
    <span id="lbl_IlanTuru">Yeterlik Sınavı İlanları</span>
    <span id="lbl_BasDate">05.10.2026</span>
    <span id="lbl_BitDate">14.10.2026</span>
    <div id="lbl_anailanmetni">${'İlan metni burada yer alır; başvuru şartları ve sınav takvimi açıklanır. '.repeat(4)}</div>
    <div id="div_AltIlan">Unvan (UZMAN) TÜRKİYE GENELİ Kontenjan (5)</div>
    <a id="href_BasvuruLinki" href="https://www.turkiye.gov.tr/ornek-kariyer-kapisi-kamu-ise-alim">BAŞVUR</a>
  </body></html>`;

  // Kaynak artık resmî RSS akışını kullanıyor (API bölge engelli). Eski HTTP/API
  // adaptörü (KariyerKapisiAdapter), API erişimi/izni gelirse diye kayıtlı kalıyor;
  // bu akış testleri onu sentetik bir kaynak tanımıyla çalıştırır.
  const kariyerSource = (): SourceDefinition =>
    ({
      key: 'kariyerkapisi-isealim',
      name: 'Kariyer Kapısı — Kamu İşe Alım (eski API yolu)',
      group: 'ulusal',
      sourceType: 'official-portal',
      institution: 'T.C. Cumhurbaşkanlığı (Kariyer Kapısı)',
      listingUrl: 'https://kariyerkapisi.gov.tr/isealim',
      homepageUrl: 'https://kariyerkapisi.gov.tr/',
      adapterKey: 'kariyer-kapisi-isealim',
      method: 'html-list',
      status: 'verified',
      statusNote: '',
      lastVerifiedAt: '2026-10-13',
      verificationEvidence: '',
      coverageNote: '',
      enabled: true,
      intervalMinutes: 60,
      minRequestIntervalMs: 1,
      maxConcurrency: 1,
      allowedHosts: ['kariyerkapisi.gov.tr', 'www.kariyerkapisi.gov.tr', 'api.kariyerkapisi.gov.tr'],
      tags: ['cekirdek'],
    }) as SourceDefinition;

  it('HTTP listesi doluysa detayları birleştirir; dış satır detay beklemez', async () => {
    const { KariyerKapisiAdapter } = await import('../src/sources/adapters/kariyerkapisi');
    const { http } = fakeHttp((url) => {
      if (url.includes('IlanDetay')) return detailHtml('ILN00000101');
      if (url.includes('/isealim')) return LIST_HTML;
      return undefined;
    });
    const result = await new KariyerKapisiAdapter().run(contextFor(kariyerSource()!, http, true));
    expect(result.items.length).toBe(3);
    expect(result.notes.some((note) => note.includes('Liste HTTP ile okundu: 3 ilan satırı'))).toBe(true);
    expect(result.items[0]?.referenceNo).toBe('ILN00000101');
    expect(result.items[0]?.applicationUrl).toBe(
      'https://www.turkiye.gov.tr/ornek-kariyer-kapisi-kamu-ise-alim',
    );
    expect(result.items[0]?.quota).toBe(5);
    expect(result.items[2]?.applicationUrl).toContain('personeltemin.msb.gov.tr');
    expect(result.items[2]?.referenceNo).toBeUndefined();
  });

  it('boş liste kapsayıcısı tek başına son sayfanın kanıtı değildir', async () => {
    const { KariyerKapisiAdapter } = await import('../src/sources/adapters/kariyerkapisi');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const firstPage = `<html><body><table>
      <tr><td>ÖRNEK BAKANLIK</td><td>ÖRNEK BAKANLIK PERSONEL ALIM İLANI</td><td>14 Ekim 2026</td><td><a href="/IlanDetay?i=${id}">Başvur</a></td></tr>
    </table><nav class="pagination"><a rel="next" href="?page=2">Sonraki</a></nav></body></html>`;
    const secondPage =
      '<html><body><div id="pnlIlanlar"></div><nav class="pagination"><a rel="next" aria-disabled="true" class="disabled" href="?page=3">Sonraki</a></nav></body></html>';
    const { http } = fakeHttp((url) =>
      url.includes('page=2') ? secondPage : url.includes('/isealim') ? firstPage : undefined,
    );
    const result = await new KariyerKapisiAdapter().run({
      ...contextFor(kariyerSource()!, http, true),
      knownItemIds: new Set([id]),
      knownItemIdsWithDetail: new Set([id]),
    });

    expect(result.coverage?.status).toBe('unknown');
    expect(result.coverage?.note).toContain('boş ilan listesi doğrulanamadı');
  });

  it('detay bütçesi önce yeni ilanlara harcanır (bilinenler arkaya)', async () => {
    const { KariyerKapisiAdapter } = await import('../src/sources/adapters/kariyerkapisi');
    const { http } = fakeHttp((url) => {
      if (url.includes('11111111-1111')) return detailHtml('ILN00000101');
      if (url.includes('22222222-2222')) return detailHtml('ILN00000102');
      if (url.includes('/isealim')) return LIST_HTML;
      return undefined;
    });
    const ctx = {
      ...contextFor(kariyerSource()!, http, true),
      knownItemIds: new Set(['11111111-1111-4111-8111-111111111111']),
      maxDetailFetches: 1,
    };
    const result = await new KariyerKapisiAdapter().run(ctx);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.sourceItemId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.items[0]?.referenceNo).toBe('ILN00000102');
    expect(result.notes.some((note) => note.includes('detay bütçesi 1'))).toBe(true);
  });

  it('HTTP listesi satırsızsa başlığı not düşüp tarayıcıdan okur', async () => {
    const { KariyerKapisiAdapter } = await import('../src/sources/adapters/kariyerkapisi');
    const { http } = fakeHttp((url) => {
      if (url.includes('/isealim')) {
        return '<html><head><title>Lütfen Bekleyiniz</title></head><body>Doğrulanıyor…</body></html>';
      }
      return undefined;
    });
    const render = async (urls: string[]): Promise<Map<string, string>> =>
      new Map(urls.map((url) => [url, url.includes('IlanDetay') ? detailHtml('ILN00000109') : LIST_HTML]));
    const result = await new KariyerKapisiAdapter(render).run(contextFor(kariyerSource()!, http, true));
    expect(result.items.length).toBe(3);
    expect(
      result.notes.some((note) =>
        note.includes('satır ayrıştırılamadı (sayfa başlığı: "Lütfen Bekleyiniz")'),
      ),
    ).toBe(true);
    expect(result.notes.some((note) => note.includes('Liste tarayıcı ile okundu: 3 ilan satırı'))).toBe(true);
    expect(result.items[0]?.referenceNo).toBe('ILN00000109');
  });

  it('HTTP sayfa başlığındaki e-posta ve telefonu tanı notunda redakte eder', async () => {
    const { KariyerKapisiAdapter } = await import('../src/sources/adapters/kariyerkapisi');
    const source = kariyerSource();
    if (!source) throw new Error('Kariyer Kapısı kaynağı envanterde yok');
    const email = 'private.notice@example.test';
    const phone = '+90 (312) 555-98-76';
    const shell = `<html><head><title>${email} ${phone}</title></head><body><div id="pnlIlanlar"></div></body></html>`;
    const { http } = fakeHttp((url) => (url === source.listingUrl ? shell : undefined));
    const render = async (urls: string[]): Promise<Map<string, string>> =>
      new Map(urls.map((url) => [url, shell]));

    const result = await new KariyerKapisiAdapter(render).run(contextFor(source, http, true));
    const titleNote = result.notes.find((note) => note.includes('sayfa başlığı')) ?? '';

    expect(titleNote).toContain('[e-posta gizlendi]');
    expect(titleNote).toContain('[telefon gizlendi]');
    expect(titleNote).not.toContain(email);
    expect(titleNote).not.toContain(phone);
  });

  it('HTTP 403 listede ve detayda Chromium fallback başlatmaz; detay kaybını kısmi bildirir', async () => {
    const { KariyerKapisiAdapter } = await import('../src/sources/adapters/kariyerkapisi');
    let browserCalls = 0;
    const render = async (urls: string[]): Promise<Map<string, string>> => {
      browserCalls += 1;
      return new Map(
        urls.map((url) => [url, url.includes('/isealim') ? LIST_HTML : detailHtml('ILN00000109')]),
      );
    };
    const listDenied = {
      async fetchText(url: string): Promise<FetchResponse> {
        throw new FetchError(url, 'HTTP 403', 403, false);
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('binary request not expected');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;
    await expect(
      new KariyerKapisiAdapter(render).run(contextFor(kariyerSource()!, listDenied, true)),
    ).rejects.toMatchObject({ status: 403 });
    expect(browserCalls).toBe(0);

    const detailDenied = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url.includes('/isealim')) return htmlResponse(url, LIST_HTML);
        throw new FetchError(url, 'HTTP 403', 403, false);
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('binary request not expected');
      },
      async close(): Promise<void> {
        /* ağ yok */
      },
    } as unknown as HttpClient;
    const result = await new KariyerKapisiAdapter(render).run(
      contextFor(kariyerSource()!, detailDenied, true),
    );
    expect(browserCalls).toBe(0);
    expect(result.httpStatuses).toContain(403);
    expect(result.coverage?.status).toBe('partial');
    expect(result.coverage?.note).toContain('detay isteği başarısız oldu');
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

  it('tarayıcı moduna düşünce kalan sayfaları da tarayıcıyla izler', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'ilan-gov-tr');
    const cardFor = (id: number, kurum: string, baslik: string, ref: string, sehir: string) =>
      `<html><body><a href="https://www.ilan.gov.tr/ilan/${id}/personel-x"><div>${kurum}</div><div>${baslik}</div><div>${ref}</div><div>${sehir}</div></a></body></html>`;
    const { http } = fakeHttp((url) => {
      if (url.includes('/ilan/2254672') || url.includes('/ilan/2254673')) {
        return `<html><body><main><p>${'Personel alım ilanı detay metni burada yer alır. '.repeat(6)}</p></main></body></html>`;
      }
      return '<html><body><div id="app">Yükleniyor…</div></body></html>';
    });
    const render = async (url: string): Promise<string> => {
      if (url.includes('currentPage=2')) {
        return cardFor(
          2254673,
          'ANKARA ÜNİVERSİTESİ REKTÖRLÜĞÜ',
          'Ankara Üniversitesi Öğretim Görevlisi Alım İlanı',
          'YOK853486',
          'ANKARA',
        );
      }
      if (url.includes('currentPage=')) return '<html><body></body></html>';
      return cardFor(
        2254672,
        'NECMETTİN ERBAKAN ÜNİVERSİTESİ REKTÖRLÜĞÜ',
        'Necmettin Erbakan Üniversitesi Öğretim Görevlisi Alım İlanı',
        'YOK853485',
        'KONYA',
      );
    };
    const result = await new IlanGovTrAdapter(render).run(contextFor(source!, http, true));
    expect(result.items.map((item) => item.sourceItemId)).toEqual(['2254672', '2254673']);
    expect(result.notes.some((note) => note.includes('Sayfa 2: 1 ilan satırı (tarayıcı)'))).toBe(true);
    expect(result.notes.some((note) => note.includes('Listede 2 benzersiz ilan'))).toBe(true);
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

  it('HTTP 403/429 durumunda tarayıcı yedeği veya önceki tarih isteği yapmaz', async () => {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.adapterKey === 'resmigazete-cestili');
    expect(source).toBeDefined();

    for (const status of [403, 429]) {
      const httpUrls: string[] = [];
      let browserOpens = 0;
      const http = {
        async fetchText(url: string): Promise<FetchResponse> {
          httpUrls.push(url);
          throw new FetchError(url, `HTTP ${status}`, status, status === 429);
        },
        async fetchBinary(): Promise<FetchResponse> {
          throw new Error('PDF isteği beklenmiyordu');
        },
        async close(): Promise<void> {
          /* ağ yok */
        },
      } as unknown as HttpClient;
      const browser = {
        async open() {
          browserOpens += 1;
          throw new Error('HTTP denial should not launch Chromium');
        },
      };

      await expect(
        new ResmiGazeteAdapter(browser).run(contextFor(source!, http, true)),
      ).rejects.toMatchObject({
        status,
      });
      expect(httpUrls).toHaveLength(1);
      expect(browserOpens).toBe(0);
    }
  });
});
