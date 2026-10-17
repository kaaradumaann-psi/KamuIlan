import { expect, test } from '@playwright/test';

test.describe('API güvenlik sınırları', () => {
  test('health yanıtında güvenlik başlıkları vardır', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
    const headers = response.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    expect(headers['access-control-allow-origin']).not.toBe('*');
  });

  test('oturumsuz yönetici ve test-e-posta istekleri reddedilir; bildirim kuyruğuna girilmez', async ({ request }) => {
    const admin = await request.get('/api/admin/users');
    expect(admin.status()).toBe(401);

    // Kimlik doğrulaması yok: endpoint enqueue/delivery koduna ulaşmamalıdır.
    const email = await request.post('/api/notifications/test-email', { data: {} });
    expect(email.status()).toBe(401);
  });
});
