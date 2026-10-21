/**
 * İlan servisi: ham ilanı ortak şemaya dönüştürür, tekilleştirir, kaydeder,
 * değişiklikleri sürüm geçmişine yazar ve bildirim olaylarını tetikler.
 *
 * Bu modül iş mantığının tek adresidir: hem zamanlanmış tarama hem yönetici
 * panelinden manuel kayıt hem de testler aynı yolu kullanır.
 */
import { createId, sha256Hex } from '../domain/ids';
import { jobContentFingerprint } from '../domain/job-content-fingerprint';
import {
  collapseWhitespace,
  diceSimilarity,
  escapeRegExp,
  makeExcerpt,
  normalizeTr,
  redactContactDetails,
} from '../domain/text';
import {
  addDaysDateOnly,
  isStalePublication,
  plausibleApplicationEnd,
  sanePublishedDate,
  toIstanbulDateOnly,
} from '../domain/dates';
import { normalizeUrl } from '../domain/urls';
import type { EmploymentType, JobStatus, RawAnnouncement, ClassificationResult } from '../domain';
import { CLASSIFICATION_VERSION, EXTRACTION_VERSION, DEDUPE_VERSION } from '../config/app';
import { classify } from '../classification/engine';
import { extract, extractUnit, type ExtractedJob } from '../extraction/engine';
import type { LlmClassificationGate, LlmReviewOpinion } from '../ai/classifier';
import type { JobDoc, JobRevisionDoc, JobSourceDoc, SourceDoc, SourceItemDecisionDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import { DEDUPE_THRESHOLDS, decideDedupe, matchBySourceIdentity } from './dedupe';
import type { DedupeCandidateJob, DedupeDecision } from './dedupe';
import { findSourceDefinition } from '../config/sources';

/** Şema, `www.` ve sorgu dizesi farkını yok sayarak aynı sayfayı mı gösteriyor? */
function samePageUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const host = (value: URL) => value.host.toLowerCase().replace(/^www\./, '');
    const path = (value: URL) => value.pathname.replace(/\/+$/, '').toLowerCase();
    return host(a) === host(b) && path(a) === path(b);
  } catch {
    return false;
  }
}

/**
 * İlan bağlantısı kaynağın KENDİ liste/dizin ya da ana sayfası mı?
 *
 * Gerçek veri kanıtı (16.10.2026 denetimi): iki kayıt böyle çöpe dönüştü —
 * Karayolları kaydının başlığı "Daha yüksek erişilebilirlik modunu aç" (sayfadaki
 * erişilebilirlik düğmesi), İçişleri kaydının başlığı sayfanın tüm menüsüydü;
 * ikisinin de detay bağlantısı kaynağın liste adresiydi. Bir liste sayfası ilan
 * değildir: başlık ve tarih sayfa iskeletinden gelir, kayıt uydurma olur.
 */
export async function isSourceListingUrl(url: string, sourceKey: string, repos: Repos): Promise<boolean> {
  const targets = new Set<string>();
  const definition = findSourceDefinition(sourceKey);
  if (definition) {
    targets.add(definition.listingUrl);
    targets.add(definition.homepageUrl);
  }
  // Kayıtlı kaynak satırı (kullanıcı panelden düzenlemiş olabilir) otoritedir.
  const stored = await repos.sources.getByKey(sourceKey);
  if (stored) {
    targets.add(stored.listingUrl);
    targets.add(stored.homepageUrl);
  }
  for (const target of targets) {
    if (target && samePageUrl(url, target)) return true;
  }
  return false;
}

export interface IngestOutcome {
  action: 'created' | 'merged' | 'updated' | 'review' | 'rejected' | 'withdrawal-signal';
  jobId: string | null;
  decision: DedupeDecision | null;
  classification: ClassificationResult;
  changes: string[];
  reviewId: string | null;
  revisionCreated: boolean;
}

export interface IngestOptions {
  provenance?: 'scraped' | 'sample' | 'manual';
  /** Manuel kayıtta gövde metni elle verilir. */
  now?: Date;
}

const CAPTURED_NOTICE_LIMIT = 100_000;

function capturedTextFields(
  raw: RawAnnouncement,
): Pick<JobSourceDoc, 'capturedTextCharacterCount' | 'capturedTextStatus'> {
  if (raw.bodyTextSource === 'listing') {
    return { capturedTextCharacterCount: 0, capturedTextStatus: 'listing-only' };
  }
  if (!raw.bodyText) {
    return {
      capturedTextCharacterCount: 0,
      capturedTextStatus: raw.rawExcerpt ? 'listing-only' : 'unavailable',
    };
  }
  const cleanedText = collapseWhitespace(redactContactDetails(raw.bodyText));
  const boundedText = makeExcerpt(cleanedText, CAPTURED_NOTICE_LIMIT);
  const truncated =
    raw.bodyTextTruncated === true ||
    raw.bodyText.length > CAPTURED_NOTICE_LIMIT ||
    cleanedText.length > CAPTURED_NOTICE_LIMIT;
  return {
    capturedTextCharacterCount: boundedText.length,
    capturedTextStatus: truncated ? 'truncated' : 'captured',
  };
}

function sourceLinkDocument(raw: RawAnnouncement, jobId: string, nowIso: string): JobSourceDoc {
  const capture = capturedTextFields(raw);
  return {
    id: createId('jsrc'),
    jobId,
    sourceKey: raw.sourceKey,
    sourceItemId: raw.sourceItemId,
    url: normalizeUrl(raw.url),
    title: raw.title,
    institution: raw.institution ?? null,
    sourceCategory: raw.sourceCategory ?? null,
    publishedAt: raw.publishedAt ?? null,
    ...capture,
    attachments: raw.attachments,
    active: true,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
  };
}

/**
 * İlan oluşturmayan kaydı tarama belleğine yazar (ret/inceleme).
 *
 * Bu kayıt yoksa adaptör aynı ilanı her taramada yeniden "yeni" sayar; liste
 * başındaki ihale/sonuç duyuruları detay bütçesinin tamamını yutup sonraki
 * sayfalardaki gerçek personel alım ilanlarının süresiz aç kalmasına yol açar.
 */
