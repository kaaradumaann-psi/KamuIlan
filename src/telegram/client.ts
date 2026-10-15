/**
 * Telegram Bot API istemcisi (HTTPS JSON çağrıları, enjekte edilebilir fetch).
 *
 * Güvenlik:
 *  - Token yalnızca istek URL'sinde kullanılır; hata metinlerinden (ağ istisnaları
 *    dahil) token ayıklanarak loglanır/saklanır.
 *  - Yanıt gövdesi bütçesi sınırlıdır; beklenmeyen biçim "beklenmeyen yanıt" olur.
 *
 * Hata sınıflandırması (`classifyTelegramFailure`):
 *  - blocked   : kullanıcı botu engelledi / sohbet yok → bağlantı durdurulur, kayıt ölü mektup.
 *  - retry     : ağ hatası, 429 (retry_after), 5xx, 401/404 (yapılandırma; sınırlı denemeyle).
 *  - permanent : istek biçimi hatası (400) → yeniden denemek anlamsız.
 */

export type TelegramFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type TelegramCallResult<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      kind: 'network' | 'api' | 'malformed';
      errorCode: number | null;
      description: string;
      retryAfterSec: number | null;
    };

export type TelegramFailure = Extract<TelegramCallResult<unknown>, { ok: false }>;

export interface TelegramButton {
  text: string;
  url: string;
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  buttons?: TelegramButton[];
}

const MAX_RESPONSE_CHARS = 64_000;

export class TelegramBotClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: TelegramFetch;
  private readonly timeoutMs: number;

  constructor(options: {
    token: string;
    apiBaseUrl?: string;
    fetchImpl?: TelegramFetch;
    timeoutMs?: number;
  }) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Hata metinlerinde token görünmez. */
  redact(text: string): string {
    return this.token ? text.split(this.token).join('***') : text;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status = 0;
    let raw = '';
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      status = response.status;
      raw = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        kind: 'network',
        errorCode: null,
        description: this.redact(message).slice(0, 300),
        retryAfterSec: null,
      };
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (body && typeof body === 'object' && 'ok' in body) {
      const envelope = body as {
        ok: boolean;
        result?: unknown;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (envelope.ok === true) return { ok: true, result: envelope.result as T };
      return {
        ok: false,
        kind: 'api',
        errorCode: typeof envelope.error_code === 'number' ? envelope.error_code : status || null,
        description: this.redact(envelope.description ?? `HTTP ${status}`).slice(0, 300),
        retryAfterSec:
          typeof envelope.parameters?.retry_after === 'number'
            ? Math.max(1, envelope.parameters.retry_after)
            : null,
      };
    }
    return {
      ok: false,
      kind: 'malformed',
      errorCode: status || null,
      description: `Beklenmeyen Telegram yanıtı (HTTP ${status}).`,
      retryAfterSec: null,
    };
  }

  async sendMessage(input: SendMessageInput): Promise<TelegramCallResult<{ message_id: number }>> {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: 'HTML',
      // Bot API 7.0+: disable_web_page_preview yerine link_preview_options (önizleme kapalı).
      link_preview_options: { is_disabled: true },
      ...(input.buttons && input.buttons.length > 0
        ? {
            reply_markup: {
              inline_keyboard: [input.buttons.map((button) => ({ text: button.text, url: button.url }))],
            },
          }
        : {}),
    });
  }

  async getMe(): Promise<TelegramCallResult<{ id: number; username?: string; is_bot: boolean }>> {
    return this.call('getMe');
  }

  async setWebhook(input: {
    url: string;
    secretToken: string;
    allowedUpdates: string[];
    dropPendingUpdates?: boolean;
  }): Promise<TelegramCallResult<boolean>> {
    return this.call<boolean>('setWebhook', {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: input.allowedUpdates,
      drop_pending_updates: input.dropPendingUpdates ?? false,
      max_connections: 20,
    });
  }

  async deleteWebhook(): Promise<TelegramCallResult<boolean>> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  async getWebhookInfo(): Promise<
    TelegramCallResult<{
      url: string;
      pending_update_count: number;
      last_error_message?: string;
      allowed_updates?: string[];
    }>
  > {
    return this.call('getWebhookInfo');
  }
}

export function classifyTelegramFailure(failure: TelegramFailure): 'blocked' | 'retry' | 'permanent' {
  if (failure.kind === 'network' || failure.kind === 'malformed') return 'retry';
  const code = failure.errorCode ?? 0;
  if (code === 429 || code >= 500) return 'retry';
  if (code === 401 || code === 404 || code === 409) return 'retry';
  if (code === 403) return 'blocked';
  if (
    code === 400 &&
    /chat not found|user not found|PEER_ID_INVALID|chat_id is empty/i.test(failure.description)
  ) {
    return 'blocked';
  }
  return 'permanent';
}

const defaultFetch: TelegramFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<TelegramFetch>;
