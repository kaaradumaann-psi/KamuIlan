/**
 * OCR (R-13) — SAHTE (mock) OCR motoruyla, ağsız ve anahtarsız testler.
 *
 * Gerçek tesseract.js denemesi bu testlerde YAPILMAZ (CI'da dil verisi indirmez).
 * Yerel gerçek deneme (22.10.2026, Node 24, Windows): İŞKUR 18.10-4-4 güven 90 (11,8 sn),
 * Orta Anadolu KA 19.10-4-7 güven 91 (6,6 sn; görüntü 177 px'lik şeritler hâlinde).
 */
import { inflateSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodePng, pageImageToPng, stitchStrips, type OcrEngine } from '../src/extraction/ocr';
import { extractPdfText } from '../src/extraction/pdf';
import { extractApplicationWindow } from '../src/extraction/engine';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

/** Başlık satırı metin, gövdesi tek gri görüntü olan PDF (taranmış ilan benzeri). */
function scannedPdfWithImage(options: { header?: string; width?: number; height?: number; strips?: number } = {}): Buffer {
  const width = options.width ?? 400;
  const height = options.height ?? 400;
  const strips = options.strips ?? 1;
  const stripHeight = Math.floor(height / strips);
  const objects: string[] = [];
  const binaries: Buffer[] = [];
  const header = options.header ?? 'Ornek Kurum: PERSONEL ALIM ILANI';
  const xobjects = Array.from({ length: strips }, (_, index) => `/Im${index} ${5 + index} 0 R`).join(' ');
  const draw = Array.from(
    { length: strips },
    (_, index) => `q ${width} 0 0 ${stripHeight} 50 ${700 - (index + 1) * stripHeight} cm /Im${index} Do Q`,
  ).join('\n');
  // Çok satırlı başlık: uzun tek satır sayfa dışına taşar ve pdfjs keser.
  const lines = header
    .split('\n')
    .map((line) => `(${line}) Tj T*`)
    .join(' ');
  const content = `BT /F1 12 Tf 14 TL 50 760 Td ${lines} ET\n${draw}`;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> /XObject << ${xobjects} >> >> /Contents 4 0 R >>`,
  );
  objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  for (let index = 0; index < strips; index += 1) {
    const pixels = Buffer.alloc(width * stripHeight, 255);
    for (let x = 40; x < width - 40; x += 1) pixels[Math.floor(stripHeight / 2) * width + x] = 0;
    binaries.push(pixels);
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${stripHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n@@BIN${index}@@\nendstream`,
    );
  }
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const [before, after] = body.split(/@@BIN\d+@@/);
    const binIndex = /@@BIN(\d+)@@/.exec(body)?.[1];
    const parts =
      binIndex === undefined
        ? [Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1')]
        : [
            Buffer.from(`${index + 1} 0 obj\n${before}`, 'latin1'),
            binaries[Number(binIndex)]!,
            Buffer.from(`${after}\nendobj\n`, 'latin1'),
          ];
    for (const part of parts) {
      chunks.push(part);
      length += part.length;
    }
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function fakeEngine(result: { text: string; confidence: number }): OcrEngine & { calls: { width: number; height: number }[] } {
  const calls: { width: number; height: number }[] = [];
  return {
    calls,
    async recognize(png: Buffer) {
      calls.push({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
      return result;
    },
    async terminate() {},
  };
}

const OCR_TEXT =
  'Kurumumuza 4/B sözleşmeli personel alınacaktır. Başvuru Tarihleri 09/11/2026 - 03/12/2026. KPSS P3 puanı esas alınır.';

describe('PNG kodlama (mock değil, saf işlev)', () => {
  it('gri ve RGB piksel gidiş-dönüş', () => {
    const gray = Uint8Array.from({ length: 6 }, (_, i) => i * 40);
    const png = encodePng(3, 2, 1, gray);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    const idatLength = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect([...raw]).toEqual([0, 0, 40, 80, 0, 120, 160, 200]);
  });

  it('1 bit görüntü griye açılır; küçük görüntü (logo) atlanır', () => {
    expect(pageImageToPng({ width: 50, height: 50, kind: 2, data: new Uint8Array(50 * 50 * 3) })).toBeNull();
    const oneBit = new Uint8Array(Math.ceil(320 / 8) * 320).fill(0xff);
    const png = pageImageToPng({ width: 320, height: 320, kind: 1, data: oneBit });
    expect(png?.readUInt32BE(16)).toBe(320);
    expect(png?.[25]).toBe(0); // renk türü: gri
  });

  it('aynı genişlikteki ardışık şeritler tek görüntüde birleşir', () => {
    const strip = { width: 400, height: 100, kind: 2, data: new Uint8Array(400 * 100 * 3) };
    const stitched = stitchStrips([strip, strip, strip, { ...strip, width: 200, data: new Uint8Array(200 * 100 * 3) }]);
    expect(stitched.map((image) => [image.width, image.height])).toEqual([
      [400, 300],
      [200, 100],
    ]);
  });
});

describe('extractPdfText + OCR (sahte motor)', () => {
  it('taranmış belgede güvenli OCR metni başlığın arkasına eklenir', async () => {
    const engine = fakeEngine({ text: OCR_TEXT, confidence: 91 });
    const result = await extractPdfText(new Uint8Array(scannedPdfWithImage()), {
      ocr: { engine, minConfidence: 70, maxPages: 4 },
    });
    expect(engine.calls).toHaveLength(1);
    expect(result.ocr).toMatchObject({ used: true, confidence: 91 });
    expect(result.text).toContain('PERSONEL ALIM ILANI');
    expect(result.text).toContain('sözleşmeli personel alınacaktır');
    expect(result.noTextLayer).toBe(false);
  });

  it('şeritler hâlinde gömülü sayfa tek görüntü olarak okunur', async () => {
    const engine = fakeEngine({ text: OCR_TEXT, confidence: 88 });
    await extractPdfText(new Uint8Array(scannedPdfWithImage({ strips: 4, height: 400 })), {
      ocr: { engine, minConfidence: 70, maxPages: 4 },
    });
    expect(engine.calls).toEqual([{ width: 400, height: 400 }]);
  });

  it('çağıran metin katmanına bakıp OCR istemezse motor çağrılmaz (bütçe korunur)', async () => {
    const engine = fakeEngine({ text: OCR_TEXT, confidence: 91 });
    const seen: string[] = [];
    const result = await extractPdfText(new Uint8Array(scannedPdfWithImage({ header: 'Ornek Kurum: IHALELERE KATILMAKTAN YASAKLAMA KARARI' })), {
      ocr: {
        engine,
        minConfidence: 70,
        maxPages: 4,
        when: (textLayer) => {
          seen.push(textLayer);
          return false;
        },
      },
    });
    expect(seen[0]).toContain('YASAKLAMA');
    expect(engine.calls).toHaveLength(0);
    expect(result.ocr).toBeUndefined();
  });

  it('güveni eşiğin altındaki OCR metni kullanılmaz (tahmin yok, inceleme)', async () => {
    const engine = fakeEngine({ text: OCR_TEXT, confidence: 41 });
    const result = await extractPdfText(new Uint8Array(scannedPdfWithImage()), {
      ocr: { engine, minConfidence: 70, maxPages: 4 },
    });
    expect(result.ocr?.used).toBe(false);
    expect(result.ocr?.note).toContain('güveni düşük');
    expect(result.text).not.toContain('sözleşmeli personel');
  });

  it('OCR verilmezse (varsayılan) ya da belge metin içeriyorsa motor çağrılmaz', async () => {
    const off = await extractPdfText(new Uint8Array(scannedPdfWithImage()));
    expect(off.ocr).toBeUndefined();
    const engine = fakeEngine({ text: OCR_TEXT, confidence: 99 });
    const longHeader = Array.from({ length: 10 }, () => 'Ornek Kurum personel alim ilani metni').join('\n');
    await extractPdfText(new Uint8Array(scannedPdfWithImage({ header: longHeader })), {
      ocr: { engine, minConfidence: 70, maxPages: 4 },
    });
    expect(engine.calls).toHaveLength(0);
  });
});

describe('OCR metniyle oluşan ilan', () => {
  it('ilan detayında OCR belirsizliği açıkça yazılır', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-ocr-')));
    await store.init();
    const repos = createRepos(store, fixedClock(new Date('2026-10-22T09:00:00+03:00')));
    const outcome = await applyRawAnnouncement(
      { ...sozlesmeliPersonelIlani(), ocrConfidence: 90 },
      { repos, now: new Date('2026-10-22T09:00:00+03:00'), workerId: 'w', provenance: 'scraped' },
    );
    const job = await repos.jobs.findById(outcome.jobId ?? '');
    expect(job?.uncertainties.join(' ')).toContain('OCR ile okundu (güven 90)');
  });
});

describe('başvuru penceresi: etiketli ilan tarihi', () => {
  it('"İlan Tarihi … Başvuru Tarihleri X — Y" satırında ilan tarihi pencereye karışmaz (RG 19.10-4-7)', () => {
    const body =
      'Tablo 1. Personel alım süreci İlan Tarihi 19/10/2026 Başvuru Tarihleri 09/11/2026 — 03/12/2026 Sınav Şekli Sözlü Sınav (Mülakat) Sınava Katılmaya Hak 15/12/2026 tarihinde';
    const window = extractApplicationWindow('PERSONEL ALIM İLANI', body);
    expect(window.start?.dateOnly).toBe('2026-11-09');
    expect(window.end?.dateOnly).toBe('2026-12-03');
  });
});
