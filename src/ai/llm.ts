/**
 * LLM sohbet istemcisi (ağ çağrısı; enjekte edilebilir fetch).
 *
 * İki taşıyıcı desteklenir:
 *  - `openai-compat`  : `${LLM_BASE_URL}/chat/completions` (OpenAI, OpenRouter,
 *                       Groq, Together, Ollama, Azure uyumlu ağ geçitleri)
 *  - `gemini-native`  : Google AI'nin birincil API'si
 *                       `POST {kök}/models/{model}:generateContent`
 *
 * Neden iki taşıyıcı: Google'ın `…/v1beta/openai/…` katmanı KISMİ bir uyumluluk
 * kabuğudur ve her anahtar/bölge/model için `chat/completions` sunmaz. 2026-10-16
 * canlı kanıtı: aynı anahtarla `/v1beta/openai/models` 200 dönerken
 * `/v1beta/openai/chat/completions` **404** döndü; `npm run llm:doctor` da aynı
 * 404'ü raporladı. Sonuç: sınıflandırma kapısındaki her çağrı hata verdi
 * (panel: %100 hata oranı, 0 token) ve inceleme kuyruğundaki tüm belirsiz
 * kayıtlar "model denetimine ulaşılamadı" ile insana kaldı.
 * Bu yüzden Google kökü artık birincil (yerel) API'ye yönlendirilir; kabuğa
 * bağımlılık kalmaz. Diğer sağlayıcıların davranışı DEĞİŞMEZ.
 *
 * Güvenlik:
 *  - API anahtarı yalnızca yetki başlığında gider (`Authorization: Bearer` ya da
 *    `x-goog-api-key`); URL sorgusuna YAZILMAZ, hata metinlerinden ayıklanır.
 *  - Zaman aşımı zorunludur; yanıt boyutu sınırlıdır.
 *  - Ham istem ve yanıt loglanmaz; sağlayıcının hata mesajı kısaltılarak alınır.
 */
import { shouldBlockExternalHttpInTest } from '../lib/offline-network';

export type LlmFetchHeaders =
  | { get?(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

export type LlmFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    /** Sağlayıcı yönlendirmesi API anahtarını başka host'a taşımasın diye hata. */
    redirect: 'error';
  },
) => Promise<{ status: number; headers?: LlmFetchHeaders; text(): Promise<string> }>;

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** Sağlayıcının bildirdiği token kullanımı (maliyet telemetrisi; her sağlayıcı döndürmez). */
export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export type LlmErrorBodyKind = 'empty' | 'json' | 'unexpected-json' | 'html' | 'text';

export type LlmFailureCategory =
  | 'auth'
  | 'not-found'
  | 'rate-limit'
  | 'service-unavailable'
  | 'bad-request'
  | 'http-error'
  | 'timeout'
  | 'network'
  | 'empty-output'
  | 'invalid-json'
  | 'config';

/**
 * HTTP yanıtı için güvenli ve hassas verilerden arındırılmış tanı özeti.
 * Ham gövde veya gizli başlıklar burada tutulmaz; yalnızca izin verilen alanlar
 * ve temizlenmiş kısa özet raporlanır.
 */
export interface LlmHttpDiagnostics {
  status: number | null;
  contentType: string | null;
  bodyLength: number;
  bodyKind: LlmErrorBodyKind;
  errorCode: string | number | null;
  errorStatus: string | null;
  errorMessage: string | null;
  bodySummary: string;
  retryAfter: string | null;
  retryAfterMs: number | null;
  requestId: string | null;
  requestIdHeader: string | null;
  finishReason?: string | null;
  /** Sağlayıcının hız sınırı başlıkları (varsa). */
  rateLimit?: LlmRateLimitInfo | null;
}

/**
 * OpenAI/Groq uyumlu hız sınırı başlıkları. Groq belgesine göre (console.groq.com/docs/rate-limits)
 * `*-requests` alanları günlük istek (RPD), `*-tokens` alanları dakikalık token (TPM) sınırıdır;
 * başlıklar her yanıtta gelir, `retry-after` yalnızca 429'da.
 */
export interface LlmRateLimitInfo {
  limitRequests: number | null;
  remainingRequests: number | null;
  resetRequestsMs: number | null;
  limitTokens: number | null;
  remainingTokens: number | null;
  resetTokensMs: number | null;
  /** `retry-after` (kırpılmamış, ms). Yeniden deneme beklemesi ayrıca MAX_RETRY_AFTER_MS ile sınırlanır. */
  retryAfterMs: number | null;
}

/** "2m59.56s", "7.66s", "1h2m", "120ms" → ms; tanınmazsa null. */
export function parseDurationMs(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/gy;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    const unit = match[2];
    total += unit === 'h' ? value * 3_600_000 : unit === 'm' ? value * 60_000 : unit === 's' ? value * 1_000 : value;
    consumed += match[0].length;
  }
  return consumed > 0 && consumed === text.length ? Math.round(total) : null;
}

export function readRateLimitInfo(headers: LlmFetchHeaders | undefined): LlmRateLimitInfo | null {
  const count = (name: string): number | null => {
    const value = readResponseHeader(headers, name);
    return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  };
  const info: LlmRateLimitInfo = {
    limitRequests: count('x-ratelimit-limit-requests'),
    remainingRequests: count('x-ratelimit-remaining-requests'),
    resetRequestsMs: parseDurationMs(readResponseHeader(headers, 'x-ratelimit-reset-requests')),
    limitTokens: count('x-ratelimit-limit-tokens'),
    remainingTokens: count('x-ratelimit-remaining-tokens'),
    resetTokensMs: parseDurationMs(readResponseHeader(headers, 'x-ratelimit-reset-tokens')),
    retryAfterMs: parseRetryAfterMs(readResponseHeader(headers, 'retry-after'), Date.now(), Number.MAX_SAFE_INTEGER),
  };
  return Object.values(info).some((value) => value !== null) ? info : null;
}

