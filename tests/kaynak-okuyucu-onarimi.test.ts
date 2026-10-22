/**
 * 22.10.2026 kaynak okuyucu onarımı: gerçek sayfalardan kısaltılmış fixture'larla
 * (tests/fixtures/kaynak-html) ağsız doğrulama + depodaki ara sertifika ile TLS zinciri.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { connect, rootCertificates } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_DEFINITIONS, type SourceDefinition } from '../src/config/sources';
import { loadHtml } from '../src/lib/html';
import { createLogger } from '../src/lib/logger';
import { loadBundledIntermediates } from '../src/lib/tls-intermediates';
import { SbbKamuIlanAdapter } from '../src/sources/adapters/sbb-kamuilan';
import {
  KariyerKapisiAdapter,
  KARIYER_API_DETAIL_URL,
  KARIYER_API_LIST_URL,
  kariyerDetailHtmlFromApi,
  parseKariyerApiRows,
  parseKariyerDetail,
} from '../src/sources/adapters/kariyerkapisi';
import { requireAdapter } from '../src/sources/registry';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { AdapterContext } from '../src/sources/types';

const FIXTURES = fileURLToPath(new URL('./fixtures/kaynak-html/', import.meta.url));
const TLS_FIXTURES = fileURLToPath(new URL('./fixtures/tls-aia/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');

function response(url: string, text: string, contentType = 'text/html; charset=utf-8'): FetchResponse {
  const body = Buffer.from(text, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': contentType },
    body,
    contentType,
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

function fakeHttp(routes: Record<string, string>): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];
  const handler = {
    async fetchText(url: string): Promise<FetchResponse> {
      calls.push(url);
      const text = routes[url];
      if (text === undefined) throw new Error(`Beklenmeyen istek: ${url}`);
      return response(url, text, url.includes('api.') ? 'application/json' : 'text/html; charset=utf-8');
    },
    async fetchBinary(url: string): Promise<FetchResponse> {
      throw new Error(`İkili istek beklenmiyordu: ${url}`);
    },
    async close(): Promise<void> {},
  };
  return { http: handler as unknown as HttpClient, calls };
}

function source(key: string): SourceDefinition {
  const found = SOURCE_DEFINITIONS.find((entry) => entry.key === key);
  if (!found) throw new Error(`${key} envanterde yok`);
  return found;
}

function ctx(src: SourceDefinition, http: HttpClient, fetchedAt = new Date('2026-10-22T09:00:00Z')): AdapterContext {
  return { source: src, http, logger: createLogger('test', { level: 'silent' }), liveFetch: true, fetchedAt, maxDetailFetches: 0 };
}

describe('Kamu İlan (SBB) zaman çizelgesi', () => {
  it('her ilanı ayrı okur, manşet tekrarını almaz ve sayaçla kapsamı tam sayar', async () => {
    const src = source('kamuilan-sbb');
    const { http } = fakeHttp({ [src.listingUrl]: fixture('sbb-kamuilan.html') });
    const result = await new SbbKamuIlanAdapter().run(ctx(src, http));
    expect(result.items).toHaveLength(6);
    expect(new Set(result.items.map((item) => item.sourceItemId)).size).toBe(6);
    expect(result.coverage?.status).toBe('complete');
    const first = result.items[0]!;
    expect(first.institution).toBeTruthy();
    expect(first.title).not.toMatch(/\d+\s+(Ekim|Kasım)\s*-/);
    expect(first.publishedAt).toBe('2026-10-22T00:00:00+03:00');
    expect(first.url).toMatch(/ilanDetay\.aspx\?kod=/);
  });

  it('kimlik değişen kod parametresine bağlı değildir', () => {
    const src = source('kamuilan-sbb');
    const adapter = new SbbKamuIlanAdapter();
    const html = fixture('sbb-kamuilan.html');
    const reencoded = html.replace(/kod=([^'"]+)/g, (_m, kod: string) => `kod=X${kod.slice(1)}`);
    const a = adapter.parseListing(loadHtml(html), src.listingUrl, src.allowedHosts, new Date('2026-10-22T09:00:00Z'));
    const b = adapter.parseListing(loadHtml(reencoded), src.listingUrl, src.allowedHosts, new Date('2026-10-22T09:00:00Z'));
    expect(a.map((row) => row.id)).toEqual(b.map((row) => row.id));
  });
});

describe('Kariyer Kapısı resmî JSON ucu', () => {
  const list = JSON.parse(fixture('kariyerkapisi-GetIseAlimPage.json')) as unknown;
  const detail = JSON.parse(fixture('kariyerkapisi-GetIlanPreviewPublic.json')) as unknown;

  it('liste yanıtından iç/dış ilanları HTML yoluyla aynı kimliklerle çıkarır', () => {
    const src = source('kariyerkapisi-isealim');
    const parsed = parseKariyerApiRows(list, src.listingUrl, src.allowedHosts, new Date('2026-10-20T09:00:00Z'));
    expect(parsed?.rows).toHaveLength(3);
    const [internal, , external] = parsed!.rows;
    expect(internal!.url).toMatch(/^https:\/\/kariyerkapisi\.gov\.tr\/IlanDetay\?i=[0-9a-f-]{36}$/);
    expect(internal!.sourceItemId).toMatch(/^[0-9a-f-]{36}$/);
    expect(external!.url).toBe(src.listingUrl);
    expect(external!.applicationUrl).toMatch(/^https:\/\//);
  });

  it('bitiş tarihi geçmiş satırları sayfadaki gibi atlar', () => {
    const src = source('kariyerkapisi-isealim');
    const parsed = parseKariyerApiRows(list, src.listingUrl, src.allowedHosts, new Date('2030-01-01T00:00:00Z'));
    expect(parsed?.rows).toHaveLength(0);
    expect(parsed?.expired).toBe(3);
  });

  it('detay yanıtını kararlı öğe kimlikleriyle HTML yapıp ayrıştırır', () => {
    const page = kariyerDetailHtmlFromApi(detail);
    expect(page).not.toBeNull();
    const parsed = parseKariyerDetail(page!);
    expect(parsed.referenceNo).toMatch(/^ILN\d+/);
    expect(parsed.applicationStartAt).toBe('2026-10-12T00:00:00+03:00');
    expect(parsed.applicationEndAt).toBe('2026-10-22T23:59:00+03:00');
    expect(parsed.applicationUrl).toMatch(/^https:\/\/www\.turkiye\.gov\.tr\//);
    expect(parsed.bodyText ?? '').not.toMatch(/\[\/?b\]|\[size/);
  });

  it('run(): JSON ucu doluysa HTML/tarayıcı denenmez ve liste kapsamı tamdır', async () => {
    const src = source('kariyerkapisi-isealim');
    const { http, calls } = fakeHttp({ [KARIYER_API_LIST_URL]: JSON.stringify(list), [KARIYER_API_DETAIL_URL]: JSON.stringify(detail) });
    const adapter = new KariyerKapisiAdapter(async () => {
      throw new Error('tarayıcı çağrılmamalı');
    });
    const result = await adapter.run({ ...ctx(src, http, new Date('2026-10-20T09:00:00Z')), maxDetailFetches: 1 });
    expect(calls[0]).toBe(KARIYER_API_LIST_URL);
    expect(calls).not.toContain(src.listingUrl);
    expect(result.notes.join(' ')).toContain('resmî JSON ucundan okundu: 3 kayıt');
    const withDetail = result.items.find((item) => item.referenceNo);
    expect(withDetail?.referenceNo).toMatch(/^ILN/);
  });
});

describe('ortak liste adaptörü — 22.10.2026 gerçek sayfa biçimleri', () => {
  async function rows(key: string, file: string): Promise<string[]> {
    const src = source(key);
    const { http } = fakeHttp({ [src.listingUrl]: fixture(file) });
    const adapter = requireAdapter(src.adapterKey);
    // Detay isteği yapılmadan (bütçe 0) satır notundan sayı okunur.
    const result = await adapter.run(ctx(src, http));
    return result.notes.filter((note) => /^Sayfa 1:/.test(note));
  }

  it('ISAY CMS: betikle açılan gizli sarmalayıcı silinmez (AFAD)', async () => {
    expect(await rows('afad-duyurular', 'afad-isay.html')).toEqual(['Sayfa 1: 4 ilan bağlantısı.']);
  });
  it('WebForms: sayfayı saran <form> silinmez (KGM)', async () => {
    expect(await rows('kgm-duyurular', 'kgm-aspnetform.html')).toEqual(['Sayfa 1: 4 ilan bağlantısı.']);
  });
  it('<body id="a11y-…"> iskelet sayılmaz (YÖK)', async () => {
    expect(await rows('yok-duyurular', 'yok-a11y-body.html')).toEqual(['Sayfa 1: 4 ilan bağlantısı.']);
  });
  it('Next.js akışlı çizim (<div hidden id="S:5">) okunur (TKGM)', async () => {
    expect(await rows('tkgm-duyurular', 'tkgm-next-stream.html')).toEqual(['Sayfa 1: 3 ilan bağlantısı.']);
  });
  it('form içindeki basın tablosu okunur, form dışı menü alınmaz (TMSF)', async () => {
    expect(await rows('tmsf-duyurular', 'tmsf-basin.html')).toEqual(['Sayfa 1: 3 ilan bağlantısı.']);
  });

  it('istek adresinde www korunur (BDDK: bddk.org.tr çözümlenmez)', async () => {
    const src = source('bddk-duyurular');
    const calls: string[] = [];
    const page = fixture('bddk-duyuru.html');
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        calls.push(url);
        if (url === src.listingUrl) return response(url, page);
        return response(url, '<html><body><main><p>' + 'Duyuru metni ve başvuru koşulları. '.repeat(12) + '</p></main></body></html>');
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('yok');
      },
      async close(): Promise<void> {},
    } as unknown as HttpClient;
    const result = await requireAdapter(src.adapterKey).run({ ...ctx(src, http), maxDetailFetches: 2 });
    expect(result.items.length).toBeGreaterThan(0);
    for (const url of calls) expect(new URL(url).hostname).toBe('www.bddk.org.tr');
  });
});

describe('depodaki ara sertifikalar (certs/intermediates)', () => {
  const pem = (name: string): string => readFileSync(`${TLS_FIXTURES}${name}`, 'utf8');

  it('yalnız güvenilen köke bağlanan, süresi geçerli CA sertifikalarını kabul eder', () => {
    const dir = TLS_FIXTURES;
    const loaded = loadBundledIntermediates([pem('root.crt')], { dir, now: new Date('2027-01-01T00:00:00Z') });
    // intermediate.crt kabul; root (kendisi) ve unrelated kök değil-ara olarak; nonca/leaf reddedilir.
    expect(loaded.accepted).toContain(pem('intermediate.crt').trim());
    const rejectedFiles = loaded.rejected.map((entry) => entry.file);
    expect(rejectedFiles).toEqual(expect.arrayContaining(['nonca.crt', 'leaf.crt', 'unrelated.crt']));
  });

  it('kök güven listesinde yoksa ve süre dışındaysa reddeder', () => {
    expect(loadBundledIntermediates([], { dir: TLS_FIXTURES }).accepted).toEqual([]);
    const expired = loadBundledIntermediates([pem('root.crt')], { dir: TLS_FIXTURES, now: new Date('2040-01-01T00:00:00Z') });
    expect(expired.accepted).toEqual([]);
  });

  it('depodaki GeoTrust TLS RSA CA G1, Node’un gömülü DigiCert Global Root G2 köküyle doğrulanır', () => {
    const loaded = loadBundledIntermediates([...rootCertificates], { now: new Date('2026-10-22T00:00:00Z') });
    expect(loaded.rejected).toEqual([]);
    expect(loaded.accepted).toHaveLength(1);
  });

  it('yalnız yaprak gönderen sunucu: kökle reddedilir, kök + ara sertifikayla doğrulanır (doğrulama açık)', async () => {
    const server = createServer({ cert: pem('leaf.crt'), key: pem('leaf.key') }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const attempt = (ca: string[]): Promise<string> =>
      new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port, servername: 'site.example.gov.tr', ca }, () => {
          resolve(socket.authorized ? 'ok' : 'unauthorized');
          socket.end();
        });
        socket.on('error', (error: Error & { code?: string }) => resolve(error.code ?? error.message));
      });
    try {
      expect(await attempt([pem('root.crt')])).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      expect(await attempt([pem('root.crt'), pem('intermediate.crt')])).toBe('ok');
      // Ara sertifika tek başına güven kökü olamaz (kısmi zincir kapalı).
      expect(await attempt([pem('intermediate.crt')])).not.toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
