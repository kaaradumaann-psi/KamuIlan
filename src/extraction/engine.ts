/**
 * Alan çıkarım motoru.
 *
 * İlkeler:
 *  - Tahmin yürütülmez. Bir alan metinden güvenle çıkarılamıyorsa boş bırakılır
 *    ve arayüzde "belirtilmemiş" olarak gösterilir.
 *  - Tarihler için `parseTurkishDate(Range)` kullanılır; yıl içermeyen ifadelerden
 *    kesin tarih üretilmez.
 *  - Her alan için kanıt (metinde eşleşen parça) ve kaynak (başlık/gövde/ek)
 *    saklanır; kullanıcı bilginin nereden geldiğini görebilir.
 */
import { collapseWhitespace, normalizeTr, uniquePreserve } from '../domain/text';
import { findDateTokens, parseTurkishDate, parseTurkishDateRange, type ParsedTurkishDate } from '../domain/dates';
import { fileExtensionOf, hostOf, isHttpUrl, normalizeUrl } from '../domain/urls';
import { PROVINCES } from '../domain/provinces';
import { KPSS_SCORE_TYPES, type EducationLevel, type JobAttachment, type JobRequirements, type KpssScoreType } from '../domain';
import { EXTRACTION_VERSION } from '../config/app';
import { APPLICATION_HOSTS, APPLICATION_LINK_TEXT_PATTERNS, CERTIFICATES, DEPARTMENTS, FOREIGN_LANGUAGES, JOB_TITLES } from './dictionaries';

export interface ExtractionInput {
  title: string;
  body?: string | null;
  /** Kaynağın verdiği kurum bilgisi (varsa otoriter kabul edilir). */
  institutionHint?: string | null;
  /** Kaynak listesinden gelen yayım tarihi. */
  publishedAt?: string | null;
  /** Kaynağın verdiği yapılandırılmış tarihler (varsa otoriter). */
  applicationStartAt?: string | null;
  applicationEndAt?: string | null;
  /** Kaynak listesindeki şehir bilgisi (ilan.gov.tr verir). */
  cityHint?: string | null;
  /** Kaynağın verdiği ilan numarası. */
  referenceHint?: string | null;
  attachments?: JobAttachment[];
  baseUrl?: string;
  /** Gövde PDF'ten geldiyse 'document'. */
  bodySource?: 'listing' | 'detail' | 'document';
}

export interface ExtractionResult {
  institution: string | null;
  unit: string | null;
  city: string | null;
  district: string | null;
  quota: number | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  publishedAt: string | null;
  applicationUrl: string | null;
  originalRefNo: string | null;
  titles: string[];
  requirements: JobRequirements;
  attachments: JobAttachment[];
  specialConditions: string[];
  /** Alan bazlı kanıt: kullanıcı arayüzünde gösterilir. */
  evidence: Record<string, string>;
  /** Alan bazlı kaynak. */
  fieldSources: Record<string, string>;
  confidence: number;
  notes: string[];
  version: string;
}

const EMPTY_REQUIREMENTS: JobRequirements = {
  educationLevels: [],
  departments: [],
  kpssScoreTypes: [],
  kpssMinScore: undefined,
  kpssYear: undefined,
  minAge: undefined,
  maxAge: undefined,
  certificates: [],
  minExperienceYears: undefined,
  foreignLanguages: [],
  specialConditions: [],
};

/**
 * Başvuru penceresini bulur.
 *
 * Birden çok kalıp ve jeton tabanlı yedek birlikte denenir; en bilgilendirici
 * aday (hem başlangıç hem bitiş, saat bilgisi varsa saat dahil) seçilir.
 * "Yayım tarihi" gibi başvuruyla ilgisiz tarihler pencereye alınmaz.
 */
