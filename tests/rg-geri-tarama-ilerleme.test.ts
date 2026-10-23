/**
 * Resmî Gazete geriye dönük tarama ilerlemesi (kaynak düzeltmesi, 23.10.2026).
 *
 * Kanıtlanan üretim arızası: 60 günlük geri tarama açıktı ama `doneDates` boş kaldı; ilerleme hiç
 * kaydedilmiyordu. İki birleşik neden: (1) olağan günler (bugün+dün) PDF bütçesinin tamamını yiyip
 * her geçmiş günü "deferred" bırakıyordu; (2) pipeline adaptör durumunu yalnız HİÇ ilan hatası yoksa
 * yazıyordu, tek hata tüm ilerlemeyi siliyordu. Ağ yok; sahte http + enjekte OCR motoru.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { resetEnvCache } from '../src/config/env';
import { runSourceScrape } from '../src/ingest/pipeline';
import { disabledLlmGate } from '../src/ai/classifier';
import { ResmiGazeteAdapter, resmiGazeteSectionUrl } from '../src/sources/adapters/resmigazete';
import { createKurumAdapter } from '../src/sources/adapters/anchor-list';
import {
  demoteBackfillDates,
  readRgBackfillState,
  RG_BACKFILL_MAX_ATTEMPTS,
  type RgBackfillState,
} from '../src/sources/adapters/resmigazete-backfill';
import type { OcrEngine } from '../src/extraction/ocr';
import type { FetchOptions, FetchResponse, HttpClient } from '../src/sources/fetcher';
import type { AdapterContext, SourceAdapter } from '../src/sources/types';
import type { RawAnnouncement } from '../src/domain';

const rgSource = SOURCE_DEFINITIONS.find((source) => source.adapterKey === 'resmigazete-cestili')!;
const dsiSource = SOURCE_DEFINITIONS.find((source) => source.key === 'dsi-duyurular')!;

function response(url: string, text: string, headers: Record<string, string> = {}): FetchResponse {
  const body = Buffer.from(text, 'utf8');
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body,
    contentType: 'text/html; charset=utf-8',
    etag: null,
    lastModified: null,
    notModified: false,
    decoded: { text, charset: 'utf-8', charsetGuessed: false },
    bytes: body.byteLength,
  };
}

function binaryResponse(url: string, body: Buffer): FetchResponse {
  return { ...response(url, ''), body, bytes: body.byteLength, contentType: 'application/pdf', decoded: undefined };
}

function ctxFor(http: HttpClient, extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    source: rgSource as unknown as AdapterContext['source'],
    http,
    logger: createLogger('test', { level: 'silent' }),
    liveFetch: true,
    fetchedAt: new Date('2026-10-12T09:00:00Z'),
    maxDetailFetches: 6,
    ...extra,
  };
}

const sectionHtml = (pdfUrls: string[]): string => `<html><body><h1>ÇEŞİTLİ İLÂNLAR</h1>
  <div class="pagination"><a rel="next" class="disabled" aria-disabled="true" href="?page=2">Sonraki</a></div>
  <table>${pdfUrls.map((url) => `<tr><td>ÖRNEK KURUMU <a href="${url}">(PDF)</a></td></tr>`).join('')}</table>
</body></html>`;

const fakePdf = (): Buffer => Buffer.from('%PDF-1.4 sahte-icerik', 'utf8');
const pdfUrl = (stem: string): string => `https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/${stem}.pdf`;

/** Metin katmanı kısa (başlık + ilan no), gövdesi görüntü olan taranmış PDF benzeri — geçerli PDF. */
function thinTextPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 50 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const part = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(part);
    length += part.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
  ].join('');
  chunks.push(
    Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'),
  );
  return Buffer.concat(chunks);
}

const fakeOcrEngine = (): OcrEngine => ({
  async recognize() {
    return { text: 'ocr metni', confidence: 90 };
  },
  async terminate() {},
});

afterEach(() => {
  delete process.env.RG_BACKFILL_DAYS;
  delete process.env.RG_BACKFILL_PDFS_PER_RUN;
  delete process.env.OCR_ENABLED;
  delete process.env.OCR_MAX_DOCS_PER_RUN;
  resetEnvCache();
  vi.restoreAllMocks();
});

