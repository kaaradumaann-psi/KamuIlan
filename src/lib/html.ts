/**
 * HTML helpers (Cheerio).
 *
 * Collected pages are untrusted input:
 *  - script/style/iframe content is never extracted as announcement text.
 *  - Text is returned as plain text, not rendered as HTML.
 *  - Instructions found on a page are data, not system commands (see docs/security.md).
 */
import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import { isTag, type AnyNode } from 'domhandler';
import { collapseWhitespace, stripHtmlTags } from '../domain/text';

export type { CheerioAPI, Cheerio, AnyNode };

export function loadHtml(html: string): CheerioAPI {
  return load(html);
}

/** XML (RSS/Atom) documents: preserve tag names and text nodes as written. */
export function loadXml(xml: string): CheerioAPI {
  return load(xml, { xml: true });
}

/** Plain text: remove executable/non-visible elements and normalize whitespace. */
export function readableText($: CheerioAPI, selector?: string, limit = 20_000): string {
  const root = selector ? $(selector).first() : $.root();
  if (root.length === 0) return '';
  const clone = root.clone();
  stripPageChrome(clone);
  const text = collapseWhitespace(clone.text());
  return text.length > limit ? text.slice(0, limit) : text;
}

export function elementText(element: Cheerio<AnyNode>, limit = 4_000): string {
  const clone = element.clone();
  stripPageChrome(clone);
  const text = collapseWhitespace(clone.text());
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Keep structural boundaries as line breaks when extracting card/list text.
 * A single collapsed paragraph loses institution, province, and date fields
 * that the source presents in separate blocks.
 */
export function blockElementText(element: Cheerio<AnyNode>, limit = 4_000): string {
  const clone = element.clone();
  stripPageChrome(clone);
  const text = stripHtmlTags(clone.html() ?? '');
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Sayfa iskeleti seçicileri: menü/alt bilgi/paylaşım gibi her sayfada tekrar eden
 * bölümler, çerez-KVKK onay modalları ve erişilebilirlik araç çubukları.
 *
 * Bu bölümler hem metin özetini hem bağlantı taramasını kirletir; 2026-10-15 canlı
 * çıktısında icisleri/goc/afad listeleri "Modal content ... GİZLİLİK VE ÇEREZ
 * POLİTİKASI", iskur listeleri "Erişilebilirlik Menüsü Ekran Okuyucu ..." özetleriyle
 * "yapı tanınmadı" hatası vermişti.
 */
export const PAGE_CHROME_SELECTORS: readonly string[] = [
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'object',
  'embed',
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  '[role="navigation"]',
  '[role="complementary"]',
  '[role="dialog"]',
  '[role="toolbar"]',
  '[aria-modal="true"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '.breadcrumb',
  '.breadcrumbs',
  '.navbar',
  '.navigation',
  '.sidebar',
  '.share-buttons',
  '.modal',
  '.modal-dialog',
  '.modal-content',
  '.modal-backdrop',
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="cerez"]',
  '[id*="cerez"]',
  '[class*="consent"]',
  '[id*="consent"]',
  '[class*="kvkk"]',
  '[id*="kvkk"]',
  '[class*="gizlilik"]',
  '[id*="gizlilik"]',
  '[class*="modal"]',
  '[id*="modal"]',
  '[class*="accessibilit"]',
  '[id*="accessibilit"]',
  '[class*="erisilebilirlik"]',
  '[id*="erisilebilirlik"]',
  '[class*="a11y"]',
  '[id*="a11y"]',
];

const CHROME_SELECTORS = PAGE_CHROME_SELECTORS.join(',');

/** Remove recurring page chrome from a selected root before extracting text or links. */
export function stripPageChrome(root: Cheerio<AnyNode>): void {
  root.find(CHROME_SELECTORS).remove();
  root
    .find('[style]')
    .filter((_index, element) => {
      const style = isTag(element) ? (element.attribs.style ?? '') : '';
      return /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
    })
    .remove();
}

/**
 * Parse a document, drop page chrome, and return readable body text. Used for
 * operator-facing diagnostics so a cookie modal or accessibility toolbar is
 * never reported as the page content.
 */
export function chromeFreeText(html: string, limit = 300): string {
  const $ = loadHtml(html);
  stripPageChrome($.root());
  return readableText($, 'body', limit);
}

/** Anchor/markup census used to explain why a list page structure was not recognised. */
export interface PageStructureSummary {
  anchors: number;
  sameHostAnchors: number;
  topPathPrefixes: string[];
  forms: number;
  iframes: number;
  scripts: number;
  bodyTextLength: number;
}

/**
 * Describe what a page actually contains (counts and the most common first path
 * segments) so an operator can fix selector/pathPattern without guessing. Only
 * path prefixes are reported - no query strings, tokens, or full URLs.
 */
export function describePageStructure(html: string, baseUrl: string): PageStructureSummary {
  const $ = loadHtml(html);
  const scripts = $('script').length;
  const iframes = $('iframe').length;
  const forms = $('form').length;
  const rawAnchors = $('a[href]').toArray();
  const counts = new Map<string, number>();
  let sameHostAnchors = 0;
  let baseHost = '';
  try {
    baseHost = new URL(baseUrl).host.toLowerCase();
  } catch {
    baseHost = '';
  }
  for (const node of rawAnchors) {
    const href = isTag(node) ? (node.attribs.href ?? '') : '';
    const resolved = absoluteUrl(href, baseUrl, $);
    if (!resolved) continue;
    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      continue;
    }
    if (baseHost && parsed.host.toLowerCase() === baseHost) sameHostAnchors += 1;
    const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    const key = segment ? `/${segment}` : '/';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  stripPageChrome($.root());
  const topPathPrefixes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([prefix, count]) => `${prefix} (${count})`);
  return {
    anchors: rawAnchors.length,
    sameHostAnchors,
    topPathPrefixes,
    forms,
    iframes,
    scripts,
    bodyTextLength: readableText($, 'body', 20_000).length,
  };
}

