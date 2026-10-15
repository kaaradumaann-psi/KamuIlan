/**
 * Liste sayfaları için ortak yardımcılar (adaptörler arasında paylaşılır).
 */
import type { CheerioAPI } from '../lib/html';
import { absoluteUrl, blockElementText, cleanAnchorText, elementText } from '../lib/html';
import { parseTurkishDate } from '../domain/dates';
import { collapseWhitespace } from '../domain/text';
import type { AnyNode, Cheerio } from '../lib/html';

/** Listede görülen yayım/duyuru tarihini YYYY-MM-DD olarak döner. */
export function parseListingDate(text: string | null | undefined): string | null {
  if (!text) return null;
  return parseTurkishDate(text)?.dateOnly ?? null;
}

const REFERENCE_PATTERNS: readonly RegExp[] = [
  // YOK853479, DPB845507, ILN0250539595 gibi resmî ilan numaraları
  /\b([A-Z]{2,4})[-\s]?(\d{5,12})\b/g,
  // "İlan No: YOK-2026-482311" — iki tuzak:
  //  1. `\b` JavaScript'te DAİMA ASCII sözcük sınırıdır (`u` bayrağı bunu
  //     değiştirmez); "İ" sözcük karakteri sayılmadığı için kalıbın başındaki
  //     `\b` satır başındaki "İlan"ı hiç yakalayamaz.
  //  2. `i` bayrağı "İ" (U+0130) ile "i"yi eşleştirmez; harf açıkça yazılır.
  /(?:İ|I)lan\s*(?:No|Numarası)\s*[:.]?\s*([A-Z0-9-]{4,20})/gi,
];

/** Metinden resmî ilan numaralarını çıkarır (tekilleştirme için değerli). */
export function extractReferenceNumbers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] && match[2] ? `${match[1]}${match[2]}` : match[1])?.trim();
      if (value && value.length >= 5) found.push(value.toUpperCase());
    }
  }
  return [...new Set(found)];
}

/** Başlık temizliği: tarih/numaralandırma/jenerik ekler ayıklanır. */
/** Türkçe ay adları (başlıklara yapışan tarih rozetlerini temizlemek için). */
const TURKISH_MONTHS =
  'Ocak|Şubat|Subat|Mart|Nisan|Mayıs|Mayis|Haziran|Temmuz|Ağustos|Agustos|Eylül|Eylul|Ekim|Kasım|Kasim|Aralık|Aralik';

export function cleanTitle(raw: string): string {
  let title = collapseWhitespace(raw);
  title = title.replace(/\s*[-–—]\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}\s*$/u, '');
  // "İlân No: ILN01234567" / "İlan Numarası YOK0123456" — etiketiyle birlikte
  // silinir; aksi halde başlıkta yetim "İlân No:" kalıyordu.
  title = title.replace(
    /\s*[İI]l[âa]n\s*(?:No|Numarası|Numarasi)\s*[:.]?\s*(?:(?:YOK|DPB|ILN)\s?-?\s?)?\d{5,12}\b/giu,
    ' ',
  );
  title = title.replace(/\b(YOK|DPB|ILN)\s?-?\s?\d{5,12}\b/gi, ' ');
  // Sondaki tarih rozeti: "…Hakkında Duyuru07 Eylül 2026" → "…Hakkında Duyuru".
  // Satır metninden üretilen başlıklarda kartın kategori etiketi ve tarihi
  // başlığa yapışıyordu (2026-10-16 panel görüntüsü).
  title = title.replace(
    new RegExp(`\\s*\\(?\\d{1,2}\\s*(?:${TURKISH_MONTHS})\\s*\\d{4}(?:\\s+\\d{1,2}[:.]\\d{2})?\\s*(?:tarihli|tarihinde)?\\s*\\)?\\s*$`, 'iu'),
    '',
  );
  title = title.replace(/\s*\(?\d{2}[.\-/]\d{2}[.\-/]\d{4}\s*(?:tarihli|tarihinde)?\s*\)?\s*/giu, ' ');
  title = title.replace(/\s*İlan\s*(?:No|Numarası)\s*[:.]?\s*[A-Z0-9-]{4,20}\s*/gi, ' ');
  // Yapışık ikiz sözcük: satır rozeti bağlantı metninin sonuna bitişir
  // ("…DuyuruDuyuru"). Boşluksuz tekrar gerçek başlıkta olmaz.
  title = title.replace(/(\p{L}{3,})\1/gu, '$1');
  // Sondaki YAPIŞIK kategori rozeti: "…Bilişim Personel Alım İlanıDuyuru" →
  // "…Bilişim Personel Alım İlanı". Rozetten önce boşluk varsa dokunulmaz
  // ("…Hakkında Duyuru" gerçek bir başlıktır).
  title = title.replace(/(\p{L})(?:Duyuru|Haber|[İI]lan|Etkinlik|Güncel|Genel)$/u, '$1');
  // Baştaki yapışık rozet: "GüncelTapu Arşivleri…", "Yeni2026 Yılı…"
  title = title.replace(/^(?:Güncel|Guncel|Yeni|Önemli|Onemli|Son|Duyuru|Haber)(?=[\p{Lu}\d])/u, '');
  // Kırıntı (breadcrumb) başlangıcı: "Ana Sayfa İlanlar Kamu Memur Alım İlanları".
  title = title.replace(/^Ana\s+Sayfa\s+/iu, '');
  title = title.replace(/\s{2,}/g, ' ').trim();
  return title.replace(/[:;,–—-]\s*$/u, '').trim();
}

