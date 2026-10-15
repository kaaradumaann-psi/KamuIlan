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
export type LlmFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

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

export type LlmResult =
  | { ok: true; content: string; usage: LlmUsage; status: number }
  | { ok: false; reason: string; status: number | null; retryable: boolean; timedOut?: boolean };

const MAX_RESPONSE_CHARS = 64_000;
const MAX_PROVIDER_MESSAGE_CHARS = 240;

export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
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
  options: { temperature?: number; maxTokens?: number; jsonMode?: boolean } = {},
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

  return {
    ...(systemTexts.length > 0 ? { systemInstruction: { parts: systemTexts.map((text) => ({ text })) } } : {}),
    contents,
    generationConfig,
  };
}

/**
 * Gemini yanıtını `LlmResult` biçimine çevirir.
 *
 * - Metin: `candidates[0].content.parts[].text` birleştirilir (çok parçalı
 *   yanıtlar ve düşünce modellerinde parça parça metin dönebilir).
 * - Token: `usageMetadata.promptTokenCount` / `candidatesTokenCount`.
 * - `promptFeedback.blockReason` ve `finishReason` (SAFETY, RECITATION,
 *   MAX_TOKENS, PROHIBITED_CONTENT) içerik üretilemediğini söyler; sessizce
 *   boş içerik döndürmek yerine gerekçesiyle raporlanır.
 */
export function parseGeminiResponse(payload: unknown): {
  content: string | null;
  usage: LlmUsage;
  failure: string | null;
} {
  const toCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

  const envelope = payload as {
    candidates?: {
      content?: { parts?: { text?: unknown }[] };
      finishReason?: unknown;
      finishMessage?: unknown;
    }[];
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
    promptFeedback?: { blockReason?: unknown; safetyRatings?: unknown };
    modelVersion?: unknown;
  };

  const usage: LlmUsage = {
    promptTokens: toCount(envelope?.usageMetadata?.promptTokenCount),
    completionTokens: toCount(envelope?.usageMetadata?.candidatesTokenCount ?? envelope?.usageMetadata?.totalTokenCount),
  };

  const blockReason = envelope?.promptFeedback?.blockReason;
  if (typeof blockReason === 'string' && blockReason.trim().length > 0) {
    return { content: null, usage, failure: `Sağlayıcı istemi engelledi (blockReason: ${blockReason.trim()}).` };
  }

  const candidate = envelope?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  if (text.length === 0) {
    const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason.trim() : '';
    const finishMessage = typeof candidate?.finishMessage === 'string' ? candidate.finishMessage.trim() : '';
    const detail = [finishReason && `finishReason: ${finishReason}`, finishMessage].filter(Boolean).join(' — ');
    return {
      content: null,
      usage,
      failure: `Sağlayıcı yanıtında içerik yok${detail ? ` (${detail})` : ''}.`,
    };
  }

  return { content: text, usage, failure: null };
}

/** Sağlayıcının hata gövdesinden okunabilir mesajı çıkarır (anahtar ayıklanır, kısaltılır). */
export function providerErrorMessage(raw: string, apiKey: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown; status?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return redactSecret(message.replace(/\s+/g, ' ').trim(), apiKey).slice(0, MAX_PROVIDER_MESSAGE_CHARS);
    }
  } catch {
    /* gövde JSON değil: mesaj üretilmez */
  }
  return null;
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

/** HTTP durum koduna göre operatörün deneyebileceği ilk adım (sır içermez). */
function statusHint(status: number, endpoint: LlmEndpoint): string {
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
  if (status === 429) return ' Sağlayıcı hız/kota sınırı uyguluyor; günlük sınır (LLM_DAILY_CALL_LIMIT) düşürülebilir.';
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
  const jsonMode = options.jsonMode === true;

  if (jsonMode && !endpoint.supportsJsonMode) {
    // Sessizce biçimsiz yanıt beklemek yerine açık hata: kayıt incelemede kalır
    // ve panelde neden görünür.
    return {
      ok: false,
      reason: `Taşıyıcı JSON modunu desteklemiyor (${describeTransport(endpoint.transport)}).`,
      status: null,
      retryable: false,
    };
  }

  const native = endpoint.transport === 'gemini-native';
  if (native && endpoint.model.length === 0) {
    return {
      ok: false,
      reason: 'Model adı boş: LLM_MODEL ya da LLM_CLASSIFIER_MODEL tanımlı olmalı (ör. gemini-2.5-flash).',
      status: null,
      retryable: false,
    };
  }
  const geminiBody = native
    ? buildGeminiRequestBody(messages, {
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens ?? 1200,
        jsonMode,
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
    });
    const raw = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    if (response.status < 200 || response.status >= 300) {
      // 429 (hız sınırı) ve 5xx geçici hatalardır; sınırlı yeniden deneme yapılır.
      // 401/403/400/404 yapılandırma hatasıdır; yeniden deneme kotası tüketmez.
      const retryable = response.status === 429 || response.status >= 500;
      // Sağlayıcının KENDİ mesajı da gerekçeye eklenir: 404'ün "model adı mı,
      // uç nokta mı, anahtar mı" olduğunu ayırt eden tek bilgi budur.
      const providerMessage = providerErrorMessage(raw, config.apiKey);
      return {
        ok: false,
        reason:
          `Sağlayıcı HTTP ${response.status} döndü [${describeTransport(endpoint.transport)}].` +
          (providerMessage ? ` Sağlayıcı mesajı: ${providerMessage}.` : '') +
          statusHint(response.status, endpoint),
        status: response.status,
        retryable,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'Sağlayıcı yanıtı JSON değil.', status: response.status, retryable: false };
    }

    if (native) {
      const gemini = parseGeminiResponse(parsed);
      if (!gemini.content) {
        return {
          ok: false,
          reason: gemini.failure ?? 'Sağlayıcı yanıtında içerik yok.',
          status: response.status,
          retryable: false,
        };
      }
      return { ok: true, content: gemini.content, status: response.status, usage: gemini.usage };
    }

    const envelope = parsed as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, reason: 'Sağlayıcı yanıtında içerik yok.', status: response.status, retryable: false };
    }
    const toCount = (value: unknown): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {
      ok: true,
      content,
      status: response.status,
      usage: {
        promptTokens: toCount(envelope?.usage?.prompt_tokens),
        completionTokens: toCount(envelope?.usage?.completion_tokens),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = controller.signal.aborted
      ? 'Zaman aşımı.'
      : redactSecret(message, config.apiKey).slice(0, 200);
    // Zaman aşımı ve ağ hatası geçicidir: sınırlı yeniden denenebilir.
    return {
      ok: false,
      reason: `Sağlayıcıya ulaşılamadı: ${reason}`,
      status: null,
      retryable: true,
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}