async function recordIngestDecision(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  decision: SourceItemDecisionDoc['decision'],
): Promise<void> {
  const capture = capturedTextFields(raw);
  await ctx.repos.jobs.recordSourceItemDecision({
    sourceKey: raw.sourceKey,
    sourceItemId: raw.sourceItemId,
    decision,
    capturedTextStatus: capture.capturedTextStatus,
    title: raw.title,
    url: normalizeUrl(raw.url) ?? raw.url,
    classificationVersion: CLASSIFICATION_VERSION,
  });
}

/** Başvuru penceresine göre ilan durumu. */
export function computeStatus(params: {
  applicationStartAt: string | null;
  applicationEndAt: string | null;
  applicationEndDate: string | null;
  /** Yayım tarihi (YYYY-MM-DD). Son başvuru yoksa eski ilan kapalı sayılır. */
  publishedAt?: string | null;
  now: Date;
}): JobStatus {
  const today = toIstanbulDateOnly(params.now);
  // Yanlış çıkarılmış son başvuru (1991, yayından önce) "kapandı" yapmasın; mevcut satırlar için de geçerli.
  const deadline = plausibleApplicationEnd({
    endAt: params.applicationEndAt,
    endDate: params.applicationEndDate,
    publishedAt: params.publishedAt,
  });
  if (deadline.applicationEndDate && deadline.applicationEndDate < today) return 'closed';
  if (params.applicationStartAt && new Date(params.applicationStartAt).getTime() > params.now.getTime())
    return 'upcoming';
  // Saat YALNIZCA metinde gerçekten yazılıysa kesin kabul edilir. Çıkarım
  // motoru saati bilinmeyen tarihlerde 00:00 yazar; bu "gün başı" damgasını
  // kesin sanmak, son başvuru günü BUGÜN olan ilanı gece yarısından sonra
  // "Kapandı" yapıyordu (kullanıcı "son gün" diyor, sistem "kapandı" diyordu).
  // Son başvuru günü, gün bitene kadar açıktır.
  const endAt = deadline.applicationEndAt;
  const endAtHasExplicitTime = endAt !== null && !endAt.includes('T00:00:00');
  if (endAtHasExplicitTime && endAt && new Date(endAt).getTime() < params.now.getTime()) {
    return 'closed';
  }
  // Son başvuru tarihi hiç yoksa ve ilan çok eskiyse (ör. 2008/2018 yayımlı), açık sayılmaz:
  // bu tür kayıtlar yalnızca eski bir duyurunun arşiv kopyasıdır.
  const hasNoDeadline = !deadline.applicationEndDate && !endAt;
  if (hasNoDeadline && isStalePublication(sanePublishedDate(params.publishedAt, today), today)) return 'closed';
  // Son başvuru tarihi bilinmiyorsa "başvuru açık" denmez: başlangıç geçmiş olsa bile durum belirsizdir.
  if (hasNoDeadline) return 'unknown';
  return 'active';
}

/** Durum gerekçesi (panelde ve detayda gösterilir). Boşsa gerekçe yazılmaz. */
export function statusReasonFor(status: JobStatus, params: { applicationEndDate: string | null; applicationEndAt: string | null; publishedAt: string | null; now: Date }): string {
  if (status === 'unknown') return 'Tarih bilgisi bulunamadı';
  if (status === 'closed' && !params.applicationEndDate && !params.applicationEndAt) {
    return 'Yayımından uzun süre geçti ve son başvuru tarihi belirtilmemiş.';
  }
  return '';
}

/**
 * Başlıkta kesin iptal/geri çekme ifadesi.
 *
 * KAPSAM KANITI (21.10.2026 ilan.gov.tr personel alımı listesi): gerçek iptal
 * kaydının başlığı **"İptal İlanı (İzmir Kalkınma Ajansı)"** biçimindeydi.
 * Eski kural yalnızca "ilan iptal…" sırasını tanıdığı için bu duyuru sıradan
 * bir ret olarak düşüyor, iptal edilen ilan ise arayüzde "Başvuru açık"
 * kalıyordu. Bu yüzden ad ÖNCE gelen biçim de (iptal ilanı/duyurusu,
 * düzeltme ilanı/duyurusu) tanınır.
 */
const WITHDRAWAL_TITLE_PATTERN =
  /\bilan\w*\s+iptal|\biptal\s+(?:ilan|duyuru)\w*|\biptal\s+edilmi[şs]tir|\bgeri\s+[çc]ekil|\by[üu]r[üu]rl[üu]kten\s+kald[ıi]r/;

/**
 * Gövdede yalnızca KESİN geçmiş zaman ifadeleri iptal sayılır.
 *
 * Koşullu/olasılık kipleri ("sınav iptal edilirse", "ihale iptal edilebilir")
 * bilinçli olarak dışarıda bırakılır: bunlar gerçek ilan metinlerinde geçer ve
 * yanlış iptal, geçerli bir ilanı kullanıcıdan saklamak demektir.
 */
const WITHDRAWAL_BODY_PATTERN =
  /\bil\w*\s+iptal\s+edil(mi[şs]|di)|\biptal\s+edilmi[şs]tir\b|\bgeri\s+[çc]ekilmi[şs]tir\b/;

/** Düzeltme duyurusu (ilan/düzeltme sırasından bağımsız). */
const CORRECTION_PATTERN = /\b(?:duzeltme\s+(?:ilan|duyuru)\w*|ilan\w*\s+duzeltme\w*|\bd[üu]zeltme)\b/;

/** Metinde geri çekme/iptal sinyali var mı? */
export function detectWithdrawalSignal(title: string, body: string): 'withdrawn' | 'correction' | null {
  // Başlık ayrı değerlendirilir: gövdedeki koşullu ifadeler iptal sayılmamalı.
  const titleText = normalizeTr(title);
  if (WITHDRAWAL_TITLE_PATTERN.test(titleText)) return 'withdrawn';
  const bodyText = normalizeTr(body.slice(0, 400));
  if (WITHDRAWAL_BODY_PATTERN.test(bodyText)) return 'withdrawn';
  if (CORRECTION_PATTERN.test(titleText) || CORRECTION_PATTERN.test(bodyText)) return 'correction';
  return null;
}

