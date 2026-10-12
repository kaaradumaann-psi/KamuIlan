/**
 * PDF metin çıkarımı.
 *
 * İlkeler:
 *  - Önce metin katmanı okunur (pdfjs). Taranmış (görüntü) PDF'lerde metin
 *    katmanı yoktur; bu durumda OCR'a ZORLAMAK yerine durum bildirilir, PDF
 *    ek olarak saklanır ve kayıt "metin çıkarılamadı" notu ile doğrulanır.
 *  - Bozuk/şifreli PDF uygulamayı çökertmez; hata nesnesi döner.
 *  - Metin uzunluğu sınırlanır (bellek) ama kırpıldığı bilgisi açıkça döner.
 */

export interface PdfTextResult {
  text: string;
  pages: number;
  pagesRead: number;
  /** Metin katmanı yok/çok kısa → büyük olasılıkla taranmış görüntü. */
  noTextLayer: boolean;
  truncated: boolean;
  title: string | null;
  error: string | null;
}

export interface PdfExtractOptions {
  maxPages?: number;
  maxChars?: number;
  /** Sayfa başına en az bu kadar karakter varsa metin katmanı var sayılır. */
  minCharsForTextLayer?: number;
}

type PdfTextItem = { str?: string; hasEOL?: boolean };

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup?(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: { Title?: string } }>;
  destroy(): Promise<void>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfModule {
  getDocument(params: Record<string, unknown>): PdfLoadingTask;
}

let cachedModule: PdfModule | null = null;

/** pdfjs-dist'i (legacy derleme) yükler. Modül yoksa hata mesajı ile döner. */
export async function loadPdfJs(): Promise<PdfModule> {
  if (cachedModule) return cachedModule;
  try {
    const legacy = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;
    cachedModule = legacy;
    return legacy;
  } catch {
    const modern = (await import('pdfjs-dist')) as unknown as PdfModule;
    cachedModule = modern;
    return modern;
  }
}

/** PDF bayt dizisinden metin çıkarır. Hata fırlatmaz; `error` alanını doldurur. */
export async function extractPdfText(
  data: Uint8Array,
  options: PdfExtractOptions = {},
): Promise<PdfTextResult> {
  const maxPages = options.maxPages ?? 12;
  const maxChars = options.maxChars ?? 60_000;
  const minChars = options.minCharsForTextLayer ?? 40;

  const empty: PdfTextResult = {
    text: '',
    pages: 0,
    pagesRead: 0,
    noTextLayer: true,
    truncated: false,
    title: null,
    error: null,
  };

  if (data.byteLength === 0) {
    return { ...empty, error: 'PDF boş (0 bayt).' };
  }
  // Çok küçük dosyalar PDF başlığı taşımaz.
  const header = Buffer.from(data.subarray(0, 5)).toString('latin1');
  if (header !== '%PDF-') {
    return { ...empty, error: 'Dosya PDF biçiminde değil (başlık bulunamadı).' };
  }

  let task: PdfLoadingTask | null = null;
  let doc: PdfDocument | null = null;

  try {
    const pdfjs = await loadPdfJs();
    task = pdfjs.getDocument({
      // pdfjs veri tamponunu devralır; kopya veriyoruz ki çağıran taraf bozulmasın.
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Node ortamında worker yerine aynı süreçte çalışır.
      useWorkerFetch: false,
    });
    doc = await task.promise;

    const metadata = await doc.getMetadata().catch(() => ({ info: undefined }));
    const title = metadata.info?.Title && metadata.info.Title.trim().length > 2 ? metadata.info.Title.trim() : null;

    const pagesToRead = Math.min(doc.numPages, maxPages);
    const parts: string[] = [];
    let charCount = 0;
    let truncated = false;
    let pagesRead = 0;

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageParts: string[] = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        pageParts.push(item.str);
        if (item.hasEOL) pageParts.push('\n');
      }
      const pageText = normalizePdfWhitespace(pageParts.join(' '));
      pagesRead += 1;
      charCount += pageText.length;
      parts.push(pageText);
      page.cleanup?.();
      if (charCount >= maxChars) {
        // Kırpma nedeni: ya okunacak sayfa kaldı ya da bu sayfa sınırı aştı.
        truncated = pageNumber < pagesToRead || charCount > maxChars;
        break;
      }
    }

    const joined = parts.join('\n\n');
    const text = joined.slice(0, maxChars);
    // Tek sayfa bile sınırı aşmış olabilir; o durumda da kırpıldığı bildirilir.
    if (text.length < joined.length) truncated = true;
    const noTextLayer = text.replace(/\s/g, '').length < minChars;

    return {
      text,
      pages: doc.numPages,
      pagesRead,
      noTextLayer,
      truncated: truncated || doc.numPages > pagesToRead,
      title,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      error: `PDF okunamadı: ${message.slice(0, 200)}`,
    };
  } finally {
    try {
      await doc?.destroy();
    } catch {
      /* yok sayılır */
    }
    try {
      await task?.destroy();
    } catch {
      /* yok sayılır */
    }
  }
}

/** Türkçe metinde PDF satır kırılmalarından doğan fazla boşlukları düzeltir. */
export function normalizePdfWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2') // satır sonu tirelemesi
    .trim();
}

/** PDF başlığında "İLAN" gibi işaretler var mı? (panelde gösterim için) */
export function looksLikeAnnouncementPdf(text: string): boolean {
  const head = text.slice(0, 1_500).toLocaleLowerCase('tr');
  return /(ilan|alım|alimi|başvuru|kontenjan|personel)/.test(head);
}
