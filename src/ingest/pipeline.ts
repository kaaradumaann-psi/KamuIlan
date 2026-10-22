/**
 * Tarama hattı (pipeline): kaynak kaydı → adaptör → sınıflandırma → çıkarım →
 * tekilleştirme → kayıt → bildirim olayları → tarama kaydı + kaynak sağlığı.
 *
 * Garantiler:
 *  - Bir kaynak aynı anda YALNIZCA bir kez taranır (veritabanı kilidi).
 *  - Kaynağa erişilemese bile mevcut ilanlar SİLİNMEZ; yalnızca sağlık durumu
 *    ve hata kaydı güncellenir.
 *  - Adaptör yapısı değiştiğinde boş sonuç döndürmek yerine hata kaydedilir
 *    (sessiz veri kaybı yok).
 *  - Bildirim olayları taramanın içinde üretilir ama gönderim worker'a aittir;
 *    SMTP erişilemese de tarama tamamlanır.
 */
import { getEnv } from '../config/env';
import { CLASSIFICATION_VERSION } from '../config/app';
import {
  findSourceDefinition,
  type SourceDefinition,
  type SourceGroup,
  type SourceMethod,
  type SourceStatus,
  type SourceType,
} from '../config/sources';
import type { RawAnnouncement } from '../domain';
import { sha256Hex } from '../domain/ids';
import type { JobDoc, ScrapeRunDoc, SourceDoc } from '../db/schemas';
import type { Repos } from '../db/repos';
import type { ScrapeRunTotals } from '../db/repos/runs';
import { EMPTY_TOTALS } from '../db/repos/runs';
import { createLogger, type Logger } from '../lib/logger';
import { addMilliseconds, type Clock } from '../lib/clock';
import { FetchError, HttpClient } from '../sources/fetcher';
import { requireAdapter } from '../sources/registry';
import { AdapterStructureError, AdapterUnavailableError, SourceAccessError } from '../sources/errors';
import type { AdapterContext, SourceAdapter } from '../sources/types';
import { queueNotificationsForJob } from '../notifications/service';
import { createLlmClassificationGate, disabledLlmGate, llmClassifierConfig, type LlmClassificationGate } from '../ai/classifier';
import { applyRawAnnouncement } from './jobs-service';
import { sanitizeRawAnnouncement } from './sanitize';
import { sourceTermsGate } from '../sources/terms';

export interface RunSourceOptions {
  repos: Repos;
  source: SourceDoc;
  trigger: ScrapeRunDoc['trigger'];
  workerId: string;
  /** Testlerde sahte istemci verilir; üretimde kaynak başına bir HttpClient kullanılır. */
  http?: HttpClient;
  logger?: Logger;
  queueNotifications?: boolean;
  liveFetch?: boolean;
  now?: Date;
  scheduledFor?: string | null;
  /** Adaptörü doğrudan çalıştırmak için (test/kapsam denetimi). */
  adapter?: SourceAdapter;
  /** Operatör staging koşumu için ek detay indirme tavanı (yöntem tavanını yükseltmez). */
  maxDetailFetches?: number;
  /**
   * LLM sınıflandırma kapısı. Üretimde verilmez; ortam değişkenlerinden
   * (LLM_CLASSIFIER_ENABLED) koşu başına bir kapı kurulur. Testlerde sahte
   * fetch ile kapı enjekte edilebilir.
   */
  llmGate?: LlmClassificationGate;
}

