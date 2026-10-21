/**
 * Metin katmanı olmayan (taranmış) PDF için OCR — R-13.
 *
 * Kanıt: Resmî Gazete örneğinde 19 belgeden 7'sinin metni yalnızca başlık satırıydı
 * (gövde taranmış görüntü). Bunların ikisi gerçek iş ilanıydı (İŞKUR sözleşmeli
 * bilişim personeli, Orta Anadolu Kalkınma Ajansı); kayıtlar incelemeye düşüyordu.
 *
 * Akış: PDF sayfasındaki gömülü görüntüler pdfjs ile çözülür → PNG'ye kodlanır
 * (yerleşik zlib; ek paket yok) → OCR motoru (tesseract.js, Türkçe).
 *
 * Güvenlik/doğruluk:
 *  - VARSAYILAN KAPALI (`OCR_ENABLED=0`). Kapalıyken davranış hiç değişmez.
 *  - Ortalama güven `OCR_MIN_CONFIDENCE`'ın altındaysa metin KULLANILMAZ: kayıt
 *    eskisi gibi "belge metni yok" olarak incelemeye gider (tahmin yok).
 *  - Kullanılan OCR metni kayda işaretlenir; ilan detayında "tarih ve sayıları resmî
 *    belgeden doğrulayın" belirsizliği görünür.
 *  - OCR girdisi güvenilmeyen içeriktir; yalnızca metin olarak işlenir.
 */
import { deflateSync, crc32 } from 'node:zlib';

export interface OcrEngine {
  recognize(png: Buffer): Promise<{ text: string; confidence: number }>;
  terminate(): Promise<void>;
}

export interface OcrPageImage {
  width: number;
  height: number;
  /** pdfjs ImageKind: 1 = 1 bit gri, 2 = RGB 24 bit, 3 = RGBA 32 bit. */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Çok küçük görüntüler (logo, mühür, çizgi) OCR'a gönderilmez. */
const MIN_IMAGE_SIDE = 300;

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** Ham piksel → PNG (8 bit; 1 = gri, 3 = RGB, 4 = RGBA kanal). */
export function encodePng(width: number, height: number, channels: 1 | 3 | 4, pixels: Uint8Array): Buffer {
  if (pixels.length < width * height * channels) throw new Error('Piksel verisi görüntü boyutundan kısa.');
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filtre: yok
    Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** pdfjs görüntüsünü PNG'ye çevirir; desteklenmeyen biçimde `null`. */
export function pageImageToPng(image: OcrPageImage): Buffer | null {
  const { width, height, kind, data } = image;
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length);
  if (kind === 2) return encodePng(width, height, 3, bytes);
  if (kind === 3) return encodePng(width, height, 4, bytes);
  if (kind === 1) {
    // 1 bit/piksel, satır baytla hizalı; 1 = beyaz (pdfjs GRAYSCALE_1BPP).
    const rowBytes = Math.ceil(width / 8);
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = (bytes[y * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7));
        gray[y * width + x] = bit ? 255 : 0;
      }
    }
    return encodePng(width, height, 1, gray);
  }
  return null;
}

export interface OcrOutcome {
  text: string;
  /** Okunan görüntülerin ortalama güveni (0–100). */
  confidence: number;
  images: number;
}

/**
 * Ardışık, aynı genişlik ve türdeki görüntüleri dikey birleştirir.
 *
 * Bazı taranmış sayfalar yatay ŞERİTLER hâlinde gömülür (RG 19.10.2026-4-7: 727×177
 * parçalar). Şeritleri ayrı ayrı okumak satırları ortadan böler ve küçük boyut
 * eşiğine takılır; çizim sırasındaki komşu şeritler tek sayfa görüntüsü olur.
 */
export function stitchStrips(images: readonly OcrPageImage[]): OcrPageImage[] {
  const out: OcrPageImage[] = [];
  for (const image of images) {
    const last = out[out.length - 1];
    if (last && last.width === image.width && last.kind === image.kind && image.height < MIN_IMAGE_SIDE) {
      const merged = new Uint8Array(last.data.length + image.data.length);
      merged.set(last.data, 0);
      merged.set(image.data, last.data.length);
      out[out.length - 1] = { width: last.width, height: last.height + image.height, kind: last.kind, data: merged };
    } else {
      out.push(image);
    }
  }
  return out;
}

/** Görüntüleri sırayla tanır; hiç uygun görüntü yoksa `null`. */
export async function ocrImages(images: readonly OcrPageImage[], engine: OcrEngine): Promise<OcrOutcome | null> {
  const texts: string[] = [];
  let confidenceTotal = 0;
  let count = 0;
  for (const image of images) {
    const png = pageImageToPng(image);
    if (!png) continue;
    const result = await engine.recognize(png);
    texts.push(result.text.trim());
    confidenceTotal += result.confidence;
    count += 1;
  }
  if (count === 0) return null;
  return { text: texts.filter(Boolean).join('\n\n'), confidence: Math.round(confidenceTotal / count), images: count };
}

/**
 * tesseract.js motoru (Türkçe). Tek işçi; çağrılar sıraya alınır. `langPath` boşsa
 * tesseract.js dil verisini kendi dağıtım adresinden bir kez indirip `cachePath`'e yazar;
 * ağsız sunucuda `OCR_LANG_PATH` ile yerel dizin verilir.
 */
export async function createTesseractEngine(options: { langPath?: string; cachePath?: string }): Promise<OcrEngine> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('tur', 1, {
    ...(options.langPath ? { langPath: options.langPath } : {}),
    ...(options.cachePath ? { cachePath: options.cachePath } : {}),
  });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    recognize(png: Buffer) {
      const next = queue.then(async () => {
        const { data } = await worker.recognize(png);
        return { text: data.text ?? '', confidence: data.confidence ?? 0 };
      });
      queue = next.catch(() => undefined);
      return next;
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

let sharedEngine: Promise<OcrEngine> | null = null;

/** Süreç başına tek motor (ilk kullanımda kurulur). OCR kapalıysa `null`. */
export function sharedOcrEngine(config: { enabled: boolean; langPath: string; cachePath: string }): Promise<OcrEngine> | null {
  if (!config.enabled) return null;
  sharedEngine ??= createTesseractEngine({ langPath: config.langPath || undefined, cachePath: config.cachePath });
  // Kurulum başarısızsa bir sonraki çağrı yeniden dener (kalıcı hatayı önbelleklemez).
  sharedEngine.catch(() => {
    sharedEngine = null;
  });
  return sharedEngine;
}
