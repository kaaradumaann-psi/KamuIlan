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
import { collapseWhitespace, makeExcerpt, normalizeTr, uniquePreserve } from '../domain/text';
import {
  formatDateTr,
  parseTurkishDate,
  parseTurkishDateRange,
  plausibleApplicationEnd,
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
  KNOWN_QUALIFICATION_CODES,
  KPSS_TYPES,
  PROVINCES,
} from './dictionaries';
import { EXTRACTION_VERSION } from '../config/app';
import { extractPdfText } from './pdf';
import { extractOpenings, type JobOpening } from './openings';
import { parseTurkishNumberWords } from './number-words';
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

function sourceForEvidence(input: ExtractionInput, evidence: string | null | undefined): FieldSourceKind {
  if (!evidence) return 'unstated';
  const needle = normalizeTr(evidence);
  const body = normalizeTr(input.body ?? '');
  const title = normalizeTr(input.title);
  if (body && needle && body.includes(needle)) return input.bodySource ?? 'detail';
  if (title && needle && title.includes(needle)) return 'listing';
  return body ? (input.bodySource ?? 'detail') : 'listing';
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
  /** Tablodan okunan kadro kırılımı (unvan × kontenjan); kanıtsız tablo üretilmez. */
  openings: JobOpening[];
  educationLevels: EducationLevel[];
  departments: string[];
  kpssScoreTypes: KpssScoreType[];
  kpssMinScore: number | null;
  kpssYear: number | null;
  /** ÖSYM başvuru nitelik kodları ("Nitelik Kodu" sütunu: 4001, 6225, 4539...). */
  qualificationCodes: string[];
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
  const rawBody = (input.body ?? '').slice(0, MAX_BODY);
  const body = collapseWhitespace(rawBody);
  const title = collapseWhitespace(input.title);
  const haystack = `${title}\n${body}`;
  // Keep source line/sentence boundaries for contextual fields (education,
  // departments, roles). Flattened text made an incidental word anywhere in a
  // page look like a job requirement.
  const fieldSources: Record<string, FieldSource> = {};
  const evidence: Record<string, string> = {};
  const uncertainties: string[] = [];
  const listing = input.listing ?? {};

  const setField = (field: string, kind: FieldSourceKind, snippet: string | null) => {
    fieldSources[field] = { kind, snippet: snippet ? makeExcerpt(snippet, 240) : null };
    if (snippet) evidence[field] = makeExcerpt(snippet, 240);
  };

  // --- Kurum ---------------------------------------------------------------
  const institutionFromListing = cleanText(listing.institution);
  const institutionFromTitle = extractInstitutionFromTitle(title);
  const institutionFromBody = extractInstitutionFromBody(body);
  const institution = institutionFromListing ?? institutionFromTitle ?? institutionFromBody;
  if (institution) {
    setField(
      'institution',
      institutionFromListing
        ? 'listing'
        : institutionFromTitle
          ? 'listing'
          : sourceForEvidence(input, institutionFromBody),
      institution,
    );
  } else {
    setField('institution', 'unstated', null);
    uncertainties.push('İlan metninde kurum adı net biçimde belirtilmemiş.');
  }

  // --- Birim ---------------------------------------------------------------
  const unit = extractUnit(haystack);
  setField('unit', sourceForEvidence(input, unit), unit);

  // --- Çalışma biçimi / kadro durumu --------------------------------------
  const { employmentType, cadreStatus } = extractEmploymentType(haystack, title);
  setField(
    'employmentType',
    employmentType === 'belirsiz' ? 'unstated' : sourceForEvidence(input, cadreStatus ?? employmentType),
    cadreStatus,
  );
  if (employmentType === 'belirsiz') {
    uncertainties.push('Çalışma biçimi (kadrolu/sözleşmeli/işçi) metinden anlaşılamadı.');
  }

  // --- İl / ilçe -----------------------------------------------------------
  const cityFromListing = cleanText(listing.city);
  const textCity = chooseCityFromText(title, body);
  const cityCandidates = textCity.candidates;
  const cityFromText = textCity.city;
  const city = cityFromListing ?? cityFromText;
  if (city) {
    setField('city', cityFromListing ? 'listing' : sourceForEvidence(input, city), city);
    if (cityFromListing && cityFromText && normalizeTr(cityFromListing) !== normalizeTr(cityFromText)) {
      uncertainties.push(
        `Liste sayfası il bilgisini "${cityFromListing}", ilan metni "${cityFromText}" olarak veriyor; liste değeri kullanıldı.`,
      );
    }
  } else {
    setField('city', 'unstated', null);
    uncertainties.push('İl bilgisi belirtilmemiş.');
  }
  if (!cityFromListing && cityCandidates.length > 1 && !cityFromText) {
    uncertainties.push(
      `İlan metninde birden çok il geçiyor (${cityCandidates.slice(0, 4).join(', ')}) ve görev yeri belirtilmemiş; il atanmadı, elle doğrulanmalı.`,
    );
  }

  const districtFromListing = cleanText(listing.district);
  const districtFromText = extractDistrict(haystack);
  const district = districtFromListing ?? districtFromText;
  setField('district', districtFromListing ? 'listing' : sourceForEvidence(input, district), district);

  // --- Kontenjan -----------------------------------------------------------
  // Kadro tablosu (başlığı doğrulanmış, her satırı kanıtlı) metindeki tek sayıdan
  // güçlü kanıttır: varsa kontenjan tablo toplamıdır. İstisna: yazıyla doğrulanmış resmî
  // toplam ("11 (Onbir) … Personeli alınacaktır") kırılımdan güçlüdür — kırılım eksik
  // okunmuş olabilir (OCR sayfa sınırı: İŞKUR RG 18.10-4-4, 11 pozisyonun 2'si). Fark her
  // iki durumda da sessizce ezilmez; tutarsızlık belirsizlik olarak yazılır.
  const openings = extractOpenings(rawBody);
  const tableTotal = openings.reduce((total, opening) => total + opening.quota, 0);
  const textQuota = extractQuota(haystack);
  let quota = textQuota;
  if (openings.length > 0) {
    if (textQuota?.official && textQuota.value !== tableTotal) {
      uncertainties.push(
        `Kontenjan tutarsız: resmî toplam ${textQuota.value} (yazıyla doğrulandı), okunabilen kadro/pozisyon ` +
          `toplamı ${tableTotal}. Resmî toplam gösteriliyor; kırılım eksik olabilir, resmî metinden doğrulayın.`,
      );
    } else {
      if (textQuota && textQuota.value !== tableTotal) {
        uncertainties.push(
          `Kontenjan tutarsız: metinde ${textQuota.value} geçiyor, kadro tablosunun toplamı ${tableTotal}. ` +
            'Tablo toplamı gösteriliyor; resmî metinden doğrulayın.',
        );
      }
      quota = { value: tableTotal, snippet: openings.map((opening) => opening.evidence).join(' | ').slice(0, 300) };
    }
  }
  setField('quota', sourceForEvidence(input, quota?.snippet), quota?.snippet ?? null);
  if (!quota) uncertainties.push('Kontenjan bilgisi ilanda sayı olarak belirtilmemiş.');

  // --- Başvuru penceresi ---------------------------------------------------
  const windowResult = extractApplicationWindow(title, body, listing);
  const endKind: FieldSourceKind = windowResult.endFromListing
    ? 'listing'
    : sourceForEvidence(input, windowResult.endSnippet);
  const startEvidence = windowResult.startSnippet ?? cleanText(listing.applicationStartAt);
  const startKind = windowResult.startSnippet
    ? sourceForEvidence(input, windowResult.startSnippet)
    : listing.applicationStartAt
      ? 'listing'
      : 'unstated';
  setField('applicationStartAt', startKind, startEvidence);
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
  setField(
    'publishedAt',
    listing.publishedAt ? 'listing' : sourceForEvidence(input, publishedAt),
    publishedAt,
  );

  // --- Başvuru bağlantısı ve yöntemi --------------------------------------
  const applicationUrl = extractApplicationUrl(input.links ?? [], title, body);
  setField('applicationUrl', applicationUrl ? 'link' : 'unstated', applicationUrl);
  if (!applicationUrl) {
    uncertainties.push(
      'İlanda resmî bir başvuru bağlantısı bulunamadı; yalnızca ilan bağlantısı gösterilir.',
    );
  }
  const applicationMethod = extractApplicationMethod(haystack, Boolean(applicationUrl));
  setField('applicationMethod', sourceForEvidence(input, applicationMethod), applicationMethod);

  // --- İlan numarası -------------------------------------------------------
  const referenceNo =
    cleanText(input.referenceNo) ?? cleanText(listing.referenceNo) ?? extractReference(title, body);
  setField(
    'referenceNo',
    input.referenceNo || listing.referenceNo ? 'listing' : sourceForEvidence(input, referenceNo),
    referenceNo,
  );

  // --- Unvanlar, öğrenim, bölüm, KPSS, yaş, deneyim, belge, dil -----------
  const titles = extractTitles(rawBody, input.title);
  const titleEvidence = evidenceForTerms(input.title, rawBody, titles, input.bodySource);
  setField(
    'titles',
    titles.length > 0 ? (titleEvidence?.kind ?? 'unstated') : 'unstated',
    titleEvidence?.snippet ?? null,
  );

  const educationLevels = extractEducationLevels(rawBody, input.title);
  const educationEvidence = evidenceForTerms(
    input.title,
    rawBody,
    educationLevels.map(educationEvidenceLabel),
    input.bodySource,
  );
  setField(
    'educationLevels',
    educationLevels.length > 0 ? (educationEvidence?.kind ?? 'unstated') : 'unstated',
    educationEvidence?.snippet ?? null,
  );
  if (educationLevels.length === 0) uncertainties.push('Öğrenim düzeyi belirtilmemiş.');

  const departments = extractDepartments(rawBody, input.title);
  const departmentEvidence = evidenceForTerms(
    input.title,
    rawBody,
    departments.slice(0, 5),
    input.bodySource,
  );
  setField(
    'departments',
    departments.length > 0 ? (departmentEvidence?.kind ?? 'unstated') : 'unstated',
    departmentEvidence?.snippet ?? null,
  );

  const kpss = extractKpss(haystack);
  setField('kpss', sourceForEvidence(input, kpss.snippet), kpss.snippet);
  if (kpss.types.length === 0 && kpss.minScore === null) uncertainties.push('KPSS puanı/türü belirtilmemiş.');

  const qualification = extractQualificationCodes(haystack);
  setField('qualificationCodes', sourceForEvidence(input, qualification.snippet), qualification.snippet);

  const age = extractAge(haystack);
  setField('age', sourceForEvidence(input, age.snippet), age.snippet);

  const experience = extractExperience(haystack);
  setField('experience', sourceForEvidence(input, experience.snippet), experience.snippet);

  const certificates = extractCertificates(haystack);
  const certificateEvidence = certificates.join(', ') || null;
  setField('certificates', sourceForEvidence(input, certificateEvidence), certificateEvidence);

  const foreignLanguages = extractForeignLanguages(haystack);
  const languageEvidence = foreignLanguages.join(', ') || null;
  setField('foreignLanguages', sourceForEvidence(input, languageEvidence), languageEvidence);

  const specialHits = extractSpecialConditions(haystack);
  const specialConditions = specialHits.map((hit) => hit.label);
  setField(
    'specialConditions',
    sourceForEvidence(input, specialHits.map((hit) => hit.snippet).join(' • ') || null),
    specialHits.map((hit) => hit.snippet).join(' • ') || null,
  );

  // --- Ekler ---------------------------------------------------------------
  const attachments = uniqueAttachments(input.attachments ?? []);
  setField(
    'attachments',
    attachments.length > 0 ? 'link' : 'unstated',
    attachments.map((item) => item.url).join('\n') || null,
  );

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
    ...plausibleApplicationEnd({
      endAt: windowResult.end?.iso ?? cleanText(listing.applicationEndAt),
      endDate: windowResult.end?.dateOnly ?? dateOnlyOf(listing.applicationEndAt),
      publishedAt,
    }),
    publishedAt,
    applicationUrl,
    applicationMethod,
    referenceNo,
    cadreStatus,
    titles,
    openings,
    educationLevels,
    departments,
    kpssScoreTypes: kpss.types,
    kpssMinScore: kpss.minScore,
    kpssYear: kpss.year,
    qualificationCodes: qualification.codes,
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

/** Birim adını bitiren kelimeler (yalın hâl; "Başkanlığına" gibi ekli biçim sayılmaz). */
const UNIT_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'Müdürlüğü',
  'Fakültesi',
  'Enstitüsü',
  'Yüksekokulu',
  'Hastanesi',
  'Başhekimliği',
  'Birimi',
  'Koordinatörlüğü',
]);
/** Tek başına birim sayılmayan son kelimeler için iki kelimelik bitişler. */
const UNIT_SUFFIX_PAIRS: ReadonlySet<string> = new Set(['Daire Başkanlığı', 'Bölüm Başkanlığı']);
/**
 * Tablo başlığı / kalıp sözcükleri (küçük harf). PDF tabloları gövdede tek satıra
 * sıkışır: "KADRO ÜNVANI AÇIKLAMA MDF01 Mühendislik … Fakültesi" (RG 21.10.2026).
 */