/** Sağlayıcı mesajı günlük kotayı mı anlatıyor? (Groq: "… on requests per day (RPD) …") */
const DAILY_QUOTA_PATTERN = /(per\s+day|\(RPD\)|\(TPD\)|\bdaily\b)/i;

/**
 * 429 günlük kota tükenmesi mi? Kanıt: sağlayıcı mesajı günlük sınırı adlandırıyor ya da
 * günlük istek sayacı (`x-ratelimit-remaining-requests`) sıfır. Dakikalık sınır (TPM/RPM)
 * günlük sayılmaz. 401/403/400 hiçbir zaman kota değildir.
 */
export function isDailyQuotaExhausted(result: Extract<LlmResult, { ok: false }>): boolean {
  if (result.failureCategory !== 'rate-limit') return false;
  // Yalnız SAĞLAYICININ mesajı ve sayacı kanıttır; `reason` uygulamanın kendi ipucunu da taşır.
  const message = result.diagnostics?.errorMessage ?? '';
  return DAILY_QUOTA_PATTERN.test(message) || result.diagnostics?.rateLimit?.remainingRequests === 0;
}

/** Model kullanılamıyor mu (bulunamadı/kaldırıldı)? Bu durumda sıradaki modele geçilir. */
export function isModelUnavailable(result: Extract<LlmResult, { ok: false }>): boolean {
  if (result.failureCategory === 'not-found') return true;
  const code = String(result.diagnostics?.errorCode ?? '');
  return /model_(?:not_found|decommissioned|not_available)/i.test(code);
}

export type LlmResult =
  | {
      ok: true;
      content: string;
      usage: LlmUsage;
      status: number;
      finishReason?: string | null;
      thoughtsTokens?: number | null;
      rateLimit?: LlmRateLimitInfo | null;
    }
  | {
      ok: false;
      reason: string;
      status: number | null;
      retryable: boolean;
      timedOut?: boolean;
      failureCategory?: LlmFailureCategory;
      diagnostics?: LlmHttpDiagnostics;
    };

const MAX_RESPONSE_CHARS = 64_000;
const MAX_PROVIDER_MESSAGE_CHARS = 240;

/** Yeniden deneme ve Retry-After bekleme süresi için güvenli üst sınır (10 saniye). */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Yanıt başlıklarından yalnızca bu sabit izin listesindeki istek/izleme
 * kimlikleri okunur; diğer başlıklar (Set-Cookie, Authorization vb.) asla okunmaz.
 */
export const ALLOWED_REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-goog-request-id',
  'x-guploader-uploadid',
  'cf-ray',
  'traceparent',
  'x-amzn-requestid',
  'x-correlation-id',
] as const;

/**
 * Metin içindeki API anahtarını ve yaygın yetki belirteci kalıplarını maskeler.
 */
export function redactSecret(text: string, secret: string): string {
  if (!text) return text;
  let cleaned = secret ? text.split(secret).join('***') : text;
  cleaned = cleaned
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, '***')
    .replace(/\bsk-[0-9A-Za-z_-]{10,}/g, '***')
    // Groq anahtarı ("gsk_…") ve hata mesajındaki kuruluş kimliği ("org_…").
    .replace(/\bgsk_[0-9A-Za-z]{10,}/g, '***')
    .replace(/\borg_[0-9A-Za-z]{8,}/g, 'org_***')
    .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1***')
    .replace(/((?:x-goog-api-key|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,"';]+/gi, '$1***');
  return cleaned;
}

export function readResponseHeader(headers: LlmFetchHeaders | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const getter = headers as { get(k: string): string | null | undefined };
    const value = getter.get(target) ?? getter.get(name);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const [key, rawValue] of Object.entries(record)) {
    if (key.toLowerCase() === target) {
      const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    }
  }
  return null;
}

/**
 * Sabit izin listesindeki yanıt başlıklarından güvenli istek/izleme kimliğini okur.
 */
export function extractAllowedRequestId(
  headers: LlmFetchHeaders | undefined,
  apiKey = '',
): { header: string; value: string } | null {
  if (!headers) return null;
  for (const header of ALLOWED_REQUEST_ID_HEADERS) {
    const raw = readResponseHeader(headers, header);
    if (!raw) continue;
    const sanitized = redactSecret(raw, apiKey)
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 120);
    if (sanitized.length > 0) {
      return { header, value: sanitized };
    }
  }
  return null;
}

