/**
 * Kariyer Kapısı RSS adaptörü. İlan API'si bölge engelli; kurumun resmî RSS akışı
 * (/RSS) okunur. Akış başlık/kategori/kurum/tarih/bağlantı verir; detay SPA olduğundan
 * son başvuru/kontenjan alınamaz.
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
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
});