const UNIT_STOP_WORDS: ReadonlySet<string> = new Set([
  'kadro', 'kadrosu', 'unvan', 'unvanı', 'ünvan', 'ünvanı', 'açıklama', 'aranan', 'koşullar',
  'koşulları', 'takvimi', 'gereken', 'bölümler', 'fakülteler', 'sayısı', 'program', 'dalı',
  'birim', 'akademik', 'sınav', 'dil', 'ilan', 'kodu', 'tablo', 'nitelik', 'nitelikleri',
  'şartlar', 'şartları', 'adet', 'derece', 'sınıfı',
]);
const UNIT_TITLE_CASE = /^[A-ZÇĞİÖŞÜÂÎÛ][a-zçğıöşüâîû’'-]+$/u;
const MAX_UNIT_WORDS = 8;

/**
 * İlanın birimi (ör. "Mühendislik ve Doğa Bilimleri Fakültesi").
 *
 * Birim adı, bitiş kelimesinden geriye doğru yalnızca Başlık Biçimli kelimeler ve
 * "ve/ile" ile toplanır; büyük harfli kod/tablo başlığı ("MDF01", "ÜNVANI"),
 * kalıp sözcüğü, noktalama ya da başka bir birim bitişi görülünce durulur.
 * Metinde birden fazla FARKLI birim varsa (çok fakülteli akademik ilan, mezuniyet
 * şartı tablosu) tek birim uydurulmaz: `null`.
 */
export function extractUnit(text: string): string | null {
  const tokens = collapseWhitespace(text).split(' ');
  const found: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = (tokens[index] ?? '').replace(/[.,;:)]+$/u, '');
    const pair = index > 0 && UNIT_SUFFIX_PAIRS.has(`${tokens[index - 1] ?? ''} ${word}`);
    if (!UNIT_SUFFIX_WORDS.has(word) && !pair) continue;
    const parts = [word];
    for (let back = index - 1; back >= 0 && parts.length < MAX_UNIT_WORDS; back -= 1) {
      const token = tokens[back] ?? '';
      if (/[.,;:)]$/u.test(token) || UNIT_SUFFIX_WORDS.has(token)) break;
      const lower = token.toLocaleLowerCase('tr');
      const connector = lower === 've' || lower === 'ile';
      if (!connector && (!UNIT_TITLE_CASE.test(token) || UNIT_STOP_WORDS.has(lower))) break;
      parts.unshift(token);
    }
    while (parts.length > 1 && /^(?:ve|ile)$/iu.test(parts[0] ?? '')) parts.shift();
    const value = parts.join(' ');
    if (parts.length >= 2 && value.length >= 8) found.push(value.slice(0, 140));
  }
  // Aynı birimin önüne cümle başı kelimesi eklenmiş biçimi ("Başvurular Hukuk Fakültesi") aynı birimdir.
  const distinct = [...new Set(found)].filter(
    (candidate, _, all) => !all.some((other) => other !== candidate && candidate.endsWith(` ${other}`)),
  );
  return distinct.length === 1 ? (distinct[0] ?? null) : null;
}

