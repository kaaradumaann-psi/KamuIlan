/**
 * LLM kapısı tanısı: `npm run llm:doctor`
 *
 * Neden var: inceleme kuyruğundaki kayıtlarda "LLM doğrulaması yapılamadı
 * (sağlayıcı hatası)" ve panelde "%100 hata oranı · 0 token" göründüğünde,
 * sorunun ANAHTAR mı, UÇ NOKTA mı, MODEL ADI mı, KOTA/YOĞUNLUK mu yoksa
 * ÇIKTI TOKEN SINIRI mı olduğu panelden anlaşılamıyordu. Bu betik yapılandırmayı
 * her iki kapı (ilan sınıflandırıcısı ve panel öneri asistanı) için ayrı ayrı
 * inceler, sınırlı sayıda gerçek çağrı yapar ve kanıta dayalı sonuç üretir.
 *
 * Kullanım:
 *   npm run llm:doctor                → yapılandırma + kontrollü canlı çağrı
 *   npm run llm:doctor -- --offline   → yalnızca yapılandırma denetimi (ağ yok)
 *   npm run llm:doctor -- --compat    → Google kökünde OpenAI uyumlu ucu dene
 *   npm run llm:doctor -- --native    → taşıyıcıyı Gemini yerel API'sine zorla
 *   npm run llm:doctor -- --json      → makine okunur çıktı
 *
 * Güvenlik: API anahtarı, Authorization ve x-goog-api-key değerleri hiçbir
 * biçimde yazdırılmaz (yalnızca anahtar uzunluğu). Ham istem/yanıt gövdesi
 * loglanmaz ve veritabanına yazılmaz. TLS doğrulaması asla kapatılmaz.
 */
import { getEnv, inspectEnvironment, type Env } from '../src/config/env';
import {
  callChatCompletionWithRetry,
  describeLlmEndpointRisk,
  describeTransport,
  inspectHttpErrorResponse,
  normalizeGeminiModel,
  redactSecret,
  resolveLlmEndpoint,
  type LlmConfig,
  type LlmFailureCategory,
  type LlmFetch,
  type LlmFetchHeaders,
  type LlmHttpDiagnostics,
  type LlmTransport,
} from '../src/ai/llm';
import { llmClassifierConfig } from '../src/ai/classifier';

const HELP = `LLM kapısı tanısı

Kullanım:
  npm run llm:doctor                yapılandırma + kontrollü canlı çağrı (taşıyıcı otomatik seçilir)
  npm run llm:doctor -- --offline   yalnızca yapılandırma (ağ çağrısı yok)
  npm run llm:doctor -- --compat    Google kökünde OpenAI uyumlu ucu DENE (karşılaştırma için)
  npm run llm:doctor -- --native    taşıyıcıyı Gemini yerel API'sine zorla
  npm run llm:doctor -- --json      makine okunur çıktı
  npm run llm:doctor -- --help      bu yardım

Taşıyıcılar:
  gemini-native  POST {kök}/models/{model}:generateContent  (Google AI birincil API'si)
  openai-compat  POST {kök}/chat/completions                (OpenAI, OpenRouter, Groq, Ollama …)`;

/**
 * Tanı çağrısı çıktı token sınırı.
 *
 * Neden 8 veya 64 değil 256: Gemini düşünme modellerinde `generationConfig.maxOutputTokens`
 * hem iç düşünme (`usageMetadata.thoughtsTokenCount`) hem görünür çıktı
 * (`candidatesTokenCount`) bütçesini birlikte sınırlar. `maxOutputTokens: 8`
 * gönderildiğinde model düşünme aşamasında 8 tokenı tüketip boş içerikle,
 * `maxOutputTokens: 64` gönderildiğinde ise düşünme kapalı değilse 63 düşünme +
 * 1 çıktı tokenı ("haz") üretip `finishReason: MAX_TOKENS` ile yarıda kesilir.
 * 256 token sınırı (ve Flash modellerinde `thinkingBudget: 0`) yanıtın kesilmeden
 * tamamlanmasını sağlarken maliyeti ihmal edilebilir düzeyde tutar.
 */
export const DOCTOR_PROBE_MAX_TOKENS = 256;

/** Tek bir tanı çalıştırmasında yapılabilecek azami gerçek HTTP çağrısı. */
export const DOCTOR_MAX_API_CALLS = 5;

/** Tanı çalıştırmasında çağrı başına azami yeniden deneme sayısı (geçici 429/503 için). */
export const DOCTOR_MAX_RETRIES_PER_CALL = 1;

export const DOCTOR_PROBE_MESSAGES = [
  { role: 'system', content: 'Bağlantı denetimi. Yanıt olarak yalnızca "hazır" kelimesini yaz.' },
  { role: 'user', content: 'hazır' },
] as const;

export type CheckStatus = 'başarılı' | 'başarısız' | 'bilinmiyor';