/**
 * `Retry-After` başlığını ayrıştırır (hem saniye tam/ondalık hem HTTP tarih biçimi).
 * Bekleme süresini `[0, maxWaitMs]` aralığında sınırlar.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
  maxWaitMs: number = MAX_RETRY_AFTER_MS,
): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;
  const safeCap = Math.max(0, maxWaitMs);

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(safeCap, Math.round(seconds * 1_000));
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    const deltaMs = Math.max(0, parsedDateMs - nowMs);
    return Math.min(safeCap, deltaMs);
  }

  return null;
}

interface ParsedProviderErrorEnvelope {
  code: string | number | null;
  status: string | null;
  message: string | null;
  matchedKnownField: boolean;
}

function extractDocumentedJsonError(parsed: unknown, apiKey: string): ParsedProviderErrorEnvelope {
  const root = Array.isArray(parsed) ? (parsed.length > 0 ? parsed[0] : null) : parsed;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { code: null, status: null, message: null, matchedKnownField: false };
  }

  const record = root as Record<string, unknown>;
  let rawMessage: string | null = null;
  let rawCode: string | number | null = null;
  let rawStatus: string | null = null;
  let matchedKnownField = false;

  if (record.error !== undefined) {
    matchedKnownField = true;
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      rawMessage = record.error;
    } else if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
      const errObj = record.error as Record<string, unknown>;
      if (typeof errObj.message === 'string' && errObj.message.trim().length > 0) {
        rawMessage = errObj.message;
      }
      if (typeof errObj.code === 'number' || (typeof errObj.code === 'string' && errObj.code.trim().length > 0)) {
        rawCode = typeof errObj.code === 'string' ? errObj.code.trim() : errObj.code;
      }
      if (typeof errObj.status === 'string' && errObj.status.trim().length > 0) {
        rawStatus = errObj.status.trim();
      } else if (typeof errObj.type === 'string' && errObj.type.trim().length > 0) {
        rawStatus = errObj.type.trim();
      }
    }
  }

  if (!rawMessage) {
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      rawMessage = record.message;
      matchedKnownField = true;
    } else if (typeof record.detail === 'string' && record.detail.trim().length > 0) {
      rawMessage = record.detail;
      matchedKnownField = true;
    }
  }

  if (rawCode === null) {
    if (typeof record.code === 'number' || (typeof record.code === 'string' && record.code.trim().length > 0)) {
      rawCode = typeof record.code === 'string' ? record.code.trim() : record.code;
      matchedKnownField = true;
    } else if (typeof record.error_code === 'string' && record.error_code.trim().length > 0) {
      rawCode = record.error_code.trim();
      matchedKnownField = true;
    }
  }

  if (!rawStatus && typeof record.status === 'string' && record.status.trim().length > 0) {
    rawStatus = record.status.trim();
    matchedKnownField = true;
  }

  const cleanMessage = rawMessage
    ? redactSecret(rawMessage.replace(/\s+/g, ' ').trim(), apiKey).slice(0, MAX_PROVIDER_MESSAGE_CHARS)
    : null;
  const cleanCode =
    typeof rawCode === 'string' ? redactSecret(rawCode, apiKey).slice(0, 64) : rawCode;
  const cleanStatus = rawStatus ? redactSecret(rawStatus, apiKey).slice(0, 64) : null;

  const hasExtracted = Boolean(cleanMessage || cleanCode !== null || cleanStatus);
  return {
    code: cleanCode,
    status: cleanStatus,
    message: cleanMessage,
    matchedKnownField: matchedKnownField && hasExtracted,
  };
}

/** Sağlayıcının hata gövdesinden okunabilir mesajı çıkarır (anahtar ayıklanır, kısaltılır). */
export function providerErrorMessage(raw: string, apiKey: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const extracted = extractDocumentedJsonError(parsed, apiKey);
    return extracted.message;
  } catch {
    /* gövde JSON değil: mesaj üretilmez */
  }
  return null;
}

function looksLikeHtml(raw: string, contentType: string | null): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<title\b|<h1\b)/i.test(raw) || /<\/(?:html|body|head|title)>/i.test(raw);
}

function canSafelySummarizePlainText(raw: string): boolean {
  // Kontrol karakterleri veya yapılandırma/özel anahtar dökümü içeren metinler doğrudan özetlenmez.
  if (/[\x00-\x08\x0E-\x1F]/.test(raw)) return false;
  if (/(?:BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE\s+KEY|password\s*=|secret\s*=)/i.test(raw)) return false;
  return true;
}

/**
 * HTTP hata yanıtını güvenli biçimde inceler:
 *  - Boş, JSON, beklenmeyen JSON, HTML ve düz metin gövdelerini ayırt eder.
 *  - Yalnızca belgelenmiş JSON hata alanlarını ayrıştırır.
 *  - API anahtarı ve yetki başlıklarını temizler.
 *  - İzin verilen başlıklardan istek kimliğini ve güvenli üst sınırlı Retry-After değerini okur.
 */