function findApplicationWindow(body: string): {
  start: ParsedTurkishDate | null;
  end: ParsedTurkishDate | null;
  evidence: string | null;
} {
  const text = collapseWhitespace(body);
  const patterns: RegExp[] = [
    // Başvurular 14/09/2026 (09:00) – 24/09/2026 (23:59) tarihleri arasında
    /ba[şs]vuru\w*[\s\S]{0,80}?(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}(?:\s*\(?\s*(?:saat\s*)?\d{1,2}[:.]\d{2}\s*\)?)?[\s\S]{1,40}?\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}(?:\s*\(?\s*(?:saat\s*)?\d{1,2}[:.]\d{2}\s*\)?)?)/i,
    // Son başvuru tarihi: 26.10.2026
    /son\s+ba[şs]vuru(?:\s+tarihi)?\s*[:\-]?\s*(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}(?:\s*\(?\s*(?:saat\s*)?\d{1,2}[:.]\d{2}\s*\)?)?)/i,
    // Başvuru tarihleri: 12-26 Ekim 2026
    /ba[şs]vuru\s+tarihleri?\s*[:\-]?\s*(\d{1,2}\s*[-–—]\s*\d{1,2}\s+\p{L}+\s+\d{4})/iu,
    // Başvurular 12-26 Ekim 2026 tarihleri arasında
    /ba[şs]vuru\w*[\s\S]{0,40}?(\d{1,2}\s*[-–—]\s*\d{1,2}\s+\p{L}+\s+\d{4})/iu,
    // 12 Ekim 2026 - 26 Ekim 2026 tarihleri arasında
    /(\d{1,2}\s+\p{L}+\s+\d{4})\s*[-–—]\s*(\d{1,2}\s+\p{L}+\s+\d{4})/iu,
    // Başvuru süresi: 12.10.2026 – 26.10.2026
    /ba[şs]vuru\s+s[üu]resi[\s\S]{0,40}?(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4})[\s\S]{0,20}?([0-9]{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4})/i,
  ];

  const candidates: { start: ParsedTurkishDate | null; end: ParsedTurkishDate | null; evidence: string | null }[] = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const window = parseTurkishDateRange(match[0]);
    if (window.start || window.end) candidates.push({ ...window, evidence: match[0].trim() });
  }

  // Yedek: yalnızca "başvuru" kelimesine 80 karakterden yakın tarihler dikkate alınır.
  const tokens = findDateTokens(text).filter((token) => {
    const context = text.slice(Math.max(0, token.index - 80), token.index + 80);
    return /ba[şs]vuru/i.test(context);
  });
  if (tokens.length >= 2) {
    const first = tokens[0] as { index: number; parsed: ParsedTurkishDate };
    const last = tokens[tokens.length - 1] as { index: number; parsed: ParsedTurkishDate };
    candidates.push({
      start: first.parsed,
      end: last.parsed,
      evidence: `${first.parsed.matched} … ${last.parsed.matched}`,
    });
  } else if (tokens.length === 1) {
    const only = tokens[0] as { index: number; parsed: ParsedTurkishDate };
    const context = text.slice(Math.max(0, only.index - 60), only.index + 60);
    if (/son\s+ba[şs]vuru/i.test(context)) {
      candidates.push({ start: null, end: only.parsed, evidence: only.parsed.matched });
    }
  }

  if (candidates.length === 0) return { start: null, end: null, evidence: null };

  const score = (candidate: { start: ParsedTurkishDate | null; end: ParsedTurkishDate | null }): number =>
    (candidate.start ? 1 : 0) + (candidate.end ? 2 : 0) + (candidate.start?.hadTime ? 0.5 : 0) + (candidate.end?.hadTime ? 0.5 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] as {
    start: ParsedTurkishDate | null;
    end: ParsedTurkishDate | null;
    evidence: string | null;
  };
}

/** Kontenjan: "12 kişi", "5 adet sözleşmeli", "kontenjan: 30" */
export function extractQuota(text: string): { quota: number | null; evidence: string | null } {
  const patterns: RegExp[] = [
    /(?:kontenjan[ıi]?|kadro\s+say[ıi]s[ıi]|pozisyon\s+say[ıi]s[ıi])\s*[:\-]?\s*(\d{1,4})/i,
    /(\d{1,4})\s*(?:\(?[\w\s]{0,30}?\)?)?\s*(?:ki[şs]i|adet|personel|eleman|pozisyon)\b/i,
    /toplam\s+(\d{1,4})\s*(?:ki[şs]i|adet|personel|eleman)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const valueText = match[1];
    if (!valueText) continue;
    const value = Number(valueText);
    if (!Number.isFinite(value) || value <= 0 || value > 20_000) continue;
    // "657 sayılı Kanun" gibi sayıları kontenjan sanmayalım.
    if (/\b(?:say[ıi]l[ıi]|y[ıi]l[ıi]?|madde|puan|ya[şs])\b/i.test(match[0])) continue;
    return { quota: value, evidence: match[0].trim() };
  }
  return { quota: null, evidence: null };
}

