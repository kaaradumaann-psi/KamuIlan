/**
 * Cloudflare vekili → API istemci IP'si (hız sınırı doğruluğu + başlık sahtelemesi).
 *
 * Bulgu (21.10.2026): `functions/api/[[path]].ts` istemci başlıklarını olduğu gibi
 * aktarıyordu.
 *  1. `x-forwarded-for` istemciden geldiği gibi geçiyordu. API `TRUST_PROXY=1`
 *     ile çalıştığında istemci kendi IP'sini uydurabilir, hız sınırını atlatabilir
 *     ve denetim kaydını zehirleyebilirdi.
 *  2. Vekil `x-forwarded-for` YAZMIYORDU. Bu durumda API bütün istekleri vekilin
 *     tek IP'sinden görür: `RATE_LIMIT_MAX_REQUESTS` tüm kullanıcılar için tek
 *     kova olur, tek bir istemci herkesi kilitler.
 */
import { describe, expect, it } from 'vitest';
import { buildForwardHeaders } from '../functions/api/[[path]]';

function forwarded(headers: Record<string, string>): Headers {
  return buildForwardHeaders(new Request('https://kamuilan.test/api/jobs', { headers }));
}

describe('vekil başlık aktarımı', () => {
  it('istemcinin gönderdiği x-forwarded-for / x-real-ip / forwarded başlıklarını atar', () => {
    const headers = forwarded({
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '5.6.7.8',
      forwarded: 'for=9.9.9.9',
    });
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
  });

  it('güvenilir cf-connecting-ip değerini x-forwarded-for olarak yazar', () => {
    const headers = forwarded({ 'cf-connecting-ip': '88.245.10.20' });
    expect(headers.get('x-forwarded-for')).toBe('88.245.10.20');
    // Cloudflare'e özgü başlık API'ye taşınmaz.
    expect(headers.get('cf-connecting-ip')).toBeNull();
  });

  it('istemci sahtelemesi güvenilir değeri ezemez', () => {
    const headers = forwarded({
      'x-forwarded-for': '6.6.6.6',
      'cf-connecting-ip': '88.245.10.20',
    });
    expect(headers.get('x-forwarded-for')).toBe('88.245.10.20');
  });

  it('cf-connecting-ip yoksa x-forwarded-for yazmaz (API soket IP’sine düşer)', () => {
    expect(forwarded({ 'user-agent': 'test' }).get('x-forwarded-for')).toBeNull();
  });

  it('normal başlıklar korunur (çerez, CSRF, içerik türü)', () => {
    const headers = forwarded({
      cookie: 'kamuilan_session=abc',
      'x-csrf-token': 'token-123',
      'content-type': 'application/json',
    });
    expect(headers.get('cookie')).toBe('kamuilan_session=abc');
    expect(headers.get('x-csrf-token')).toBe('token-123');
    expect(headers.get('content-type')).toBe('application/json');
  });
});
