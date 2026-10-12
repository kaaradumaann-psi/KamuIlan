/**
 * Liste sayfaları için ortak yardımcılar.
 * Adaptörler bu fonksiyonları kullanır; böylece tarih/kurum ayıklama tek yerde kalır.
 */
import type { CheerioAPI } from 'cheerio';
import { collapseWhitespace, normalizeTr } from '../domain/text';
import { parseTurkishDate } from '../domain/dates';
import { absoluteUrl } from '../lib/html';

const TR_MONTHS =
  '(ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)';

/** Liste satırındaki tarih metnini ISO damgasına çevirir; yıl yoksa null. */
export function parseListingDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = parseTurkishDate(raw);
  return parsed?.iso ?? null;
}

/**
 * ÖSYM/MEB gibi sitelerde tarih `dd.MM.yyyy` biçiminde ayrı bir sütunda durur.
 * Bu fonksiyon metnin tamamından ilk tarihi bulur.
 */
export function firstDateIn(text: string): string | null {
  const parsed = parseTurkishDate(text);
  return parsed?.iso ?? null;
}

/** "12 Ekim 2026" / "12.10.2026" gibi ifadeleri bulan genel kalıp. */
export const DATE_TEXT_PATTERN = new RegExp(
  `(\\d{1,2}\\s*[./-]\\s*\\d{1,2}\\s*[./-]\\s*\\d{4}|\\d{1,2}\\s+${TR_MONTHS}\\s+\\d{4})`,
  'i',
);

/** Kurum adı sütunundan temizlik: fazla boşluk, tire ve etiketler kaldırılır. */
export function cleanInstitution(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = collapseWhitespace(
    raw
      .replace(/\s*[-–—]\s*$/, '')
      .replace(/^[-–—•]\s*/, '')
      .replace(/\s+/g, ' '),
  );
  return cleaned.length >= 3 ? cleaned : null;
}

/** Başlık temizliği: baştaki/sondaki ilan numarası ve etiketleri ayıklar. */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  return collapseWhitespace(
    raw
      .replace(/^\s*[-–—•\d.]+\s*/, '')
      .replace(/\s*[-–—•]\s*(?:YOK|DPB|ILN)\d+\s*$/i, '')
      .replace(/\s+/g, ' '),
  );
}

/**
 * İlan numarası: "YOK853480", "DPB845507", "ILN02566625" gibi resmî referanslar.
 * Tekilleştirmede kaynağın resmî kimliği olarak kullanılır.
 */
export function extractReferenceNo(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /\b(?:YOK|DPB|ILN|ILN0?)[\s-]?(\d{4,12})\b/i.exec(text);
  if (!match) return null;
  const prefix = /\b(YOK|DPB|ILN)\b/i.exec(match[0])?.[1] ?? '';
  return `${prefix}${match[1]}`.toUpperCase();
}

/** Bir bağlantı metninden/URL'inden ilan kimliği üretir (kaynak içi kararlı kimlik). */
export function sourceItemIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    return last.replace(/\.[a-z0-9]{1,5}$/i, '') || normalizeTr(parsed.hostname);
  } catch {
    return normalizeTr(url).slice(0, 60);
  }
}

/** Sayfadaki "sayfalama" bağlantılarından sonraki sayfa adresini bulur. */
export function findNextPageUrl(root: CheerioAPI, container: string, base: string): string | null {
  const selectors = [
    'a[rel="next"]',
    '.pagination a.next',
    '.pagination a[aria-label*="Sonraki" i]',
    'a[title*="Sonraki" i]',
    'li.next a',
    '.pager a:contains("Sonraki")',
    'a:contains("Sonraki sayfa")',
  ];
  for (const selector of selectors) {
    const href = root(`${container} ${selector}`).first().attr('href') ?? root(selector).first().attr('href');
    const url = absoluteUrl(href, base);
    if (url) return url;
  }
  return null;
}

/** Türkçe ay adını sayıya çevirir (liste sıralaması/doğrulama için). */
export function parseTurkishMonthName(name: string): number | null {
  const map: Record<string, number> = {
    ocak: 1,
    şubat: 2,
    subat: 2,
    mart: 3,
    nisan: 4,
    mayıs: 5,
    mayis: 5,
    haziran: 6,
    temmuz: 7,
    ağustos: 8,
    agustos: 8,
    eylül: 9,
    eylul: 9,
    ekim: 10,
    kasım: 11,
    kasim: 11,
    aralık: 12,
    aralik: 12,
  };
  return map[normalizeTr(name)] ?? null;
}