/** Şehir: metinde geçen il adlarından en sık geçeni seçer. */
export function extractCity(text: string): { city: string | null; evidence: string | null } {
  const normalized = ` ${normalizeTr(text)} `;
  let best: { city: string; count: number } | null = null;
  for (const province of PROVINCES) {
    const needle = ` ${normalizeTr(province.name)} `;
    let count = 0;
    let index = normalized.indexOf(needle);
    while (index >= 0) {
      count += 1;
      index = normalized.indexOf(needle, index + needle.length - 1);
    }
    if (count > 0 && (!best || count > best.count)) best = { city: province.name, count };
  }
  return best ? { city: best.city, evidence: best.city } : { city: null, evidence: null };
}

/** Kurum adı: "…Bakanlığından:", "…Rektörlüğünden:" kalıpları. */
export function extractInstitution(title: string, body: string): { institution: string | null; evidence: string | null } {
  const sources = [title, body];
  const pattern =
    /([A-ZÇĞİÖŞÜ][\wçğıöşüÇĞİÖŞÜ.,'’\- ]{5,140}?(?:Bakanlığı|Bakanlığından|Başkanlığı|Başkanlığından|Rektörlüğü|Rektörlüğünden|Genel Müdürlüğü|Genel Müdürlüğünden|Müdürlüğü|Müdürlüğünden|Belediye Başkanlığı|Üniversitesi|Kurumu|Valiliği|Kaymakamlığı|Ajansı|Fonu|Kurulu|Müsteşarlığı|Daire Başkanlığı))\s*:?/u;
  for (const source of sources) {
    if (!source) continue;
    const match = pattern.exec(source);
    if (match?.[1]) {
      const institution = collapseWhitespace(match[1].replace(/[:.]$/, ''));
      if (institution.length >= 6) return { institution, evidence: match[0].trim() };
    }
  }
  return { institution: null, evidence: null };
}

/** Unvanlar: sözlükteki unvanların metinde geçenleri. */
export function extractTitles(title: string, body: string): string[] {
  const haystack = ` ${normalizeTr(title)} \n ${normalizeTr(body.slice(0, 6_000))} `;
  const found: string[] = [];
  for (const candidate of JOB_TITLES) {
    const needle = ` ${normalizeTr(candidate)} `;
    if (haystack.includes(needle) || haystack.includes(`${needle.trim()} `)) found.push(candidate);
  }
  // Daha uzun (daha spesifik) unvanlar önce gelsin; kısa jenerik unvanları ele.
  const sorted = found.sort((a, b) => b.length - a.length);
  const filtered = sorted.filter((candidate, index) => {
    const normalized = normalizeTr(candidate);
    return !sorted.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const otherNormalized = normalizeTr(other);
      if (otherNormalized === normalized) return false;
      // "memur", "uzman" gibi kısa jenerikler daha uzun unvanın parçasıysa atlanır.
      return otherNormalized.includes(normalized) && candidate.length < 6;
    });
  });
  return uniquePreserve(filtered).slice(0, 12);
}

/** Öğrenim seviyeleri. */
export function extractEducationLevels(text: string): { levels: EducationLevel[]; evidence: string | null } {
  const normalized = normalizeTr(text);
  const levels: EducationLevel[] = [];
  let evidence: string | null = null;
  const check = (pattern: RegExp, level: EducationLevel) => {
    const match = pattern.exec(normalized);
    if (match) {
      levels.push(level);
      evidence = evidence ?? match[0].trim();
    }
  };
  check(/\b(?:doktora|doktora\s+mezunu)\w*/, 'doktora');
  check(/\b(?:on\s*lisans|onlisans|2\s*yillik\s+(?:okul|program))/, 'onlisans');
  check(/\b(?:yuksek\s+lisans|master)\w*/, 'yukseklisans');
  check(/(?<!on\s*)(?<!yuksek\s*)\b(?:lisans\s+mezunu|lisans\s+duzeyi|en\s+az\s+lisans|lisans\b|4\s*yillik)/, 'lisans');
  check(/\b(?:ortaogretim|lise\s+mezunu|lise\s+ve\s+dengi)/, 'ortaogretim');
  check(/\b(?:ilkogretim|ilkokul)/, 'ilkogretim');
  return { levels: uniquePreserve(levels), evidence };
}

