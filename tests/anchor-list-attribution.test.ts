/**
 * Anchor-list tarih ve gövde atfı regresyonu.
 *
 * Sorun: satır (rowSelector) bir `div` ise ve birden çok duyuruyu kapsıyorsa,
 * bağlantının yayım tarihi ve gövde metni komşu duyurudan alınıyordu. Bu hem
 * yanlış yayım tarihi (ve dolayısıyla yanlış "eski ilan" kararı) hem de gövde
 * kirlenmesi demekti. Düzeltme: paylaşılan satırda yalnızca bağlantının kendi
 * metni kullanılır; tarih ve gövde komşudan alınmaz.
 */
import { describe, expect, it } from 'vitest';
import { AnchorListAdapter } from '../src/sources/adapters/anchor-list';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { AdapterContext } from '../src/sources/types';

const LISTING_URL = 'https://example-kurum.gov.tr/duyurular';

function response(url: string, html: string): FetchResponse {
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

function ctxFor(html: string): AdapterContext {
  const http: HttpClient = {
    async fetchText(url: string) {
      return response(url, html);
    },
  } as unknown as HttpClient;
  return {
    source: {
      key: 'test-kurum-liste',
      name: 'Test kurum',
      listingUrl: LISTING_URL,
      allowedHosts: ['example-kurum.gov.tr', 'www.example-kurum.gov.tr'],
      institution: 'Test Kurumu',
      minRequestIntervalMs: 0,
    } as unknown as AdapterContext['source'],
    http,
    liveFetch: true,
    fetchedAt: new Date('2026-10-15T09:00:00+03:00'),
    knownItemIds: [],
    knownItemIdsWithDetail: [],
    maxDetailFetches: 0,
    logger: { child: () => ({}), info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AdapterContext;
}

/** Detay okumadan yalnızca liste ayrıştırmasını test eder. */
function listOnlyAdapter(): AnchorListAdapter {
  return new AnchorListAdapter({
    key: 'test-kurum-liste',
    label: 'Test kurum listesi',
    notes: 'test',
    pathPattern: /\/duyuru\//i,
    rowSelector: 'li, tr, article, .card, div',
    minTitleLength: 18,
    defaultInstitution: '',
    sourceCategory: 'kurum duyurusu',
    maxItems: 25,
    fetchDetail: false,
  });
}

describe('anchor-list: tarih ve gövde atfı', () => {
  it('ayrı satırlardaki her duyurunun kendi tarihini alır', async () => {
    const html = `<main><ul>
      <li><a href="/duyuru/alim-ilani-1">Sözleşmeli Bilişim Personeli Alım İlanı Duyurusu</a> <span>10.10.2026</span></li>
      <li><a href="/duyuru/haber-2">Rektör kurum ziyaretinde konuştu ve açıklama yaptı</a> <span>01.09.2026</span></li>
    </ul></main>`;
    const result = await listOnlyAdapter().run(ctxFor(html));
    const byUrl = new Map(result.items.map((item) => [item.url, item]));
    expect(byUrl.get('https://example-kurum.gov.tr/duyuru/alim-ilani-1')?.publishedAt).toBe('2026-10-10');
    expect(byUrl.get('https://example-kurum.gov.tr/duyuru/haber-2')?.publishedAt).toBe('2026-09-01');
  });

  it('aynı kapsayıcıdaki iki duyurunun tarihi birbirine karışmaz (paylaşılan satır)', async () => {
    const html = `<main><div class="list">
      <a href="/duyuru/uzun-haber-bir">Yükseköğretim Kurulu haber metni birinci başlık</a> 05.10.2026
      <a href="/duyuru/uzun-haber-iki">Yükseköğretim Kurulu haber metni ikinci başlık</a> 20.10.2026
    </div></main>`;
    const result = await listOnlyAdapter().run(ctxFor(html));
    expect(result.items.length).toBe(2);
    for (const item of result.items) {
      // Komşu duyurunun tarihi yanlışlıkla atanmamalı.
      expect(item.publishedAt).toBeUndefined();
      // Komşu duyurunun metni gövdeye karışmamalı.
      expect(item.bodyText ?? '').not.toContain('ikinci başlık');
      expect(item.bodyText ?? '').not.toContain('birinci başlık');
    }
  });

  it('paylaşılan satırda bağlantının kendi tarihi metinde varsa yine de alınır', async () => {
    const html = `<main><div class="list">
      <a href="/duyuru/kendi-tarihi-bir">10.10.2026 Sözleşmeli Personel Alım İlanı birinci</a>
      <a href="/duyuru/kendi-tarihi-iki">01.09.2026 Sözleşmeli Personel Alım İlanı ikinci</a>
    </div></main>`;
    const result = await listOnlyAdapter().run(ctxFor(html));
    const byUrl = new Map(result.items.map((item) => [item.url, item]));
    expect(byUrl.get('https://example-kurum.gov.tr/duyuru/kendi-tarihi-bir')?.publishedAt).toBe('2026-10-10');
    expect(byUrl.get('https://example-kurum.gov.tr/duyuru/kendi-tarihi-iki')?.publishedAt).toBe('2026-09-01');
  });
});
