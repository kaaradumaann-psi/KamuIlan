/**
 * HTTP gövdesi kod çözümü.
 *
 * Kamu sitelerinde hâlâ windows-1254 / iso-8859-9 içerik görülüyor. Yanlış kod
 * çözümü Türkçe karakterleri bozar ve sınıflandırma anahtar kelimeleri tutmaz.
 */
import iconv from 'iconv-lite';
import { normalizeTr } from '../domain/text';

const TURKISH_CHARSETS = new Set(['windows-1254', 'iso-8859-9', 'iso88599', 'latin5', 'cp1254', 'tr']);

export function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

/** HTML başındaki <meta charset> / http-equiv bilgisini okur. */
export function charsetFromHtml(head: Buffer): string | null {
  const ascii = head.subarray(0, 4096).toString('latin1');
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(ascii);
  if (metaCharset?.[1]) return metaCharset[1].toLowerCase();
  const httpEquiv = /content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(ascii);
  return httpEquiv?.[1]?.toLowerCase() ?? null;
}

/**
 * Gövdeyi metne çevirir. Sıra: Content-Type charset → meta charset → UTF-8
 * doğrulaması → Türkçe kod sayfaları.
 */
export function decodeBody(buffer: Buffer, contentType?: string | null): { text: string; charset: string } {
  const declared = charsetFromContentType(contentType);
  const candidates: string[] = [];
  if (declared) candidates.push(declared);
  void TURKISH_CHARSETS;
  const meta = charsetFromHtml(buffer);
  if (meta && !candidates.includes(meta)) candidates.push(meta);

  for (const charset of candidates) {
    if (charset === 'utf-8' || charset === 'utf8') {
      const text = buffer.toString('utf8');
      if (!text.includes('\uFFFD')) return { text, charset: 'utf-8' };
      continue;
    }
    if (iconv.encodingExists(charset)) {
      return { text: iconv.decode(buffer, charset), charset };
    }
  }

  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, charset: 'utf-8' };

  // UTF-8 çözümü bozulduyse Türkçe kod sayfalarını sırayla dene; en az
  // bozulma üreteni seç.
  for (const charset of ['windows-1254', 'iso-8859-9', 'windows-1252']) {
    if (!iconv.encodingExists(charset)) continue;
    const text = iconv.decode(buffer, charset);
    const score = turkishScore(text);
    if (score > 0) return { text, charset };
  }
  return { text: iconv.decode(buffer, 'windows-1254'), charset: 'windows-1254' };
}

/** Türkçe karakterleri yanlış çözümde bozulmaya karşı puanlar. */
export function turkishScore(text: string): number {
  const markers = ['ı', 'ş', 'ğ', 'ü', 'ö', 'ç', 'İ', 'Ş', 'Ğ', 'Ü', 'Ö', 'Ç', 'personel', 'ilan'];
  const folded = normalizeTr(text);
  let score = 0;
  for (const marker of markers) {
    if (folded.includes(normalizeTr(marker))) score += 1;
  }
  // Bozulma göstergeleri
  score -= (text.match(/Ã/g) ?? []).length > 3 ? 5 : 0;
  return score;
}
