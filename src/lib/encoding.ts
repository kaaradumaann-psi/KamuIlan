/**
 * Karakter kodlaması çözümü.
 *
 * Türk kamu sitelerinin bir kısmı ISO-8859-9 / Windows-1254 kullanır; UTF-8
 * varsayımı Türkçe karakterleri bozar (ş, ğ, ı, İ). Bu modül Content-Type
 * başlığından veya <meta charset> etiketinden kodlamayı bulur ve metni çözer.
 */
import iconv from 'iconv-lite';

const CHARSET_ALIASES: Record<string, string> = {
  'iso-8859-9': 'iso-8859-9',
  'iso8859-9': 'iso-8859-9',
  latin5: 'iso-8859-9',
  'windows-1254': 'windows-1254',
  cp1254: 'windows-1254',
  'tr-tr': 'iso-8859-9',
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'iso-8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
};

export function normalizeCharsetLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const cleaned = label.trim().toLowerCase().replace(/["']/g, '');
  if (!cleaned) return null;
  return CHARSET_ALIASES[cleaned] ?? cleaned;
}

/** Content-Type başlığından charset çıkarır: text/html; charset=iso-8859-9 */
export function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*([^;,\s]+)/i.exec(contentType);
  return normalizeCharsetLabel(match?.[1] ?? null);
}

/** HTML/XML başlığındaki <meta charset> ya da <?xml encoding> bildirimini bulur. */
export function charsetFromMarkup(head: Buffer): string | null {
  const ascii = head.toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(ascii);
  if (meta?.[1]) return normalizeCharsetLabel(meta[1]);
  const httpEquiv = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_-]+)/i.exec(ascii);
  if (httpEquiv?.[1]) return normalizeCharsetLabel(httpEquiv[1]);
  const xml = /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_-]+)["']/i.exec(ascii);
  if (xml?.[1]) return normalizeCharsetLabel(xml[1]);
  return null;
}

/** Geçerli çözümlenebilir mi? Bilinmeyen etiketlerde UTF-8'e düşeriz. */
export function canDecode(charset: string): boolean {
  try {
    return iconv.encodingExists(charset);
  } catch {
    return false;
  }
}

export interface DecodedBody {
  text: string;
  charset: string;
  /** Kodlama tahmin edildi mi (başlıkta belirtilmemişti)? */
  charsetGuessed: boolean;
}

/**
 * Gövdeyi metne çevirir.
 * Öncelik: Content-Type charset → meta bildirimi → UTF-8 (geçersizse ISO-8859-9).
 */
export function decodeBody(buffer: Buffer, contentType: string | null = null, headLimit = 4096): DecodedBody {
  const fromHeader = charsetFromContentType(contentType);
  const head = buffer.subarray(0, Math.min(buffer.length, headLimit));
  const fromMarkup = charsetFromMarkup(head);

  let charset = fromHeader ?? fromMarkup ?? 'utf-8';
  let guessed = !(fromHeader ?? fromMarkup);

  if (!canDecode(charset)) {
    charset = 'utf-8';
    guessed = true;
  }

  let text = decodeWith(buffer, charset);
  if (charset === 'utf-8' && text.includes('\uFFFD') && !guessed) {
    // Başlık UTF-8 diyor ama gövde bozuk: Türkçe için en olası kodlama.
    text = decodeWith(buffer, 'iso-8859-9');
    charset = 'iso-8859-9';
    guessed = true;
  } else if (charset === 'utf-8' && text.includes('\uFFFD')) {
    const fallback = decodeWith(buffer, 'iso-8859-9');
    if (!fallback.includes('\uFFFD') || countReplacement(fallback) < countReplacement(text)) {
      text = fallback;
      charset = 'iso-8859-9';
    }
  }

  return { text, charset, charsetGuessed: guessed };
}

function decodeWith(buffer: Buffer, charset: string): string {
  if (charset === 'utf-8') return buffer.toString('utf8');
  return iconv.decode(buffer, charset);
}

function countReplacement(value: string): number {
  let count = 0;
  for (const char of value) if (char === '\uFFFD') count += 1;
  return count;
}