/** Türkçe hâl ekleri: "Ankara'da", "Muş'ta", "Van ilinde" gibi kullanımlar için. */
const CITY_SUFFIXES: readonly string[] = [
  'daki',
  'deki',
  'taki',
  'teki',
  'lardaki',
  'lerdeki',
  'dan',
  'den',
  'tan',
  'ten',
  'dır',
  'dir',
  'dur',
  'dür',
  'tır',
  'tir',
  'tur',
  'tür',
  'da',
  'de',
  'ta',
  'te',
  'lar',
  'ler',
  'ya',
  'ye',
  'ın',
  'in',
  'un',
  'ün',
  'lık',
  'lik',
  'luk',
  'lük',
  'lı',
  'li',
  'lu',
  'lü',
  'a',
  'e',
  'ı',
  'i',
  'u',
  'ü',
];

let cityMatcherSource: { source: string; canonical: Map<string, string> } | null = null;

function getCityMatcher(): { source: string; canonical: Map<string, string> } {
  if (cityMatcherSource) return cityMatcherSource;
  const canonical = new Map<string, string>();
  for (const name of PROVINCES) canonical.set(normalizeTr(name), name);
  const names = [...canonical.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const suffixes = [...CITY_SUFFIXES].sort((a, b) => b.length - a.length).join('|');
  cityMatcherSource = {
    canonical,
    source: `(?<!\\p{L})(${names.join('|')})(?:${suffixes})?(?!\\p{L})`,
  };
  return cityMatcherSource;
}

/**
 * Metinde geçen il adları (kanonik yazımla, geçiş sırasına göre, tekrarsız).
 *
 * Neden kelime sınırı: düz arama "doldurmuş" içinde "Muş", "avantaj" içinde
 * "Van", "Bursaspor" içinde "Bursa" bulur ve ilana OLMAYAN bir il yazardı.
 * İl adı yalnızca kelime başında tanınır; ardından Türkçe ek gelebilir.
 */
export function extractCityCandidates(text: string): string[] {
  const { source, canonical } = getCityMatcher();
  const regex = new RegExp(source, 'gu');
  const normalized = normalizeTr(text);
  const found: string[] = [];
  for (const match of normalized.matchAll(regex)) {
    const key = match[1];
    if (!key) continue;
    const name = canonical.get(key);
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/** Görev yeri ipucu: "görev yeri: Ankara", "çalışma yeri - İzmir" gibi açık ifadeler. */
const CITY_CUE_PATTERN =
  /(?:gorev\s*yeri|calisma\s*yeri|calisilacak\s*(?:il|yer)|atama\s*(?:yeri|ili)|\bil\s*:)\s*[:\-]?\s*(.{0,40})/g;

/**
 * Metinden kadronun ili. Öncelik: açık görev yeri ipucu; yoksa metinde TEK bir il.
 * Birden çok il geçiyor ve ipucu yoksa il null döner (ilk geçen ilin seçilmesi kadronun
 * yanlış ile atanmasına yol açardı: bkz. kurum merkezi, nav menüsü ve başka birimler).
 */
export function chooseCityFromText(
  title: string,
  body: string,
): { city: string | null; candidates: string[]; byCue: boolean } {
  const text = `${title}\n${body}`;
  const candidates = extractCityCandidates(text);
  for (const match of normalizeTr(text).matchAll(CITY_CUE_PATTERN)) {
    const city = extractCityCandidates(match[1] ?? '')[0];
    if (city) return { city, candidates, byCue: true };
  }
  if (candidates.length === 1) return { city: candidates[0] ?? null, candidates, byCue: false };
  return { city: null, candidates, byCue: false };
}

/** İlan metninden il: ilk geçen il adı. Birden çok il geçiyorsa engine uyarı ekler. */
export function extractCity(text: string): string | null {
  return extractCityCandidates(text)[0] ?? null;
}

export function extractDistrict(text: string): string | null {
  const match = /([A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,25})\s+(?:İlçesi|ilçesi|İlçesinde|ilçesinde|İlçe|ilçe)/u.exec(
    text,
  );
  return match?.[1] ? collapseWhitespace(match[1]) : null;
}

const QUOTA_ROLE = String.raw`(?:personel|memur|işçi|eleman|uzman|kadro|mühendis|tekniker|teknisyen|görevli|müfettiş|avukat|hemşire|ebe|şoför)[a-zçğıöşü]*`;
// Kalem: "6 (altı) Uzman", "| (bir) Destek Personeli" — rakam OCR'da "|", "l", "I" okunabilir.
const QUOTA_ITEM = String.raw`(\d{1,4}|[|lI])\s*\(([a-zçğıöşü ]{2,30})\)\s+(?:[^\s.;:()]+\s+){0,4}?${QUOTA_ROLE}`;
const QUOTA_ITEM_UNCAPTURED = String.raw`(?:\d{1,4}|[|lI])\s*\([a-zçğıöşü ]{2,30}\)\s+(?:[^\s.;:()]+\s+){0,4}?${QUOTA_ROLE}`;
const OFFICIAL_TOTAL = new RegExp(
  String.raw`${QUOTA_ITEM_UNCAPTURED}(?:\s*(?:,|ve)\s*${QUOTA_ITEM_UNCAPTURED})*` +
    String.raw`\s*(?:\([^()]{0,40}\)\s*)?(?:alın|alım[ıi]\s+yap|istihdam)`,
  'iu',
);

/**
 * Resmî toplam "sayıyla (yazıyla)": "… 2 (iki) Sözleşmeli Bilişim Personeli alınacaktır" (RG
 * 16.10-4-1, Sayıştay), "6 (altı) Uzman ve 1 (bir) Destek Personeli … alımı yapılacaktır" (RG
 * 19.10-4-7). Pozisyon başı "(1 Kişi …)" ifadeleri metinde önce geçse de toplam budur. Her kalemde
 * rakam yazıyla doğrulanır: çelişki → kural kullanılmaz; rakam okunamıyorsa (OCR "|") yazı esas.
 */
function extractOfficialTotal(text: string): { value: number; snippet: string; official: true } | null {
  const match = OFFICIAL_TOTAL.exec(text);
  if (!match) return null;
  let total = 0;
  for (const item of match[0].matchAll(new RegExp(QUOTA_ITEM, 'giu'))) {
    const words = parseTurkishNumberWords(item[2] ?? '');
    if (words === null) return null;
    const digits = /^\d+$/.test(item[1] ?? '') ? Number(item[1]) : null;
    if (digits !== null && digits !== words) return null;
    total += words;
  }
  return total > 0 && total <= 20_000 ? { value: total, snippet: collapseWhitespace(match[0]), official: true } : null;
}

export function extractQuota(text: string): { value: number; snippet: string; official?: true } | null {
  const official = extractOfficialTotal(text);
  if (official) return official;
  const patterns: readonly RegExp[] = [
    /kontenjan\s*(?:bilgisi|sayısı|:)?\s*[:.]?\s*(\d{1,4})/i,
    // "adet" çoğu ilanda BELGE sayısıdır: "3 adet vesikalık fotoğraf", "Sabıka Kaydı (1 adet)",
    // "Profesör kadrosu adayları 6 adet, … 4 adet dijital dosya" (gerçek RG metinleri).
    // Yalnızca ardından en çok dört kelime içinde kadro/personel sözcüğü gelirse kontenjandır:
    // "5 adet sözleşmeli personel", "1 adet Zabıta Memuru kadrosu".
    /(\d{1,4})\s*(?:kişi|adet(?=\s+(?:[^\s,.;:()]+\s+){0,4}?(?:kadro|personel|memur|işçi|pozisyon|eleman|uzman|mühendis|tekniker|teknisyen|şoför|hemşire|ebe|öğretim|görevli|avukat|müfettiş|zabıta|itfaiye|bekçi)[\wçğıöşü]*)|personel|pozisyon|eleman|işçi)(?:\s+alım|\s+alınacak)?/i,
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
    /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/iu.test(
      sentence,
    );

  // "İlan Tarihi 19/10/2026 Başvuru Tarihleri 09/11/2026 — 03/12/2026" (tablo biçimli ilan,
  // RG 19.10.2026-4-7): etiketli ilan/yayım tarihi başvuru penceresi değildir. Aralık
  // okunmadan önce çıkarılır; yoksa ilan tarihi başlangıç, başvuru başlangıcı BİTİŞ sanılıyor
  // ve ilan haftalar önce "kapandı" görünüyordu.
  const withoutPublicationDate = (sentence: string): string =>
    sentence.replace(
      // `\b` "İ" önünde çalışmaz (ASCII dışı): Unicode harf geriye bakışı kullanılır.
      /(?<![\p{L}\d])(?:[İi]lan|ILAN|İLAN|Yay[ıi]m|Yay[ıi]n|YAYIM|YAYIN)\s+(?:[Tt]arihi|TARİHİ)\s*:?\s*(?:\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}|\d{1,2}\s+\p{L}+\s+\d{4})/gu,
      ' ',
    );

  const windowSentences = sentences.filter(isWindowSentence);
  for (const sentence of windowSentences) {
    const range = parseTurkishDateRange(withoutPublicationDate(sentence));
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
  const explicitEnd =
    /(?:son\s+ba[şs]vuru(?:\s+tarihi)?|ba[şs]vurular[ıi]n\s+son\s+g[üu]n[üu]|en\s+son)[^.\n]{0,120}/iu.exec(
      text,
    );
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
      return {
        start: null,
        end: parsed,
        startSnippet: null,
        endSnippet: collapseWhitespace(until[0]).slice(0, 240),
      };
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

/** Noktalı (14.10.2026) ya da yazıyla ay (14 Ekim 2026) tarih biçimi. */
const TR_DATE_FORM = '(?:\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,12}\\s+\\d{4})';

/**
 * Yasal atıf tarihlerini metinden çıkarır: "26 Eylül 2004 tarihli ve 25585 sayılı
 * Yönetmelik", "15 Temmuz 2018 tarihli 30479 sayılı Kararname" gibi.
 *
 * Neden gerekli: bu tarih İLANIN yayım tarihi değil, atıf yapılan mevzuatın
 * tarihidir. Ayıklanmazsa 2026'da yayımlanan bir ilan 2004/2008/2018 tarihli
 * görünür; "tarih yok + eski yayım" kuralı yüzünden güncel ilan kapanmış sayılır.
 */
function stripLegalCitationDates(text: string): string {
  const spelledOrDotted = `\\d{1,2}(?:[./]\\d{1,2}[./]\\d{4}|\\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,12}\\s+\\d{4})`;
  const citation = new RegExp(
    `${spelledOrDotted}\\s+tarihli\\s+(?:ve\\s+)?(?:\\d{1,5}\\s*)?(?:sayılı|Sayılı)[^.\\n]{0,80}`,
    'giu',
  );
  return text.replace(citation, ' ');
}

export function extractPublishedAt(text: string): string | null {
  const cleaned = stripLegalCitationDates(text);
  // Etiketli yayım tarihi: "Yayım Tarihi: 14.10.2026", "İlan tarihi 14 Ekim 2026".
  // Etiket ile tarih AYNI SATIRDA olmalıdır: satır atlanırsa komşu cümlenin
  // (ör. son başvuru ya da bir başka duyurunun) tarihi yayım tarihi sanılırdı.
  // NOT: `i` bayrağı "İ" (U+0130) ile "i"yi eşleştirmez; Türkçe büyük harf
  // açıkça yazılır (bkz. src/sources/listing-utils.ts aynı tuzağı not ediyor).
  const labelPattern = new RegExp(
    `(?:yay[ıi]m|yay[ıi]nlanma|yay[ıi]mlanma|duyuru|duyurulma|[İIiı]lan)[ \\t]*(?:tarihi|tarihinde)?[ \\t]*[:.]?[ \\t]*(${TR_DATE_FORM})`,
    'giu',
  );
  for (const match of cleaned.matchAll(labelPattern)) {
    const parsed = parseTurkishDate(match[1] ?? '');
    if (parsed) return parsed.iso;
  }
  // "… tarihli …" kalıbı: yasal atıflar ayıklandıktan sonra kalanlar ilanın
  // kendi tarihi olabilir. Ardından "sayılı"/"Resmî Gazete" geliyorsa yine atıftır.
  const suffixPattern = /([^.\n]{0,40}?tarihli)/giu;
  for (const match of cleaned.matchAll(suffixPattern)) {
    const after = cleaned.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + 40,
    );
    if (/sayılı|resm[îi]\s+gazete/iu.test(after)) continue;
    const parsed = parseTurkishDate(match[1] ?? '');
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
  const normalized = normalizeTr(text);
  const found: string[] = [];
  for (const method of APPLICATION_METHODS) {
    if (normalized.includes(normalizeTr(method))) found.push(method);
  }
  if (found.length === 0) return null;
  // Kapsanan ifadeleri at: "posta yoluyla" varken "posta" ayrıca yazılmasın.
  const unique = found.filter(
    (method) => !found.some((other) => other !== method && normalizeTr(other).includes(normalizeTr(method))),
  );
  void hasApplicationUrl;
  return unique.slice(0, 3).join(', ');
}

export function extractReference(title: string, body: string): string | null {
  const match = /\b(YOK|DPB|ILN|TR)[-\s]?(\d{5,12})\b/i.exec(`${title} ${body}`);
  return match?.[1] && match[2] ? `${match[1].toUpperCase()}${match[2]}` : null;
}

const ROLE_CONTEXT =
  /\b(?:pozisyon\w*|kadro\w*|unvan\w*|kontenjan\w*|al(?:im|in\p{L}*)|istihdam\w*|gorevlendir\p{L}*|calistiril\p{L}*|aranan\s+(?:unvan|pozisyon))\b/u;
const EDUCATION_CONTEXT =
  /\b(?:mezun\p{L}*|mezuniyet\w*|ogrenim\w*|egitim\s+(?:duzeyi|durumu|seviyesi)|diploma\w*|diplomali|ogretim\s+programi)\b/u;
const DEPARTMENT_CONTEXT =
  /\b(?:bolum\w*|program\w*|mezun\p{L}*|mezuniyet\w*|ogrenim\w*|egitim\w*|fakulte\w*|anabilim\s+dali|ana\s+bilim\s+dali|lisans\s+programi|diploma\w*)\b/u;

/**
 * A phrase is evidence only as a complete word/phrase, never as a substring of
 * another word (e.g. "Ebe" inside "Muhasebe"). For body text, also require a
 * nearby role/qualification cue; a dictionary mention in page chrome or prose
 * is not enough to populate a user's structured job requirements.
 */
function hasBoundedPhrase(text: string, phrase: string): boolean {
  const normalized = normalizeTr(text);
  const needle = normalizeTr(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, 'u').test(normalized);
}

function hasContextualPhrase(text: string, phrase: string, context: RegExp): boolean {
  const chunks = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((part) => collapseWhitespace(part))
    .filter(Boolean);
  const needle = normalizeTr(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const phrasePattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, 'u');

  for (let index = 0; index < chunks.length; index += 1) {
    const current = chunks[index] ?? '';
    if (!phrasePattern.test(normalizeTr(current))) continue;
    const adjacent = [chunks[index - 1], current, chunks[index + 1]]
      .filter((part) => part && part.length <= 180)
      .join(' ');
    const normalized = normalizeTr(adjacent);
    const withoutPhrase = normalized.replace(phrasePattern, ' ');
    const explicitlyNegated =
      /\b(?:alinmayacak\w*|gorevlendirilmeyecek\w*|calistirilmayacak\w*|kadroda\s+yer\s+almayacak\w*)\b/u.test(
        withoutPhrase,
      );
    const phraseItselfCarriesContext = context.test(normalizeTr(phrase));
    if ((context.test(withoutPhrase) || phraseItselfCarriesContext) && !explicitlyNegated) return true;
  }
  return false;
}

function evidenceForTerms(
  titleText: string,
  bodyText: string,
  terms: readonly string[],
  bodySource: ExtractionInput['bodySource'],
): { kind: FieldSourceKind; snippet: string } | null {
  const titleChunks = titleText
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((part) => collapseWhitespace(part))
    .filter(Boolean);
  const bodyChunks = bodyText
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((part) => collapseWhitespace(part))
    .filter(Boolean);
  for (const term of terms) {
    const bodyEvidence = bodyChunks.find((chunk) => hasBoundedPhrase(chunk, term));
    if (bodyEvidence) return { kind: bodySource ?? 'detail', snippet: bodyEvidence.slice(0, 240) };
    const titleEvidence = titleChunks.find((chunk) => hasBoundedPhrase(chunk, term));
    if (titleEvidence) return { kind: 'listing', snippet: titleEvidence.slice(0, 240) };
  }
  return null;
}

function educationEvidenceLabel(level: EducationLevel): string {
  const labels: Record<EducationLevel, string> = {
    ilkogretim: 'ilköğretim',
    ortaogretim: 'ortaöğretim',
    onlisans: 'ön lisans',
    lisans: 'lisans',
    yukseklisans: 'yüksek lisans',
    doktora: 'doktora',
  };
  return labels[level];
}

export function extractTitles(text: string, titleText = ''): string[] {
  const found: string[] = [];
  for (const title of JOB_TITLES) {
    // A genuine role in the announcement heading is strong evidence. Body-only
    // matches need local hiring context and strict word boundaries.
    if (hasBoundedPhrase(titleText, title) || hasContextualPhrase(text, title, ROLE_CONTEXT))
      found.push(title);
  }
  // Uzun (spesifik) unvanlar önce gelir.
  return found.sort((a, b) => b.length - a.length).slice(0, 12);
}

/** "ön lisans", "önlisans", "yüksek lisans" (Türkçe büyük/küçük harf, noktalı/noktasız i dahil). */
const PREFIXED_LISANS_PATTERN =
  /(?<![\p{L}\p{N}])(?:[öÖoO][nN]|[yY][üÜuU][kK][sS][eE][kK])\s*[lL][iİIı][sS][aA][nN][sS](?![\p{L}\p{N}])/gu;

export function extractEducationLevels(text: string, titleText = ''): EducationLevel[] {
  const levels: EducationLevel[] = [];
  const checks: readonly { level: EducationLevel; phrases: readonly string[] }[] = [
    { level: 'doktora', phrases: ['doktora', 'sanatta yeterlik', 'sanatta yeterlilik'] },
    { level: 'yukseklisans', phrases: ['yüksek lisans', 'master'] },
    { level: 'onlisans', phrases: ['ön lisans', 'önlisans', 'iki yıllık yüksekokul'] },
    { level: 'lisans', phrases: ['lisans', 'dört yıllık', 'fakülte mezunu'] },
    { level: 'ortaogretim', phrases: ['ortaöğretim', 'lise mezunu', 'lise ve dengi', 'meslek lisesi'] },
    { level: 'ilkogretim', phrases: ['ilköğretim', 'ilk öğretim'] },
  ];
  for (const check of checks) {
    // "Ön lisans"/"yüksek lisans" içindeki "lisans" lisans kanıtı değildir; maske HAM metinde
    // uygulanır. Önceden metin normalize edilip maskeleniyordu: normalize noktaları sildiği
    // için cümle bölme çalışmıyor, tek paragraflık ilanda "Hemşirelik lisans mezunu" bile
    // bulunamıyordu ("ön lisans veya lisans" yalnız ön lisans çıkıyordu).
    const bodyForLevel = check.level === 'lisans' ? text.replace(PREFIXED_LISANS_PATTERN, ' ') : text;
    const titleForLevel = check.level === 'lisans' ? titleText.replace(PREFIXED_LISANS_PATTERN, ' ') : titleText;
    const matched = check.phrases.some(
      (phrase) =>
        hasContextualPhrase(titleForLevel, phrase, EDUCATION_CONTEXT) ||
        hasContextualPhrase(bodyForLevel, phrase, EDUCATION_CONTEXT),
    );
    if (matched) levels.push(check.level);
  }
  return levels;
}

export function extractDepartments(text: string, titleText = ''): string[] {
  const found: string[] = [];
  for (const department of DEPARTMENTS) {
    if (
      hasContextualPhrase(titleText, department, DEPARTMENT_CONTEXT) ||
      hasContextualPhrase(text, department, DEPARTMENT_CONTEXT)
    ) {
      found.push(department);
    }
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

  const scoreMatch =
    /(?:KPSS[^.\n]{0,60}?|taban puan[ıi]?[^.\n]{0,20}?)(\d{2,3})(?:[.,](\d{1,2}))?\s*(?:puan|ve üzeri|puan[ıi]|ve yukar[ıi]s[ıi])?/i.exec(
      normalizedText,
    );
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

/**
 * ÖSYM başvuru nitelik kodu çıkarımı ("Nitelik Kodu: 4001", "4539 ve 6225").
 *
 * Ekosistem yaklaşımı (emrekorkusuz/kamu-ilan-takip): kodlar 4xxx/6225 kalıbıyla
 * yakalanır. Yanlış pozitifi (yıl, dosya no, tutar) elemek için bağlam penceresi
 * isteriz: "nitelik kodu" etrafı; bilinen kodlar (4001, 6225...) ise nitelik/
 * KPSS/ÖSYM/mezun yakınlığıyla da kabul edilir.
 */
export function extractQualificationCodes(text: string): { codes: string[]; snippet: string | null } {
  const normalizedText = text.replace(/\s+/g, ' ');
  const found: string[] = [];
  let snippet: string | null = null;
  const add = (code: string, window: string): void => {
    if (found.includes(code)) return;
    if (found.length >= 8) return;
    found.push(code);
    snippet ??= collapseWhitespace(window.slice(0, 240));
  };

  // 1) "nitelik kodu / nitelik kodları" penceresi (±220 karakter)
  for (const match of normalizedText.matchAll(/\bnitelik\s+kod(?:u|lar[ıi])?\b/giu)) {
    const index = match.index ?? 0;
    const window = normalizedText.slice(
      Math.max(0, index - 220),
      Math.min(normalizedText.length, index + 260),
    );
    for (const codeMatch of window.matchAll(/\b[3-6]\d{3}\b/g)) {
      add(codeMatch[0], window);
    }
  }

  // 2) Bilinen nitelik kodları: nitelik/KPSS/ÖSYM/mezun yakınlığıyla
  const NEAR = /\bnitelik|\bkpss\b|\b[öo]sym\b|\bmezun|\bpuan\s*t[üu]r/iu;
  for (const code of KNOWN_QUALIFICATION_CODES) {
    const pattern = new RegExp(`\\b${code}\\b`, 'g');
    for (const match of normalizedText.matchAll(pattern)) {
      const index = match.index ?? 0;
      const window = normalizedText.slice(
        Math.max(0, index - 120),
        Math.min(normalizedText.length, index + 120),
      );
      if (NEAR.test(window)) add(code, window);
    }
  }

  return { codes: found, snippet };
}

export function extractAge(text: string): {
  minAge: number | null;
  maxAge: number | null;
  snippet: string | null;
} {
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
  if (driving?.[1] && !found.includes('Sürücü Belgesi'))
    found.push(`${driving[1].toUpperCase()} sınıfı sürücü belgesi`);
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
    const priority: EmploymentType[] = [
      'akademik',
      'kariyer-meslek',
      'kuruma-ozel-sinav',
      'kamu-isci',
      'sozlesmeli',
      'kadrolu',
    ];
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
export function summarizeAnnouncement(input: {
  title: string;
  institution: string | null;
  city: string | null;
  quota: number | null;
}): string {
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