export interface RunSourceResult {
  runId: string;
  sourceKey: string;
  status: ScrapeRunDoc['status'];
  itemsFound: number;
  itemsAccepted: number;
  itemsRejected: number;
  itemsReview: number;
  jobsCreated: number;
  jobsUpdated: number;
  itemsMerged: number;
  revisionsCreated: number;
  notificationsQueued: number;
  durationMs: number;
  coverageStatus: 'complete' | 'partial' | 'unknown';
  coverageNote: string;
  notes: string[];
  errors: string[];
  /** Görülen HTTP durum kodları (en fazla 50; son yönlendirme hariç). */
  httpStatuses: number[];
  /** Fatal hatanın HTTP durumu (erişim kısıtı/HTTP hatası); yoksa null. */
  httpStatus: number | null;
  /** Fatal/ilan hatalarının sınıfı; başarıda null. */
  errorType: 'unavailable' | 'structure' | 'fetch' | 'item' | 'other' | null;
  locked: boolean;
  /** LLM sınıflandırma kapısı özeti (kapı kapalıysa enabled:false, tüm sayaçlar 0). */
  llm: {
    enabled: boolean;
    calls: number;
    cacheHits: number;
    upgradedToJob: number;
    upgradedToProcess: number;
    rejected: number;
    keptReview: number;
    blocked: number;
    invalid: number;
    errors: number;
  };
}

const LOCK_TTL_PADDING_MS = 90_000;
const ADMIN_WARNING_FAILURE_THRESHOLD = 3;

/** Aynı kaynak için yönetici uyarısının tekrar aralığı (6 saat). */
const SOURCE_WARNING_REPEAT_MS = 6 * 60 * 60 * 1000;
const KNOWN_ITEMS_LOOKBACK = 5_000;

/** Adaptörün ihtiyaç duyduğu kaynak tanımı (envanter kaydı; yoksa DB kaydından türetilir). */
export function resolveAdapterSource(doc: SourceDoc): SourceDefinition {
  const fromInventory = findSourceDefinition(doc.key);
  if (fromInventory) return fromInventory;

  // Envanterde kaydı olmayan (yönetici tarafından eklenmiş) kaynak: DB kaydından
  // türetilir. Doğrulama kanıtı yoksa bu kaynak "doğrulanmamış" sayılır.
  return {
    key: doc.key,
    name: doc.name,
    group: 'kurum' as SourceGroup,
    sourceType: doc.sourceType as SourceType,
    institution: doc.institution,
    listingUrl: doc.listingUrl,
    homepageUrl: doc.homepageUrl,
    adapterKey: doc.adapterKey,
    method: doc.method as SourceMethod,
    status: doc.status as SourceStatus,
    statusNote: doc.statusNote,
    lastVerifiedAt: doc.verification.verifiedAt,
    verificationEvidence: doc.verification.evidence,
    coverageNote: doc.coverageNotes,
    enabled: doc.enabled,
    intervalMinutes: doc.scrapeIntervalMinutes,
    minRequestIntervalMs: doc.minRequestIntervalMs,
    maxConcurrency: doc.maxConcurrency,
    allowedHosts: doc.allowHosts,
    conditionalRequests: doc.method === 'html-list' || doc.method === 'pdf-index',
    tags: doc.tags,
  };
}

/** Ayrıntı isteği üst sınırı: pahalı yöntemlerde daha az indirilir. */
export function detailFetchBudget(method: string): number {
  if (method === 'browser') return 5;
  if (method === 'pdf-index') return 25;
  // Each item may trigger multiple DB writes after this request; keep HTML
  // source runs within the configured timeout and drain detail backlogs over
  // subsequent scans instead of silently abandoning later pages.
  return 8;
}

/**
 * Eski kural sürümüyle verilmiş RET kararı tarama belleğinde sayılmaz.
 *
 * Reddedilen kayıt ilan (`jobs`) oluşturmaz; yalnızca karar kaydı kalır ve gövde
 * metni saklanmaz. Bu yüzden `jobs:reclassify` ona ulaşamaz: kural düzeltmesi
 * (ör. #31 "Bursa" ≠ "burs") yalnızca kayıt kaynakta yeniden görülüp işlenirse
 * etkili olur. Bu kayıt bilinen kümeden çıkarılınca adaptör onu bir kez yeniden
 * indirir; karar güncel sürümle yeniden yazılır ve kayıt yine "bilinen" olur.
 * İnceleme/sinyal kararları insan kuyruğunda olduğu için yeniden işlenmez.
 */
function staleRejection(decision: { decision: string; classificationVersion: string }): boolean {
  return decision.decision === 'rejected' && decision.classificationVersion !== CLASSIFICATION_VERSION;
}

