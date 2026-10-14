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

const CHROME_SELECTORS = [
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
  '[aria-hidden="true"]',
  '[hidden]',
  '.breadcrumb',
  '.breadcrumbs',
  '.navbar',
  '.navigation',
  '.sidebar',
  '.share-buttons',
].join(',');

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
 * Extracts the first meaningful preferred announcement container, falling
 * back to body/root. Candidate selectors are ordered from most specific to
 * broadest by the adapter.
 */
export function readableAnnouncementText(
  $: CheerioAPI,
  selectors: readonly string[],
  limit = 100_000,
): string {
  const candidates = [...selectors, 'body'];
  const seen = new Set<AnyNode>();
  for (const selector of candidates) {
    for (const node of $(selector).toArray()) {
      if (seen.has(node)) continue;
      seen.add(node);
      const text = blockElementText($(node), limit + 1);
      if (text.length >= 80) return text.length > limit ? text.slice(0, limit + 1) : text;
    }
  }
  return blockElementText($.root(), limit + 1).slice(0, limit + 1);
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