describe('demoteBackfillDates', () => {
  const baseState = (): RgBackfillState => ({
    windowDays: 60,
    anchorDate: '2026-10-23',
    doneDates: ['2026-10-20', '2026-10-21'],
    skippedDates: [],
    attempts: {},
    completedAt: '2026-10-23T10:00:00.000Z',
  });

  it('ilanı kaybolan günü "tamamlandı"dan geri çeker, denemeyi artırır, geri taramayı yeniden açar', () => {
    const next = demoteBackfillDates({ rgBackfill: baseState() }, new Set(['2026-10-21']));
    const state = readRgBackfillState(next);
    expect(state?.doneDates).toEqual(['2026-10-20']);
    expect(state?.attempts).toEqual({ '2026-10-21': 1 });
    expect(state?.completedAt).toBeNull();
  });

  it(`${RG_BACKFILL_MAX_ATTEMPTS}. kez kaybolan günü kalıcı atlar (skippedDates)`, () => {
    const start = baseState();
    start.attempts = { '2026-10-21': RG_BACKFILL_MAX_ATTEMPTS - 1 };
    const next = demoteBackfillDates({ rgBackfill: start }, new Set(['2026-10-21']));
    const state = readRgBackfillState(next);
    expect(state?.doneDates).toEqual(['2026-10-20']);
    expect(state?.skippedDates).toEqual(['2026-10-21']);
    expect(state?.attempts).toEqual({});
  });

  it('ilgisiz tarih veya rgBackfill olmayan durumu değiştirmez', () => {
    const untouched = demoteBackfillDates({ rgBackfill: baseState() }, new Set(['2026-10-01']));
    expect(readRgBackfillState(untouched)?.doneDates).toEqual(['2026-10-20', '2026-10-21']);
    expect(demoteBackfillDates({ other: 1 }, new Set(['2026-10-21']))).toEqual({ other: 1 });
  });
});

describe('Resmî Gazete adaptörü — geri taramaya ayrılmış PDF bütçesi', () => {
  it('olağan günde çok PDF olsa da ayrılan payla geçmiş gün işlenir ve ilerler', async () => {
    process.env.RG_BACKFILL_DAYS = '3';
    resetEnvCache();
    const current = ['20261012-4-1', '20261012-4-2', '20261012-4-3', '20261012-4-4', '20261012-4-5'];
    const past = ['20261010-4-1', '20261010-4-2'];
    const textCalls: string[] = [];
    const binaryCalls: string[] = [];
    const intervals: (number | undefined)[] = [];
    const http = {
      async fetchText(url: string, options: FetchOptions = {}): Promise<FetchResponse> {
        textCalls.push(url);
        intervals.push(options.minIntervalMs);
        if (url === resmiGazeteSectionUrl('2026-10-12')) return response(url, sectionHtml(current.map(pdfUrl)));
        if (url === resmiGazeteSectionUrl('2026-10-10')) return response(url, sectionHtml(past.map(pdfUrl)));
        return response(url, sectionHtml([]));
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        binaryCalls.push(url);
        intervals.push(2_000);
        return binaryResponse(url, fakePdf());
      },
    } as unknown as HttpClient;

    // maxDetailFetches 6 → pay = min(8, floor(6/2)) = 3; olağan günler en çok 3 PDF indirir, pay 3 geçmişe.
    const result = await new ResmiGazeteAdapter(null, null).run(ctxFor(http, { maxDetailFetches: 6 }));

    expect(intervals.every((value) => (value ?? 0) >= 2_000)).toBe(true);
    // Olağan gün yalnız ilk 3 PDF'i indirdi; geçmiş günün 2 PDF'i ayrılan payla indirildi.
    expect(binaryCalls).toEqual([...current.slice(0, 3), ...past].map(pdfUrl));
    const ids = result.items.map((item) => item.sourceItemId);
    expect(ids).toContain('resmigazete:20261010-4-1.pdf');
    expect(ids).toContain('resmigazete:20261010-4-2.pdf');
    const state = readRgBackfillState(result.adapterState);
    expect(state?.doneDates).toEqual(['2026-10-09', '2026-10-10']);
    expect(result.coverage?.note).toContain('Geri tarama');
  });

  it('OCR bütçesi dolunca taranmış belge kaydedilmez, sonraki taramaya bırakılır (sentetik başlıkla kilitlenmez)', async () => {
    process.env.OCR_ENABLED = '1';
    process.env.OCR_MAX_DOCS_PER_RUN = '0';
    resetEnvCache();
    const scanned = thinTextPdf('Ornek Universitesi Rektorlugunden 12345/1-1 govde taranmis goruntudedir');
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url === resmiGazeteSectionUrl('2026-10-12')) return response(url, sectionHtml([pdfUrl('20261012-4-1')]));
        return response(url, sectionHtml([]));
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        return binaryResponse(url, scanned);
      },
    } as unknown as HttpClient;

    // Enjekte OCR motoru: ocrAllowed=false (bütçe 0) olduğu için asla awaitlenmez/çağrılmaz; ağ yok.
    const adapter = new ResmiGazeteAdapter(null, Promise.resolve(fakeOcrEngine()));
    const result = await adapter.run(ctxFor(http, { maxDetailFetches: 5 }));

    expect(result.items).toHaveLength(0);
    expect(result.coverage?.status).toBe('partial');
    expect(result.notes.some((note) => note.includes('OCR bütçesi'))).toBe(true);
  });
});

