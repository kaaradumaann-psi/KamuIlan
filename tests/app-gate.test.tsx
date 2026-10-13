// @vitest-environment jsdom
/**
 * Giriş kapısı regresyonu: oturumsuz kullanıcı uygulama kabuğunu hiç
 * görmemeli; her uygulama yolu giriş ekranına düşmelidir (psikolog modeli).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async () => {
      throw Object.assign(new Error('Oturum yok'), { statusCode: 401, code: 'unauthorized' });
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { default: App } = await import('../src/App');
const { SessionProvider } = await import('../src/lib/session');

describe('Giriş kapısı', () => {
  it('oturumsuz kullanıcıda kabuk açılmaz, giriş ekranı gelir', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ilanlar']}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeTruthy();
    // Kabuk gezinmesi (kenar çubuğu) oturumsuz render edilmemeli.
    expect(screen.queryByText('Kaydettiklerim')).toBeNull();
    expect(screen.queryByText('Bildirim kur')).toBeNull();
  });
});