export function inspectHttpErrorResponse(
  raw: string,
  headers: LlmFetchHeaders | undefined,
  apiKey: string,
  status: number | null = null,
  nowMs: number = Date.now(),
): LlmHttpDiagnostics {
  const safeRaw = raw ?? '';
  const bodyLength = Buffer.byteLength(safeRaw, 'utf8');
  const rawContentType = readResponseHeader(headers, 'content-type');
  const contentType = rawContentType ? redactSecret(rawContentType, apiKey).slice(0, 100) : null;
  const rawRetryAfter = readResponseHeader(headers, 'retry-after');
  const retryAfter = rawRetryAfter ? redactSecret(rawRetryAfter, apiKey).slice(0, 80) : null;
  const retryAfterMs = parseRetryAfterMs(rawRetryAfter, nowMs, MAX_RETRY_AFTER_MS);
  const reqId = extractAllowedRequestId(headers, apiKey);

  const trimmed = safeRaw.trim();
  if (trimmed.length === 0) {
    return {
      status,
      contentType,
      bodyLength,
      bodyKind: 'empty',
      errorCode: null,
      errorStatus: null,
      errorMessage: null,
      bodySummary: 'boş gövde (0 bayt)',
      retryAfter,
      retryAfterMs,
      requestId: reqId?.value ?? null,
      requestIdHeader: reqId?.header ?? null,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const extracted = extractDocumentedJsonError(parsed, apiKey);
    if (extracted.matchedKnownField) {
      const parts = [
        extracted.code !== null ? `kod=${extracted.code}` : '',
        extracted.status ? `durum=${extracted.status}` : '',
        extracted.message ?? '',
      ].filter((part) => part.length > 0);
      return {
        status,
        contentType,
        bodyLength,
        bodyKind: 'json',
        errorCode: extracted.code,
        errorStatus: extracted.status,
        errorMessage: extracted.message,
        bodySummary: parts.join(' · ') || `JSON hata gövdesi (${bodyLength} bayt)`,
        retryAfter,
        retryAfterMs,
        requestId: reqId?.value ?? null,
        requestIdHeader: reqId?.header ?? null,
      };
    }
    return {
      status,
      contentType,
      bodyLength,
      bodyKind: 'unexpected-json',
      errorCode: null,
      errorStatus: null,
      errorMessage: null,
      bodySummary: `beklenmeyen JSON biçimi (${bodyLength} bayt, belgelenmiş hata alanı bulunamadı)`,
      retryAfter,
      retryAfterMs,
      requestId: reqId?.value ?? null,
      requestIdHeader: reqId?.header ?? null,
    };
  } catch {
    /* JSON değil: HTML veya düz metin olarak sınıflandır */
  }

  if (looksLikeHtml(trimmed, contentType)) {
    const titleMatch = /<title[^>]*>([\s\S]{1,120}?)<\/title>/i.exec(trimmed);
    const rawTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    const safeTitle =
      rawTitle && canSafelySummarizePlainText(rawTitle) && !/[?&=/]/.test(rawTitle)
        ? redactSecret(rawTitle, apiKey).slice(0, 80)
        : '';
    return {
      status,
      contentType,
      bodyLength,
      bodyKind: 'html',
      errorCode: null,
      errorStatus: null,
      errorMessage: null,
      bodySummary: safeTitle
        ? `HTML hata gövdesi (${bodyLength} bayt, başlık: "${safeTitle}")`
        : `HTML hata gövdesi (${bodyLength} bayt)`,
      retryAfter,
      retryAfterMs,
      requestId: reqId?.value ?? null,
      requestIdHeader: reqId?.header ?? null,
    };
  }

  if (!canSafelySummarizePlainText(trimmed)) {
    return {
      status,
      contentType,
      bodyLength,
      bodyKind: 'text',
      errorCode: null,
      errorStatus: null,
      errorMessage: null,
      bodySummary: `düz metin gövdesi (${bodyLength} bayt, güvenlik nedeniyle özetlenmedi)`,
      retryAfter,
      retryAfterMs,
      requestId: reqId?.value ?? null,
      requestIdHeader: reqId?.header ?? null,
    };
  }

  const cleanText = redactSecret(trimmed.replace(/\s+/g, ' '), apiKey).slice(0, 160);
  return {
    status,
    contentType,
    bodyLength,
    bodyKind: 'text',
    errorCode: null,
    errorStatus: null,
    errorMessage: null,
    bodySummary: `düz metin (${bodyLength} bayt): ${cleanText}`,
    retryAfter,
    retryAfterMs,
    requestId: reqId?.value ?? null,
    requestIdHeader: reqId?.header ?? null,
  };
}

export function classifyHttpFailureStatus(status: number): LlmFailureCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status === 503 || (status >= 500 && status < 600)) return 'service-unavailable';
  if (status === 400 || status === 413 || (status >= 400 && status < 500)) return 'bad-request';
  return 'http-error';
}

export interface ChatCompletionOptions {
  fetchImpl?: LlmFetch;
  /** Varsayılan 0.2 (mevcut panel önerileri davranışı korunur). */
  temperature?: number;
  /** Varsayılan 1200 (mevcut panel önerileri davranışı korunur). */
  maxTokens?: number;
  /** JSON çıktı biçimi isteği; taşıyıcı desteklemiyorsa SESSİZCE yutulmaz, hata üretilir. */
  jsonMode?: boolean;
  /**
   * Taşıyıcıyı elle seç (varsayılan: kök adrese göre otomatik).
   * Tanı aracı (`llm:doctor --compat`) ve testler kullanır.
   */
  transport?: LlmTransport;
  /**
   * Yalnızca Gemini 2.5 düşünme modellerinde isteğe bağlı düşünme bütçesi
   * (`generationConfig.thinkingConfig.thinkingBudget`). Belirtilmezse gönderilmez.
   */
  thinkingBudget?: number;
}

export type LlmTransport = 'openai-compat' | 'gemini-native';

export interface LlmEndpoint {
  transport: LlmTransport;
  /** İsteğin gideceği tam adres. */
  url: string;
  /** İstek gövdesinde/yolunda kullanılacak model kimliği (taşıcıya göre normalize). */
  model: string;
  /** API anahtarının taşındığı başlık. */
  authHeader: 'authorization' | 'x-goog-api-key';
  /** JSON çıktı biçimi bu taşıyıcıda destekleniyor mu? */
  supportsJsonMode: boolean;
}

const GOOGLE_AI_HOST = 'generativelanguage.googleapis.com';

function isGoogleAiHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(GOOGLE_AI_HOST);
}

/** OpenAI uyumlu kökten sürüm önekini ayıklar (`/v1beta`, `/v1`, `/v1beta/openai` → `/v1beta`). */
function googleApiVersionPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  const withoutOpenAi = path.endsWith('/openai') ? path.slice(0, -'/openai'.length) : path;
  const versionMatch = withoutOpenAi.match(/^(\/v\d+[A-Za-z]*)/);
  return versionMatch?.[1] ?? withoutOpenAi ?? '/v1beta';
}

/**
 * Google model kimliğini yerel API'nin beklediği biçime indirger.
 *
 * `models/gemini-2.5-flash` (ListModels çıktısı) ve OpenRouter biçimi
 * `google/gemini-2.5-flash` istek yolunda `models/models/…` üretmesin diye
 * önekler atılır. Boş değer boş döner (çağıran taraf yapılandırma hatası verir).
 */