/** Daha önce görülmüş kaynak içi kimlikler (pahalı indirmeleri atlamak için). */
export async function loadKnownItemIds(repos: Repos, sourceKey: string): Promise<Set<string>> {
  const [links, decisions] = await Promise.all([
    repos.store.find('jobSources', { sourceKey }, { limit: KNOWN_ITEMS_LOOKBACK }),
    repos.jobs.listSourceItemDecisions(sourceKey, KNOWN_ITEMS_LOOKBACK),
  ]);
  // İlan oluşturmayan kayıtlar (ret/inceleme/sinyal) da "görüldü" sayılır;
  // yoksa liste başındaki reddedilen duyurular her koşumda detay bütçesini
  // yutup sonraki sayfalardaki gerçek ilanların süresiz aç kalmasına yol açar.
  return new Set([
    ...links.map((link) => link.sourceItemId),
    ...decisions.filter((d) => !staleRejection(d)).map((d) => d.sourceItemId),
  ]);
}

export async function loadKnownItemIdsWithDetail(repos: Repos, sourceKey: string): Promise<Set<string>> {
  const [links, decisions] = await Promise.all([
    repos.store.find('jobSources', { sourceKey }, { limit: KNOWN_ITEMS_LOOKBACK }),
    repos.jobs.listSourceItemDecisions(sourceKey, KNOWN_ITEMS_LOOKBACK),
  ]);
  const withText = (status: string): boolean => status === 'captured' || status === 'truncated';
  return new Set([
    ...links.filter((link) => withText(link.capturedTextStatus)).map((link) => link.sourceItemId),
    // Gövde metni olmadan reddedilmiş/incelemeye alınmış kayıtlar burada yer
    // almaz: detay sonradan gelirse sınıflandırma yeniden çalışabilir.
    ...decisions.filter((d) => withText(d.capturedTextStatus) && !staleRejection(d)).map((d) => d.sourceItemId),
  ]);
}

/** Sert `withTimeout` reddinden önce adaptöre bırakılan pay (ms). */
const SCAN_DEADLINE_MARGIN_MS = 8_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} zaman aşımına uğradı (${timeoutMs} ms)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Kaynak sağlığı için hata türü: fatal hata varsa türü, yalnız ilan bazlı hatalar varsa "item", yoksa null. */
export function classifyErrorType(
  fatalError: Error | null,
  itemErrorCount: number,
): 'unavailable' | 'structure' | 'fetch' | 'item' | 'other' | null {
  if (fatalError instanceof AdapterUnavailableError) return 'unavailable';
  if (fatalError instanceof AdapterStructureError) return 'structure';
  if (fatalError instanceof FetchError) return 'fetch';
  if (fatalError) return 'other';
  return itemErrorCount > 0 ? 'item' : null;
}

