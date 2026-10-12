/**
 * PDF metin çıkarımı.
 *
 * Akış:
 *  1. Metin katmanı var mı? (pdfjs ile sayfa sayfa metin toplanır)
 *  2. Metin katmanı yoksa (taranmış belge) OCR gerekir. Bu sürümde OCR
 *     bağımlılığı yoktur; kayıt SİLİNMEZ, ek bağlantısı korunur ve belge
 *     "metin katmanı yok" olarak işaretlenip incelemeye gönderilir.
 *  3. Bozuk/açılamayan PDF: hata yutulmaz; `error` alanı doldurulur, ilan
 *     ek bağlantısıyla birlikte saklanır (kayıp yok).
 */
import { createRequire } from 'node:module';
import { collapseWhitespace } from '../domain/text';

const require = createRequire(import.meta.url);

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  hasTextLayer: boolean;
  /** Metin katmanı olmayan sayfa sayısı (OCR gerektiren). */
  emptyPages: number;
  truncated: boolean;
  error: string | null;
}

export interface PdfExtractOptions {
  /** Bellek koruması: bu sayıdan fazla sayfa okunmaz. */
  maxPages?: number;
  /** Toplam karakter sınırı. */
  maxChars?: number;
}

interface PdfTextItem {
  str?: string;
}

interface PdfPageProxy {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup(): void;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(params: { data: Uint8Array; isEvalSupported: false; useSystemFonts: boolean }): {
    promise: Promise<PdfDocumentProxy>;
  };
  GlobalWorkerOptions?: { workerSrc?: string };
}

let pdfModule: PdfJsModule | null = null;

/**
 * pdfjs-dist legacy derlemesi Node tarafında kullanılır. Modül yüklenemezse
 * (ör. eksik bağımlılık) hata döndürülür; ilan kaybolmaz.
 */
export function loadPdfJs(): PdfJsModule | null {
  if (pdfModule) return pdfModule;
  try {
    const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as PdfJsModule;
    pdfModule = legacy;
    return legacy;
  } catch (error) {
    try {
      const modern = require('pdfjs-dist') as PdfJsModule;
      pdfModule = modern;
      return modern;
    } catch {
      throw new Error(`PDF kütüphanesi yüklenemedi: ${(error as Error).message}`);
    }
  }
}

export async function extractPdfText(
  data: Uint8Array,
  options: PdfExtractOptions = {},
): Promise<PdfExtractionResult> {
  const maxPages = options.maxPages ?? 40;
  const maxChars = options.maxChars ?? 200_000;
  const result: PdfExtractionResult = {
    text: '',
    pageCount: 0,
    hasTextLayer: false,
    emptyPages: 0,
    truncated: false,
    error: null,
  };

  let doc: PdfDocumentProxy | null = null;
  try {
    const pdfjs = loadPdfJs();
    if (!pdfjs) throw new Error('PDF kütüphanesi bulunamadı');
    doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    result.pageCount = doc.numPages;
    const chunks: string[] = [];
    let chars = 0;

    const pageLimit = Math.min(doc.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = collapseWhitespace(content.items.map((item) => item.str ?? '').join(' '));
      if (pageText.length === 0) result.emptyPages += 1;
      chars += pageText.length;
      chunks.push(pageText);
      page.cleanup();
      if (chars >= maxChars) {
        result.truncated = true;
        break;
      }
    }

    result.text = collapseWhitespace(chunks.join('\n\n'));
    result.hasTextLayer = result.text.length > 0;
    if (result.emptyPages > 0 && result.pageCount > pageLimit) result.truncated = true;
    return result;
  } catch (error) {
    result.error = `PDF ayrıştırma hatası: ${(error as Error).message}`;
    return result;
  } finally {
    if (doc) {
      try {
        await doc.destroy();
      } catch {
        /* temizlik hatası yutulur */
      }
    }
  }
}

/** Testler ve araçlar için: Buffer'dan metin. */
export async function extractPdfTextFromBuffer(
  buffer: Buffer,
  options: PdfExtractOptions = {},
): Promise<PdfExtractionResult> {
  return extractPdfText(new Uint8Array(buffer), options);
}