/** Mezuniyet bölümleri. */
export function extractDepartments(text: string): { departments: string[]; evidence: string | null } {
  const normalized = ` ${normalizeTr(text)} `;
  const found: string[] = [];
  let evidence: string | null = null;
  for (const department of DEPARTMENTS) {
    const needle = ` ${normalizeTr(department)} `;
    const alternative = ` ${normalizeTr(department)}lerinden `;
    if (normalized.includes(needle) || normalized.includes(alternative) || normalized.includes(`${needle.trim()},`)) {
      found.push(department);
      evidence = evidence ?? department;
    }
  }
  return { departments: found, evidence };
}

/** KPSS puan türü, taban puan ve yıl. */
export function extractKpss(text: string): {
  scoreTypes: KpssScoreType[];
  minScore: number | null;
  year: number | null;
  evidence: string | null;
} {
  const normalized = normalizeTr(text);
  const scoreTypes: KpssScoreType[] = [];
  let evidence: string | null = null;
  const typePattern = /\b(p1|p2|p3|p10|p93|p94|p121|p124|dhbt)\b/g;
  for (const match of normalized.matchAll(typePattern)) {
    const raw = (match[1] ?? '').toUpperCase().replace('DHBT', 'DHBT');
    const candidate = (raw.startsWith('P') ? raw : raw) as KpssScoreType;
    if (KPSS_SCORE_TYPES.includes(candidate)) {
      scoreTypes.push(candidate);
      evidence = evidence ?? match[0];
    }
  }

  let minScore: number | null = null;
  const minScoreMatch =
    /(?:en\s+az|asgari|minimum)\s*(\d{2,3})(?:[.,]\d{1,2})?\s*(?:kpss\s*)?puan/i.exec(normalized) ??
    /(\d{2,3})(?:[.,]\d{1,2})?\s*(?:ve\s+uzeri|puan\s+ve\s+uzeri)/i.exec(normalized) ??
    /kpss\s*(?:puan[ıi]?)?\s*[:\-]?\s*(\d{2,3})/i.exec(normalized);
  if (minScoreMatch?.[1]) {
    const value = Number(minScoreMatch[1]);
    if (value >= 30 && value <= 100) {
      minScore = value;
      evidence = evidence ?? minScoreMatch[0].trim();
    }
  }

  let year: number | null = null;
  const yearMatch = /\b(20\d{2})\s*(?:y[ıi]l[ıi]\s*)?kpss\b/i.exec(normalized) ?? /\bkpss\s*(20\d{2})/i.exec(normalized);
  if (yearMatch?.[1]) year = Number(yearMatch[1]);

  return { scoreTypes: uniquePreserve(scoreTypes), minScore, year, evidence };
}

/** Yaş şartı. */
export function extractAge(text: string): { minAge: number | null; maxAge: number | null; evidence: string | null } {
  const normalized = normalizeTr(text);
  let minAge: number | null = null;
  let maxAge: number | null = null;
  let evidence: string | null = null;

  const maxMatch =
    /(\d{2})\s*ya[şs][ıi]n[ıi]\s*(?:doldurmam[ıi][şs]|ge[çc]memi[şs]|bitirmemi[şs])/.exec(normalized) ??
    /en\s+fazla\s*(\d{2})\s*ya[şs]/.exec(normalized) ??
    /(\d{2})\s*ya[şs]\s*ve\s+alt[ıi]/.exec(normalized);
  if (maxMatch?.[1]) {
    const value = Number(maxMatch[1]);
    if (value >= 18 && value <= 70) {
      maxAge = value;
      evidence = maxMatch[0].trim();
    }
  }

  const minMatch =
    /en\s+az\s*(\d{2})\s*ya[şs]/.exec(normalized) ??
    /(\d{2})\s*ya[şs][ıi]n[ıi]\s*(?:tamamlam[ıi][şs]|doldurmu[şs])/.exec(normalized);
  if (minMatch?.[1]) {
    const value = Number(minMatch[1]);
    if (value >= 15 && value <= 60) {
      minAge = value;
      evidence = evidence ?? minMatch[0].trim();
    }
  }
  return { minAge, maxAge, evidence };
}