/**
 * İptal/düzeltme duyurusunun HEDEF ilanını seçer.
 *
 * Eski davranış aday listesinin ilk elemanını (`candidates[0]`) kullanıyordu.
 * Aday listesi "son 400 ilan" ile doldurulduğu için kurum bilgisi eşleşmediğinde
 * hedef **en son eklenen, ilgisiz ilan** oluyor ve o ilan "iptal edildi" diye
 * kapatılıyordu (tekrarlanabilir test: tests/ilan-iptal-guvenligi.test.ts).
 * Artık yalnızca kanıtla eşleşme kabul edilir:
 *
 *  1. resmî ilan numarası birebir aynı,
 *  2. kanonik URL birebir aynı,
 *  3. duyuru başlığı orijinal ilan başlığını BİREBİR içeriyor (tek aday),
 *  4. aynı kurum + başlık benzerliği birleştirme eşiğinin üzerinde ve tek aday.
 *
 * Kanıt yoksa `null` döner; çağıran taraf kaydı insan incelemesine gönderir.
 * Belirsizlikte ilan kapatmak, açık bir ilanı yanlışlıkla gizlemekten daha
 * maliyetlidir.
 */
export function selectWithdrawalTarget(
  raw: Pick<RawAnnouncement, 'title' | 'url' | 'institution' | 'referenceNo'>,
  candidates: readonly DedupeCandidateJob[],
): DedupeCandidateJob | null {
  if (candidates.length === 0) return null;

  const reference = raw.referenceNo ?? extractReferenceFromTitle(raw.title);
  if (reference) {
    const needle = normalizeTr(reference);
    const byReference = candidates.find(
      (candidate) => candidate.originalRefNo && normalizeTr(candidate.originalRefNo) === needle,
    );
    if (byReference) return byReference;
  }

  const url = normalizeUrl(raw.url);
  if (url) {
    const byUrl = candidates.find((candidate) => candidate.normalizedUrl === url);
    if (byUrl) return byUrl;
  }

  const noticeTitle = normalizeTr(raw.title);
  const institution = normalizeTr(raw.institution ?? '');
  const sameInstitution = (candidate: DedupeCandidateJob): boolean =>
    institution.length > 0 &&
    (candidate.institutionNormalized === institution ||
      candidate.institutionNormalized.includes(institution) ||
      institution.includes(candidate.institutionNormalized));

  // 3) Duyuru başlığı, orijinal ilan başlığını BİREBİR içeriyor.
  //    ("… Sözleşmeli Personel Alım İlanı İptal Edilmiştir" gibi gerçek biçim.)
  //    Kurum alanı boş gelse bile başlık kapsama tek başına güçlü kanıttır; ancak
  //    kurum bilgisi varsa ve adayın kurumu açıkça FARKLIysa aday elenir.
  const institutionContradicts = (candidate: DedupeCandidateJob): boolean =>
    institution.length > 0 &&
    candidate.institutionNormalized.length > 0 &&
    !sameInstitution(candidate);
  const contained = candidates.filter(
    (candidate) =>
      candidate.titleNormalized.length >= 12 &&
      noticeTitle.includes(candidate.titleNormalized) &&
      !institutionContradicts(candidate),
  );
  if (contained.length === 1) return contained[0] ?? null;
  if (contained.length > 1) {
    // Birden çok başlık kapsanıyorsa kurum eşleşmesi ayırt edici olabilir.
    const withInstitution = contained.filter(sameInstitution);
    return withInstitution.length === 1 ? (withInstitution[0] ?? null) : null;
  }

  // 4) Aynı kurum + yüksek başlık benzerliği; en iyi aday açık ara önde olmalı.
  if (!institution) return null;
  const scored = candidates
    .filter(sameInstitution)
    .map((candidate) => ({
      candidate,
      score: diceSimilarity(noticeTitle, candidate.titleNormalized || normalizeTr(candidate.title)),
    }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < DEDUPE_THRESHOLDS.mergeTitleSimilarity) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.05) return null;
  return best.candidate;
}

/**
 * "16.10.2026 tarih ve 33402 sayılı Resmî Gazete'de yayınlanan …" atfının günü (YYYY-MM-DD).
 *
 * Gerçek düzeltme ilanları (RG 17.10.2026-4-12, 20.10.2026-4-5) hedeflerini bu
 * biçimde yazar. Tarih + sayı + "Resmî Gazete" birlikte aranır: tek başına tarih
 * ("sınav 16.10.2026 tarihinde") atıf sayılmaz.
 */
export function citedResmiGazeteDate(text: string): string | null {
  const match = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}) tarih\w* ve \d{4,6} sayili resm[iî] gazete/u.exec(
    normalizeTr(text),
  );
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** İki kurum adı aynı kurumu mu gösteriyor? (normalize; biri diğerini içerebilir: "…rektorlugu" / "…rektorlugunden") */
function institutionsMatch(left: string, right: string): boolean {
  return left.length > 0 && right.length > 0 && (left === right || left.includes(right) || right.includes(left));
}

/**
 * Düzeltme duyurusunun Resmî Gazete atfıyla hedefi: atıf yapılan günde
 * yayımlanmış, AYNI kurumun TEK ilanı. Birden fazla aday ya da hiç aday yoksa
 * `null` (çağıran insan incelemesine gönderir; belirsizlikte tahmin yok).
 */