export function normalizeGeminiModel(model: string): string {
  return (model ?? '')
    .trim()
    .replace(/^models\//i, '')
    .replace(/^google\//i, '');
}

/**
 * OpenAI uyumlu sohbet ucunu kurar (yalnızca `openai-compat` taşıyıcısı).
 *
 * Kurallar:
 *  - Zaten tam uç verilmişse (`…/chat/completions`) aynen kullanılır.
 *  - Google AI kökü verilirse OpenAI uyumlu `…/v1beta/openai` yoluna çevrilir
 *    (bu yol `llm:doctor --compat` ile karşılaştırma yapmak için korunur;
 *    varsayılan taşıyıcı artık `gemini-native`'tir).
 *  - Diğer sağlayıcılarda köke `/chat/completions` eklenir.
 */
export function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `${trimmed}/chat/completions`;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(path)) return url.toString();
  if (isGoogleAiHost(url.hostname)) {
    url.pathname = `${googleApiVersionPath(path)}/openai`;
    url.search = '';
    return `${url.toString().replace(/\/+$/, '')}/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
}

/**
 * Kök adres + model adına göre kullanılacak taşıyıcıyı ve tam istek adresini seçer.
 *
 * Google AI kökü → yerel `generateContent`; diğer her şey → OpenAI uyumlu uç.
 * `options.transport` verilirse otomatik seçim ezilir (tanı/test amaçlı).
 */
export function resolveLlmEndpoint(
  config: Pick<LlmConfig, 'baseUrl' | 'model'>,
  options: { transport?: LlmTransport } = {},
): LlmEndpoint {
  const trimmed = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  const googleHost = url ? isGoogleAiHost(url.hostname) : false;
  const transport: LlmTransport = options.transport ?? (googleHost ? 'gemini-native' : 'openai-compat');

  if (transport === 'gemini-native') {
    // Kök çözümlenemiyorsa da bir adres üretmeye çalışmayız: çağıran taraf
    // (env denetimi/doctor) geçersiz LLM_BASE_URL'i ayrıca raporlar.
    const origin = url ? url.origin : trimmed;
    const versionPath = url ? googleApiVersionPath(url.pathname) : '/v1beta';
    const model = normalizeGeminiModel(config.model);
    return {
      transport,
      url: `${origin}${versionPath}/models/${encodeURIComponent(model)}:generateContent`,
      model,
      authHeader: 'x-goog-api-key',
      supportsJsonMode: true,
    };
  }

  return {
    transport,
    url: chatCompletionsEndpoint(config.baseUrl),
    model: config.model,
    authHeader: 'authorization',
    supportsJsonMode: true,
  };
}

/** Taşıyıcının insan okunur adı (hata metinlerinde ve tanı çıktısında kullanılır). */
export function describeTransport(transport: LlmTransport): string {
  return transport === 'gemini-native' ? 'Gemini yerel API (generateContent)' : 'OpenAI uyumlu uç';
}

export interface ChatMessage {
  role: string;
  content: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

function geminiRole(role: string): 'user' | 'model' {
  const normalized = (role ?? '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'model' || normalized === 'bot') return 'model';
  // 'system' ayrıca systemInstruction'a taşınır; buraya ulaşan her şey kullanıcı mesajıdır.
  return 'user';
}

/**
 * OpenAI biçimli mesaj listesini Gemini `generateContent` gövdesine çevirir.
 *
 * - `system` mesajları `systemInstruction` altında birleştirilir (Gemini'de
 *   sistem rolü `contents` içinde taşınmaz).
 * - `assistant` → `model`; diğerleri → `user`.
 * - Ardışık aynı roldeki mesajlar tek `content` altında birleştirilir: Gemini
 *   ardışık aynı rolü bazı sürümlerde reddeder (400).
 */
export function buildGeminiRequestBody(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; jsonMode?: boolean; thinkingBudget?: number } = {},
): { systemInstruction?: { parts: { text: string }[] }; contents: GeminiContent[]; generationConfig: Record<string, unknown> } {
  const systemTexts = messages
    .filter((message) => (message.role ?? '').trim().toLowerCase() === 'system')
    .map((message) => String(message.content ?? '').trim())
    .filter((text) => text.length > 0);

  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const role = (message.role ?? '').trim().toLowerCase();
    if (role === 'system') continue;
    const text = String(message.content ?? '');
    const mapped = geminiRole(role);
    const last = contents[contents.length - 1];
    if (last && last.role === mapped) last.parts.push({ text });
    else contents.push({ role: mapped, parts: [{ text }] });
  }

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxTokens ?? 1200,
  };
  if (options.jsonMode) generationConfig.responseMimeType = 'application/json';
  if (
    typeof options.thinkingBudget === 'number' &&
    Number.isInteger(options.thinkingBudget) &&
    options.thinkingBudget >= 0
  ) {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
  }

  return {
    ...(systemTexts.length > 0 ? { systemInstruction: { parts: systemTexts.map((text) => ({ text })) } } : {}),
    contents,
    generationConfig,
  };
}

/**
 * Gemini yanıtını `LlmResult` biçimine çevirir.
 *
 * - Metin: `candidates[0].content.parts[].text` birleştirilir (`thought: true`
 *   olan iç düşünme parçaları görünür çıktıya karıştırılmaz).
 * - Token: `usageMetadata.promptTokenCount` / `candidatesTokenCount`.
 * - `promptFeedback.blockReason` ve `finishReason` (SAFETY, RECITATION,
 *   MAX_TOKENS, PROHIBITED_CONTENT) içerik üretilemediğini söyler; sessizce
 *   boş içerik döndürmek yerine gerekçesiyle raporlanır.
 */
export function parseGeminiResponse(payload: unknown): {
  content: string | null;
  usage: LlmUsage;
  failure: string | null;
  finishReason?: string | null;
  thoughtsTokens?: number | null;
} {
  const toCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

  const envelope = payload as {
    candidates?: {
      content?: { parts?: { text?: unknown; thought?: unknown }[] };
      finishReason?: unknown;
      finishMessage?: unknown;
    }[];
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      totalTokenCount?: unknown;
      thoughtsTokenCount?: unknown;
    };
    promptFeedback?: { blockReason?: unknown; safetyRatings?: unknown };
    modelVersion?: unknown;
  };

  const thoughtsTokens = toCount(envelope?.usageMetadata?.thoughtsTokenCount);
  const usage: LlmUsage = {
    promptTokens: toCount(envelope?.usageMetadata?.promptTokenCount),
    completionTokens: toCount(envelope?.usageMetadata?.candidatesTokenCount ?? envelope?.usageMetadata?.totalTokenCount),
  };

  const blockReason = envelope?.promptFeedback?.blockReason;
  if (typeof blockReason === 'string' && blockReason.trim().length > 0) {
    return {
      content: null,
      usage,
      failure: `Sağlayıcı istemi engelledi (blockReason: ${blockReason.trim()}).`,
      finishReason: null,
      thoughtsTokens,
    };
  }

  const candidate = envelope?.candidates?.[0];
  const finishReason =
    typeof candidate?.finishReason === 'string' && candidate.finishReason.trim().length > 0
      ? candidate.finishReason.trim()
      : null;
  const finishMessage = typeof candidate?.finishMessage === 'string' ? candidate.finishMessage.trim() : '';
  const parts = candidate?.content?.parts ?? [];
  const visibleParts = parts.filter((part) => part?.thought !== true);
  const text = visibleParts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  const detail = [
    finishReason && `finishReason: ${finishReason}`,
    thoughtsTokens !== null && thoughtsTokens > 0 ? `thoughtsTokenCount: ${thoughtsTokens}` : '',
    finishMessage,
  ]
    .filter(Boolean)
    .join(' — ');

  if (text.length === 0) {
    return {
      content: null,
      usage,
      failure: `Sağlayıcı yanıtında içerik yok${detail ? ` (${detail})` : ''}.`,
      finishReason,
      thoughtsTokens,
    };
  }

  if (finishReason === 'MAX_TOKENS') {
    return {
      content: null,
      usage,
      failure: `Sağlayıcı yanıtı MAX_TOKENS nedeniyle yarıda kesildi (${detail}${
        usage.completionTokens !== null ? ` — çıktı tokenı: ${usage.completionTokens}` : ''
      }).`,
      finishReason,
      thoughtsTokens,
    };
  }

  return { content: text, usage, failure: null, finishReason, thoughtsTokens };
}

/**
 * Sağlayıcı kökü ile model adı uyuşmuyorsa operatöre okunabilir uyarı.
 * Başlatmayı ENGELLEMEZ (yanlış pozitif olasılığı vardır) ama `env:check` ve
 * `llm:doctor` çıktısında görünür.
 */
export function describeLlmEndpointRisk(baseUrl: string, model: string): string | null {
  const trimmed = (baseUrl ?? '').trim();
  const name = (model ?? '').trim().toLowerCase();
  if (!trimmed || !name) return null;
  let host = '';
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return `LLM_BASE_URL geçerli bir adres değil: "${trimmed}" — örnek: https://openrouter.ai/api/v1`;
  }
  const googleHost = isGoogleAiHost(host);
  const openAiHost = host.endsWith('api.openai.com');
  const geminiModel = normalizeGeminiModel(name).startsWith('gemini');
  const openAiModel = /^(gpt-|o1|o3|o4|chatgpt|text-davinci)/.test(name);
  if (openAiHost && geminiModel) {
    return (
      `LLM_BASE_URL OpenAI ucunu gösteriyor (${host}) ama model bir Gemini modeli ("${model}"): ` +
      'sağlayıcı 404/400 döndürür. Gemini için https://generativelanguage.googleapis.com/v1beta ' +
      'yazın (istemci yerel generateContent API\'sini kullanır) ya da OpenRouter gibi bir ağ geçidi seçin.'
    );
  }
  if (googleHost && openAiModel) {
    return (
      `LLM_BASE_URL Google AI ucunu gösteriyor (${host}) ama model bir OpenAI modeli ("${model}"): ` +
      'sağlayıcı 404 döndürür. OpenAI modelleri için https://api.openai.com/v1 kullanın.'
    );
  }
  return null;
}