/** Deneyim şartı. */
export function extractExperience(text: string): { years: number | null; evidence: string | null } {
  const normalized = normalizeTr(text);
  const match =
    /en\s+az\s*(\d{1,2})\s*y[ıi]l[\s\S]{0,30}?(?:deneyim|tecrube|cal[ıi][şs]ma)/.exec(normalized) ??
    /(\d{1,2})\s*y[ıi]ll[ıi]k\s+(?:deneyim|tecrube)/.exec(normalized);
  if (match?.[1]) {
    const value = Number(match[1]);
    if (value > 0 && value <= 40) return { years: value, evidence: match[0].trim() };
  }
  return { years: null, evidence: null };
}

export function extractCertificates(text: string): string[] {
  const normalized = ` ${normalizeTr(text)} `;
  const found: string[] = [];
  for (const certificate of CERTIFICATES) {
    if (normalized.includes(` ${normalizeTr(certificate)} `)) found.push(certificate);
  }
  return found;
}

export function extractLanguages(text: string): string[] {
  const normalized = ` ${normalizeTr(text)} `;
  const found: string[] = [];
  for (const language of FOREIGN_LANGUAGES) {
    if (normalized.includes(` ${normalizeTr(language)} `)) found.push(language);
  }
  return uniquePreserve(found);
}

/** Özel koşullar: ceza/askerlik/güvenlik/sağlık gibi ifadeler. */
export function extractSpecialConditions(text: string): string[] {
  const normalized = normalizeTr(text);
  const conditions: { pattern: RegExp; label: string }[] = [
    { pattern: /\bguvenlik\s+sorusturmasi/, label: 'Güvenlik soruşturması şartı' },
    { pattern: /\baskerlig\w*[\s\S]{0,40}?(?:yapmis|yapm[ıi][şs]|muaf|ertele)/, label: 'Askerlik durumu şartı' },
    { pattern: /\b(?:841|3713|657)\s*say[ıi]l[ıi][\s\S]{0,30}?(?:hukumlu|mahkum|su[çc])/, label: 'Adli sicil/kısıtlama şartı' },
    { pattern: /\bsa[ğg]l[ıi]k\s+durumu[\s\S]{0,40}?(?:uygun|elveri[şs]li)/, label: 'Sağlık durumu şartı' },
    { pattern: /\b(?:gorevini\s+surekli\s+yapmas[ıi]na|bedenen)\b/, label: 'Bedenen görevi yapabilme şartı' },
    { pattern: /\bs[ıi]nav[\s\S]{0,30}?(?:kat[ıi]lma|girme)\s+[şs]art[ıi]/, label: 'Sınava katılma şartı' },
    { pattern: /\bikamet\b/, label: 'İkamet şartı' },
    { pattern: /\b(?:erkek|kad[ıi]n)\s+aday/, label: 'Cinsiyete ilişkin ifade' },
    { pattern: /\bengelli\s+(?:personel|kadro|aday)/, label: 'Engelli kadrosu' },
    { pattern: /\btercih\s+[öo]nceli[ğg]i/, label: 'Tercih önceliği' },
  ];
  const found = conditions.filter((entry) => entry.pattern.test(normalized)).map((entry) => entry.label);
  return uniquePreserve(found);
}

/** Başvuru bağlantısı: bilinen başvuru ekranları veya "başvuru" ifadeli bağlantılar. */
export function extractApplicationUrl(
  links: { text: string; url: string }[],
  baseUrl?: string,
): string | null {
  for (const link of links) {
    if (!isHttpUrl(link.url)) continue;
    const host = safeHost(link.url);
    if (host && APPLICATION_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return normalizeUrl(link.url);
    }
    const normalizedText = normalizeTr(`${link.text} ${link.url}`);
    if (APPLICATION_LINK_TEXT_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
      try {
        const url = baseUrl ? new URL(link.url, baseUrl) : new URL(link.url);
        // Yalnızca kurumsal/başvuru bağlantıları; sosyal medya ve e-posta değil.
        if (/\.(pdf|docx?|xlsx?)$/i.test(url.pathname)) continue;
        return normalizeUrl(url.toString());
      } catch {
        continue;
      }
    }
  }
  return null;
}