export async function runSourceScrape(options: RunSourceOptions): Promise<RunSourceResult> {
  const env = getEnv();
  const { repos, source, trigger, workerId } = options;
  const now = options.now ?? repos.clock.now();
  const logger = options.logger ?? createLogger('scrape');
  const timeoutMs = env.SCRAPE_TIMEOUT_MS;
  const lockKey = `scrape:${source.key}`;
  const lockTtl = timeoutMs + LOCK_TTL_PADDING_MS;

  const acquired = await repos.locks.acquire(lockKey, workerId, lockTtl);
  if (!acquired) {
    await repos.runs.markSkipped(
      source.key,
      workerId,
      'Bu kaynak başka bir worker tarafından taranıyor (kilit alınamadı).',
    );
    logger.warn({ sourceKey: source.key, workerId }, 'kaynak zaten taranıyor; çift tarama engellendi');
    return {
      runId: '',
      sourceKey: source.key,
      status: 'locked',
      itemsFound: 0,
      itemsAccepted: 0,
      itemsRejected: 0,
      itemsReview: 0,
      jobsCreated: 0,
      jobsUpdated: 0,
      itemsMerged: 0,
      revisionsCreated: 0,
      notificationsQueued: 0,
      durationMs: 0,
      coverageStatus: 'unknown',
      coverageNote: 'Kilit alınamadığı için kaynak kapsamı kontrol edilmedi.',
      notes: ['Kilit alınamadı: başka bir tarama sürüyor.'],
      errors: [],
      httpStatuses: [],
      httpStatus: null,
      errorType: null,
      locked: true,
      llm: disabledLlmGate().summary(),
    };
  }

  const run = await repos.runs.start({
    sourceKey: source.key,
    trigger,
    workerId,
    scheduledFor: options.scheduledFor ?? null,
  });

  const totals: ScrapeRunTotals = { ...EMPTY_TOTALS, httpStatuses: [], errors: [], notes: [] };
  const notificationCounts = { queued: 0 };
  const startedAt = repos.clock.now().getTime();
  let status: ScrapeRunDoc['status'] = 'success';
  let resultMessage = '';
  let coverageStatus: ScrapeRunDoc['coverageStatus'] = 'unknown';
  let coverageNote = 'Adaptör bu çalışmada sayfa/arşiv kapsamı bildirmedi; tam kapsam doğrulanamıyor.';
  let fatalError: Error | null = null;
  let fatalHttpStatus: number | null = null;
  let contentUnchanged = false;
  let adapterNotes: string[] = [];
  let etag: string | null = null;
  let lastModified: string | null = null;
  let contentHash: string | null = null;
  const liveFetch = options.liveFetch ?? env.SOURCE_LIVE_FETCH;
  // SOURCE_LIVE_FETCH=0 gerçek kaynak taramasını kapatır. Bu durumda bir "boş
  // başarılı tarama" yazmak yerine denemeyi atlandı olarak kaydet; ancak testte
  // açıkça verilen sahte adaptör ağa çıkmadığı için çalıştırılmaya devam eder.
  const liveScanDisabled = !liveFetch && options.adapter === undefined;
  // Kullanım şartları kapısı yalnız gerçek ağ taramasında (sahte adaptör ağa çıkmaz).
  const termsGate =
    !liveScanDisabled && options.adapter === undefined ? sourceTermsGate(source.key, env.SOURCE_TERMS_POLICY) : null;
  const ownedHttp = options.http === undefined;
  const requestAbort = new AbortController();
  const http =
    options.http ??
    new HttpClient({
      logger,
      signal: requestAbort.signal,
      // robots kuralları DB kaydında değil, incelenmiş kod tanımında tutulur.
      disallowedPaths: findSourceDefinition(source.key)?.robotsDisallow,
    });
  // LLM sınıflandırma kapısı: koşu başına bir örnek (bütçe sayaçları koşuya ait).
  // Kapalıysa veya yapılandırma eksikse no-op kapı kullanılır (davranış değişmez).
  const llmGate =
    options.llmGate ??
    (llmClassifierConfig(env)
      ? createLlmClassificationGate({
          repos,
          env,
          logger: logger.child({ component: 'llm-gate', sourceKey: source.key }),
        })
      : disabledLlmGate());

  try {
    if (liveScanDisabled) {
      status = 'skipped';
      coverageNote = 'Canlı kaynak erişimi kapalı olduğu için bu çalışmada kapsam doğrulanmadı.';
      resultMessage = 'Canlı kaynak erişimi kapalı (SOURCE_LIVE_FETCH=0); ilan taraması yapılmadı.';
      adapterNotes = [resultMessage];
    } else if (termsGate?.skip) {
      status = 'skipped';
      coverageNote = 'Kaynak kullanım şartları kapısı nedeniyle bu çalışmada tarama yapılmadı.';
      resultMessage = termsGate.note ?? 'Kaynak kullanım şartları kapısı taramayı durdurdu.';
      adapterNotes = [resultMessage];
    } else {
      const adapter = options.adapter ?? requireAdapter(source.adapterKey);
      const definition = resolveAdapterSource(source);
      const [knownItemIds, knownItemIdsWithDetail] = await Promise.all([
        loadKnownItemIds(repos, source.key),
        loadKnownItemIdsWithDetail(repos, source.key),
      ]);

      const ctx: AdapterContext = {
        source: definition,
        http,
        logger: logger.child({ sourceKey: source.key }),
        liveFetch,
        signal: requestAbort.signal,
        // Sert zaman aşımından ÖNCE adaptörün durup kısmi sonuç döndürebilmesi
        // için pay bırakılır (BUDGET_RESERVE_MS + ağ kapanma payı).
        deadlineAt: new Date(Date.now() + Math.max(5_000, timeoutMs - SCAN_DEADLINE_MARGIN_MS)),
        fetchedAt: now,
        knownItemIds,
        knownItemIdsWithDetail,
        maxDetailFetches:
          options.maxDetailFetches === undefined
            ? detailFetchBudget(source.method)
            : Math.min(detailFetchBudget(source.method), Math.max(0, options.maxDetailFetches)),
      };

      const runResult = await withTimeout(adapter.run(ctx), timeoutMs, `${adapter.label} taraması`, () =>
        requestAbort.abort(),
      );
      totals.itemsFound = runResult.items.length;
      totals.httpStatuses = (runResult.httpStatuses ?? []).slice(0, 50);
      adapterNotes = runResult.notes.slice(0, 18);
      if (termsGate?.note) adapterNotes.unshift(termsGate.note);
      coverageStatus = runResult.coverage?.status ?? 'unknown';
      coverageNote =
        runResult.coverage?.note ??
        'Adaptör bu çalışmada sayfa/arşiv kapsamı bildirmedi; tam kapsam doğrulanamıyor.';
      adapterNotes.push(
        `Kapsam: ${coverageStatus === 'complete' ? 'tam olarak doğrulandı' : coverageStatus === 'partial' ? 'kısmi' : 'bilinmiyor'} — ${coverageNote}`,
      );
      totals.coverageStatus = coverageStatus;
      totals.coverageNote = coverageNote;
      if (coverageStatus === 'partial') status = 'partial';
      etag = runResult.etag;
      lastModified = runResult.lastModified;

      if (runResult.notModified) {
        // HTTP 304 kanıtı başarılı kontroldür: ilanlar korunur, son başarı güncellenir.
        status = 'success';
        contentUnchanged = true;
        resultMessage = 'Kaynak içeriği değişmemiş (ETag/Last-Modified eşleşti).';
        adapterNotes.push(resultMessage);
      }

      for (const item of runResult.items) {
        try {
          const outcome = await processItem(sanitizeRawAnnouncement(item), {
            repos,
            now,
            workerId,
            logger,
            llmGate,
          });
          if (outcome === 'created') totals.jobsCreated += 1;
          else if (outcome === 'updated') totals.jobsUpdated += 1;
          else if (outcome === 'merged') totals.itemsMerged += 1;
          else if (outcome === 'review') totals.itemsReview += 1;
          else if (outcome === 'rejected') totals.itemsRejected += 1;
          if (outcome === 'created' || outcome === 'updated') {
            totals.itemsAccepted += 1;
            totals.revisionsCreated += 1;
          }
          if (
            outcome === 'created' ||
            outcome === 'updated' ||
            outcome === 'merged' ||
            outcome === 'review' ||
            outcome === 'withdrawal'
          ) {
            notificationCounts.queued += await notify(item, outcome, {
              repos,
              logger,
              now,
              enabled: options.queueNotifications ?? true,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          totals.errors.push(`${item.url}: ${message}`);
          // Log alanları aranabilirlik içindir: hangi kaynak, hangi aşama, hangi kayıt.
          logger.error(
            { err: message, url: item.url, sourceKey: source.key, stage: 'item' },
            'ilan işlenemedi',
          );
        }
      }

      if (!contentUnchanged) {
        // Görülen kayıt kümesinin parmak izi: aynı ilanlar tekrar geldi mi?
        contentHash =
          runResult.items.length > 0
            ? sha256Hex(
                runResult.items
                  .map((item) => item.sourceItemId)
                  .sort()
                  .join('|'),
              )
            : null;
      }

      // LLM kapısı özeti tarama notlarına yazılır (kalıcı telemetri: llmAnalyses).
      const llmSummary = llmGate.summary();
      if (
        llmSummary.enabled &&
        (llmSummary.calls > 0 || llmSummary.cacheHits > 0 || llmSummary.blocked > 0 || llmSummary.errors > 0)
      ) {
        adapterNotes.push(
          `LLM kapısı: ${llmSummary.calls} çağrı, ${llmSummary.cacheHits} önbellek isabeti, ` +
            `${llmSummary.upgradedToJob} ilan yükseltme, ${llmSummary.upgradedToProcess} süreç duyurusu, ` +
            `${llmSummary.rejected} kanıtlı ret, ${llmSummary.keptReview} belirsiz, ` +
            `${llmSummary.invalid} doğrulanamadı, ${llmSummary.errors} sağlayıcı hatası, ${llmSummary.blocked} bütçe/metin engeli`,
        );
      }

      if (totals.errors.length > 0) {
        status = 'partial';
        resultMessage = `${totals.errors.length} ilan işlenemedi, ${totals.itemsFound - totals.errors.length} ilan işlendi. Kapsam: ${coverageNote}`;
      } else if (contentUnchanged) {
        // 304 doğrulanmış bir kontrol olsa da yeni ilan içeriği üretmez.
      } else if (coverageStatus === 'partial') {
        resultMessage = `Tarama kapsamı kısmi. ${coverageNote} ${totals.itemsFound} ilan işlendi; sonraki taramada devam edilecek.`;
      } else {
        resultMessage = `${totals.itemsFound} ilan bulundu, ${totals.jobsCreated} yeni kayıt, ${totals.itemsMerged} birleştirme, ${totals.itemsReview} inceleme.`;
        if (coverageStatus === 'unknown') resultMessage += ` Kapsam doğrulanamadı: ${coverageNote}`;
        if (totals.itemsFound === 0) {
          resultMessage = `Kaynak erişildi ancak yeni ilan bulunamadı. Kapsam: ${coverageNote}`;
        }
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error(String(error));
    const isUnavailable = error instanceof AdapterUnavailableError;
    const isStructure = error instanceof AdapterStructureError;
    const isAccess = error instanceof SourceAccessError;
    if (isAccess) fatalHttpStatus = error.httpStatus;
    if (fatalError instanceof FetchError) fatalHttpStatus = fatalError.status;
    // Erişim kısıtı (WAF/geo/oturum) bir başarısızlık değil, ATLAMA olarak kaydedilir;
    // kısıt aşılmaya çalışılmaz ve kaynak sağlığında ayrı hata türü olarak görünür.
    status = isUnavailable || isAccess ? 'skipped' : 'failed';
    resultMessage = isUnavailable
      ? `Kaynak atlandı: ${fatalError.message}`
      : isAccess
        ? `Kaynak erişimi kısıtlı${fatalHttpStatus ? ` (HTTP ${fatalHttpStatus})` : ''}: ${fatalError.message}`
        : isStructure
          ? `Kaynak yapısı beklenenden farklı (HTML değişmiş olabilir): ${fatalError.message}`
          : `Tarama başarısız: ${fatalError.message}`;
    totals.errors.push(resultMessage);
    logger.error(
      {
        err: fatalError.message,
        sourceKey: source.key,
        stage: 'adapter',
        errorType: classifyErrorType(fatalError, totals.errors.length),
      },
      'tarama başarısız',
    );
  } finally {
    if (ownedHttp) {
      // Kaynak başına yeni istemci açıldıysa bağlantılar bırakılır.
      await http.close().catch(() => undefined);
    }
  }

  totals.notes = adapterNotes;
  totals.coverageStatus = coverageStatus;
  totals.coverageNote = coverageNote;
  const finished = await repos.runs.finish(run.id, totals, status, resultMessage);
  const durationMs = repos.clock.now().getTime() - startedAt;

  // Şartlar kapısı atlaması bir toplama denemesi değil, politika kararıdır: sağlık
  // sayaçlarına "başarısızlık" yazılmaz (yazılırsa durum raporu sahte KRİTİK verir ve
  // 3 atlamadan sonra yöneticiye "kaynak başarısız" uyarısı gider). Koşu kaydı kalır.
  if (!liveScanDisabled && !termsGate?.skip) {
    const lastHttpStatus =
      totals.httpStatuses.length > 0
        ? (totals.httpStatuses[totals.httpStatuses.length - 1] ?? null)
        : fatalError instanceof FetchError
          ? fatalError.status
          : null;
    await repos.sources.recordHealth(source.key, {
      lastRunAt: now.toISOString(),
      success: fatalError === null && status !== 'skipped',
      durationMs,
      discoveredCount: totals.itemsFound,
      acceptedCount: totals.itemsAccepted,
      errorMessage: fatalError ? fatalError.message : (totals.errors[0] ?? null),
      scheduleDelayMs: finished?.scheduleDelayMs ?? null,
      etag: contentUnchanged && etag === null ? undefined : etag,
      lastModified: contentUnchanged && lastModified === null ? undefined : lastModified,
      contentHash: contentUnchanged ? undefined : contentHash,
      contentUnchanged,
      skipped: status === 'skipped',
      httpStatus: lastHttpStatus,
      errorType: classifyErrorType(fatalError, totals.errors.length),
      extracted: totals.itemsFound > 0 && (status === 'success' || status === 'partial'),
      rejectedCount: totals.itemsRejected,
      reviewCount: totals.itemsReview,
    });

    // Atlanan tarama da yöneticiyi ilgilendirir (kaynak hiç toplanamıyor); uyarı
    // metni atlama ile hatayı ayırır ve uyarılar 6 saatte bir tekrarlanır.
    await warnOnRepeatedFailures({ repos, source, logger, fatalError, skipped: status === 'skipped' });
  }

  await repos.locks.release(lockKey, workerId);

  return {
    runId: run.id,
    sourceKey: source.key,
    status,
    itemsFound: totals.itemsFound,
    itemsAccepted: totals.itemsAccepted,
    itemsRejected: totals.itemsRejected,
    itemsReview: totals.itemsReview,
    jobsCreated: totals.jobsCreated,
    jobsUpdated: totals.jobsUpdated,
    itemsMerged: totals.itemsMerged,
    revisionsCreated: totals.revisionsCreated,
    notificationsQueued: notificationCounts.queued,
    durationMs,
    coverageStatus,
    coverageNote,
    notes: totals.notes,
    errors: totals.errors,
    httpStatuses: totals.httpStatuses,
    httpStatus: fatalHttpStatus,
    errorType: classifyErrorType(fatalError, totals.errors.length),
    locked: false,
    llm: llmGate.summary(),
  };
}

/** Zamanlanmış taramanın gecikmesini kaydetmek için kullanılan saat (sabit an). */
export function clockAt(now: Date): Clock {
  return { now: () => now };
}

/** Kilit süresi: tarama zaman aşımı + pay (worker çökerse kilit kendiliğinden açılır). */
export function lockExpiry(now: Date, timeoutMs: number): string {
  return addMilliseconds(now.toISOString(), timeoutMs + LOCK_TTL_PADDING_MS);
}

async function processItem(
  item: RawAnnouncement,
  ctx: { repos: Repos; now: Date; workerId: string; logger: Logger; llmGate: LlmClassificationGate },
): Promise<'created' | 'updated' | 'merged' | 'review' | 'rejected' | 'withdrawal'> {
  const outcome = await applyRawAnnouncement(item, {
    repos: ctx.repos,
    now: ctx.now,
    workerId: ctx.workerId,
    provenance: 'scraped',
    llmGate: ctx.llmGate,
  });
  switch (outcome.action) {
    case 'created':
      return 'created';
    case 'updated':
      return 'updated';
    case 'merged':
      return 'merged';
    case 'review':
      return 'review';
    case 'rejected':
      return 'rejected';
    case 'withdrawal-signal':
      return 'withdrawal';
    default:
      return 'review';
  }
}

async function notify(
  item: RawAnnouncement,
  action: 'created' | 'updated' | 'merged' | 'review' | 'rejected' | 'withdrawal',
  ctx: { repos: Repos; logger: Logger; now: Date; enabled: boolean },
): Promise<number> {
  if (!ctx.enabled) return 0;
  // İptal/düzeltme duyurusu da ilanı değiştirir (`withdrawal`): kullanıcı iptal edilen
  // ilana başvurmaya devam etmesin diye "ilanda değişiklik" bildirimi üretilir.
  if (action !== 'created' && action !== 'updated' && action !== 'withdrawal') return 0;

  const link = await ctx.repos.jobs.findLinkBySourceItem(item.sourceKey, item.sourceItemId);
  const jobId = link?.jobId;
  if (!jobId) return 0;
  const job: JobDoc | null = await ctx.repos.jobs.findById(jobId);
  if (!job) return 0;
  // Değişiklik özeti sürüm kaydından gelir (ör. "İlan resmî olarak geri çekildi/iptal
  // edildi."); önceden e-posta yalnızca "güncelleme var" diyordu.
  const changeSummary =
    action === 'created'
      ? undefined
      : (await ctx.repos.jobs.listRevisions(job.id)).find((revision) => revision.version === job.version)?.summary;

  const env = getEnv();
  try {
    const result = await queueNotificationsForJob({
      repos: ctx.repos,
      job,
      kind: action === 'created' ? 'new-job' : 'job-changed',
      ...(changeSummary ? { changeSummary } : {}),
      baseUrl: env.APP_BASE_URL,
      senderName: env.APP_DISPLAY_NAME,
      now: ctx.now,
    });
    return result.queued;
  } catch (error) {
    // Bildirim kuyruğu hatası tarama sonucunu bozmaz; ilan kaydedilmiştir.
    ctx.logger.error(
      { err: error instanceof Error ? error.message : String(error), jobId },
      'bildirim olayı oluşturulamadı',
    );
    return 0;
  }
}

async function warnOnRepeatedFailures(input: {
  repos: Repos;
  source: SourceDoc;
  logger: Logger;
  fatalError: Error | null;
  skipped?: boolean;
}): Promise<void> {
  const { repos, source, logger, fatalError, skipped = false } = input;
  const current = await repos.sources.getByKey(source.key);
  const failures = current?.health.consecutiveFailures ?? 0;
  if (!fatalError || failures < ADMIN_WARNING_FAILURE_THRESHOLD) return;

  // Uyarı en fazla 6 saatte bir tekrarlanır: 1 dakikalık test taramasında her
  // dakika aynı kaydı yazmak denetim kaydını ve logu okunamaz hale getirirdi.
  const lastWarningAt = current?.health.lastWarningAt ?? null;
  const due =
    lastWarningAt === null ||
    Date.parse(lastWarningAt) < repos.clock.now().getTime() - SOURCE_WARNING_REPEAT_MS;

  const message = skipped
    ? `${source.name} kaynağı ${failures} kez üst üste toplanamadı (atlandı): ${fatalError.message}`
    : `${source.name} kaynağı ${failures} kez üst üste başarısız oldu: ${fatalError.message}`;

  if (!due) {
    logger.debug({ sourceKey: source.key, failures }, `${message} (uyarı tekrarı bastırıldı)`);
    return;
  }

  logger.warn({ sourceKey: source.key, failures, skipped }, message);
  await repos.sources.recordWarning(source.key, repos.clock.now().toISOString());
  await repos.audit.append({
    actorUserId: null,
    actorRole: 'worker',
    action: skipped ? 'source.skipping' : 'source.failing',
    targetType: 'source',
    targetId: source.key,
    meta: {
      failures,
      skipped,
      error: fatalError.message,
      lastSuccessAt: current?.health.lastSuccessAt ?? null,
    },
  });
}