async function targetByCitedGazette(repos: Repos, raw: RawAnnouncement): Promise<string | null> {
  const day = citedResmiGazeteDate(raw.bodyText ?? raw.rawExcerpt ?? '');
  const institution = normalizeTr(raw.institution ?? '');
  if (!day || !institution) return null;
  const sameDay = await repos.store.find(
    'jobs',
    { publishedAt: { $gte: day, $lt: addDaysDateOnly(day, 1) } },
    { limit: 50 },
  );
  const matches = sameDay.filter((job) => institutionsMatch(job.institutionNormalized, institution));
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/** İlan dokümanını ham kayıttan üretir (kaydetmez). */
export function buildJobDocument(
  raw: RawAnnouncement,
  classification: ClassificationResult,
  options: { now: Date; provenance: 'scraped' | 'sample' | 'manual' },
): Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'> {
  const detailUrl = normalizeUrl(raw.url);
  const body = raw.bodyText ?? raw.rawExcerpt ?? '';
  const extraction = extract({
    title: raw.title,
    body,
    // Liste sayfasından gelen yapılandırılmış alanlar otoriter kabul edilir.
    listing: {
      institution: raw.institution ?? null,
      city: raw.city ?? null,
      district: raw.district ?? null,
      publishedAt: raw.publishedAt ?? null,
      referenceNo: raw.referenceNo ?? null,
      applicationStartAt: raw.applicationStartAt ?? null,
      applicationEndAt: raw.applicationEndAt ?? null,
    },
    links: raw.links ?? [],
    attachments: raw.attachments,
    bodySource: raw.bodyTextSource ?? (raw.bodyText ? 'detail' : 'listing'),
  });

  const attachments = dedupeAttachments(raw.attachments);

  const applicationEndAt = extraction.applicationEndAt ?? null;
  const applicationStartAt = extraction.applicationStartAt ?? null;
  const publishedAt = sanePublishedDate(
    extraction.publishedAt ?? raw.publishedAt ?? null,
    toIstanbulDateOnly(options.now),
  );
  const status = computeStatus({
    applicationStartAt,
    applicationEndAt,
    applicationEndDate: extraction.applicationEndDate,
    publishedAt,
    now: options.now,
  });

  const institution = extraction.institution ?? raw.institution ?? 'Belirtilmemiş kurum';
  const title = raw.title.trim().slice(0, 400);
  const requirements = toStoredRequirements(extraction);
  const textExcerpt = makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 2_500);

  const employmentType: EmploymentType = classification.employmentType;
  const quota = extraction.quota ?? raw.quota ?? null;

  return {
    title,
    titleNormalized: normalizeTr(title),
    institution,
    institutionNormalized: normalizeTr(institution),
    unit: extraction.unit,
    employmentType,
    status,
    statusReason: statusReasonFor(status, {
      applicationEndDate: extraction.applicationEndDate ?? null,
      applicationEndAt,
      publishedAt,
      now: options.now,
    }),
    city: extraction.city ?? raw.city ?? null,
    cityNormalized: normalizeTr(extraction.city ?? raw.city ?? ''),
    district: extraction.district ?? raw.district ?? null,
    quota,
    applicationStartAt,
    applicationEndAt,
    applicationEndDate: extraction.applicationEndDate,
    publishedAt,
    detailUrl,
    normalizedUrl: detailUrl,
    applicationUrl: raw.applicationUrl ? normalizeUrl(raw.applicationUrl) : extraction.applicationUrl,
    // Metinden okunan başvuru yöntemi depoya yazılır (detay sayfası gösterir).
    applicationMethod: extraction.applicationMethod ?? null,
    attachments,
    requirements,
    titles: extraction.titles,
    openings: extraction.openings,
    textExcerpt,
    // Gövde metni aramada da bulunsun: normalleştirilmiş kopya saklanır.
    textNormalized: normalizeTr(textExcerpt),
    originalRefNo:
      extraction.referenceNo ??
      raw.referenceNo ??
      extractReferenceFromTitle(raw.sourceItemId) ??
      extractReferenceFromTitle(title),
    sourceKeys: [raw.sourceKey],
    primarySourceKey: raw.sourceKey,
    classification: { ...classification, classifiedAt: options.now.toISOString() },
    extractionConfidence: extraction.confidence,
    fieldSources: extraction.fieldSources,
    evidence: extraction.evidence,
    // OCR ile okunan metinde rakam/tarih okuma hatası olabilir: detayda açıkça yazılır.
    uncertainties:
      raw.ocrConfidence !== undefined
        ? [
            ...extraction.uncertainties,
            `İlan metni taranmış belgeden OCR ile okundu (güven ${raw.ocrConfidence}); tarih, kontenjan ve sayıları resmî belgeden doğrulayın.`,
          ]
        : extraction.uncertainties,
    provenance: options.provenance,
    // Taranan ilan kayıt anında kaynakta görülmüştür: "son kontrol" o andır
    // (birleştirmede de aynı alan güncellenir). Manuel/örnek kayıt doğrulanmamıştır.
    lastVerifiedAt: options.provenance === 'scraped' ? options.now.toISOString() : null,
    contentHash: jobContentFingerprint({ title, textExcerpt, applicationEndAt, quota }),
    dedupeKey: sha256Hex(`${raw.sourceKey}|${raw.sourceItemId}`),
  };
}

/**
 * Çıkarım motorunun `undefined` tabanlı isteğe bağlı alanlarını depo şemasının
 * `null` tabanlı alanlarına çevirir. "Belirtilmemiş" bilgi null olarak saklanır.
 */
export function toStoredRequirements(extraction: ExtractedJob): JobDoc['requirements'] {
  return {
    educationLevels: extraction.educationLevels,
    departments: extraction.departments,
    kpssScoreTypes: extraction.kpssScoreTypes,
    kpssMinScore: extraction.kpssMinScore,
    kpssYear: extraction.kpssYear,
    qualificationCodes: extraction.qualificationCodes,
    minAge: extraction.minAge,
    maxAge: extraction.maxAge,
    certificates: extraction.certificates,
    minExperienceYears: extraction.minExperienceYears,
    foreignLanguages: extraction.foreignLanguages,
    specialConditions: extraction.specialConditions,
  };
}

function extractReferenceFromTitle(title: string): string | null {
  const match = /\b(YOK|DPB|ILN)[\s-]?(\d{4,12})\b/i.exec(title);
  return match ? `${match[1]?.toUpperCase()}${match[2]}` : null;
}

