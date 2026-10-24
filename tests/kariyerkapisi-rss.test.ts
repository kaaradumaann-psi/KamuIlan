/**
 * Kariyer Kapısı RSS adaptörü. İlan API'si bölge engelli; kurumun resmî RSS akışı
 * (/RSS) okunur. Akış başlık/kategori/kurum/tarih/bağlantı verir; detay SPA olduğundan
 * son başvuru/kontenjan alınamaz.
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { classify } from '../src/classification/engine';
import { createLogger } from '../src/lib/logger';
import { KariyerKapisiRssAdapter } from '../src/sources/adapters/kariyerkapisi-rss';
import { requireAdapter } from '../src/sources/registry';
import { AdapterStructureError } from '../src/sources/errors';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { SourceDefinition } from '../src/config/sources';
import type { AdapterContext } from '../src/sources/types';

const FEED_URL = 'https://kariyerkapisi.gov.tr/RSS';

function rssItem(guid: string, category: string, title: string, pubDate: string): string {
  return `  <item>
      <guid isPermaLink="true">https://kariyerkapisi.gov.tr/IlanDetay?i=${guid}</guid>
      <link>https://kariyerkapisi.gov.tr/IlanDetay?i=${guid}</link>
      <category>${category}</category>
      <title>${title}</title>
      <description>${title}</description>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="https://kariyerkapisi.gov.tr/UPS/x.png" type="image/png" length="10" />
    </item>`;
}

function rssFeed(items: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel>\n<title>Kariyer Kapısı</title>\n${items.join('\n')}\n</channel></rss>`;
}

function textResponse(url: string, text: string): FetchResponse {
  const body = Buffer.from(text, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    body,
    contentType: 'application/rss+xml; charset=utf-8',
    etag: 'W/"abc"',
    lastModified: null,
    notModified: false,
    decoded: { text, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

function fakeHttp(text: string): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];
  const handler = {
    async fetchText(url: string): Promise<FetchResponse> {
      calls.push(url);
      return textResponse(url, text);
    },
    async fetchBinary(url: string): Promise<FetchResponse> {
      throw new Error(`İkili istek beklenmiyordu: ${url}`);
    },
    async close(): Promise<void> {},
  };
  return { http: handler as unknown as HttpClient, calls };
}

const source =
  SOURCE_DEFINITIONS.find((s) => s.adapterKey === 'kariyer-kapisi-rss') ??
  ({
    key: 'kariyerkapisi-isealim',
    listingUrl: FEED_URL,
    allowedHosts: ['kariyerkapisi.gov.tr'],
    minRequestIntervalMs: 1,
  } as SourceDefinition);

function contextFor(http: HttpClient): AdapterContext {
  return {
    source,
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-23T09:00:00.000Z'),
    maxDetailFetches: 0,
  };
}

describe('Kariyer Kapısı RSS adaptörü', () => {
  it('envanterde RSS akışına bağlıdır ve bölge engeli işareti kaldırılmıştır', () => {
    const inv = SOURCE_DEFINITIONS.find((s) => s.key === 'kariyerkapisi-isealim');
    expect(inv?.adapterKey).toBe('kariyer-kapisi-rss');
    expect(inv?.listingUrl).toBe(FEED_URL);
    expect(inv?.accessState).toBeUndefined();
    expect(requireAdapter('kariyer-kapisi-rss')).toBeInstanceOf(KariyerKapisiRssAdapter);
  });

  it('akıştaki ilanları başlık/kategori/kurum/tarih/başvuru bağlantısıyla çıkarır', async () => {
    const { http, calls } = fakeHttp(
      rssFeed([
        rssItem(
          'e53c369b-3913-48dc-8e41-be3a6392c249',
          'İşçi İlanları',
          'KIYI EMNİYETİ GENEL MÜDÜRLÜĞÜ - PERSONEL ALIM İLANI (9 KİŞİLİK)',
          'Mon, 19 Oct 2026 00:01:00 +0300',
        ),
        rssItem(
          'aa11bb22-0000-0000-0000-000000000001',
          'Memur İlanları',
          'ÖRNEK BAKANLIĞI - MEMUR ALIM İLANI',
          'Tue, 20 Oct 2026 00:01:00 +0300',
        ),
      ]),
    );

    const result = await new KariyerKapisiRssAdapter().run(contextFor(http));

    expect(calls).toEqual([FEED_URL]);
    expect(result.items).toHaveLength(2);
    const first = result.items[0]!;
    expect(first.sourceItemId).toBe('e53c369b-3913-48dc-8e41-be3a6392c249');
    expect(first.url).toContain('IlanDetay?i=e53c369b');
    expect(first.applicationUrl).toBe(first.url);
    expect(first.title).toContain('KIYI EMNİYETİ');
    expect(first.institution).toBe('KIYI EMNİYETİ GENEL MÜDÜRLÜĞÜ');
    expect(first.sourceCategory).toBe('İşçi İlanları');
    expect(first.publishedAt).toBe('2026-10-19');
    // Son başvuru/kontenjan RSS'te yok: alanlar boş.
    expect(first.applicationEndAt).toBeUndefined();
    expect(first.quota).toBeUndefined();
    expect(result.coverage?.status).toBe('complete');
  });

  it('aynı guid iki kez gelirse tek ilan olur (tekilleştirme)', async () => {
    const dup = rssItem('dup-0000-0000-0000-000000000009', 'İşçi İlanları', 'A KURUMU - İLAN', 'Mon, 19 Oct 2026 00:01:00 +0300');
    const { http } = fakeHttp(rssFeed([dup, dup]));
    const result = await new KariyerKapisiRssAdapter().run(contextFor(http));
    expect(result.items).toHaveLength(1);
  });

  it('akışta <item> yoksa yapı hatası verir (sessiz kayıp değil)', async () => {
    const { http } = fakeHttp('<?xml version="1.0"?><rss><channel><title>boş</title></channel></rss>');
    await expect(new KariyerKapisiRssAdapter().run(contextFor(http))).rejects.toBeInstanceOf(AdapterStructureError);
  });

  it('ileri tarihli pubDate yayım tarihi diye yazılmaz, başvuru başlangıcı da uydurulmaz', async () => {
    const { http } = fakeHttp(
      rssFeed([
        rssItem('f0000000-0000-0000-0000-000000000001', 'Sözleşmeli Personel İlanları', 'ORTA ANADOLU KALKINMA AJANSI - PERSONEL ALIM İLANI - 2026', 'Mon, 09 Nov 2026 00:01:00 +0300'),
      ]),
    );
    const [item] = (await new KariyerKapisiRssAdapter().run(contextFor(http))).items;
    expect(item?.publishedAt).toBeUndefined();
    expect(item?.applicationStartAt).toBeUndefined();
  });
});

describe('Kariyer Kapısı ilanlarının sınıflandırılması (gerçek akıştan örnekler, 24.10.2026)', () => {
  const kk = (title: string, category: string, sourceKey = 'kariyerkapisi-isealim') =>
    classify({ title, body: '', sourceCategory: category, sourceKey, documentTextMissing: true });

  it('alım kategorisindeki gövdesiz öğe kabul edilir; istihdam türü kategoriden gelir', () => {
    const cases: [string, string, string][] = [
      ['TÜRK STANDARDLARI ENSTİTÜSÜ - SÖZLEŞMELİ BİLİŞİM PERSONELİ ALIM İLANI 2026', 'Sözleşmeli Personel İlanları', 'sozlesmeli'],
      ['TÜRK AKREDİTASYON KURUMU GENEL SEKRETERLİĞİ - AKREDİTASYON UZMAN YARDIMCISI ALIMI', 'A Grubu Memur (Kariyer Meslek)', 'kariyer-meslek'],
      ['TÜRKİYE CUMHURİYETİ DEVLET DEMİRYOLLARI TAŞIMACILIK ANONİM ŞİRKETİ GENEL MÜDÜRLÜĞÜ - 166 SÜREKLİ İŞÇİ İSTİHDAMI', 'Sürekli İşçi', 'kamu-isci'],
      ['ADALET BAKANLIĞI - 2026 Yılı Açıktan İcra Müdür ve İcra Müdür Yardımcılığı Sınav İlanı', 'Merkezi Yerleştirme (ÖSYM)', 'kadrolu'],
      ['JANDARMA VE SAHİL GÜVENLİK AKADEMİSİ BAŞKANLIĞI - 2027 YILI J.GN.K.LIĞI MUVAZZAF SUBAY TEMİNİ', 'Askeri Personel İlanları', 'diger-kamu'],
    ];
    for (const [title, category, type] of cases) {
      const result = kk(title, category);
      expect(result.decision, title).toBe('accept');
      expect(result.kind, title).toBe('job');
      expect(result.employmentType, title).toBe(type);
      expect(result.rules, title).toContain('pozitif.resmi-portal-kategorisi');
    }
  });

  it('alım olmayan portal kategorileri olağan kurala kalır ve reddedilir', () => {
    expect(
      kk('ATATÜRK ORMAN ÇİFTLİĞİ MÜDÜRLÜĞÜ (AOÇ) - Görevde Yükselme ve Ünvan Değişikliği', 'Görevde Yükselme ve Unvan Değişikliği İlanları').decision,
    ).toBe('reject');
    expect(
      kk('KAMU İHALE KURUMU - MESLEK PERSONELİ İÇİN YURT DIŞI YÜKSEK LİSANS EĞİTİMİ (2026 YILI)', 'Yurt Dışı Eğitim İlanları').decision,
    ).toBe('reject');
  });

  it('portal ayrıcalığı başka kaynağa uygulanmaz (gövdesiz kayıt incelemede kalır)', () => {
    const other = kk('TÜRK STANDARDLARI ENSTİTÜSÜ - SÖZLEŞMELİ BİLİŞİM PERSONELİ ALIM İLANI 2026', 'Sözleşmeli Personel İlanları', 'baska-kaynak');
    expect(other.decision).toBe('review');
  });
});