/**
 * Extracts the first meaningful preferred announcement container, falling
 * back to body/root. Candidate selectors are ordered from most specific to
 * broadest by the adapter.
 */
export function readableAnnouncementText(
  $: CheerioAPI,
  selectors: readonly string[],
  limit = 100_000,
  options: { stripChrome?: boolean } = {},
): string {
  // Menü/çerez modali/erişilebilirlik araç çubuğu ilan gövdesi sayılmaz; 2026-10-15
  // çıktısında bu iskelet metni gövde kanıtı gibi puanlanıp %49'luk inceleme kayıtları
  // üretmişti. Çağıranın bağlantı taraması bozulmasın diye kopya üzerinde temizlenir.
  const stripChrome = options.stripChrome !== false;
  const candidates = [...selectors, 'body'];
  const seen = new Set<AnyNode>();
  const textOf = (node: AnyNode): string => {
    const selection = $(node);
    if (!stripChrome) return blockElementText(selection, limit + 1);
    const cloned = selection.clone();
    stripPageChrome(cloned);
    return blockElementText(cloned, limit + 1);
  };
  for (const selector of candidates) {
    for (const node of $(selector).toArray()) {
      if (seen.has(node)) continue;
      seen.add(node);
      const text = textOf(node);
      if (text.length >= 80) return text.length > limit ? text.slice(0, limit + 1) : text;
    }
  }
  const root = $.root();
  if (!stripChrome) return blockElementText(root, limit + 1).slice(0, limit + 1);
  const clonedRoot = root.clone();
  stripPageChrome(clonedRoot);
  return blockElementText(clonedRoot, limit + 1).slice(0, limit + 1);
}

/** Resolve a link while ignoring cross-origin or malformed <base href> values. */
export function absoluteUrl(href: string | undefined, baseUrl: string, $?: CheerioAPI): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().startsWith('javascript:')) return null;

  try {
    const pageBase = new URL(baseUrl);
    let effectiveBase = pageBase;
    const baseHref = $?.('base[href]').first().attr('href');
    if (baseHref) {
      try {
        const candidateBase = new URL(baseHref, pageBase);
        if (candidateBase.origin === pageBase.origin) effectiveBase = candidateBase;
      } catch {
        // Malformed base tags are ignored; relative links stay on the page origin.
      }
    }

    const url = new URL(trimmed, effectiveBase);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface Anchor {
  text: string;
  href: string;
  /** Heading level (h1..h6), if the anchor is contained in a heading. */
  headingLevel?: number;
}

/** Collect links below a selected root. */
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

/** Date-like forms found in Turkish notices (03.10.2026, 3 Ekim 2026, 2026-10-03). */
export const DATE_PATTERNS: readonly RegExp[] = [
  /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/g,
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  /\b(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s+(\d{4})\b/gi,
];

/** Extract visible text from an HTML fragment while preserving line breaks. */
export function blockText(html: string, limit = 20_000): string {
  return stripHtmlTags(html).slice(0, limit);
}

/** Clean anchor labels (icons/arrows and excess whitespace). */
export function cleanAnchorText(value: string): string {
  return collapseWhitespace(
    value
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s*[»›→]+\s*$/u, '')
      .replace(/^(?:»|›|→)+\s*/u, ''),
  );
}
