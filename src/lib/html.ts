/**
 * HTML yardımcıları (cheerio).
 *
 * Toplanan içerik GÜVENSİZ VERİ olarak ele alınır:
 *  - script/style/iframe içerikleri hiç okunmaz.
 *  - Metin her zaman düz metne çevrilir; HTML olarak render edilmez.
 *  - Sayfadaki talimatlar sistem komutu değildir (bkz. docs/security.md).
 */
import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { collapseWhitespace, stripHtmlTags } from '../domain/text';

export type { CheerioAPI, Cheerio, AnyNode };

export function loadHtml(html: string): CheerioAPI {
  return load(html);
}

/** XML (RSS/Atom) belgeleri için: etiket adları ve metin düğümleri aynen korunur. */
export function loadXml(xml: string): CheerioAPI {
  return load(xml, { xml: true });
}

/** Düz metin: script/style/noscript kaldırılır, boşluklar sadeleştirilir. */
export function readableText($: CheerioAPI, selector?: string, limit = 20_000): string {
  const root = selector ? $(selector).first() : $.root();
  if (root.length === 0) return '';
  const clone = root.clone();
  clone.find('script, style, noscript, svg, template').remove();
  const text = collapseWhitespace(clone.text());
  return text.length > limit ? text.slice(0, limit) : text;
}

export function elementText(element: Cheerio<AnyNode>, limit = 4_000): string {
  const clone = element.clone();
  clone.find('script, style, noscript, svg, template').remove();
  const text = collapseWhitespace(clone.text());
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Blok sınırlarını satır sonu olarak KORUYARAK düz metin çıkarır.
 *
 * `elementText` tüm boşlukları tek boşluğa indirger; bir ilan kartında ayrı
 * bloklarda duran kurum / il / tarih alanları bu yüzden tek paragrafta
 * birleşir. Liste ayrıştırıcıları (bkz. `sources/adapters/ilan-gov-tr.ts`)
 * alanları satır satır okuyabilsin diye bu yardımcı kullanılır.
 */
export function blockElementText(element: Cheerio<AnyNode>, limit = 4_000): string {
  const clone = element.clone();
  clone.find('script, style, noscript, svg, template').remove();
  const text = stripHtmlTags(clone.html() ?? '');
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Sayfa içi <base href> dikkate alınarak göreli bağlantıyı mutlaklaştırır. */
export function absoluteUrl(href: string | undefined, baseUrl: string, $?: CheerioAPI): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('javascript:')) return null;
  const baseHref = $?.('base[href]').first().attr('href');
  const effectiveBase = baseHref ? new URL(baseHref, baseUrl).toString() : baseUrl;
  try {
    const url = new URL(trimmed, effectiveBase);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface Anchor {
  text: string;
  href: string;
  /** Kapsayıcı başlık seviyesi (h1..h6) varsa. */
  headingLevel?: number;
}

/** Belirli bir kök altındaki bağlantıları toplar. */
export function anchors($: CheerioAPI, selector: string, baseUrl: string, textLimit = 400): Anchor[] {
  const out: Anchor[] = [];
  $(selector)
    .find('a[href]')
    .each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), baseUrl, $);
      if (!href) return;
      const text = elementText(node, textLimit);
      out.push({ text, href });
    });
  return out;
}

/** Metin içindeki tarih benzeri ifadeleri bulur (03.10.2026, 3 Ekim 2026, 2026-10-03). */
export const DATE_PATTERNS: readonly RegExp[] = [
  /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/g,
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  /\b(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s+(\d{4})\b/gi,
];

/** HTML'den görünür metin çıkarırken satır sonlarını korur. */
export function blockText(html: string, limit = 20_000): string {
  return stripHtmlTags(html).slice(0, limit);
}

/** Bağlantı metnini temizler (ikon/ok işaretleri, fazla boşluk). */
export function cleanAnchorText(value: string): string {
  return collapseWhitespace(
    value
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s*[»›→]+\s*$/u, '')
      .replace(/^(?:»|›|→)+\s*/u, ''),
  );
}