function dedupeAttachments(attachments: RawAnnouncement['attachments']): JobDoc['attachments'] {
  const seen = new Set<string>();
  const out: JobDoc['attachments'] = [];
  for (const attachment of attachments) {
    if (!attachment.url || seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    out.push({
      url: attachment.url,
      label: attachment.label,
      kind: attachment.kind,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    });
  }
  return out;
}

export interface ChangeSet {
  changeTypes: JobRevisionDoc['changeTypes'];
  changedFields: string[];
  summary: string;
}

/** Sürüm geçmişi için önemli değişiklikleri bulur. */
export function detectChanges(previous: JobDoc, next: Partial<JobDoc>): ChangeSet {
  const changedFields: string[] = [];
  const changeTypes: JobRevisionDoc['changeTypes'] = [];

  const compare = (field: keyof JobDoc, type: JobRevisionDoc['changeTypes'][number], label: string) => {
    if (!(field in next)) return;
    const before = JSON.stringify(previous[field] ?? null);
    const after = JSON.stringify(next[field] ?? null);
    if (before !== after) {
      changedFields.push(field);
      if (!changeTypes.includes(type)) changeTypes.push(type);
    }
    void label;
  };

  compare('applicationEndAt', 'deadline', 'Son başvuru tarihi');
  compare('applicationEndDate', 'deadline', 'Son başvuru günü');
  compare('applicationStartAt', 'deadline', 'Başvuru başlangıcı');
  compare('quota', 'quota', 'Kontenjan');
  compare('requirements', 'requirements', 'Başvuru şartları');
  compare('applicationUrl', 'application-url', 'Başvuru bağlantısı');
  compare('applicationMethod', 'application-url', 'Başvuru yöntemi');
  compare('title', 'content', 'Başlık');
  compare('textExcerpt', 'content', 'İlan metni');
  compare('attachments', 'content', 'Ekler');
  compare('status', 'closed', 'Durum');

  const summaryParts: string[] = [];
  if (changedFields.includes('applicationEndDate') || changedFields.includes('applicationEndAt')) {
    summaryParts.push('son başvuru tarihi değişti');
  }
  if (changedFields.includes('quota')) summaryParts.push('kontenjan değişti');
  if (changedFields.includes('requirements')) summaryParts.push('başvuru şartları değişti');
  if (changedFields.includes('applicationUrl')) summaryParts.push('başvuru bağlantısı değişti');
  if (changedFields.includes('status'))
    summaryParts.push(`durum "${previous.status}" → "${next.status}" olarak değişti`);
  if (changedFields.includes('textExcerpt') || changedFields.includes('title'))
    summaryParts.push('ilan metni güncellendi');

  return {
    changeTypes: changeTypes.length > 0 ? changeTypes : ['content'],
    changedFields,
    summary: summaryParts.length > 0 ? summaryParts.join(', ') : 'İlan içeriği güncellendi',
  };
}

export interface ApplyContext {
  repos: Repos;
  now: Date;
  workerId: string;
  provenance: 'scraped' | 'sample' | 'manual';
  /**
   * LLM sınıflandırma kapısı (yalnızca tarama hattında verilir; bkz. src/ai/classifier.ts).
   * Kapı YALNIZCA deterministik motorun `review` dediği kayıtlarda çalışır;
   * kanıtı doğrulanamayan veya sağlayıcı hatalı durumlarda kayıt review kalır.
   */
  llmGate?: LlmClassificationGate;
}

/**
 * Ham ilanı işler: sınıflandırma → çıkarma → tekilleştirme → kayıt/sürüm.
 * Reddedilen kayıtlar sessizce atılmaz; karar gerekçesiyle birlikte döner.
 */
export async function applyRawAnnouncement(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  options: { classificationOverride?: ClassificationResult } = {},
): Promise<IngestOutcome> {
  // Güvenlik süzgeci: kaynağın kendi liste/dizin sayfası ilan kaydı olamaz.
  // Kayıt oluşmadan reddedilir ve karar tarama belleğine yazılır ki sonraki
  // taramada "yeni" sayılıp yeniden işlenmesin (bakım: recordIngestDecision).
  if (await isSourceListingUrl(raw.url, raw.sourceKey, ctx.repos)) {
    const listingClassification =
      options.classificationOverride ??
      classify({
        title: raw.title,
        body: raw.bodyText ?? raw.rawExcerpt ?? '',
        sourceCategory: raw.sourceCategory ?? null,
        sourceKey: raw.sourceKey,
        documentTextMissing: true,
      });
    await recordIngestDecision(raw, ctx, 'rejected');
    return {
      action: 'rejected',
      jobId: null,
      decision: null,
      classification: listingClassification,
      changes: [],
      reviewId: null,
      revisionCreated: false,
    };
  }

  let classification =
    options.classificationOverride ??
    classify({
      title: raw.title,
      body: raw.bodyText ?? raw.rawExcerpt ?? '',
      sourceCategory: raw.sourceCategory ?? null,
      sourceKey: raw.sourceKey,
      documentTextMissing: !raw.bodyText || raw.bodyText.length < 100 || raw.bodyTextSource === 'listing',
    });

  // LLM ikinci aşama kapısı: yalnızca belirsiz (review) kayıtlarda ve yalnızca
  // tarama hattı kapıyı sağladıysa çalışır. Deterministik kabul/ret değişmez.
  let llmOpinion: LlmReviewOpinion | null = null;
  if (!options.classificationOverride && ctx.llmGate && classification.decision === 'review') {
    const gateOutcome = await ctx.llmGate.evaluate({
      title: raw.title,
      body: raw.bodyText ?? raw.rawExcerpt ?? null,
      bodyTextSource: raw.bodyTextSource ?? null,
      sourceCategory: raw.sourceCategory ?? null,
      sourceKey: raw.sourceKey,
      url: raw.url,
      base: classification,
    });
    classification = gateOutcome.classification;
    llmOpinion = gateOutcome.opinion;
  }

  const withdrawal = detectWithdrawalSignal(raw.title, raw.bodyText ?? '');

  // Kaynak içi kimlik: aynı kaynak aynı ilanı tekrar gördü → güncelleme yolu.
  const existingLink = await ctx.repos.jobs.findLinkBySourceItem(raw.sourceKey, raw.sourceItemId);

  if (classification.decision === 'reject' && !withdrawal) {
    // İlan oluşmuyor; yine de tarama belleğine yaz ki sonraki taramada bu
    // kayıt yeniden "yeni" sayılıp detay bütçesini yemesin.
    await recordIngestDecision(raw, ctx, 'rejected');
    return {
      action: 'rejected',
      jobId: existingLink?.jobId ?? null,
      decision: null,
      classification,
      changes: [],
      reviewId: null,
      revisionCreated: false,
    };
  }

  // Geri çekme/düzeltme sinyali: mevcut ilan varsa durum güncellenir.
  if (withdrawal && !existingLink) {
    const candidates = await findCandidates(ctx.repos, raw, null);
    // Hedef YALNIZCA kanıtla seçilir (resmî no, kanonik URL, başlık kapsama,
    // kurum + yüksek benzerlik). Aday listesinin ilk elemanına düşmek, ilgisiz
    // bir ilanı "iptal edildi" diye kapatıyordu.
    // DÜZELTME duyurusu atıf yaptığı Resmî Gazete gününü yazıyorsa o gün + kurum ikinci
    // kanıttır. İPTAL için kullanılmaz: "… tarihli Resmî Gazete'de yayımlanan ihale iptal
    // edilmiştir" metni, kurumun o günkü tek personel ilanını yanlışlıkla kapatabilirdi.
    // Düzeltme ilanın durumunu değiştirmez (not + sürüm), iptal ilanı kullanıcıdan saklar.
    const targetId =
      selectWithdrawalTarget(raw, candidates)?.id ??
      (withdrawal === 'correction' ? await targetByCitedGazette(ctx.repos, raw) : null);
    if (!targetId) {
      const reason =
        withdrawal === 'withdrawn'
          ? 'İptal/geri çekme duyurusu için eşleşen ilan bulunamadı; insan incelemesi gerekiyor.'
          : 'Düzeltme ilanı için eşleşen ilan bulunamadı; insan incelemesi gerekiyor.';
      const review = await ctx.repos.review.enqueue({
        kind: 'dedupe',
        sourceKey: raw.sourceKey,
        title: raw.title,
        url: raw.url,
        reason,
        confidence: 0.4,
        payload: {
          sourceItemId: raw.sourceItemId,
          withdrawal,
          excerpt: makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 1_500),
        },
      });
      await recordIngestDecision(raw, ctx, 'review');
      return {
        action: 'review',
        jobId: null,
        decision: null,
        classification,
        changes: [reason],
        reviewId: review.item.id,
        revisionCreated: false,
      };
    }
    return applyWithdrawal(raw, ctx, targetId, withdrawal, classification);
  }

  const document = buildJobDocument(raw, classification, { now: ctx.now, provenance: ctx.provenance });

  // Kaynak bağlantısı yeni kurulacaksa tekilleştirme adayları toplanır.
  const candidates = await findCandidates(ctx.repos, raw, existingLink?.jobId ?? null);
  const identity = matchBySourceIdentity(
    {
      sourceKey: raw.sourceKey,
      sourceItemId: raw.sourceItemId,
      title: raw.title,
      institution: raw.institution ?? document.institution,
      normalizedUrl: document.normalizedUrl,
      referenceNo: document.originalRefNo,
      applicationEndDate: document.applicationEndDate,
      textExcerpt: document.textExcerpt,
    },
    existingLink
      ? {
          jobId: existingLink.jobId,
          sourceKey: existingLink.sourceKey,
          sourceItemId: existingLink.sourceItemId,
        }
      : null,
  );

  const decision =
    identity ??
    decideDedupe(
      {
        sourceKey: raw.sourceKey,
        sourceItemId: raw.sourceItemId,
        title: raw.title,
        institution: raw.institution ?? document.institution,
        normalizedUrl: document.normalizedUrl,
        referenceNo: document.originalRefNo,
        applicationEndDate: document.applicationEndDate,
        textExcerpt: document.textExcerpt,
      },
      candidates,
    );

  if (classification.decision === 'review') {
    const review = await ctx.repos.review.enqueue({
      kind: 'classification',
      sourceKey: raw.sourceKey,
      title: raw.title,
      url: raw.url,
      reason: classification.reasons.join(' • ') || 'Sınıflandırma güveni düşük',
      confidence: classification.confidence,
      payload: {
        sourceItemId: raw.sourceItemId,
        employmentType: classification.employmentType,
        reasons: classification.reasons,
        rules: classification.rules,
        excerpt: makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 1_500),
        institution: raw.institution ?? null,
        publishedAt: raw.publishedAt ?? null,
        applicationStartAt: raw.applicationStartAt ?? null,
        applicationEndAt: raw.applicationEndAt ?? null,
        attachments: raw.attachments,
        dedupeAction: decision.action,
        candidateJobIds: decision.candidateJobIds,
        // LLM kapısı çalıştıysa modelin görüşü insan incelemesini kolaylaştırır
        // (karar değildir; doğrulanamayan kanıt/hata durumu da burada görünür).
        ...(llmOpinion ? { llmOpinion } : {}),
      },
      candidateJobIds: decision.candidateJobIds,
    });
    // İnceleme bekleyen kayıt için ilan oluşturulmaz; karar verildiğinde
    // yönetici paneli bu kaydı kabul edip ilana dönüştürebilir.
    await recordIngestDecision(raw, ctx, 'review');
    return {
      action: 'review',
      jobId: decision.jobId,
      decision,
      classification,
      changes: [classification.reasons[0] ?? 'İnceleme gerekiyor'],
      reviewId: review.item.id,
      revisionCreated: false,
    };
  }

  if (decision.action === 'review') {
    const review = await ctx.repos.review.enqueue({
      kind: 'dedupe',
      sourceKey: raw.sourceKey,
      title: raw.title,
      url: raw.url,
      reason: decision.reason,
      confidence: decision.score,
      payload: {
        sourceItemId: raw.sourceItemId,
        excerpt: makeExcerpt(raw.bodyText ?? raw.rawExcerpt ?? '', 1_500),
        decision: decision.matchedBy,
      },
      candidateJobIds: decision.candidateJobIds,
    });
    await recordIngestDecision(raw, ctx, 'review');
    return {
      action: 'review',
      jobId: null,
      decision,
      classification,
      changes: [decision.reason],
      reviewId: review.item.id,
      revisionCreated: false,
    };
  }

  if (decision.action === 'merge' && decision.jobId) {
    return mergeIntoExistingJob(raw, ctx, decision, document);
  }

  return createJob(raw, ctx, decision, document);
}