describe('DSİ duyuru başlığı bağlantı metninden alınır (gövde cümlesi değil)', () => {
  // Gerçek DSİ liste yapısı (www.dsi.gov.tr/duyuru/duyuruListe, 23.10.2026): başlık, `.text`
  // kutusundaki <a> bağlantı metnidir; gövde özeti ayrı `.aciklama` kutusundadır. Üretimdeki
  // "Sınav, sözlü ve yazılı olmak üzere 2 aşamada…" başlığı, liste seçicisi tanınmazken (22.10
  // öncesi) oluşmuş ESKİ bir kayıttı; güncel kod bağlantı metnini kullanır.
  const listing = readFileSync(
    fileURLToPath(new URL('./fixtures/kaynak-html/dsi-duyuru-liste.html', import.meta.url)),
    'utf8',
  );
  const detail = `<html><body><main><h1>SONDÖR BELGESİ SINAV İLANI</h1>
    <p>Sınav, sözlü ve yazılı olmak üzere 2 aşamada yapılacaktır. Sondör belgesi almak isteyen adaylar başvurabilir.</p></main></body></html>`;

  it('başlık bağlantı metnidir; gövdedeki "Sınav, sözlü…" cümlesi başlık olmaz', async () => {
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        return response(url, url.includes('/Duyuru/Detay/') ? detail : listing);
      },
      async fetchBinary(url: string): Promise<FetchResponse> {
        return binaryResponse(url, Buffer.from(''));
      },
    } as unknown as HttpClient;
    const ctx: AdapterContext = {
      source: dsiSource as unknown as AdapterContext['source'],
      http,
      logger: createLogger('test', { level: 'silent' }),
      liveFetch: true,
      fetchedAt: new Date('2026-10-23T09:00:00Z'),
      maxDetailFetches: 5,
    };
    const result = await createKurumAdapter().run(ctx);
    const target = result.items.find((item) => item.url.includes('19016'));
    expect(target?.title).toBe('SONDÖR BELGESİ SINAV İLANI');
    expect(target?.title).not.toContain('Sınav, sözlü');
  });
});

describe('pipeline — geri tarama ilerlemesi ilan hatasına rağmen kalıcılaşır', () => {
  it('bir ilanın kayıt hatası tüm ilerlemeyi silmez; yalnız o günü geri çeker', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-rg-')));
    await store.init();
    const repos = createRepos(store, fixedClock(new Date('2026-10-23T09:00:00Z')));
    await repos.sources.seed([rgSource]);
    const source = (await repos.sources.getByKey(rgSource.key))!;

    const nextState: RgBackfillState = {
      windowDays: 60,
      anchorDate: '2026-10-23',
      doneDates: ['2026-10-20', '2026-10-21'],
      skippedDates: [],
      attempts: {},
      completedAt: null,
    };
    const item: RawAnnouncement = {
      sourceKey: rgSource.key,
      sourceItemId: 'resmigazete:20261021-4-1.pdf',
      url: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261021-4-1.pdf',
      title: 'Örnek Kurumundan: SÖZLEŞMELİ PERSONEL ALIM İLANI',
      bodyText: 'Kuruma sözleşmeli personel alınacaktır.',
      bodyTextSource: 'document',
      publishedAt: '2026-10-21T00:00:00+03:00',
      sourceCategory: 'resmi-gazete-cesitli-ilanlar',
      attachments: [],
      extractionConfidence: 0.6,
    };
    const adapter: SourceAdapter = {
      key: 'resmigazete-cestili',
      label: 'test',
      method: 'pdf-index',
      notes: '',
      async run() {
        return {
          items: [item],
          requestCount: 1,
          notes: [],
          etag: null,
          lastModified: null,
          notModified: false,
          coverage: { status: 'partial', note: 'test' },
          adapterState: { rgBackfill: nextState },
        };
      },
    };

    // İlanın kayıt aşaması (applyRawAnnouncement) hata versin.
    vi.spyOn(repos.jobs, 'findLinkBySourceItem').mockRejectedValue(new Error('kayıt deposu geçici hata'));

    const result = await runSourceScrape({
      repos,
      source,
      trigger: 'manual',
      workerId: 'test',
      adapter,
      liveFetch: true,
      queueNotifications: false,
      llmGate: disabledLlmGate(),
    });

    expect(result.errors.length).toBe(1);
    const persisted = readRgBackfillState((await repos.sources.getByKey(rgSource.key))?.adapterState);
    // İlerleme KORUNDU (eski davranış: tümü silinirdi), yalnız hatalı gün geri alındı.
    expect(persisted?.doneDates).toEqual(['2026-10-20']);
    expect(persisted?.attempts).toEqual({ '2026-10-21': 1 });
  });
});