/**
 * Sağlayıcının 429 gövdesi KOTA/PLAN sınırını mı anlatıyor?
 * Canlı kanıt (16.10.2026): Google `RESOURCE_EXHAUSTED` + "You exceeded your current
 * quota, please check your plan and billing details." döndürdü. Eski ipucu yalnızca
 * "günlük sınır (LLM_DAILY_CALL_LIMIT) düşürülebilir" diyordu; bu, sınırı YANLIŞ yere
 * (uygulamanın kendi sayacına) yıkıyordu. Ayrım operatör için kritiktir: uygulama ayarı
 * sağlayıcı kotasını değiştirmez.
 */
const PROVIDER_QUOTA_PATTERN = /(quota|billing|resource[_\s-]?exhausted|rate[_\s-]?limit|plan)/i;

/** HTTP durum koduna göre operatörün deneyebileceği ilk adım (sır içermez). */
function statusHint(status: number, endpoint: LlmEndpoint, providerMessage?: string | null): string {
  if (status === 404) {
    if (endpoint.transport === 'gemini-native') {
      return (
        ` Model adı ya da API sürümü geçersiz olabilir: istek ${endpoint.url} adresine gönderildi. ` +
        'Model kimliği "gemini-2.5-flash" biçiminde olmalı (models/ öneki gerekmez). ' +
        'Kullanılabilir modeller: GET {LLM_BASE_URL}/models — anahtar x-goog-api-key başlığıyla. ' +
        "Karşılaştırma için: npm run llm:doctor -- --compat"
      );
    }
    return (
      ' Uç nokta ya da model adı yanlış olabilir: istek ' +
      `${endpoint.url} adresine "${endpoint.model}" modeliyle gönderildi. LLM_BASE_URL OpenAI uyumlu KÖK olmalı ` +
      '(ör. https://api.openai.com/v1, https://openrouter.ai/api/v1). Google kökü yazıldığında istemci ' +
      'yerel generateContent API\'sine geçer; bu ucu görmek için: npm run llm:doctor'
    );
  }
  if (status === 401 || status === 403) return ' API anahtarı geçersiz, süresi dolmuş ya da bu model için yetkisiz.';
  if (status === 400) {
    return endpoint.transport === 'gemini-native'
      ? ' İstek gövdesi Gemini biçimiyle uyumsuz olabilir (model adı, maxOutputTokens, systemInstruction ya da ardışık aynı roldeki mesajlar).'
      : ' İstek gövdesi sağlayıcıyla uyumsuz olabilir (model adı, max_tokens ya da response_format desteği).';
  }
  if (status === 429) {
    if (providerMessage && PROVIDER_QUOTA_PATTERN.test(providerMessage)) {
      return (
        ' Sağlayıcı KOTA/PLAN sınırı bildirdi (HTTP 429). Bu sınır SAĞLAYICIDA (hesap/plan/günlük kota); ' +
        'uygulamanın kendi sayacı (LLM_DAILY_CALL_LIMIT) ya da yeniden deneme ayarı bu hatayı ÇÖZMEZ. ' +
        'Sağlayıcı panelinden kotayı/planı kontrol edin; kota yenilendiğinde komutu yineleyin.'
      );
    }
    return ' Sağlayıcı hız/kota sınırı uyguluyor; günlük sınır (LLM_DAILY_CALL_LIMIT) düşürülebilir.';
  }
  if (status === 413) return ' İstem çok büyük; LLM_MAX_INPUT_CHARS değerini düşürün.';
  return '';
}