async function findCandidates(
  repos: Repos,
  raw: RawAnnouncement,
  excludeJobId: string | null,
): Promise<(DedupeCandidateJob & { id: string })[]> {
  const institutionHint = normalizeTr(raw.institution ?? '');
  const referenceNo = extractReferenceFromTitle(raw.title);

  const queries: Promise<JobDoc[]>[] = [];
  if (referenceNo) {
    queries.push(repos.store.find('jobs', { originalRefNo: referenceNo }, { limit: 5 }));
  }
  queries.push(repos.store.find('jobs', { normalizedUrl: normalizeUrl(raw.url) }, { limit: 5 }));
  if (institutionHint) {
    queries.push(
      repos.store.find(
        'jobs',
        // Kurum adı taranmış içerikten gelir; regex kaynağı olarak güvenli hâle getirilir.
        { institutionNormalized: { $regex: escapeRegExp(institutionHint.slice(0, 40)), $regexFlags: 'i' } },
        { limit: 25, sort: [['createdAt', -1]] },
      ),
    );
  }

  const results = await Promise.all(queries);
  const map = new Map<string, JobDoc>();
  for (const rows of results) {
    for (const job of rows) {
      if (excludeJobId && job.id === excludeJobId) continue;
      map.set(job.id, job);
    }
  }

  // Metin benzerliği taraması için son ilanlardan geniş bir küme eklenir.
  const recent = await repos.store.find('jobs', {}, { limit: 400, sort: [['createdAt', -1]] });
  for (const job of recent) {
    if (excludeJobId && job.id === excludeJobId) continue;
    map.set(job.id, job);
  }

  return [...map.values()].map((job) => ({
    id: job.id,
    title: job.title,
    titleNormalized: job.titleNormalized,
    institution: job.institution,
    institutionNormalized: job.institutionNormalized,
    normalizedUrl: job.normalizedUrl,
    originalRefNo: job.originalRefNo,
    applicationEndDate: job.applicationEndDate,
    textExcerpt: job.textExcerpt,
    sourceKeys: job.sourceKeys,
  }));
}

