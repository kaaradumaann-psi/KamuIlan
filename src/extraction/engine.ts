/**
 * Alan çıkarım motoru (§7).
 *
 * İlkeler:
 *  - TAHMİN YOK: Bir alan metinden güvenle çıkarılamıyorsa boş bırakılır ve
 *    `uncertainties` içinde gerekçe yazılır. "Belirtilmemiş" bilgi uydurulmaz.
 *  - Kaynak ÖNCELİĞİ: liste sayfasındaki yapılandırılmış alan > detay metni.
 *    Çelişki varsa liste değeri korunur ve `uncertainties`'e not düşülür.
 *  - KANIT: her alan için metinden alınan kısa parça (`evidence`) ve alanın
 *    hangi belgeden geldiği (`fieldSources`) saklanır.
 *  - Başvuru bağlantısı yalnızca resmî adreslerden (kariyerkapisi, e-Devlet,
 *    İŞKUR, ÖSYM) seçilir; uydurma link üretilmez.
 */
import { collapseWhitespace, normalizeTr, uniquePreserve } from '../domain/text';
import {
  formatDateTr,
  parseTurkishDate,
  parseTurkishDateRange,
  toIstanbulDateOnly,
  type ParsedTurkishDate,
} from '../domain/dates';
import {
  ACCEPT_KEYWORDS,
  APPLICATION_METHODS,
  APPLICATION_URL_HOSTS,
  CERTIFICATES,
  DEPARTMENTS,
  EDUCATION_KEYWORDS,
  EMPLOYMENT_TYPE_KEYWORDS,
  FOREIGN_LANGUAGES,
  JOB_TITLES,
  KPSS_TYPES,
  PROVINCES,
} from './dictionaries';
import { EXTRACTION_VERSION } from '../config/app';
import { extractPdfText } from './pdf';
import type {
  EmploymentType,
  EducationLevel,
  JobAttachment,
  KpssScoreType,
  RawAnnouncement,
} from '../domain';

export type FieldSourceKind = 'listing' | 'detail' | 'document' | 'link' | 'unstated';

export interface FieldSource {
  kind: FieldSourceKind;
  /** Metinden alınan kanıt (kısa). */
  snippet: string | null;
}

export interface ExtractionInput {
  title: string;
  body?: string | null;
  /** Liste sayfasından gelen yapılandırılmış alanlar (otoriter). */
  listing?: {
    institution?: string | null;
    city?: string | null;
    district?: string | null;
    publishedAt?: string | null;
    referenceNo?: string | null;
    applicationEndAt?: string | null;
    applicationStartAt?: string | null;
  };
  /** Metindeki bağlantılar (başvuru bağlantısı seçimi için). */
  links?: readonly { text: string; url: string }[];
  attachments?: readonly JobAttachment[];
  referenceNo?: string | null;
  bodySource?: 'listing' | 'detail' | 'document';
  /** Metin katmanı olmayan PDF gibi durumlar. */
  noTextLayer?: boolean;
}

export interface SpecialConditionHit {
  /** Kanonik etiket (arayüzde ve filtrelerde kullanılır). */
  label: string;
  /** İlandaki kanıt cümlesi (kısaltılmış). */
  snippet: string;
}

export interface ExtractedJob {
  institution: string | null;
  unit: string | null;
  employmentType: EmploymentType;
  city: string | null;
  district: string | null;
  quota: number | null;
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  publishedAt: string | null;
  applicationUrl: string | null;
  applicationMethod: string | null;
  referenceNo: string | null;
  cadreStatus: string | null;
  titles: string[];
  educationLevels: EducationLevel[];
  departments: string[];
  kpssScoreTypes: KpssScoreType[];
  kpssMinScore: number | null;
  kpssYear: number | null;
  minAge: number | null;
  maxAge: number | null;
  certificates: string[];
  minExperienceYears: number | null;
  foreignLanguages: string[];
  specialConditions: string[];
  attachments: JobAttachment[];
  fieldSources: Record<string, FieldSource>;
  evidence: Record<string, string>;
  uncertainties: string[];
  confidence: number;
  version: string;
}

const MAX_BODY = 60_000;