export interface DoctorChecks {
  /** 1. Model sağlayıcının model listesinde bulunuyor mu? */
  modelListed: CheckStatus;
  /** 2. Modelin supportedGenerationMethods alanında generateContent var mı? */
  supportsGenerateContent: CheckStatus;
  /** 3. İstek HTTP düzeyinde yanıt alabildi mi? */
  httpResponseReceived: CheckStatus;
  /** 4. Yetkilendirme doğrulaması (401/403 gözlendi mi / gerçek üretimle kanıtlandı mı)? */
  authorizationCheck: CheckStatus;
  /** 5. Gerçek çağrı kullanılabilir metin üretti mi? */
  usableTextGenerated: CheckStatus;
}

export interface DoctorCallReport {
  attempted: boolean;
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  attempts: number;
  detail: string;
  failureCategory: LlmFailureCategory | 'ok' | null;
  contentPreview: string | null;
  diagnostics: LlmHttpDiagnostics | null;
}

export interface ListedModelEntry {
  name: string;
  supportedGenerationMethods: string[] | null;
}

export interface DoctorModelListReport {
  ok: boolean;
  status: number | null;
  count: number;
  configuredModelListed: boolean;
  supportedGenerationMethods: string[] | null;
  supportsGenerateContent: boolean | null;
  detail: string;
  diagnostics: LlmHttpDiagnostics | null;
}

export interface GateDiagnosticReport {
  gate: 'classifier' | 'assistant';
  label: string;
  enabled: boolean;
  configured: boolean;
  model: string | null;
  modelSource: 'LLM_CLASSIFIER_MODEL' | 'LLM_MODEL' | null;
  baseUrl: string | null;
  transport: LlmTransport | null;
  endpoint: string | null;
  endpointRisk: string | null;
  promptSummary: string;
  generationSettings: {
    temperature: number;
    maxTokens: number;
    jsonMode: boolean;
  };
  call: DoctorCallReport | null;
  modelList: DoctorModelListReport | null;
  checks: DoctorChecks;
}

export interface DoctorReport {
  classifierEnabled: boolean;
  assistantEnabled: boolean;
  model: string | null;
  baseUrl: string | null;
  transport: LlmTransport | null;
  endpoint: string | null;
  endpointRisk: string | null;
  timeoutMs: number;
  maxCallsPerRun: number;
  dailyCallLimit: number;
  costConfigured: boolean;
  warnings: string[];
  call: DoctorCallReport | null;
  modelList: DoctorModelListReport | null;
  checks: DoctorChecks;
  gates: {
    classifier: GateDiagnosticReport;
    assistant: GateDiagnosticReport;
  };
  apiBudget: {
    maxCalls: number;
    usedCalls: number;
    maxRetriesPerCall: number;
  };
}

export type DoctorHttpFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; headers?: LlmFetchHeaders; text(): Promise<string> }>;

function hasFlag(flag: string, argv: readonly string[] = process.argv): boolean {
  return argv.includes(flag);
}

/** Anahtarın kendisini değil yalnızca varlığını/uzunluğunu raporlar. */
export function describeSecret(value: string): string {
  return value ? `tanımlı (uzunluk ${value.length})` : 'BOŞ';
}

/**
 * Gemini Flash modellerinde tanı çağrısının düşünme tokenlarıyla `maxOutputTokens`
 * sınırını tüketmemesi ve gecikmeyi düşürmesi için `thinkingBudget: 0` belirler.
 */
export function probeThinkingBudgetForModel(model: string, transport: LlmTransport): number | undefined {
  if (transport !== 'gemini-native') return undefined;
  const normalized = normalizeGeminiModel(model).toLowerCase();
  if (/^gemini-[\d.]+-flash/i.test(normalized)) {
    return 0;
  }
  return undefined;
}

/**
 * Sağlayıcının MODEL LİSTESİ ucunu dener ve `supportedGenerationMethods` bilgisini ayrıştırır.
 *
 * ÖNEMLİ: Modelin listede görünmesi veya `generateContent` metodunu desteklemesi
 * tek başına üretim yetkisini veya sağlıklı metin üretimini KANITLAMAZ; yalnızca
 * model kimliğinin katalogda bulunduğunu ve desteklenen yöntemleri gösterir.
 */