function safeHost(raw: string): string | null {
  try {
    return hostOf(raw);
  } catch {
    return null;
  }
}

export function attachmentKindFromUrl(url: string): JobAttachment['kind'] {
  const extension = fileExtensionOf(url);
  if (extension === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(extension)) return 'doc';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) return 'excel';
  if (['html', 'htm', 'php', 'aspx'].includes(extension)) return 'html';
  return 'other';
}

/** Ana çıkarım fonksiyonu. */
export function extract(input: ExtractionInput): ExtractionResult {
  const title = collapseWhitespace(input.title ?? '');
  const body = collapseWhitespace(input.body ?? '');
  const combined = `${title}\n${body}`;
  const evidence: Record<string, string> = {};
  const fieldSources: Record<string, string> = {};
  const notes: string[] = [];
  const bodySource = input.bodySource ?? 'detail';

  // Kurum: kaynak verisi varsa otoriter, yoksa başlık/gövdeden çıkarılır.
  let institution = input.institutionHint ? collapseWhitespace(input.institutionHint) : null;
  if (institution) {
    fieldSources.institution = 'listing';
  } else {
    const extracted = extractInstitution(title, body);
    if (extracted.institution) {
      institution = extracted.institution;
      evidence.institution = extracted.evidence ?? '';
      fieldSources.institution = bodySource;
    }
  }

  // Şehir: kaynak verisi varsa otoriter, yoksa metinden en sık geçen il.
  let city = input.cityHint ? collapseWhitespace(input.cityHint) : null;
  if (city) {
    fieldSources.city = 'listing';
  } else {
    const extracted = extractCity(`${title} ${body.slice(0, 4_000)}`);
    if (extracted.city) {
      city = extracted.city;
      evidence.city = extracted.evidence ?? '';
      fieldSources.city = bodySource;
    }
  }

  // Başvuru penceresi: kaynak yapılandırılmış tarih verdiyse o kullanılır.
  let applicationStartAt = input.applicationStartAt ?? null;
  let applicationEndAt = input.applicationEndAt ?? null;
  if (applicationStartAt || applicationEndAt) {
    fieldSources.applicationWindow = 'listing';
  } else {
    const window = findApplicationWindow(body);
    if (window.start) {
      applicationStartAt = window.start.iso;
      evidence.applicationStartAt = window.start.matched;
    }
    if (window.end) {
      applicationEndAt = window.end.iso;
      evidence.applicationEndAt = window.end.matched;
    }
    // Tek tarih verilmişse ve metin "son başvuru" diyorsa bitiş tarihi kabul edilir.
    if (!applicationEndAt && window.start && /\bson\s+ba[şs]vuru/i.test(body)) {
      applicationEndAt = window.start.iso;
    }
    if (applicationStartAt || applicationEndAt) fieldSources.applicationWindow = bodySource;
  }

  // Gövdede gün/ay var ama yıl yoksa not düşülür (tahmin yapılmaz).
  if (!applicationEndAt && /\bson\s+ba[şs]vuru/i.test(body)) {
    const partial = /son\s+ba[şs]vuru[\s\S]{0,60}/i.exec(body)?.[0] ?? '';
    if (parseTurkishDate(partial) === null && /\d{1,2}\s+\p{L}+/u.test(partial)) {
      notes.push('Son başvuru ifadesi bulundu ancak yıl belirtilmediği için tarih boş bırakıldı.');
    }
  }

  const applicationEndDate = applicationEndAt ? toDateOnlyFromIso(applicationEndAt) : null;
  if (applicationEndDate) fieldSources.applicationEndDate = fieldSources.applicationWindow ?? bodySource;

  // Kontenjan
  const quota = extractQuota(combined);
  if (quota.quota !== null) {
    evidence.quota = quota.evidence ?? '';
    fieldSources.quota = bodySource;
  }

  // Unvanlar
  const titles = extractTitles(title, body);
  if (titles.length > 0) fieldSources.titles = bodySource;

  // Şartlar
  const education = extractEducationLevels(`${title} ${body}`);
  if (education.levels.length > 0) {
    evidence.educationLevels = education.evidence ?? '';
    fieldSources.educationLevels = bodySource;
  }
  const departments = extractDepartments(`${title} ${body}`);
  if (departments.departments.length > 0) {
    evidence.departments = departments.evidence ?? '';
    fieldSources.departments = bodySource;
  }
  const kpss = extractKpss(`${title} ${body}`);
  if (kpss.scoreTypes.length > 0 || kpss.minScore !== null || kpss.year !== null) {
    evidence.kpss = kpss.evidence ?? '';
    fieldSources.kpss = bodySource;
  }
  const age = extractAge(`${title} ${body}`);
  if (age.minAge !== null || age.maxAge !== null) {
    evidence.age = age.evidence ?? '';
    fieldSources.age = bodySource;
  }
  const experience = extractExperience(body);
  if (experience.years !== null) {
    evidence.experience = experience.evidence ?? '';
    fieldSources.experience = bodySource;
  }
  const certificates = extractCertificates(body);
  const languages = extractLanguages(body);
  const specialConditions = extractSpecialConditions(body);

  // Ekler: kaynaktan gelenler + gövdedeki belge bağlantıları
  const attachments = uniqueAttachments([
    ...(input.attachments ?? []),
  ]);

  const requirements: JobRequirements = {
    ...EMPTY_REQUIREMENTS,
    educationLevels: education.levels,
    departments: departments.departments,
    kpssScoreTypes: kpss.scoreTypes,
    kpssMinScore: kpss.minScore ?? undefined,
    kpssYear: kpss.year ?? undefined,
    minAge: age.minAge ?? undefined,
    maxAge: age.maxAge ?? undefined,
    certificates,
    minExperienceYears: experience.years ?? undefined,
    foreignLanguages: languages,
    specialConditions,
  };

  // Güven: çıkarılan alan sayısı + gövde uzunluğu
  const filledFields = [
    institution,
    city,
    quota.quota,
    applicationEndAt,
    postsCount(titles),
    postsCount(education.levels),
    postsCount(kpss.scoreTypes),
  ].filter((value) => value !== null && value !== undefined && value !== 0).length;
  const bodyFactor = body.length > 400 ? 0.5 : body.length > 120 ? 0.3 : 0;
  const confidence = Math.min(0.95, Number((0.15 + filledFields * 0.06 + bodyFactor).toFixed(2)));

  if (body.length < 120) notes.push('İlan metni çok kısa: alanların çoğu belirtilmemiş olabilir.');

  return {
    institution,
    unit: null,
    city,
    district: null,
    quota: quota.quota,
    applicationStartAt,
    applicationEndAt,
    applicationEndDate,
    publishedAt: input.publishedAt ?? null,
    applicationUrl: null,
    originalRefNo: input.referenceHint ?? null,
    titles,
    requirements,
    attachments,
    specialConditions,
    evidence,
    fieldSources,
    confidence,
    notes,
    version: EXTRACTION_VERSION,
  };
}

function postsCount(values: string[]): number {
  return values.length;
}

function toDateOnlyFromIso(iso: string): string | null {
  // ISO damgası +03:00 ofsetliyse gün kısmı doğrudan İstanbul günüdür.
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match?.[1] ?? null;
}

function uniqueAttachments(attachments: JobAttachment[]): JobAttachment[] {
  const seen = new Set<string>();
  const out: JobAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment.url || seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    out.push(attachment);
  }
  return out;
}

/** Gövdeden ek bağlantılarını toplar (PDF/DOC/XLS). */
export function collectAttachmentLinks(
  links: { text: string; url: string }[],
  baseUrl?: string,
): JobAttachment[] {
  const out: JobAttachment[] = [];
  for (const link of links) {
    if (!isHttpUrl(link.url)) continue;
    const kind = attachmentKindFromUrl(link.url);
    if (kind === 'other' || kind === 'html') continue;
    try {
      const absolute = baseUrl ? new URL(link.url, baseUrl).toString() : link.url;
      out.push({ url: normalizeUrl(absolute), label: collapseWhitespace(link.text).slice(0, 200), kind });
    } catch {
      continue;
    }
  }
  return uniqueAttachments(out);
}
