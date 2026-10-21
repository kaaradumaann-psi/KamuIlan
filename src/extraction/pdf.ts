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

/** pdfjs metin parçası: `transform[4..5]` sayfa konumu (x, y), `width` yatay genişlik. */
export type PdfTextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };

/**
 * Metin parçalarını sayfadaki KONUMA göre birleştirir.
 *
 * Eski davranış her parçanın arasına boşluk koyuyordu. Bazı Resmî Gazete PDF'lerinde
 * Türkçe harfler (İ, Ğ, Ş, ı, ğ, ş …) gömülü yazı tipinde AYRI parça olarak gelir:
 * "İKTİSADİ" → "İ KT İ SAD İ", "Doçentliğini" → "Doçentli ğ ini" (RG 16.10.2026-4-14:
 * 554 kopukluk). Bu metin sınıflandırmayı, aramayı ve kadro tablosu okumayı bozuyordu.
 *
 * Kural: yazı YÖNÜ dönüşüm matrisinden okunur (tablo hücrelerinde metin döndürülmüş
 * olabilir: a=d=0, yazı y ekseninde ilerler — RG 16.10-4-14). Aynı yönde ve aynı
 * satırdaki (dik sapma < yazı boyunun %30'u) ardışık iki parça arasındaki boşluk, yazı
 * yönünde yazı boyunun %15'inden küçükse araya boşluk konmaz; aksi hâlde (ya da konum
 * bilgisi yoksa) eskisi gibi tek boşluk. Satır sonu (`hasEOL`) korunur.
 */
export function joinPdfTextItems(items: readonly PdfTextItem[]): string {
  type Glyph = { endX: number; endY: number; dirX: number; dirY: number; size: number };
  let out = '';
  let previous: Glyph | null = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const t = item.transform;
    let geometry: (Glyph & { x: number; y: number }) | null = null;
    if (t && t.length >= 6 && typeof item.width === 'number') {
      const [a, b, c, d, e, f] = t as [number, number, number, number, number, number];
      const advance = Math.hypot(a, b);
      const size = Math.hypot(c, d) || advance || item.height || 1;
      const dirX = advance > 0 ? a / advance : 1;
      const dirY = advance > 0 ? b / advance : 0;
      geometry = { x: e, y: f, endX: e + dirX * item.width, endY: f + dirY * item.width, dirX, dirY, size };
    }
    if (out.length > 0 && !out.endsWith('\n') && item.str.length > 0) {
      let glue = ' ';
      if (previous && geometry && Math.abs(previous.dirX * geometry.dirY - previous.dirY * geometry.dirX) < 0.01) {
        const dx = geometry.x - previous.endX;
        const dy = geometry.y - previous.endY;
        const along = dx * previous.dirX + dy * previous.dirY;
        const across = Math.abs(dx * previous.dirY - dy * previous.dirX);
        if (across < previous.size * 0.3 && along < previous.size * 0.15 && along > -previous.size * 0.5) glue = '';
      }
      if (out.endsWith(' ') || item.str.startsWith(' ')) glue = '';
      out += glue;
    }
    out += item.str;
    if (item.str.length > 0 && geometry) {
      previous = { endX: geometry.endX, endY: geometry.endY, dirX: geometry.dirX, dirY: geometry.dirY, size: geometry.size };
    }
    if (item.hasEOL) {
      out += '\n';
      previous = null;
    }
  }
  return out;
}

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
      const pageText = normalizePdfWhitespace(joinPdfTextItems(content.items));
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
