/**
 * cheerio yardımcıları: güvenli HTML yükleme, mutlak bağlantı üretimi, metin
 * ayıklama. Kaynak HTML'i asla çalıştırılmaz; yalnızca metin/bağlantı okunur.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { collapseWhitespace } from '../domain/text';
import { isHttpUrl, normalizeUrl } from '../domain/urls';

export type CheerioRoot = cheerio.CheerioAPI;
export type CheerioElement = cheerio.Cheerio<AnyNode>;

export function loadHtml(html: string): CheerioRoot {
  return cheerio.load(html);
}

export function textOf(element: CheerioElement): string {
  return collapseWhitespace(element.text());
}

export function attrOf(element: CheerioElement, name: string): string | null {
  const value = element.attr(name);
  return value === undefined ? null : value.trim();
}

/** Göreli bağlantıyı mutlak hâle getirir; HTTP dışı şemaları reddeder. */
export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, base).toString();
    return isHttpUrl(resolved) ? normalizeUrl(resolved) : null;
  } catch {
    return null;
  }
}

/** Bir kökün altındaki tabloları satır satır diziye çevirir. */
export function tableRows(root: CheerioRoot, table: CheerioElement): string[][] {
  const rows: string[][] = [];
  table.find('tr').each((_, tr) => {
    const cells: string[] = [];
    root(tr)
      .find('th,td')
      .each((_index, cell) => {
        cells.push(textOf(root(cell)));
      });
    if (cells.some((cell) => cell.length > 0)) rows.push(cells);
  });
  return rows;
}

/** HTML içindeki tüm bağlantıları (metin + url) döner. */
export function links(root: CheerioRoot, container: CheerioElement, base: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  container.find('a[href]').each((_, anchor) => {
    const element = root(anchor);
    const url = absoluteUrl(element.attr('href'), base);
    const text = textOf(element);
    if (url) out.push({ text, url });
  });
  return out;
}

/** Ana içerik metnini kaba temizlikle çıkarır (script/style/görsel atlanır). */
export function readableText(root: CheerioRoot, container?: CheerioElement): string {
  const target = container ?? root('body');
  const clone = target.clone();
  clone.find('script, style, noscript, svg, iframe, form, nav, footer, header').remove();
  return collapseWhitespace(clone.text());
}

/** Sayfanın meta açıklaması / og:description değeri. */
export function metaDescription(root: CheerioRoot): string | null {
  const value =
    root('meta[name="description"]').attr('content') ??
    root('meta[property="og:description"]').attr('content') ??
    null;
  return value ? collapseWhitespace(value) : null;
}

/** Belge başlığını `<h1>` → `<title>` sırasıyla bulur. */
export function pageTitle(root: CheerioRoot): string | null {
  const h1 = collapseWhitespace(root('h1').first().text());
  if (h1) return h1;
  const title = collapseWhitespace(root('title').first().text());
  return title || null;
}
