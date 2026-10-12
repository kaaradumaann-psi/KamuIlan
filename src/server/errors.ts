/**
 * Standart API hata biçimi.
 *
 * Tüm hatalar aynı gövdeyi döner:
 *   { "error": { "code": "...", "message": "...", "details": [...], "requestId": "..." } }
 *
 * Böylece istemciler (arayüz, E2E testleri, entegrasyonlar) tek bir kuralla
 * hata ayıklayabilir. İç hata ayrıntıları (stack) istemciye gönderilmez.
 */
import { ZodError } from 'zod';

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'service_unavailable'
  | 'internal_error';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details ?? null;
  }

  static badRequest(message = 'İstek geçersiz.', details?: unknown): ApiError {
    return new ApiError('bad_request', message, 400, details);
  }

  static validation(message = 'Gönderilen alanlar geçersiz.', details?: unknown): ApiError {
    return new ApiError('validation_error', message, 400, details);
  }

  static unauthorized(message = 'Bu işlem için oturum açmanız gerekiyor.'): ApiError {
    return new ApiError('unauthorized', message, 401);
  }

  static forbidden(message = 'Bu işlem için yetkiniz yok.'): ApiError {
    return new ApiError('forbidden', message, 403);
  }

  static notFound(message = 'Kayıt bulunamadı.'): ApiError {
    return new ApiError('not_found', message, 404);
  }

  static conflict(message = 'Kayıt zaten var.'): ApiError {
    return new ApiError('conflict', message, 409);
  }

  static rateLimited(message = 'Çok fazla istek gönderdiniz; bir süre sonra tekrar deneyin.', details?: unknown): ApiError {
    return new ApiError('rate_limited', message, 429, details);
  }

  static unavailable(message = 'Servis geçici olarak kullanılamıyor.'): ApiError {
    return new ApiError('service_unavailable', message, 503);
  }

  static internal(message = 'Beklenmeyen bir hata oluştu.'): ApiError {
    return new ApiError('internal_error', message, 500);
  }
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details: unknown;
    requestId?: string;
  };
}

export function toErrorBody(error: unknown, requestId?: string): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      body: { error: { code: error.code, message: error.message, details: error.details, ...(requestId ? { requestId } : {}) } },
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'validation_error',
          message: 'Gönderilen alanlar geçersiz.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  // Bilinen doğrulama hatalarını 400 olarak raporla.
  if (/geçersiz|zorunlu|eksik|bulunamadı/i.test(message) && !/veritabanı|bağlantı/i.test(message)) {
    return {
      statusCode: 400,
      body: { error: { code: 'bad_request', message, details: null, ...(requestId ? { requestId } : {}) } },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'Beklenmeyen bir hata oluştu. Sorun sürerse destek ile iletişime geçin.',
        details: null,
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}
