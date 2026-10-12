/**
 * API istemcisi (tarayıcı tarafı).
 *
 * Kurallar:
 *  - Tüm istekler GÖRELİ `/api/...` yoluna gider (localhost'a doğrudan istek yok;
 *    geliştirmede Vite proxy'si, üretimde aynı origin kullanılır).
 *  - Çerez tabanlı oturum + CSRF: değiştiren isteklerde `x-csrf-token` başlığı
 *    çerezden okunur.
 *  - Hata gövdesi tek biçimde çözülür ve kullanıcıya Türkçe mesaj gösterilir.
 */

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorShape) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? null;
    if (body.requestId) this.requestId = body.requestId;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function csrfToken(): string | null {
  return readCookie('kamuilan_csrf');
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Sorgu parametreleri; boş/undefined değerler atlanır. */
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
}

export function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== '') params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : '';
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  const response = await fetch(`${path}${buildQuery(options.query)}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? safeJson(text) : null;

  if (!response.ok) {
    const body =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? ((parsed as { error: ApiErrorShape }).error ?? { code: 'unknown', message: 'Beklenmeyen hata.' })
        : { code: 'unknown', message: `İstek başarısız (HTTP ${response.status}).` };
    throw new ApiError(response.status, body);
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal): Promise<T> =>
    apiRequest<T>(path, { query, ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown): Promise<T> => apiRequest<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown): Promise<T> => apiRequest<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown): Promise<T> => apiRequest<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T>(path: string, body?: unknown): Promise<T> => apiRequest<T>(path, { method: 'DELETE', body: body ?? {} }),
};

/** Kullanıcıya gösterilecek hata metni (teknik ayrıntı sızdırmaz). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Bu işlem için oturum açmanız gerekiyor.';
    if (error.status === 403) return error.message || 'Bu işlem için yetkiniz yok.';
    if (error.status === 429) return 'Çok fazla istek gönderdiniz. Lütfen biraz bekleyin.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Beklenmeyen bir hata oluştu.';
}