async function createJob(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  decision: DedupeDecision,
  document: Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'>,
): Promise<IngestOutcome> {
  const nowIso = ctx.now.toISOString();
  const job: JobDoc = {
    ...document,
    id: createId('job'),
    version: 1,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const inserted = await ctx.repos.jobs.insertJob(job);
  if (!inserted.created) {
    // Yarış koşulu: başka bir worker aynı ilanı yazdı → mevcut kaydı kullan.
    return mergeIntoExistingJob(raw, ctx, { ...decision, jobId: inserted.job.id }, document);
  }

  await ctx.repos.jobs.addSourceLink(sourceLinkDocument(raw, job.id, nowIso));

  await ctx.repos.jobs.addRevision({
    id: createId('rev'),
    jobId: job.id,
    version: 1,
    changeTypes: ['new'],
    changedFields: ['*'],
    previous: {},
    current: { title: job.title, applicationEndDate: job.applicationEndDate, quota: job.quota },
    summary: 'İlan ilk kez kaydedildi.',
    sourceKey: raw.sourceKey,
    createdAt: nowIso,
  });

  return {
    action: 'created',
    jobId: job.id,
    decision,
    classification: { ...job.classification } as ClassificationResult,
    changes: ['yeni ilan'],
    reviewId: null,
    revisionCreated: true,
  };
}

async function mergeIntoExistingJob(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  decision: DedupeDecision,
  document: Omit<JobDoc, 'id' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'version'>,
): Promise<IngestOutcome> {
  const jobId = decision.jobId;
  if (!jobId) throw new Error('Birleştirme kararı için ilan kimliği yok.');
  const previous = await ctx.repos.jobs.findById(jobId);
  if (!previous) {
    return createJob(raw, ctx, { ...decision, action: 'create', jobId: null }, document);
  }

  const nowIso = ctx.now.toISOString();
  const nextSourceKeys = previous.sourceKeys.includes(raw.sourceKey)
    ? previous.sourceKeys
    : [...previous.sourceKeys, raw.sourceKey];

  // Alanları birleştir: kaynak yeni bilgi getiriyorsa güncelle, boşsa koru.
  const merged: Partial<JobDoc> = {
    sourceKeys: nextSourceKeys,
    lastSeenAt: nowIso,
    lastVerifiedAt: nowIso,
    extractionConfidence: Math.max(previous.extractionConfidence, document.extractionConfidence),
    applicationEndAt: document.applicationEndAt ?? previous.applicationEndAt,
    applicationEndDate: document.applicationEndDate ?? previous.applicationEndDate,
    applicationStartAt: document.applicationStartAt ?? previous.applicationStartAt,
    applicationUrl: document.applicationUrl ?? previous.applicationUrl,
    applicationMethod: document.applicationMethod ?? previous.applicationMethod ?? null,
    quota: document.quota ?? previous.quota,
    // İlk yayım tarihi korunur, yoksa yeni okumadan doldurulur. Alan burada
    // atanmadığında aşağıdaki durum hesabı yayım tarihini `null` görüyor ve son
    // başvurusu olmayan eski (kapalı) ilanı her birleştirmede `unknown` yapıyordu.
    publishedAt: previous.publishedAt ?? document.publishedAt,
    city: previous.city ?? document.city,
    titles: previous.titles.length >= document.titles.length ? previous.titles : document.titles,
    // Saklı birim güncel kurala uyuyorsa korunur; tablo başlığı artığıysa ya da boşsa
    // yeni okumanın (tam metin) değeri alınır — `jobs:reclassify` çöp birimi boşaltır.
    unit: previous.unit && extractUnit(previous.unit) === previous.unit ? previous.unit : document.unit,
    // Yeni okumada tablo varsa o geçerlidir (ilan güncellenmiş olabilir); yoksa eskisi korunur.
    openings: document.openings.length > 0 ? document.openings : (previous.openings ?? []),
    requirements:
      document.requirements.departments.length +
        document.requirements.educationLevels.length +
        document.requirements.kpssScoreTypes.length +
        document.requirements.qualificationCodes.length >
      previous.requirements.departments.length +
        previous.requirements.educationLevels.length +
        previous.requirements.kpssScoreTypes.length +
        previous.requirements.qualificationCodes.length
        ? document.requirements
        : previous.requirements,
    attachments: dedupeAttachments([
      ...previous.attachments,
      ...document.attachments,
    ]) as JobDoc['attachments'],
  };

  // Durum her zaman güncel tarihlere göre yeniden hesaplanır.
  merged.status = computeStatus({
    applicationStartAt: merged.applicationStartAt ?? null,
    applicationEndAt: merged.applicationEndAt ?? null,
    applicationEndDate: merged.applicationEndDate ?? null,
    publishedAt: sanePublishedDate(merged.publishedAt ?? null, toIstanbulDateOnly(ctx.now)),
    now: ctx.now,
  });
  merged.statusReason = statusReasonFor(merged.status, {
    applicationEndDate: merged.applicationEndDate ?? null,
    applicationEndAt: merged.applicationEndAt ?? null,
    publishedAt: merged.publishedAt ?? null,
    now: ctx.now,
  });
  if (previous.status === 'cancelled') merged.status = 'cancelled';

  const changes = detectChanges(previous, merged);
  const shouldCreateRevision = changes.changedFields.length > 0 && previous.version > 0;

  const updated = await ctx.repos.jobs.updateJob(jobId, {
    ...merged,
    version: shouldCreateRevision ? previous.version + 1 : previous.version,
  });

  const link = await ctx.repos.jobs.findLinkBySourceItem(raw.sourceKey, raw.sourceItemId);
  if (link) {
    const capture = capturedTextFields(raw);
    const hasNewCapturedText =
      capture.capturedTextStatus === 'captured' || capture.capturedTextStatus === 'truncated';
    await ctx.repos.jobs.touchSourceLink(link.id, {
      lastSeenAt: nowIso,
      title: raw.title,
      active: true,
      ...(hasNewCapturedText ? { ...capture, attachments: raw.attachments } : {}),
    });
  } else {
    await ctx.repos.jobs.addSourceLink(sourceLinkDocument(raw, jobId, nowIso));
    if (!changes.changeTypes.includes('source-added')) changes.changeTypes.push('source-added');
    changes.changedFields.push('sourceKeys');
    changes.summary =
      changes.summary === 'İlan içeriği güncellendi'
        ? 'İlan ikinci bir kaynakta yayımlandı'
        : changes.summary;
  }

  let revisionCreated = false;
  if (shouldCreateRevision && updated) {
    const revision: JobRevisionDoc = {
      id: createId('rev'),
      jobId,
      version: updated.version,
      changeTypes: changes.changeTypes,
      changedFields: changes.changedFields,
      previous: pickRevisionFields(previous),
      current: pickRevisionFields(updated),
      summary: changes.summary,
      sourceKey: raw.sourceKey,
      createdAt: nowIso,
    };
    const result = await ctx.repos.jobs.addRevision(revision);
    revisionCreated = result.created;
  }

  return {
    action: revisionCreated ? 'updated' : 'merged',
    jobId,
    decision,
    classification: { ...(updated?.classification ?? previous.classification) } as ClassificationResult,
    changes: changes.changedFields,
    reviewId: null,
    revisionCreated,
  };
}

async function applyWithdrawal(
  raw: RawAnnouncement,
  ctx: ApplyContext,
  jobId: string,
  withdrawal: 'withdrawn' | 'correction',
  classification: ClassificationResult,
): Promise<IngestOutcome> {
  const previous = await ctx.repos.jobs.findById(jobId);
  if (!previous) throw new Error('Geri çekme sinyali için ilan bulunamadı.');
  const nowIso = ctx.now.toISOString();
  const nextVersion = previous.version + 1;
  const changeType = withdrawal === 'withdrawn' ? 'withdrawn' : 'content';

  const updated = await ctx.repos.jobs.updateJob(jobId, {
    status: withdrawal === 'withdrawn' ? 'cancelled' : previous.status,
    statusReason:
      withdrawal === 'withdrawn'
        ? `Resmî duyuru ile geri çekildi (${raw.sourceKey})`
        : `Düzeltme ilanı görüldü (${raw.sourceKey})`,
    version: nextVersion,
    lastSeenAt: nowIso,
    lastVerifiedAt: nowIso,
  });

  // Sinyal duyurusu da kaynak kaydı üretir: aksi hâlde aynı iptal/düzeltme
  // ilanı her taramada yeniden görülür ve her seferinde yeni sürüm yazar.
  const signalLink = await ctx.repos.jobs.findLinkBySourceItem(raw.sourceKey, raw.sourceItemId);
  if (signalLink) {
    await ctx.repos.jobs.touchSourceLink(signalLink.id, { lastSeenAt: nowIso, title: raw.title });
  } else {
    await ctx.repos.jobs.addSourceLink(sourceLinkDocument(raw, jobId, nowIso));
  }

  const revision = await ctx.repos.jobs.addRevision({
    id: createId('rev'),
    jobId,
    version: nextVersion,
    changeTypes: [changeType],
    changedFields: ['status'],
    previous: { status: previous.status },
    current: { status: updated?.status ?? previous.status },
    summary:
      withdrawal === 'withdrawn'
        ? 'İlan resmî olarak geri çekildi/iptal edildi.'
        : 'İlan için düzeltme duyurusu yayımlandı.',
    sourceKey: raw.sourceKey,
    createdAt: nowIso,
  });

  return {
    action: 'withdrawal-signal',
    jobId,
    decision: null,
    classification,
    changes: ['status'],
    reviewId: null,
    revisionCreated: revision.created,
  };
}

function pickRevisionFields(job: JobDoc): Record<string, unknown> {
  return {
    title: job.title,
    status: job.status,
    applicationStartAt: job.applicationStartAt,
    applicationEndAt: job.applicationEndAt,
    applicationEndDate: job.applicationEndDate,
    quota: job.quota,
    applicationUrl: job.applicationUrl,
    attachments: job.attachments.map((attachment) => attachment.url),
    requirements: job.requirements,
    sourceKeys: job.sourceKeys,
  };
}

export const INGEST_VERSIONS = {
  classification: CLASSIFICATION_VERSION,
  extraction: EXTRACTION_VERSION,
  dedupe: DEDUPE_VERSION,
  thresholds: DEDUPE_THRESHOLDS,
};

export type { SourceDoc };