/** Kurum adı temizliği: sonundaki iki nokta, fazla boşluk, "- İlan" ekleri. */
export function cleanInstitution(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = collapseWhitespace(raw)
    .replace(/\s*[-–—]\s*(?:İlan|Duyuru|Personel).*$/iu, '')
    .replace(/[:;]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return value.length >= 4 ? value : null;
}

/** Bağlantı metni bir ilan/detay bağlantısına mı benziyor? */
export function isLikelyDetailLink(text: string, href: string): boolean {
  if (/\b(?:detay|devam|incele|tümü|tumu|daha fazla|tüm haberler)\b/i.test(text)) return true;
  if (/\/(?:ilan|duyuru|haber|icerik|detay)[/-]/i.test(href)) return true;
  if (/\d{4,}\/?$/.test(href.replace(/\/$/, ''))) return true;
  return false;
}

export interface PagedLink {
  url: string;
  page: number;
}

/**
 * "Sonraki sayfa" bağlantılarını bulur (currentPage=N, sayfa=N, ?p=N gibi).
 * Sayfalama adı çeşitli olduğundan desen listesiyle aranır; ilk sayfa hariç.
 */
export function findPaginationLinks(
  $: CheerioAPI,
  baseUrl: string,
  options: { param: string; maxPage: number; currentPage?: number },
): PagedLink[] {
  const links: PagedLink[] = [];
  const parameter = options.param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`[?&]${parameter}=(\\d+)`, 'i');

  $('a[href]').each((_index, element) => {
    const node = $(element);
    const href = absoluteUrl(node.attr('href'), baseUrl, $);
    if (!href) return;
    const match = pattern.exec(href);
    if (!match?.[1]) return;
    const page = Number(match[1]);
    if (!Number.isFinite(page) || page < 1 || page > options.maxPage) return;
    if (options.currentPage !== undefined && page === options.currentPage) return;
    links.push({ url: href, page });
  });

  return links
    .filter((link, index, array) => array.findIndex((candidate) => candidate.page === link.page) === index)
    .sort((a, b) => a.page - b.page);
}

/**
 * Bir tablo satırını/ liste öğesini "başlık + tarih + bağlantı" olarak okur.
 * Farklı kaynaklarda ortak olan en küçük ortak payda budur.
 */
export function readListRow(
  $: CheerioAPI,
  element: Cheerio<AnyNode>,
  baseUrl: string,
): { title: string; date: string | null; href: string | null; referenceNo: string | null } | null {
  const anchor = element.find('a[href]').first();
  const href = anchor.length > 0 ? absoluteUrl(anchor.attr('href'), baseUrl, $) : null;
  const text = elementText(element, 1_500);
  const title = cleanTitle(anchor.length > 0 ? elementText(anchor, 400) || text : text);
  if (title.length < 8) return null;
  const dateText = text.match(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/)?.[0] ?? text;
  return {
    title,
    date: parseListingDate(dateText),
    href,
    referenceNo: extractReferenceNumbers(text)[0] ?? null,
  };
}

export { cleanAnchorText };

/**
 * Bağlantının kendi kartının (satır, madde, hücre) metni.
 *
 * Kart birden çok FARKLI ilan kimliği taşıyorsa paylaşılmış bir kapsayıcıdır: tarih, il,
 * kurum ve gövde gibi alanlar komşu ilandan karışabilir. Bu durumda null döner ve çağıran
 * yalnızca bağlantının kendi metnini kullanır. Aynı ilana giden iki bağlantı (başlık ve
 * "devamı") tek kimlik sayılır; böylece tek ilanlık gerçek kartlar kaybolmaz.
 *
 * `keyOf`, bir bağlantı adresinden ilan kimliğini döndürür (ilan değilse null).
 */
export function ownCardText(
  anchor: Cheerio<AnyNode>,
  selector: string,
  keyOf: (href: string) => string | null,
  limit: number,
): string | null {
  const card = anchor.closest(selector);
  if (card.length === 0) return null;
  const keys = new Set<string>();
  for (const element of card.find('a[href]').toArray()) {
    const href = (element as { attribs?: Record<string, string> }).attribs?.href ?? '';
    const key = keyOf(href);
    if (key) keys.add(key);
  }
  if (keys.size > 1) return null;
  return blockElementText(card, limit);
}