/** Ay adıyla verilen ama yıl içermeyen tarih (uydurma tarih üretmemek için). */
const YEARLESS_MONTH_DATE =
  /\b\d{1,2}\s+(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\b(?!\s*\d{4})/iu;

export function extract(input: ExtractionInput): ExtractedJob {
  const body = collapseWhitespace((input.body ?? '').slice(0, MAX_BODY));
  const title = collapseWhitespace(input.title);
  const haystack = `${title}\n${body}`;
  const fieldSources: Record<string, FieldSource> = {};
  const evidence: Record<string, string> = {};
  const uncertainties: string[] = [];
  const listing = input.listing ?? {};

  const setField = (field: string, kind: FieldSourceKind, snippet: string | null) => {
    fieldSources[field] = { kind, snippet: snippet ? snippet.slice(0, 240) : null };
    if (snippet) evidence[field] = snippet.slice(0, 240);
  };

  // --- Kurum ---------------------------------------------------------------
  const institutionFromListing = cleanText(listing.institution);
  const institutionFromTitle = extractInstitutionFromTitle(title);
  const institutionFromBody = extractInstitutionFromBody(body);
  const institution = institutionFromListing ?? institutionFromTitle ?? institutionFromBody;
  if (institution) {
    setField(
      'institution',
      institutionFromListing ? 'listing' : institutionFromTitle ? 'detail' : 'detail',
      institution,
    );
  } else {
    setField('institution', 'unstated', null);
    uncertainties.push('İlan metninde kurum adı net biçimde belirtilmemiş.');
  }

  // --- Birim ---------------------------------------------------------------
  const unit = extractUnit(haystack);
  setField('unit', unit ? 'detail' : 'unstated', unit);

  // --- Çalışma biçimi / kadro durumu --------------------------------------
  const { employmentType, cadreStatus } = extractEmploymentType(haystack, title);
  setField('employmentType', employmentType === 'belirsiz' ? 'unstated' : 'detail', cadreStatus);
  if (employmentType === 'belirsiz') {
    uncertainties.push('Çalışma biçimi (kadrolu/sözleşmeli/işçi) metinden anlaşılamadı.');
  }

  // --- İl / ilçe -----------------------------------------------------------
  const cityFromListing = cleanText(listing.city);
  const cityFromText = extractCity(haystack);
  const city = cityFromListing ?? cityFromText;
  if (city) {
    setField('city', cityFromListing ? 'listing' : 'detail', city);
    if (cityFromListing && cityFromText && normalizeTr(cityFromListing) !== normalizeTr(cityFromText)) {
      uncertainties.push(
        `Liste sayfası il bilgisini "${cityFromListing}", ilan metni "${cityFromText}" olarak veriyor; liste değeri kullanıldı.`,
      );
    }
  } else {
    setField('city', 'unstated', null);
    uncertainties.push('İl bilgisi belirtilmemiş.');
  }

  const districtFromListing = cleanText(listing.district);
  const districtFromText = extractDistrict(haystack);
  const district = districtFromListing ?? districtFromText;
  setField('district', district ? (districtFromListing ? 'listing' : 'detail') : 'unstated', district);

  // --- Kontenjan -----------------------------------------------------------
  const quota = extractQuota(haystack);
  setField('quota', quota ? 'detail' : 'unstated', quota?.snippet ?? null);
  if (!quota) uncertainties.push('Kontenjan bilgisi ilanda sayı olarak belirtilmemiş.');

  // --- Başvuru penceresi ---------------------------------------------------
  const windowResult = extractApplicationWindow(title, body, listing);
  const endKind: FieldSourceKind = windowResult.endFromListing
    ? 'listing'
    : windowResult.endSnippet
      ? 'detail'
      : 'unstated';
  setField('applicationStartAt', windowResult.startSnippet ? 'detail' : 'unstated', windowResult.startSnippet);
  setField('applicationEndAt', endKind, windowResult.endSnippet);
  setField('applicationEndDate', endKind, windowResult.endSnippet);
  if (!windowResult.start) {
    uncertainties.push('Başvuru başlangıç tarihi metinde belirtilmemiş.');
  }
  if (!windowResult.end) {
    if (YEARLESS_MONTH_DATE.test(haystack)) {
      uncertainties.push(
        'Metinde ay adıyla verilen bir tarih var ancak yıl belirtilmediği için son başvuru tarihi çıkarılmadı.',
      );
    } else {
      uncertainties.push('Son başvuru tarihi metinde belirtilmemiş; takip edilmeli.');
    }
  }

  // --- Yayım tarihi --------------------------------------------------------
  const publishedAt = cleanText(listing.publishedAt) ?? extractPublishedAt(haystack);
  setField('publishedAt', publishedAt ? (listing.publishedAt ? 'listing' : 'detail') : 'unstated', publishedAt);

  // --- Başvuru bağlantısı ve yöntemi --------------------------------------
  const applicationUrl = extractApplicationUrl(input.links ?? [], title, body);
  setField('applicationUrl', applicationUrl ? 'link' : 'unstated', applicationUrl);
  if (!applicationUrl) {
    uncertainties.push('İlanda resmî bir başvuru bağlantısı bulunamadı; yalnızca ilan bağlantısı gösterilir.');
  }
  const applicationMethod = extractApplicationMethod(haystack, Boolean(applicationUrl));
  setField('applicationMethod', applicationMethod ? 'detail' : 'unstated', applicationMethod);

  // --- İlan numarası -------------------------------------------------------
  const referenceNo = cleanText(input.referenceNo) ?? cleanText(listing.referenceNo) ?? extractReference(title, body);
  setField('referenceNo', referenceNo ? (input.referenceNo || listing.referenceNo ? 'listing' : 'detail') : 'unstated', referenceNo);

  // --- Unvanlar, öğrenim, bölüm, KPSS, yaş, deneyim, belge, dil -----------
  const titles = extractTitles(haystack);
  setField('titles', titles.length > 0 ? 'detail' : 'unstated', titles.join(', ') || null);

  const educationLevels = extractEducationLevels(haystack);
  setField('educationLevels', educationLevels.length > 0 ? 'detail' : 'unstated', educationLevels.join(', ') || null);
  if (educationLevels.length === 0) uncertainties.push('Öğrenim düzeyi belirtilmemiş.');

  const departments = extractDepartments(haystack);
  setField('departments', departments.length > 0 ? 'detail' : 'unstated', departments.slice(0, 5).join(', ') || null);

  const kpss = extractKpss(haystack);
  setField('kpss', kpss.types.length > 0 || kpss.minScore !== null ? 'detail' : 'unstated', kpss.snippet);
  if (kpss.types.length === 0 && kpss.minScore === null) uncertainties.push('KPSS puanı/türü belirtilmemiş.');

  const age = extractAge(haystack);
  setField('age', age.snippet ? 'detail' : 'unstated', age.snippet);

  const experience = extractExperience(haystack);
  setField('experience', experience.years !== null ? 'detail' : 'unstated', experience.snippet);

  const certificates = extractCertificates(haystack);
  setField('certificates', certificates.length > 0 ? 'detail' : 'unstated', certificates.join(', ') || null);

  const foreignLanguages = extractForeignLanguages(haystack);
  setField('foreignLanguages', foreignLanguages.length > 0 ? 'detail' : 'unstated', foreignLanguages.join(', ') || null);

  const specialHits = extractSpecialConditions(haystack);
  const specialConditions = specialHits.map((hit) => hit.label);
  setField(
    'specialConditions',
    specialConditions.length > 0 ? 'detail' : 'unstated',
    specialHits.map((hit) => hit.snippet).join(' • ') || null,
  );

  // --- Ekler ---------------------------------------------------------------
  const attachments = uniqueAttachments(input.attachments ?? []);
  setField('attachments', attachments.length > 0 ? 'listing' : 'unstated', attachments.map((item) => item.url).join('\n') || null);

  const confidence = computeConfidence({
    bodyLength: body.length,
    noTextLayer: input.noTextLayer ?? false,
    hasInstitution: Boolean(institution),
    hasCity: Boolean(city),
    hasQuota: Boolean(quota),
    hasStart: Boolean(windowResult.start),
    hasEnd: Boolean(windowResult.end),
    hasEducation: educationLevels.length > 0,
    hasApplicationUrl: Boolean(applicationUrl),
    hasKpss: kpss.types.length > 0 || kpss.minScore !== null,
  });

  return {
    institution,
    unit,
    employmentType,
    city,
    district,
    quota: quota?.value ?? null,
    applicationStartAt: windowResult.start?.iso ?? cleanText(listing.applicationStartAt),
    applicationEndAt: windowResult.end?.iso ?? cleanText(listing.applicationEndAt),
    applicationEndDate: windowResult.end?.dateOnly ?? dateOnlyOf(listing.applicationEndAt),
    publishedAt,
    applicationUrl,
    applicationMethod,
    referenceNo,
    cadreStatus,
    titles,
    educationLevels,
    departments,
    kpssScoreTypes: kpss.types,
    kpssMinScore: kpss.minScore,
    kpssYear: kpss.year,
    minAge: age.minAge,
    maxAge: age.maxAge,
    certificates,
    minExperienceYears: experience.years,
    foreignLanguages,
    specialConditions,
    attachments,
    fieldSources,
    evidence,
    uncertainties: uniquePreserve(uncertainties),
    confidence,
    version: EXTRACTION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Alan çıkarıcıları (her biri ayrı test edilebilir)
// ---------------------------------------------------------------------------

export function extractInstitutionFromTitle(title: string): string | null {
  const match = /^(.{5,140}?)\s*(?:'?[dt]en|ndan|den|dan)?\s*:/u.exec(title);
  if (!match?.[1]) return null;
  const candidate = collapseWhitespace(match[1]).replace(/[:;,]\s*$/, '');
  return candidate.length >= 6 ? candidate : null;
}

export function extractInstitutionFromBody(body: string): string | null {
  const patterns: readonly RegExp[] = [
    /([A-ZÇĞİÖŞÜ][\wçğıöşüÇĞİÖŞÜ.,'’\-\s]{5,120}?(?:Bakanlığı|Bakanlığından|Başkanlığı|Başkanlığından|Rektörlüğü|Rektörlüğünden|Genel Müdürlüğü|Müdürlüğü|Müdürlüğünden|Belediye Başkanlığı|Belediyesi|Üniversitesi|Kurumu|Valiliği|Kaymakamlığı|Ajansı|Fonu|Müsteşarlığı|Başkanlığınca))/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match?.[1]) {
      const candidate = collapseWhitespace(match[1]).replace(/[:;,]\s*$/, '');
      if (candidate.length >= 6) return candidate;
    }
  }
  return null;
}

export function extractUnit(text: string): string | null {
  const match = /([A-ZÇĞİÖŞÜ][\wçğıöşüÇĞİÖŞÜ\s-]{2,60}?(?:Daire Başkanlığı|Şube Müdürlüğü|Müdürlüğü|Fakültesi|Enstitüsü|Yüksekokulu|Meslek Yüksekokulu|Hastanesi|Hastane Başhekimliği|Başhekimliği|Birimi|Bölüm Başkanlığı|Koordinatörlüğü))/u.exec(text);
  if (!match?.[1]) return null;
  const value = collapseWhitespace(match[1]);
  if (value.length < 8) return null;
  return value.length > 140 ? value.slice(0, 140) : value;
}

export function extractCity(text: string): string | null {
  const matches: { province: string; index: number }[] = [];
  const normalized = text.toLocaleLowerCase('tr');
  for (const province of PROVINCES) {
    const needle = province.toLocaleLowerCase('tr');
    const index = normalized.indexOf(needle);
    if (index >= 0) matches.push({ province, index });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.index - b.index);
  const first = matches[0];
  if (!first) return null;
  const others = matches.filter((candidate) => candidate.province !== first.province).length;
  return others > 0 ? first.province : first.province;
}

export function extractDistrict(text: string): string | null {
  const match = /([A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,25})\s+(?:İlçesi|ilçesi|İlçesinde|ilçesinde|İlçe|ilçe)/u.exec(text);
  return match?.[1] ? collapseWhitespace(match[1]) : null;
}

export function extractQuota(text: string): { value: number; snippet: string } | null {
  const patterns: readonly RegExp[] = [
    /kontenjan\s*(?:bilgisi|sayısı|:)?\s*[:.]?\s*(\d{1,4})/i,
    /(\d{1,4})\s*(?:kişi|adet|personel|pozisyon|eleman|işçi)(?:\s+alım|\s+alınacak)?/i,
    /toplam\s*(\d{1,4})/i,
    /(\d{1,4})\s*daimi işçi/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 20_000) continue;
    // Tarih/sayı/diploma karışıklığını önle: 657 sayılı Kanun gibi ifadeler kontenjan değildir.
    const snippet = collapseWhitespace(match?.[0] ?? raw);
    if (/\b(?:sayılı|yılı|yıl|madde|puan|yaş|tarihli|no|numaralı)\b/i.test(snippet)) continue;
    if (value < 1) continue;
    return { value, snippet };
  }
  return null;
}

interface WindowResult {
  start: ParsedTurkishDate | null;
  end: ParsedTurkishDate | null;
  startSnippet: string | null;
  endSnippet: string | null;
  /** Tarih metinden değil, liste sayfasının yapılandırılmış alanından geldi. */
  endFromListing?: boolean;
}

/**
 * Başvuru penceresini bulur.
 *
 * Sıra: (1) "başvuru" içeren cümlelerdeki aralık, (2) "son başvuru" kalıbı,
 * (3) "…tarihine kadar". Hiçbiri yoksa tarih ÜRETİLMEZ.
 */
export function extractApplicationWindow(
  title: string,
  body: string,
  listing: ExtractionInput['listing'] = {},
): WindowResult {
  const text = `${title}\n${body}`;
  const sentences = text.split(/(?<=[.;!?])\s+|\n/).filter((sentence) => sentence.trim().length > 0);

  const isWindowSentence = (sentence: string): boolean =>
    /ba[şs]vuru/iu.test(sentence) &&
    /(?:tarih|son|ba[şs]lang[ıi]ç|kadar|aras[ıi]nda|ile)/iu.test(sentence) &&
    /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/iu.test(sentence);

  const windowSentences = sentences.filter(isWindowSentence);
  for (const sentence of windowSentences) {
    const range = parseTurkishDateRange(sentence);
    if (!range.start) continue;
    const hasRange = range.end && range.end.dateOnly !== range.start.dateOnly;
    const mentionsStart = /(?:ba[şs]lang[ıi]ç|ba[şs]vurular[ıi]n ba[şs]lan|itibaren)/iu.test(sentence);
    const mentionsEnd = /(?:son ba[şs]vuru|kadar|biti[şs])/iu.test(sentence);

    if (hasRange && range.end) {
      if (mentionsEnd && !mentionsStart) {
        return {
          start: null,
          end: range.end,
          startSnippet: null,
          endSnippet: collapseWhitespace(sentence).slice(0, 240),
        };
      }
      return {
        start: range.start,
        end: range.end,
        startSnippet: collapseWhitespace(sentence).slice(0, 240),
        endSnippet: collapseWhitespace(sentence).slice(0, 240),
      };
    }
    if (mentionsEnd) {
      return {
        start: null,
        end: range.end ?? range.start,
        startSnippet: null,
        endSnippet: collapseWhitespace(sentence).slice(0, 240),
      };
    }
    if (mentionsStart) {
      return {
        start: range.start,
        end: null,
        startSnippet: collapseWhitespace(sentence).slice(0, 240),
        endSnippet: null,
      };
    }
  }

  // "Son başvuru tarihi …", "… tarihine kadar" kalıpları.
  const explicitEnd = /(?:son\s+ba[şs]vuru(?:\s+tarihi)?|ba[şs]vurular[ıi]n\s+son\s+g[üu]n[üu]|en\s+son)[^.\n]{0,120}/iu.exec(text);
  if (explicitEnd) {
    const parsed = parseTurkishDate(explicitEnd[0]);
    if (parsed) {
      return {
        start: null,
        end: parsed,
        startSnippet: null,
        endSnippet: collapseWhitespace(explicitEnd[0]).slice(0, 240),
      };
    }
  }

  const until = /([^.\n]{0,140}?tarihine\s+kadar)/iu.exec(text);
  if (until?.[0]) {
    const parsed = parseTurkishDate(until[0]);
    if (parsed) {
      return { start: null, end: parsed, startSnippet: null, endSnippet: collapseWhitespace(until[0]).slice(0, 240) };
    }
  }

  // Liste sayfasından gelen yapılandırılmış bitiş tarihi (varsa) kullanılır.
  const listingEnd = cleanText(listing.applicationEndAt);
  if (listingEnd) {
    const iso = /^\d{4}-\d{2}-\d{2}/.test(listingEnd) ? listingEnd : null;
    if (iso) {
      return {
        start: null,
        end: {
          dateOnly: iso.slice(0, 10),
          time: null,
          raw: listingEnd,
          iso: iso.length > 10 ? iso : `${iso}T23:59:00+03:00`,
          timeIsDefault: true,
        },
        startSnippet: null,
        endSnippet: `Liste sayfası: ${listingEnd}`,
        endFromListing: true,
      };
    }
  }

  return { start: null, end: null, startSnippet: null, endSnippet: null };
}

export function extractPublishedAt(text: string): string | null {
  const patterns: readonly RegExp[] = [
    /(?:yay[ıi]m|ilan|duyuru)\s*(?:tarihi|tarihinde)?\s*[:.]?\s*([^.\n]{0,60})/iu,
    /([^.\n]{0,40}?tarihli)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = parseTurkishDate(match[1]);
    if (parsed) return parsed.iso;
  }
  return null;
}

export function extractApplicationUrl(
  links: readonly { text: string; url: string }[],
  title: string,
  body: string,
): string | null {
  const priority = (url: string): number => {
    const host = safeHost(url);
    if (!host) return -1;
    if (!APPLICATION_URL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return -1;
    if (host.includes('kariyerkapisi')) return 100;
    if (host.includes('esube.iskur')) return 90;
    if (host.includes('turkiye.gov.tr')) return 80;
    if (host.includes('iskur.gov.tr')) return 70;
    if (host.includes('osym.gov.tr')) return 60;
    return 50;
  };

  const candidates = links
    .map((link) => ({ ...link, score: priority(link.url) }))
    .filter((link) => link.score > 0)
    .sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0].url;

  // Metinde geçen çıplak bağlantılar (nadiren olur ama uydurma yapılmaz).
  const inline = /https?:\/\/[^\s"'<>)]+/g.exec(`${title} ${body}`);
  if (inline?.[0] && priority(inline[0]) > 0) return inline[0];
  return null;
}

export function extractApplicationMethod(text: string, hasApplicationUrl: boolean): string | null {
  const found: string[] = [];
  for (const method of APPLICATION_METHODS) {
    if (normalizeTr(text).includes(normalizeTr(method))) found.push(method);
  }
  if (found.length === 0) return hasApplicationUrl ? null : null;
  return found.slice(0, 3).join(', ');
}

export function extractReference(title: string, body: string): string | null {
  const match = /\b(YOK|DPB|ILN|TR)[-\s]?(\d{5,12})\b/i.exec(`${title} ${body}`);
  return match?.[1] && match[2] ? `${match[1].toUpperCase()}${match[2]}` : null;
}

export function extractTitles(text: string): string[] {
  const normalized = normalizeTr(text);
  const found: string[] = [];
  for (const title of JOB_TITLES) {
    if (normalized.includes(normalizeTr(title))) found.push(title);
  }
  // Uzun (spesifik) unvanlar önce gelir.
  return found.sort((a, b) => b.length - a.length).slice(0, 12);
}

export function extractEducationLevels(text: string): EducationLevel[] {
  const normalized = normalizeTr(text);
  const levels: EducationLevel[] = [];
  // "ön lisans" ifadesi "lisans" ile karışmasın: önce ön lisans aranır ve
  // lisans kontrolünde "ön"/"yüksek" önekleri dışlanır.
  const checks: readonly { level: EducationLevel; re: RegExp }[] = [
    { level: 'doktora', re: /doktora|sanatta yeterlik/ },
    { level: 'yukseklisans', re: /yuksek lisans|master/ },
    { level: 'onlisans', re: /on lisans/ },
    { level: 'lisans', re: /(?<!on )(?<!yuksek )lisans/ },
    { level: 'ortaogretim', re: /ortaogretim|lise mezunu|lise ve dengi|meslek lisesi/ },
    { level: 'ilkogretim', re: /ilkogretim/ },
  ];
  for (const check of checks) {
    if (check.re.test(normalized)) levels.push(check.level);
  }
  return levels;
}

export function extractDepartments(text: string): string[] {
  const normalized = normalizeTr(text);
  const found: string[] = [];
  for (const department of DEPARTMENTS) {
    if (normalized.includes(normalizeTr(department))) found.push(department);
  }
  return found.slice(0, 15);
}

export function extractKpss(text: string): {
  types: KpssScoreType[];
  minScore: number | null;
  year: number | null;
  snippet: string | null;
} {
  const types: KpssScoreType[] = [];
  const typePattern = /KPSS[^.\n]{0,40}?\b(P\d{1,3}|DHBT)\b/gi;
  const normalizedText = text.replace(/\s+/g, ' ');
  for (const match of normalizedText.matchAll(typePattern)) {
    const candidate = match[1]?.toUpperCase().replace(/^P0*/, 'P');
    if (candidate && KPSS_TYPES.includes(candidate as KpssScoreType)) types.push(candidate as KpssScoreType);
  }
  // "KPSS (P3)" gibi parantezli ifadeler
  for (const match of normalizedText.matchAll(/\((P\d{1,3}|DHBT)\)/g)) {
    const candidate = match[1]?.toUpperCase();
    if (candidate && KPSS_TYPES.includes(candidate as KpssScoreType)) types.push(candidate as KpssScoreType);
  }

  const scoreMatch = /(?:KPSS[^.\n]{0,60}?|taban puan[ıi]?[^.\n]{0,20}?)(\d{2,3})(?:[.,](\d{1,2}))?\s*(?:puan|ve üzeri|puan[ıi]|ve yukar[ıi]s[ıi])?/i.exec(normalizedText);
  let minScore: number | null = null;
  if (scoreMatch?.[1]) {
    const value = Number(scoreMatch[1]);
    if (Number.isFinite(value) && value >= 30 && value <= 100) minScore = value;
  }

  const yearMatch = /(\b20\d{2})\s*(?:y[ıi]l[ıi])?\s*KPSS/i.exec(normalizedText);
  const year = yearMatch?.[1] ? Number(yearMatch[1]) : null;

  const snippetMatch = /[^.\n]{0,60}KPSS[^.\n]{0,80}/i.exec(normalizedText);
  return {
    types: uniquePreserve(types).slice(0, 4) as KpssScoreType[],
    minScore,
    year,
    snippet: snippetMatch ? collapseWhitespace(snippetMatch[0]) : null,
  };
}

export function extractAge(text: string): { minAge: number | null; maxAge: number | null; snippet: string | null } {
  // "18-35 yaş arası" gibi açık aralık.
  const range = /(\d{2})\s*[-–]\s*(\d{2})\s*ya[şs]/iu.exec(text);
  if (range?.[1] && range[2]) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (min >= 15 && min <= 70 && max > min && max <= 80) {
      return { minAge: min, maxAge: max, snippet: collapseWhitespace(range[0]) };
    }
  }

  // "18 yaşını doldurmuş / tamamlamış" → alt sınır; "35 yaşını doldurmamış" → üst sınır.
  const minPatterns: readonly RegExp[] = [
    /(\d{2})\s*ya[şs][ıi]n[ıi]\s*(?:doldurmu[şs]|tamamlam[ıi][şs])/iu,
    /(\d{2})\s*ya[şs][ıi]ndan\s*g[üu]n\s*alm[ıi][şs]/iu,
    /en\s*az\s*(\d{2})\s*ya[şs]/iu,
  ];
  const maxPatterns: readonly RegExp[] = [
    /(\d{2})\s*ya[şs][ıi]n[ıi]\s*(?:doldurmam[ıi][şs]|bitirmemi[şs]|tamamlamam[ıi][şs]|ge[çc]memi[şs])/iu,
    /(\d{2})\s*ya[şs][ıi]ndan\s*g[üu]n\s*almam[ıi][şs]/iu,
    /en\s*(?:fazla|çok)\s*(\d{2})\s*ya[şs]/iu,
  ];

  const matchOf = (patterns: readonly RegExp[]): RegExpExecArray | null => {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match?.[1]) return match;
    }
    return null;
  };

  const minMatch = matchOf(minPatterns);
  const maxMatch = matchOf(maxPatterns);
  const asAge = (value: string | undefined, lower: number, upper: number): number | null => {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= lower && parsed <= upper ? parsed : null;
  };

  const minAge = asAge(minMatch?.[1], 15, 70);
  const maxAge = asAge(maxMatch?.[1], 16, 80);
  const snippetText = minMatch?.[0] ?? maxMatch?.[0] ?? null;
  const validMin = minAge !== null && maxAge !== null && maxAge <= minAge ? null : minAge;

  return {
    minAge: validMin,
    maxAge,
    snippet: snippetText ? collapseWhitespace(snippetText) : null,
  };
}

export function extractExperience(text: string): { years: number | null; snippet: string | null } {
  const patterns: readonly RegExp[] = [
    /(?:en az|asgar[ıi]|minimum)\s*(\d{1,2})\s*(?:y[ıi]l|[ıi]l)\s*(?:deneyim|tecrübe|çalışma)/iu,
    /(\d{1,2})\s*(?:y[ıi]l|[ıi]l)\s*(?:deneyim|tecrübe)/iu,
    /deneyim\s*[:.]?\s*(?:en az\s*)?(\d{1,2})\s*y[ıi]l/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (!raw) continue;
    const years = Number(raw);
    if (Number.isFinite(years) && years > 0 && years <= 40) {
      return { years, snippet: collapseWhitespace(match?.[0] ?? '') };
    }
  }
  return { years: null, snippet: null };
}

export function extractCertificates(text: string): string[] {
  const normalized = normalizeTr(text);
  const found: string[] = [];
  for (const certificate of CERTIFICATES) {
    if (normalized.includes(normalizeTr(certificate))) found.push(certificate);
  }
  const driving = /(B|C|D|E)\s*s[ıi]n[ıi]f[ıi]\s*s[üu]r[üu]c[üu]/iu.exec(text);
  if (driving?.[1] && !found.includes('Sürücü Belgesi')) found.push(`${driving[1].toUpperCase()} sınıfı sürücü belgesi`);
  return uniquePreserve(found).slice(0, 10);
}

export function extractForeignLanguages(text: string): string[] {
  const normalized = normalizeTr(text);
  const found: string[] = [];
  for (const language of FOREIGN_LANGUAGES) {
    if (normalized.includes(normalizeTr(language))) found.push(language);
  }
  return found.slice(0, 6);
}

/**
 * Özel koşulları kanonik etiketlerle bulur. Etiketler tek başına karar üretmez;
 * kanıt cümlesi `evidence` alanında saklanır (bkz. docs/extraction.md).
 */
export function extractSpecialConditions(text: string): SpecialConditionHit[] {
  const patterns: readonly { label: string; re: RegExp }[] = [
    { label: 'Askerlik durumu şartı', re: /askerli[ğg][^\n.]{0,80}/iu },
    { label: 'Adli sicil kaydı şartı', re: /(?:adli sicil|sab[ıi]ka)[^\n.]{0,80}/iu },
    { label: 'Sağlık raporu şartı', re: /sa[ğg]l[ıi]k (?:raporu|kurulu[şs]u raporu)[^\n.]{0,70}/iu },
    { label: 'Güvenlik soruşturması şartı', re: /g[üu]venlik soru[şs]turmas[ıi][^\n.]{0,70}/iu },
    { label: 'Vardiyalı çalışma', re: /vardiyal[ıi][^\n.]{0,60}/iu },
    { label: 'Fiziksel koşullar (boy/kilo)', re: /(?:boy ve kilo|v[üu]cut kitle)[^\n.]{0,70}/iu },
    { label: 'Sigara kullanmama şartı', re: /sigara[^\n.]{0,60}/iu },
    { label: 'Bilgisayar bilgisi şartı', re: /bilgisayar (?:bilgisi|kullan[ıi]m[ıi])[^\n.]{0,60}/iu },
    { label: 'Ehliyet şartı', re: /s[üu]r[üu]c[üu] belgesi[^\n.]{0,70}/iu },
    { label: 'Deneyim şartı', re: /deneyim[^\n.]{0,80}/iu },
  ];
  const hits: SpecialConditionHit[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const match = pattern.re.exec(text);
    if (!match?.[0]) continue;
    if (seen.has(pattern.label)) continue;
    seen.add(pattern.label);
    hits.push({ label: pattern.label, snippet: collapseWhitespace(match[0]).slice(0, 200) });
  }
  return hits.slice(0, 12);
}

export function uniqueAttachments(attachments: readonly JobAttachment[]): JobAttachment[] {
  const seen = new Set<string>();
  const out: JobAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment.url || seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    out.push({ ...attachment, url: attachment.url });
  }
  return out.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

export function detectEmploymentType(text: string): EmploymentType {
  const normalized = normalizeTr(text);
  const scores = new Map<EmploymentType, number>();
  for (const entry of EMPLOYMENT_TYPE_KEYWORDS) {
    let score = 0;
    for (const needle of entry.needles) {
      const occurrences = normalized.split(normalizeTr(needle)).length - 1;
      score += occurrences;
    }
    if (score > 0) scores.set(entry.type as EmploymentType, score);
  }
  if (scores.size === 0) return 'belirsiz';
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = sorted[0];
  if (!best) return 'belirsiz';
  const second = sorted[1];
  if (second && second[1] === best[1] && best[0] !== 'sozlesmeli') {
    // Eşitlikte daha spesifik olan tercih edilir.
    const priority: EmploymentType[] = ['akademik', 'kariyer-meslek', 'kuruma-ozel-sinav', 'kamu-isci', 'sozlesmeli', 'kadrolu'];
    for (const candidate of priority) {
      if (scores.get(candidate) === best[1]) return candidate;
    }
  }
  return best[0];
}

function extractEmploymentType(
  text: string,
  title: string,
): { employmentType: EmploymentType; cadreStatus: string | null } {
  const fromTitle = detectEmploymentType(title);
  const fromText = detectEmploymentType(text);
  const employmentType = fromTitle !== 'belirsiz' ? fromTitle : fromText;

  const cadrePatterns: readonly { label: string; re: RegExp }[] = [
    { label: 'Kadrolu (657 4/A)', re: /4\s*\/?\s*A|kadrolu memur/iu },
    { label: 'Sözleşmeli (657 4/B)', re: /4\s*\/?\s*B/iu },
    { label: 'Geçici personel (657 4/C)', re: /4\s*\/?\s*C/iu },
    { label: 'Sürekli işçi (4857)', re: /4857|s[üu]rekli i[şs][çc]i/iu },
    { label: 'Akademik (2547)', re: /2547/iu },
  ];
  const match = cadrePatterns.find((pattern) => pattern.re.test(text));
  return { employmentType, cadreStatus: match?.label ?? null };
}

function computeConfidence(input: {
  bodyLength: number;
  noTextLayer: boolean;
  hasInstitution: boolean;
  hasCity: boolean;
  hasQuota: boolean;
  hasStart: boolean;
  hasEnd: boolean;
  hasEducation: boolean;
  hasApplicationUrl: boolean;
  hasKpss: boolean;
}): number {
  if (input.noTextLayer) return 0.15;
  let score = 0.3;
  if (input.bodyLength > 400) score += 0.1;
  if (input.bodyLength > 1_200) score += 0.05;
  if (input.hasInstitution) score += 0.1;
  if (input.hasCity) score += 0.05;
  if (input.hasQuota) score += 0.1;
  if (input.hasEnd) score += 0.12;
  if (input.hasStart) score += 0.05;
  if (input.hasEducation) score += 0.05;
  if (input.hasKpss) score += 0.04;
  if (input.hasApplicationUrl) score += 0.04;
  return Math.min(0.95, Math.round(score * 100) / 100);
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = collapseWhitespace(value);
  return cleaned.length > 0 ? cleaned : null;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** İlan özeti: arayüzde ve panelde gösterilecek kısa metin. */
export function summarizeAnnouncement(input: { title: string; institution: string | null; city: string | null; quota: number | null }): string {
  const parts = [input.institution ?? 'Kurum belirtilmemiş'];
  if (input.city) parts.push(input.city);
  if (input.quota !== null) parts.push(`${input.quota} kişi`);
  return `${input.title} — ${parts.join(' • ')}`;
}

export { formatDateTr, toIstanbulDateOnly };
export const ACCEPT_KEYWORD_SAMPLE = ACCEPT_KEYWORDS.slice(0, 3);
export const EDUCATION_KEYWORD_SAMPLE = EDUCATION_KEYWORDS.slice(0, 2);

/** PDF metnini ham ilana çevirirken kullanılan yardımcı (adaptörler paylaşır). */
export async function announcementFromPdf(input: {
  sourceKey: string;
  sourceItemId: string;
  url: string;
  title: string;
  data: Uint8Array;
  institution?: string | null;
  publishedAt?: string | null;
}): Promise<Pick<RawAnnouncement, 'bodyText' | 'attachments' | 'extractionConfidence' | 'notes'>> {
  const pdf = await extractPdfText(input.data);
  const attachments: JobAttachment[] = [{ url: input.url, label: input.title.slice(0, 120), kind: 'pdf' }];
  return {
    bodyText: pdf.text,
    attachments,
    extractionConfidence: pdf.noTextLayer ? 0.2 : 0.6,
    ...(pdf.noTextLayer || pdf.error
      ? { notes: [pdf.error ?? 'PDF metin katmanı yok (taranmış görüntü olabilir).'] }
      : {}),
  };
}

export function dateOnlyOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Geriye dönük uyumluluk adı: `extractApplicationWindow` ile aynıdır.
 * Yeni kod doğrudan `extractApplicationWindow` kullanmalıdır.
 */
export const findApplicationWindow = extractApplicationWindow;
