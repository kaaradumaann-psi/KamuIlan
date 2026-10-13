/**
 * API istemcisinin hata mesajı sözleşmesi.
 *
 * Neden bu test: `errorMessage` bir dönem HER 401'i "Bu işlem için oturum
 * açmanız gerekiyor." diye çeviriyordu. Giriş ekranında yanlış parola da 401
 * döndüğü için kullanıcı gerçek nedeni göremiyordu: parolası yanlış olan kişiye
 * "oturum açmanız gerekiyor" deniyordu. Artık sunucunun mesajı korunur.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ApiTimeoutError, apiRequest, errorMessage } from '../src/lib/api';

function apiError(status: number, code: string, message: string): ApiError {
  return new ApiError(status, { code, message });
}

describe('errorMessage', () => {
  it('401 kimlik hatasında sunucunun mesajını gösterir (giriş/parola sıfırlama)', () => {
    expect(errorMessage(apiError(401, 'unauthorized', 'E-posta veya parola hatalı.'))).toBe(
      'E-posta veya parola hatalı.',
    );
    expect(errorMessage(apiError(401, 'unauthorized', 'Parola doğrulanamadı.'))).toBe('Parola doğrulanamadı.');
  });

  it('mesajsız 401 için genel oturum metnine düşer', () => {
    expect(errorMessage(apiError(401, 'unauthorized', ''))).toBe('Bu işlem için oturum açmanız gerekiyor.');
  });

  it('403/429 ve 5xx mesajlarını korur', () => {
    expect(errorMessage(apiError(403, 'forbidden', 'Bu işlem yalnızca yöneticiler içindir.'))).toBe(
      'Bu işlem yalnızca yöneticiler içindir.',
    );
    expect(errorMessage(apiError(429, 'rate_limited', 'Çok fazla istek gönderdiniz.'))).toBe(
      'Çok fazla istek gönderdiniz. Lütfen biraz bekleyin.',
    );
    expect(errorMessage(apiError(500, 'internal_error', 'Beklenmeyen bir hata oluştu.'))).toBe(
      'Beklenmeyen bir hata oluştu.',
    );
  });

  it('ağ hatasını Türkçe ve eyleme dönük anlatır (API kapalı olabilir)', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toContain('Sunucuya ulaşılamadı');
    expect(errorMessage(new Error('NetworkError when attempting to fetch resource.'))).toContain(
      'Sunucuya ulaşılamadı',
    );
  });

  it('bilinmeyen değerlerde genel mesaj döner', () => {
    expect(errorMessage('bir şeyler ters gitti')).toBe('Beklenmeyen bir hata oluştu.');
  });

  it('zaman aşımı için kullanıcıya yeniden deneme öneren Türkçe mesaj verir', () => {
    expect(errorMessage(new ApiTimeoutError(12_000))).toMatch(/12 saniye içinde yanıt vermedi/);
  });
});

describe('API isteği zaman aşımı', () => {
  it('yanıtsız isteği iptal eder ve sonsuz bekleme yerine zaman aşımı hatası verir', async () => {
    const stalledFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('AbortSignal aktarılmadı'));
          return;
        }
        signal.addEventListener('abort', () => reject(new DOMException('İstek iptal edildi.', 'AbortError')), {
          once: true,
        });
      }),
    );

    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalledFetch);
    try {
      const request = apiRequest('/api/yanitsiz', { timeoutMs: 50 });
      const rejected = expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
      await vi.advanceTimersByTimeAsync(50);
      await rejected;

      expect(stalledFetch).toHaveBeenCalledOnce();
      expect(stalledFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
