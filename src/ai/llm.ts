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

export async function callChatCompletion(
  config: LlmConfig,
  messages: { role: string; content: string }[],
  options: ChatCompletionOptions = {},
): Promise<LlmResult> {
  const fetchImpl: LlmFetch = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as never);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
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
        reason: `Sağlayıcı HTTP ${response.status} döndü.`,
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