export async function callChatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<LlmResult> {
  const fetchImpl: LlmFetch = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as never);
  const endpoint = resolveLlmEndpoint(config, options.transport ? { transport: options.transport } : {});
  if (!options.fetchImpl && shouldBlockExternalHttpInTest(endpoint.url, 'llm-provider')) {
    return {
      ok: false,
      reason: 'Vitest offline guard: dış sağlayıcı çağrısı engellendi; fake/loopback transport kullanın.',
      status: null,
      retryable: false,
      failureCategory: 'config',
    };
  }
  const jsonMode = options.jsonMode === true;

  if (jsonMode && !endpoint.supportsJsonMode) {
    // Sessizce biçimsiz yanıt beklemek yerine açık hata: kayıt incelemede kalır
    // ve panelde neden görünür.
    return {
      ok: false,
      reason: `Taşıyıcı JSON modunu desteklemiyor (${describeTransport(endpoint.transport)}).`,
      status: null,
      retryable: false,
      failureCategory: 'config',
    };
  }

  const native = endpoint.transport === 'gemini-native';
  if (native && endpoint.model.length === 0) {
    return {
      ok: false,
      reason: 'Model adı boş: LLM_MODEL ya da LLM_CLASSIFIER_MODEL tanımlı olmalı (ör. gemini-2.5-flash).',
      status: null,
      retryable: false,
      failureCategory: 'config',
    };
  }
  const geminiBody = native
    ? buildGeminiRequestBody(messages, {
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens ?? 1200,
        jsonMode,
        ...(options.thinkingBudget !== undefined ? { thinkingBudget: options.thinkingBudget } : {}),
      })
    : null;
  const requestBody: Record<string, unknown> = geminiBody ?? {
    model: endpoint.model,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 1200,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
  if (geminiBody && geminiBody.contents.length === 0) {
    return {
      ok: false,
      reason: 'İstemde model mesajı yok: sistem mesajı dışında en az bir kullanıcı mesajı gerekli.',
      status: null,
      retryable: false,
      failureCategory: 'config',
    };
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.authHeader === 'x-goog-api-key') headers['x-goog-api-key'] = config.apiKey;
  else headers.authorization = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
      // Kimlik taşıyan istek 30x ile başka host'a yönlendirilirse anahtar
      // sızabilir; yönlendirmeyi hata say (sağlayıcı uç noktası doğrudan olmalı).
      redirect: 'error',
    });
    const raw = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    if (response.status < 200 || response.status >= 300) {
      // 429 (hız sınırı) ve 5xx geçici hatalardır; sınırlı yeniden deneme yapılır.
      // 401/403/400/404 yapılandırma hatasıdır; yeniden deneme kotası tüketmez.
      const retryable = response.status === 429 || response.status >= 500;
      const diagnostics = inspectHttpErrorResponse(raw, response.headers, config.apiKey, response.status);
      diagnostics.rateLimit = readRateLimitInfo(response.headers);
      const providerMessage = diagnostics.errorMessage ?? providerErrorMessage(raw, config.apiKey);
      return {
        ok: false,
        reason:
          `Sağlayıcı HTTP ${response.status} döndü [${describeTransport(endpoint.transport)}].` +
          (providerMessage ? ` Sağlayıcı mesajı: ${providerMessage}.` : '') +
          statusHint(response.status, endpoint, providerMessage),
        status: response.status,
        retryable,
        failureCategory: classifyHttpFailureStatus(response.status),
        diagnostics,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const diagnostics = inspectHttpErrorResponse(raw, response.headers, config.apiKey, response.status);
      return {
        ok: false,
        reason: 'Sağlayıcı yanıtı JSON değil.',
        status: response.status,
        retryable: false,
        failureCategory: 'invalid-json',
        diagnostics,
      };
    }

    if (native) {
      const gemini = parseGeminiResponse(parsed);
      if (!gemini.content) {
        const reqId = extractAllowedRequestId(response.headers, config.apiKey);
        const rawContentType = readResponseHeader(response.headers, 'content-type');
        return {
          ok: false,
          reason: gemini.failure ?? 'Sağlayıcı yanıtında içerik yok.',
          status: response.status,
          retryable: false,
          failureCategory: 'empty-output',
          diagnostics: {
            status: response.status,
            contentType: rawContentType ? redactSecret(rawContentType, config.apiKey).slice(0, 100) : null,
            bodyLength: Buffer.byteLength(raw, 'utf8'),
            bodyKind: 'json',
            errorCode: null,
            errorStatus: gemini.finishReason ?? null,
            errorMessage: gemini.failure,
            bodySummary: gemini.failure ?? 'Sağlayıcı yanıtında içerik yok.',
            retryAfter: null,
            retryAfterMs: null,
            requestId: reqId?.value ?? null,
            requestIdHeader: reqId?.header ?? null,
            finishReason: gemini.finishReason ?? null,
          },
        };
      }
      return {
        ok: true,
        content: gemini.content,
        status: response.status,
        usage: gemini.usage,
        ...(gemini.finishReason ? { finishReason: gemini.finishReason } : {}),
        ...(gemini.thoughtsTokens !== null && gemini.thoughtsTokens !== undefined
          ? { thoughtsTokens: gemini.thoughtsTokens }
          : {}),
      };
    }

    const envelope = parsed as {
      choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
      };
    };
    const choice = envelope?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      const finishReason =
        typeof choice?.finish_reason === 'string' && choice.finish_reason.trim().length > 0
          ? choice.finish_reason.trim()
          : null;
      const reason = `Sağlayıcı yanıtında içerik yok${finishReason ? ` (finishReason: ${finishReason})` : ''}.`;
      const reqId = extractAllowedRequestId(response.headers, config.apiKey);
      const rawContentType = readResponseHeader(response.headers, 'content-type');
      return {
        ok: false,
        reason,
        status: response.status,
        retryable: false,
        failureCategory: 'empty-output',
        diagnostics: {
          status: response.status,
          contentType: rawContentType ? redactSecret(rawContentType, config.apiKey).slice(0, 100) : null,
          bodyLength: Buffer.byteLength(raw, 'utf8'),
          bodyKind: 'json',
          errorCode: null,
          errorStatus: finishReason,
          errorMessage: reason,
          bodySummary: reason,
          retryAfter: null,
          retryAfterMs: null,
          requestId: reqId?.value ?? null,
          requestIdHeader: reqId?.header ?? null,
          finishReason,
        },
      };
    }
    const toCount = (value: unknown): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    // `length` = çıktı token sınırında kesildi (gpt-oss akıl yürütme tokenları bütçeyi yiyebilir);
    // içerik bozuk JSON olabileceği için tanı araçları bunu raporlar.
    const finishReason =
      typeof choice?.finish_reason === 'string' && choice.finish_reason.trim().length > 0
        ? choice.finish_reason.trim()
        : null;
    return {
      ok: true,
      content,
      status: response.status,
      usage: {
        promptTokens: toCount(envelope?.usage?.prompt_tokens),
        completionTokens: toCount(envelope?.usage?.completion_tokens),
      },
      finishReason,
      thoughtsTokens: toCount(envelope?.usage?.completion_tokens_details?.reasoning_tokens),
      rateLimit: readRateLimitInfo(response.headers),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = controller.signal.aborted;
    const reason = timedOut
      ? 'Zaman aşımı.'
      : redactSecret(message, config.apiKey).slice(0, 200);
    // Zaman aşımı ve ağ hatası geçicidir: sınırlı yeniden denenebilir; 503 ile karıştırılmaz.
    return {
      ok: false,
      reason: `Sağlayıcıya ulaşılamadı: ${reason}`,
      status: null,
      retryable: true,
      timedOut,
      failureCategory: timedOut ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Artan bekleme süresi + `Retry-After` (varsa güvenli üst sınır içinde) hesabı.
 * `attempt`: 1 tabanlı yeniden deneme sırası (1 = ilk yeniden deneme).
 */
export function computeRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  retryAfterMs: number | null | undefined,
  maxDelayMs: number = MAX_RETRY_AFTER_MS,
): number {
  const safeCap = Math.max(0, maxDelayMs);
  const step = Math.max(1, Math.floor(attempt));
  const backoff = Math.max(0, baseDelayMs) * step;
  const candidate =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.max(backoff, retryAfterMs)
      : backoff;
  return Math.min(safeCap, candidate);
}

export interface LlmRetryOptions extends ChatCompletionOptions {
  /** İlk denemeden sonra yapılacak azami ek deneme sayısı (0..3). */
  maxRetries?: number;
  /** Artan bekleme için taban süre (ms). */
  baseDelayMs?: number;
  /** Bekleme süresi güvenli üst sınırı (ms). */
  maxDelayMs?: number;
  /** Testlerde bekleme süresini doğrulamak için enjekte edilebilir bekleme fonksiyonu. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Yalnızca geçici hatalarda (`retryable === true`: 429, 5xx, zaman aşımı, ağ hatası)
 * sınırlı yeniden deneme yapan sarmalayıcı.
 * `401/403`, `400`, `404` ve `HTTP 200 + MAX_TOKENS/boş içerik` durumlarında tekrar yapmaz.
 */
export async function callChatCompletionWithRetry(
  config: LlmConfig,
  messages: ChatMessage[],
  options: LlmRetryOptions = {},
): Promise<LlmResult & { attempts: number; delaysMs: number[] }> {
  const maxRetries = Math.min(3, Math.max(0, Math.floor(options.maxRetries ?? 0)));
  const maxAttempts = 1 + maxRetries;
  const baseDelayMs = options.baseDelayMs ?? 750;
  const maxDelayMs = options.maxDelayMs ?? MAX_RETRY_AFTER_MS;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempts = 0;
  const delaysMs: number[] = [];
  let lastResult: LlmResult | null = null;

  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0 && lastResult && !lastResult.ok) {
      const delayMs = computeRetryDelayMs(
        index,
        baseDelayMs,
        lastResult.diagnostics?.retryAfterMs,
        maxDelayMs,
      );
      delaysMs.push(delayMs);
      if (delayMs > 0) await sleep(delayMs);
    }
    attempts += 1;
    lastResult = await callChatCompletion(config, messages, options);
    if (lastResult.ok) {
      return { ...lastResult, attempts, delaysMs };
    }
    if (!lastResult.retryable) {
      break;
    }
  }

  return { ...(lastResult as Extract<LlmResult, { ok: false }>), attempts, delaysMs };
}
