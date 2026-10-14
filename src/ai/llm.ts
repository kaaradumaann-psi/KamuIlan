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

export type LlmResult = { ok: true; content: string } | { ok: false; reason: string };

const MAX_RESPONSE_CHARS = 64_000;

export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

export async function callChatCompletion(
  config: LlmConfig,
  messages: { role: string; content: string }[],
  options: { fetchImpl?: LlmFetch } = {},
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
        temperature: 0.2,
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });
    const raw = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: `Sağlayıcı HTTP ${response.status} döndü.` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'Sağlayıcı yanıtı JSON değil.' };
    }
    const content = (parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
      ?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { ok: false, reason: 'Sağlayıcı yanıtında içerik yok.' };
    }
    return { ok: true, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = controller.signal.aborted
      ? 'Zaman aşımı.'
      : redactSecret(message, config.apiKey).slice(0, 200);
    return { ok: false, reason: `Sağlayıcıya ulaşılamadı: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}
