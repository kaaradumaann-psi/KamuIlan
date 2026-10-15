/**
 * OpenAI uyumlu sohbet tamamlama istemcisi (ağ çağrısı; enjekte edilebilir fetch).
 *
 * Güvenlik:
 *  - API anahtarı yalnızca Authorization başlığında gider; hata metinlerinden ayıklanır.
 *  - Zaman aşımı zorunludur; yanıt boyutu sınırlıdır.
 *  - Ham istem ve yanıt loglanmaz.
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

export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

export interface ChatCompletionOptions {
  fetchImpl?: LlmFetch;
  /** Varsayılan 0.2 (mevcut panel önerileri davranışı korunur). */
  temperature?: number;
  /** Varsayılan 1200 (mevcut panel önerileri davranışı korunur). */
  maxTokens?: number;
  /** OpenAI uyumlu `response_format: { type: 'json_object' }` isteği (sağlayıcı desteklemiyorsa yok sayılır). */
  jsonMode?: boolean;
}

/**
 * OpenAI uyumlu sohbet ucunu kurar.
 *
 * Neden gerekli: istemci `${LLM_BASE_URL}/chat/completions` çağırır. Kullanıcı
 * kök adres olarak sağlayıcının YEREL (OpenAI uyumlu olmayan) ucunu yazdığında
 * istek 404 döner ve inceleme kuyruğundaki her kayıt "LLM doğrulaması
 * yapılamadı (sağlayıcı hatası)" ile insana kalır — 2026-10-16 panelinde
 * görülen durum buydu (2 çağrı, 2 hata, %100 hata oranı, 0 token).
 *
 * Kurallar:
 *  - Zaten tam uç verilmişse (`…/chat/completions`) aynen kullanılır.
 *  - Google AI (`generativelanguage.googleapis.com`) yerel kökü OpenAI uyumlu
 *    `…/v1beta/openai` yoluna çevrilir.
 *  - Diğer sağlayıcılarda köke `/chat/completions` eklenir
 *    (OpenAI, OpenRouter, Groq, Together, Ollama, Azure uyumlu ağ geçitleri).
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
  if (url.hostname.endsWith('generativelanguage.googleapis.com')) {
    const withoutOpenAi = path.endsWith('/openai') ? path.slice(0, -'/openai'.length) : path;
    const versionMatch = withoutOpenAi.match(/^(\/v\d+[A-Za-z]*)/);
    const basePath = versionMatch ? versionMatch[1] : withoutOpenAi || '/v1beta';
    url.pathname = `${basePath}/openai`;
    url.search = '';
    return `${url.toString().replace(/\/+$/, '')}/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
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
  const googleHost = host.endsWith('generativelanguage.googleapis.com');
  const openAiHost = host.endsWith('api.openai.com');
  const geminiModel = /^(gemini|models\/gemini)/.test(name);
  const openAiModel = /^(gpt-|o1|o3|o4|chatgpt|text-davinci)/.test(name);
  if (openAiHost && geminiModel) {
    return (
      `LLM_BASE_URL OpenAI ucunu gösteriyor (${host}) ama model bir Gemini modeli ("${model}"): ` +
      'sağlayıcı 404/400 döndürür. Gemini için https://generativelanguage.googleapis.com/v1beta ' +
      '(ya da OpenRouter gibi OpenAI uyumlu bir ağ geçidi) kullanın.'
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
function statusHint(status: number, endpoint: string, model: string): string {
  if (status === 404) {
    return (
      ' Uç nokta ya da model adı yanlış olabilir: istek ' +
      `${endpoint} adresine "${model}" modeliyle gönderildi. LLM_BASE_URL OpenAI uyumlu KÖK olmalı ` +
      '(ör. https://api.openai.com/v1, https://generativelanguage.googleapis.com/v1beta, ' +
      'https://openrouter.ai/api/v1); Gemini için yerel kök otomatik olarak /openai ucuna çevrilir.'
    );
  }
  if (status === 401 || status === 403) return ' API anahtarı geçersiz, süresi dolmuş ya da bu model için yetkisiz.';
  if (status === 400) return ' İstek gövdesi sağlayıcıyla uyumsuz olabilir (model adı, max_tokens ya da response_format desteği).';
  if (status === 429) return ' Sağlayıcı hız/kota sınırı uyguluyor; günlük sınır (LLM_DAILY_CALL_LIMIT) düşürülebilir.';
  if (status === 413) return ' İstem çok büyük; LLM_MAX_INPUT_CHARS değerini düşürün.';
  return '';
}

export async function callChatCompletion(
  config: LlmConfig,
  messages: { role: string; content: string }[],
  options: ChatCompletionOptions = {},
): Promise<LlmResult> {
  const fetchImpl: LlmFetch = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as never);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const endpoint = chatCompletionsEndpoint(config.baseUrl);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 1200,
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
    const raw = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    if (response.status < 200 || response.status >= 300) {
      // 429 (hız sınırı) ve 5xx geçici hatalardır; sınırlı yeniden deneme yapılır.
      // 401/403/400 yapılandırma hatasıdır; yeniden deneme anahtarı tüketmez.
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        // Gerekçe panelde ve tarama kaydında görünür: hangi uca hangi modelle
        // gidildiği yazılır (API anahtarı asla yazılmaz), böylece "sağlayıcı
        // hatası" tek başına bir çıkmaz olmaktan çıkar.
        reason: `Sağlayıcı HTTP ${response.status} döndü.${statusHint(response.status, endpoint, config.model)}`,
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