export async function probeModelList(
  config: LlmConfig,
  transport: LlmTransport,
  options: { fetchImpl?: DoctorHttpFetch } = {},
): Promise<{
  ok: boolean;
  status: number | null;
  models: string[];
  entries: ListedModelEntry[];
  detail: string;
  diagnostics: LlmHttpDiagnostics | null;
}> {
  const fetchImpl: DoctorHttpFetch =
    options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as never);
  const endpoint = resolveLlmEndpoint(config, { transport });
  const url =
    transport === 'gemini-native'
      ? `${endpoint.url.slice(0, Math.max(0, endpoint.url.indexOf('/models/')))}/models?pageSize=200`
      : endpoint.url.replace(/\/chat\/completions$/, '/models');
  const headers: Record<string, string> =
    transport === 'gemini-native'
      ? { 'x-goog-api-key': config.apiKey }
      : { authorization: `Bearer ${config.apiKey}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 15_000));
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const raw = (await response.text()).slice(0, 200_000);
    if (response.status < 200 || response.status >= 300) {
      const diagnostics = inspectHttpErrorResponse(raw, response.headers, config.apiKey, response.status);
      return {
        ok: false,
        status: response.status,
        models: [],
        entries: [],
        detail: diagnostics.bodySummary,
        diagnostics,
      };
    }
    const parsed = JSON.parse(raw) as { models?: unknown[]; data?: unknown[] };
    const rawEntries = (parsed.models ?? parsed.data ?? []) as {
      name?: unknown;
      id?: unknown;
      supportedGenerationMethods?: unknown;
    }[];
    const entries: ListedModelEntry[] = [];
    for (const entry of rawEntries) {
      const name = String(entry?.name ?? entry?.id ?? '')
        .trim()
        .replace(/^models\//i, '');
      if (!name) continue;
      const methods = Array.isArray(entry?.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.filter((item): item is string => typeof item === 'string')
        : null;
      entries.push({ name, supportedGenerationMethods: methods });
    }
    const models = entries.map((entry) => entry.name);
    return {
      ok: true,
      status: response.status,
      models,
      entries,
      detail: `${models.length} model listelendi`,
      diagnostics: null,
    };
  } catch (error) {
    const rawMessage = controller.signal.aborted
      ? 'zaman aşımı'
      : redactSecret(String(error instanceof Error ? error.message : error), config.apiKey).slice(0, 160);
    return {
      ok: false,
      status: null,
      models: [],
      entries: [],
      detail: rawMessage,
      diagnostics: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildModelListReportForModel(
  listResult: Awaited<ReturnType<typeof probeModelList>>,
  model: string | null,
): DoctorModelListReport {
  const normalizedModel = normalizeGeminiModel(model ?? '');
  const matched = listResult.entries.find(
    (entry) => entry.name.toLowerCase() === normalizedModel.toLowerCase(),
  );
  const configuredModelListed = Boolean(matched);
  const supportedGenerationMethods = matched?.supportedGenerationMethods ?? null;
  const supportsGenerateContent =
    supportedGenerationMethods !== null ? supportedGenerationMethods.includes('generateContent') : null;

  return {
    ok: listResult.ok,
    status: listResult.status,
    count: listResult.models.length,
    configuredModelListed,
    supportedGenerationMethods,
    supportsGenerateContent,
    detail: listResult.detail,
    diagnostics: listResult.diagnostics,
  };
}

/**
 * 5 bağımsız kontrol noktasını kanıta dayalı olarak (`başarılı` / `başarısız` / `bilinmiyor`)
 * hesaplar. Model listesi başarısı asla üretim veya yetkilendirme başarısı sayılmaz.
 */
export function evaluateDoctorChecks(
  call: DoctorCallReport | null,
  modelList: DoctorModelListReport | null,
): DoctorChecks {
  const modelListed: CheckStatus =
    modelList && modelList.ok
      ? modelList.configuredModelListed
        ? 'başarılı'
        : 'başarısız'
      : 'bilinmiyor';

  const supportsGenerateContent: CheckStatus =
    modelList && modelList.ok && modelList.configuredModelListed && modelList.supportsGenerateContent !== null
      ? modelList.supportsGenerateContent
        ? 'başarılı'
        : 'başarısız'
      : 'bilinmiyor';

  const httpResponseReceived: CheckStatus =
    !call || !call.attempted
      ? 'bilinmiyor'
      : call.status !== null
        ? 'başarılı'
        : 'başarısız';

  // Yetkilendirme: 401/403 gözlendiyse başarısız; gerçek üretim metin döndürdüyse başarılı.
  // 503/429/404/zaman aşımı veya boş içerik durumunda yetkilendirme hatası gözlenmemiştir
  // ancak üretim tamamlanmadığı için durum "bilinmiyor" olarak raporlanır.
  const authorizationCheck: CheckStatus =
    !call || !call.attempted
      ? 'bilinmiyor'
      : call.ok
        ? 'başarılı'
        : call.failureCategory === 'auth' || call.status === 401 || call.status === 403
          ? 'başarısız'
          : 'bilinmiyor';

  const usableTextGenerated: CheckStatus =
    !call || !call.attempted
      ? 'bilinmiyor'
      : call.ok
        ? 'başarılı'
        : 'başarısız';

  return {
    modelListed,
    supportsGenerateContent,
    httpResponseReceived,
    authorizationCheck,
    usableTextGenerated,
  };
}

export function describeFailureCategory(category: DoctorCallReport['failureCategory']): string {
  switch (category) {
    case 'ok':
      return 'başarılı metin üretimi (HTTP 200 + ayrıştırılmış içerik)';
    case 'auth':
      return 'yetkilendirme/anahtar hatası (HTTP 401/403)';
    case 'not-found':
      return 'uç nokta veya model bulunamadı (HTTP 404)';
    case 'rate-limit':
      return 'hız sınırı veya kota aşımı (HTTP 429)';
    case 'service-unavailable':
      return 'sağlayıcı geçici yoğunluk/hizmet kesintisi (HTTP 503/5xx)';
    case 'bad-request':
      return 'istek biçimi veya parametre hatası (HTTP 400/4xx)';
    case 'timeout':
      return 'zaman aşımı (HTTP 503 değildir; sağlayıcı süresi içinde yanıt vermedi)';
    case 'network':
      return 'ağ veya TLS bağlantı hatası (HTTP yanıtı alınamadı)';
    case 'empty-output':
      return 'boş üretim yanıtı (HTTP 200 döndü ancak kullanılabilir metin üretilmedi, ör. MAX_TOKENS/SAFETY)';
    case 'invalid-json':
      return 'geçersiz JSON yanıtı (HTTP 200 döndü ancak gövde JSON değil)';
    case 'config':
      return 'yerel yapılandırma hatası';
    default:
      return 'bilinmiyor';
  }
}

function buildGateBaseReport(
  gate: 'classifier' | 'assistant',
  env: Env,
  forcedTransport?: LlmTransport,
): GateDiagnosticReport {
  const baseUrl = env.LLM_BASE_URL.trim() || null;
  const hasKey = Boolean(env.LLM_API_KEY);

  if (gate === 'classifier') {
    const rawClassifierModel = env.LLM_CLASSIFIER_MODEL.trim();
    const rawFallbackModel = env.LLM_MODEL.trim();
    const model = rawClassifierModel || rawFallbackModel || null;
    const modelSource: GateDiagnosticReport['modelSource'] = rawClassifierModel
      ? 'LLM_CLASSIFIER_MODEL'
      : rawFallbackModel
        ? 'LLM_MODEL'
        : null;
    const configured = Boolean(baseUrl && hasKey && model && env.LLM_MAX_CALLS_PER_RUN > 0);
    const endpoint =
      baseUrl && model
        ? resolveLlmEndpoint({ baseUrl, model }, forcedTransport ? { transport: forcedTransport } : {})
        : null;
    const endpointRisk = baseUrl && model ? describeLlmEndpointRisk(baseUrl, model) : null;
    return {
      gate: 'classifier',
      label: 'İlan sınıflandırma kapısı (LLM_CLASSIFIER_ENABLED)',
      enabled: env.LLM_CLASSIFIER_ENABLED,
      configured,
      model,
      modelSource,
      baseUrl,
      transport: endpoint?.transport ?? null,
      endpoint: endpoint?.url ?? null,
      endpointRisk,
      promptSummary: 'buildClassifierSystemPrompt + buildClassifierUserMessage (JSON şeması + birebir kanıt doğrulaması)',
      generationSettings: { temperature: 0.1, maxTokens: 900, jsonMode: true },
      call: null,
      modelList: null,
      checks: evaluateDoctorChecks(null, null),
    };
  }

  const assistantModel = env.LLM_MODEL.trim() || null;
  const modelSource: GateDiagnosticReport['modelSource'] = assistantModel ? 'LLM_MODEL' : null;
  const configured = Boolean(baseUrl && hasKey && assistantModel);
  const endpoint =
    baseUrl && assistantModel
      ? resolveLlmEndpoint({ baseUrl, model: assistantModel }, forcedTransport ? { transport: forcedTransport } : {})
      : null;
  const endpointRisk = baseUrl && assistantModel ? describeLlmEndpointRisk(baseUrl, assistantModel) : null;
  return {
    gate: 'assistant',
    label: 'Panel öneri asistanı (AI_ASSISTANT_ENABLED)',
    enabled: env.AI_ASSISTANT_ENABLED,
    configured,
    model: assistantModel,
    modelSource,
    baseUrl,
    transport: endpoint?.transport ?? null,
    endpoint: endpoint?.url ?? null,
    endpointRisk,
    promptSummary: 'SYSTEM_PROMPT + buildMessages (aday profili ve uygun ilanların JSON değerlendirmesi)',
    generationSettings: { temperature: 0.2, maxTokens: 1200, jsonMode: false },
    call: null,
    modelList: null,
    checks: evaluateDoctorChecks(null, null),
  };
}

export interface RunDoctorOptions {
  env?: Env;
  offline?: boolean;
  forcedTransport?: LlmTransport;
  fetchImpl?: DoctorHttpFetch;
  maxRetriesPerCall?: number;
  maxApiCalls?: number;
  retryBaseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function runLlmDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? getEnv();
  const offline = options.offline ?? false;
  const forcedTransport = options.forcedTransport;
  const maxApiCalls = Math.max(1, options.maxApiCalls ?? DOCTOR_MAX_API_CALLS);
  const maxRetriesPerCall = Math.min(
    2,
    Math.max(0, options.maxRetriesPerCall ?? Math.min(DOCTOR_MAX_RETRIES_PER_CALL, env.LLM_RETRY_MAX)),
  );
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 600;

  let usedCalls = 0;
  const countingFetch: DoctorHttpFetch = async (url, init) => {
    if (usedCalls >= maxApiCalls) {
      throw new Error(`Tanı aracı çağrı bütçesi doldu (azami ${maxApiCalls} gerçek API çağrısı).`);
    }
    usedCalls += 1;
    if (options.fetchImpl) {
      return options.fetchImpl(url, init);
    }
    return fetch(url, init as RequestInit) as never;
  };
  const llmFetchAdapter: LlmFetch = (url, init) => countingFetch(url, init);

  const classifierGate = buildGateBaseReport('classifier', env, forcedTransport);
  const assistantGate = buildGateBaseReport('assistant', env, forcedTransport);

  const primaryGate =
    classifierGate.enabled && classifierGate.configured
      ? classifierGate
      : assistantGate.enabled && assistantGate.configured
        ? assistantGate
        : classifierGate.configured
          ? classifierGate
          : assistantGate.configured
            ? assistantGate
            : classifierGate;

  const inspection = inspectEnvironment(env);
  const endpointRisk = primaryGate.endpointRisk ?? assistantGate.endpointRisk ?? null;
  const llmWarnings = inspection.warnings.filter(
    (warning) =>
      (warning.includes('LLM_') || warning.includes('AI_ASSISTANT')) &&
      !(endpointRisk !== null && warning.startsWith(endpointRisk)),
  );

  if (
    classifierGate.model &&
    assistantGate.model &&
    classifierGate.model !== assistantGate.model
  ) {
    llmWarnings.push(
      `İki LLM kapısı farklı modeller kullanıyor: sınıflandırıcı="${classifierGate.model}" (LLM_CLASSIFIER_MODEL), ` +
        `panel asistanı="${assistantGate.model}" (LLM_MODEL). Her iki model ayrı ayrı doğrulanmalıdır.`,
    );
  } else if (classifierGate.configured && !assistantGate.configured && env.LLM_CLASSIFIER_MODEL.trim()) {
    llmWarnings.push(
      'LLM_CLASSIFIER_MODEL tanımlı ancak LLM_MODEL boş: ilan sınıflandırıcısı çalışabilir fakat panel öneri asistanı (AI_ASSISTANT_ENABLED) LLM_MODEL olmadan çalışmaz.',
    );
  }

  async function probeSingleModel(
    model: string,
    transport: LlmTransport,
  ): Promise<DoctorCallReport> {
    const config: LlmConfig = {
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model,
      timeoutMs: env.LLM_TIMEOUT_MS,
    };
    const thinkingBudget = probeThinkingBudgetForModel(model, transport);
    const started = Date.now();
    const result = await callChatCompletionWithRetry(
      config,
      [...DOCTOR_PROBE_MESSAGES],
      {
        fetchImpl: llmFetchAdapter,
        maxTokens: DOCTOR_PROBE_MAX_TOKENS,
        temperature: 0,
        transport,
        ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
        maxRetries: Math.min(maxRetriesPerCall, Math.max(0, maxApiCalls - usedCalls - 1)),
        baseDelayMs: retryBaseDelayMs,
        ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
      },
    );
    const elapsedMs = Date.now() - started;
    if (result.ok) {
      const preview = redactSecret(result.content.replace(/\s+/g, ' ').trim(), env.LLM_API_KEY).slice(0, 60);
      const thoughtsNote =
        typeof result.thoughtsTokens === 'number' ? ` / ${result.thoughtsTokens} düşünme` : '';
      return {
        attempted: true,
        ok: true,
        status: result.status,
        elapsedMs,
        attempts: result.attempts,
        detail: `kullanılabilir metin üretildi ("${preview}", ${result.usage.promptTokens ?? '?'} girdi${thoughtsNote} / ${result.usage.completionTokens ?? '?'} çıktı token)`,
        failureCategory: 'ok',
        contentPreview: preview,
        diagnostics: null,
      };
    }
    return {
      attempted: true,
      ok: false,
      status: result.status,
      elapsedMs,
      attempts: result.attempts,
      detail: result.reason,
      failureCategory: result.failureCategory ?? null,
      contentPreview: null,
      diagnostics: result.diagnostics ?? null,
    };
  }

  if (!offline && env.LLM_BASE_URL.trim() && env.LLM_API_KEY) {
    const callCache = new Map<string, DoctorCallReport>();
    const gatesToProbe: GateDiagnosticReport[] = [];
    if (classifierGate.configured) gatesToProbe.push(classifierGate);
    if (assistantGate.configured) gatesToProbe.push(assistantGate);

    for (const gate of gatesToProbe) {
      if (!gate.model || !gate.transport) continue;
      const normalizedKey = `${gate.transport}:${normalizeGeminiModel(gate.model).toLowerCase()}`;
      const existing = callCache.get(normalizedKey);
      if (existing) {
        gate.call = existing;
      } else if (usedCalls < maxApiCalls) {
        const callReport = await probeSingleModel(gate.model, gate.transport);
        callCache.set(normalizedKey, callReport);
        gate.call = callReport;
      }
    }

    // Model listesi denetimi: taşıyıcı başına en fazla 1 kez çağrılır (bütçe elveriyorsa).
    const activeTransport = primaryGate.transport ?? assistantGate.transport;
    const anyModel = primaryGate.model ?? assistantGate.model;
    if (activeTransport && anyModel && usedCalls < maxApiCalls) {
      const rawList = await probeModelList(
        {
          baseUrl: env.LLM_BASE_URL,
          apiKey: env.LLM_API_KEY,
          model: anyModel,
          timeoutMs: env.LLM_TIMEOUT_MS,
        },
        activeTransport,
        { fetchImpl: countingFetch },
      );
      if (classifierGate.model) {
        classifierGate.modelList = buildModelListReportForModel(rawList, classifierGate.model);
      }
      if (assistantGate.model) {
        assistantGate.modelList = buildModelListReportForModel(rawList, assistantGate.model);
      }
    }

    classifierGate.checks = evaluateDoctorChecks(classifierGate.call, classifierGate.modelList);
    assistantGate.checks = evaluateDoctorChecks(assistantGate.call, assistantGate.modelList);
  }

  // Geriye dönük uyumluluk: llmClassifierConfig kontrolü
  const hasAnyConfig = Boolean(llmClassifierConfig(env) ?? (classifierGate.configured || assistantGate.configured));
  const primaryCall = hasAnyConfig ? (primaryGate.call ?? assistantGate.call) : null;
  const primaryModelList = hasAnyConfig ? (primaryGate.modelList ?? assistantGate.modelList) : null;
  const primaryChecks = evaluateDoctorChecks(primaryCall, primaryModelList);

  return {
    classifierEnabled: env.LLM_CLASSIFIER_ENABLED,
    assistantEnabled: env.AI_ASSISTANT_ENABLED,
    model: primaryGate.model,
    baseUrl: primaryGate.baseUrl ?? (env.LLM_BASE_URL.trim() || null),
    transport: primaryGate.transport,
    endpoint: primaryGate.endpoint,
    endpointRisk,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxCallsPerRun: env.LLM_MAX_CALLS_PER_RUN,
    dailyCallLimit: env.LLM_DAILY_CALL_LIMIT,
    costConfigured: Boolean(env.LLM_COST_USD_PER_MTOK_INPUT || env.LLM_COST_USD_PER_MTOK_OUTPUT),
    warnings: llmWarnings,
    call: primaryCall,
    modelList: primaryModelList,
    checks: primaryChecks,
    gates: {
      classifier: classifierGate,
      assistant: assistantGate,
    },
    apiBudget: {
      maxCalls: maxApiCalls,
      usedCalls,
      maxRetriesPerCall,
    },
  };
}

function formatDiagnosticsLines(diagnostics: LlmHttpDiagnostics): string[] {
  const lines: string[] = [];
  lines.push(
    `    HTTP durumu          : ${diagnostics.status ?? '(yok)'}` +
      ` · Content-Type: ${diagnostics.contentType ?? '(belirtilmedi)'}` +
      ` · Gövde: ${diagnostics.bodyLength} bayt (${diagnostics.bodyKind})`,
  );
  if (diagnostics.errorCode !== null || diagnostics.errorStatus !== null) {
    lines.push(
      `    Sağlayıcı hata zarfı : kod=${diagnostics.errorCode ?? '-'} · durum=${diagnostics.errorStatus ?? '-'}`,
    );
  }
  lines.push(`    Güvenli gövde özeti  : ${diagnostics.bodySummary}`);
  if (diagnostics.retryAfter !== null) {
    lines.push(
      `    Retry-After          : "${diagnostics.retryAfter}" (güvenli bekleme karşılığı: ${diagnostics.retryAfterMs ?? '?'} ms)`,
    );
  }
  if (diagnostics.requestId !== null) {
    lines.push(`    İstek/izleme kimliği : ${diagnostics.requestId} (${diagnostics.requestIdHeader})`);
  }
  return lines;
}

function formatGateLines(gate: GateDiagnosticReport): string[] {
  const lines: string[] = [];
  lines.push(`  [${gate.label}]`);
  lines.push(`    Durum                : ${gate.enabled ? 'açık' : 'kapalı'} · yapılandırma: ${gate.configured ? 'hazır' : 'eksik'}`);
  lines.push(`    Model                : ${gate.model ?? '(tanımsız)'}${gate.modelSource ? ` (${gate.modelSource})` : ''}`);
  lines.push(`    Taşıyıcı ve uç       : ${gate.transport ? describeTransport(gate.transport) : '(yok)'} → ${gate.endpoint ?? '(hesaplanamadı)'}`);
  lines.push(`    İstem (prompt)       : ${gate.promptSummary}`);
  lines.push(
    `    Üretim ayarları      : temperature=${gate.generationSettings.temperature}, maxTokens=${gate.generationSettings.maxTokens}, jsonMode=${gate.generationSettings.jsonMode}`,
  );
  if (!gate.configured) {
    lines.push('    Canlı doğrulama      : yapılmadı (bu kapı için model/anahtar/adres eksik)');
    return lines;
  }
  if (!gate.call) {
    lines.push('    Canlı doğrulama      : yapılmadı');
    return lines;
  }
  if (gate.call.ok) {
    lines.push(
      `    Canlı doğrulama      : BAŞARILI (HTTP ${gate.call.status}, ${gate.call.elapsedMs} ms, ${gate.call.attempts} deneme) — ${gate.call.detail}`,
    );
  } else {
    lines.push(
      `    Canlı doğrulama      : BAŞARISIZ${gate.call.status ? ` (HTTP ${gate.call.status})` : ''} [${describeFailureCategory(gate.call.failureCategory)}] — ${gate.call.detail}`,
    );
    if (gate.call.diagnostics) {
      lines.push(...formatDiagnosticsLines(gate.call.diagnostics));
    }
  }
  lines.push('    Kanıt kontrolleri:');
  lines.push(`      1) Model listede bulunuyor mu?                        : ${gate.checks.modelListed}`);
  lines.push(`      2) supportedGenerationMethods içinde generateContent? : ${gate.checks.supportsGenerateContent}`);
  lines.push(`      3) İstek HTTP düzeyinde yanıt alabildi mi?            : ${gate.checks.httpResponseReceived}`);
  lines.push(`      4) Yetkilendirme doğrulandı mı (401/403 yok + üretim)?: ${gate.checks.authorizationCheck}`);
  lines.push(`      5) Gerçek çağrı kullanılabilir metin üretti mi?       : ${gate.checks.usableTextGenerated}`);
  return lines;
}

export function formatDoctorReport(report: DoctorReport, options: { offline?: boolean; forcedTransport?: LlmTransport } = {}): string[] {
  const lines: string[] = [];
  const { offline = false, forcedTransport } = options;

  lines.push('LLM kapısı tanısı (llm:doctor)');
  lines.push(`  Sınıflandırma kapısı : ${report.classifierEnabled ? 'açık' : 'kapalı'} (LLM_CLASSIFIER_ENABLED)`);
  lines.push(`  Panel öneri asistanı : ${report.assistantEnabled ? 'açık' : 'kapalı'} (AI_ASSISTANT_ENABLED)`);
  lines.push(`  Sağlayıcı kökü       : ${report.baseUrl ?? '(tanımsız)'} (LLM_BASE_URL)`);
  lines.push(
    `  Taşıyıcı             : ${report.transport ? describeTransport(report.transport) : '(hesaplanamadı)'}${
      forcedTransport ? ' — bayrakla zorlandı' : ' — kök adrese göre otomatik seçildi'
    }`,
  );
  lines.push(`  Zaman aşımı          : ${report.timeoutMs} ms · koşu başına ${report.maxCallsPerRun} çağrı · günlük ${report.dailyCallLimit} çağrı`);
  lines.push(
    `  Tanı çağrı bütçesi   : ${report.apiBudget.usedCalls}/${report.apiBudget.maxCalls} gerçek API çağrısı kullanıldı (çağrı başına en fazla ${report.apiBudget.maxRetriesPerCall} yeniden deneme, tanı çıktı sınırı ${DOCTOR_PROBE_MAX_TOKENS} token)`,
  );
  lines.push(`  Maliyet ayarı        : ${report.costConfigured ? 'tanımlı' : 'BOŞ (panelde maliyet "raporlanmadı" görünür)'}`);

  if (report.endpointRisk) lines.push(`\n  ⚠ ${report.endpointRisk}`);
  for (const warning of report.warnings) lines.push(`  ⚠ ${warning}`);

  lines.push('\n  Kapı bazlı doğrulama (bir kapının başarısı diğerini kanıtlamaz):');
  lines.push(...formatGateLines(report.gates.classifier));
  lines.push('');
  lines.push(...formatGateLines(report.gates.assistant));

  if (report.modelList) {
    const activeTransport: LlmTransport = report.transport ?? 'openai-compat';
    lines.push(
      `\n  Model listesi denetimi (${activeTransport === 'gemini-native' ? 'ListModels' : 'GET /models'}): ` +
        (report.modelList.ok
          ? `HTTP ${report.modelList.status} — ${report.modelList.detail}`
          : `BAŞARISIZ${report.modelList.status ? ` (HTTP ${report.modelList.status})` : ''} — ${report.modelList.detail}`),
    );
    if (report.modelList.ok && report.model) {
      lines.push(
        `  Model "${normalizeGeminiModel(report.model)}" listede: ${report.modelList.configuredModelListed ? 'VAR' : 'YOK'}` +
          (report.modelList.supportedGenerationMethods
            ? ` · yöntemler: [${report.modelList.supportedGenerationMethods.join(', ')}]`
            : ''),
      );
      lines.push(
        '  Not: Modelin listede görünmesi veya generateContent desteklemesi tek başına üretim yetkisi ya da sağlıklı metin üretimi kanıtı değildir.',
      );
    } else if (report.modelList.diagnostics) {
      lines.push(...formatDiagnosticsLines(report.modelList.diagnostics));
    }
  }

  const anyConfigured = report.gates.classifier.configured || report.gates.assistant.configured;
  if (!anyConfigured) {
    lines.push('\n✖ Kapı yapılandırılmamış: LLM_BASE_URL + LLM_API_KEY + model (LLM_MODEL ya da LLM_CLASSIFIER_MODEL) gerekli.');
    lines.push('  Adım adım doldurmak için: npm run env:setup');
  } else if (offline) {
    lines.push('\n• --offline: canlı çağrı yapılmadı (yalnızca yapılandırma denetlendi).');
    lines.push(
      report.endpointRisk
        ? '✖ Uç nokta/model uyuşmazlığı giderilmeden canlı çağrı başarısız olur.'
        : '✓ Yapılandırma tutarlı görünüyor; canlı deneme için --offline bayrağını kaldırın.',
    );
  } else if (report.call?.ok) {
    lines.push(
      `\n✓ Canlı üretim doğrulandı: HTTP ${report.call.status}, ${report.call.elapsedMs} ms — ${report.call.detail}`,
    );
  } else {
    const activeTransport: LlmTransport = report.transport ?? 'openai-compat';
    lines.push(
      `\n✖ Canlı üretim doğrulanamadı${report.call?.status ? ` (HTTP ${report.call.status})` : ''}: ${
        report.call?.detail ?? 'çağrı yapılmadı'
      }`,
    );
    lines.push(
      `  Karşılaştırmak için diğer taşıyıcıyı deneyin: npm run llm:doctor -- ${
        activeTransport === 'gemini-native' ? '--compat' : '--native'
      }`,
    );
  }

  return lines;
}

export function isDirectDoctorExecution(entry = process.argv[1]): boolean {
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, '/');
  return /(?:^|\/)llm-doctor\.(?:[cm]?[jt]s|tsx?)$/i.test(normalized);
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP);
    return;
  }
  const offline = hasFlag('--offline');
  const asJson = hasFlag('--json');
  const forcedTransport: LlmTransport | undefined = hasFlag('--compat')
    ? 'openai-compat'
    : hasFlag('--native')
      ? 'gemini-native'
      : undefined;

  const env = getEnv();
  const report = await runLlmDoctor({ env, offline, forcedTransport });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`  API anahtarı         : ${describeSecret(env.LLM_API_KEY)}`);
    for (const line of formatDoctorReport(report, { offline, forcedTransport })) {
      console.log(line);
    }
  }

  const anyConfigured = report.gates.classifier.configured || report.gates.assistant.configured;
  if (!anyConfigured) {
    process.exitCode = 1;
  } else if (offline) {
    if (report.endpointRisk) process.exitCode = 1;
  } else {
    // Etkin olan kapıların tamamı kullanılabilir metin üretmiş olmalıdır; hiçbir kapı etkin
    // değilse yapılandırılmış kapının canlı çağrısı başarılı olmalıdır.
    const enabledConfiguredGates = [report.gates.classifier, report.gates.assistant].filter(
      (gate) => gate.enabled && gate.configured,
    );
    const targetGates =
      enabledConfiguredGates.length > 0
        ? enabledConfiguredGates
        : [report.gates.classifier, report.gates.assistant].filter((gate) => gate.configured);
    const allSucceeded = targetGates.length > 0 && targetGates.every((gate) => gate.call?.ok === true);
    if (!allSucceeded) {
      process.exitCode = 1;
    }
  }
}

if (isDirectDoctorExecution()) {
  main().catch((error) => {
    console.error(`✖ llm:doctor çalışamadı: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
