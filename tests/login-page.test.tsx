// @vitest-environment jsdom
/**
 * Giriş ekranı yerleşimi ve tanılaması (regresyon).
 *
 * Neden bu test: giriş kartı bir dönem doğrudan `.auth-page` içine konmuştu;
 * `.auth-shell` olmadan dikey ortalama çalışmaz ve kart ekranın sol üst
 * köşesine yapışır (kullanıcı bildirimi: "Giriş ekranı ortalanmış değil").
 * Ayrıca hesap yanlış veritabanına eklenmişse kullanıcı nedenini göremiyordu;
 * kurulum uyarısı bunu açıkça yazar.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const session = vi.hoisted(() => ({
  response: {} as Record<string, unknown>,
}));

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async () => session.response),
    post: vi.fn(async () => ({ message: 'ok' })),
    put: vi.fn(async () => ({ message: 'ok' })),
    patch: vi.fn(async () => ({ message: 'ok' })),
    del: vi.fn(async () => ({ message: 'ok' })),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'bilinmeyen hata'),
}));

const { LoginPage } = await import('../src/pages/auth');
const { SessionProvider } = await import('../src/lib/session');

function renderLogin(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/giris']}>
          <SessionProvider>{children}</SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(<LoginPage />, { wrapper: Wrapper });
}

afterEach(() => cleanup());

describe('giriş ekranı yerleşimi', () => {
  it('kart ortalamayı sağlayan auth-shell + auth-layout içinde durur', async () => {
    session.response = { authenticated: false, user: null, csrfToken: null };
    renderLogin();
    await screen.findByRole('heading', { name: 'Giriş yap' });

    const page = document.querySelector('.auth-page');
    expect(page).toBeTruthy();
    // Ortalamanın tek sahibi: .auth-shell (flex + align-items/justify-content: center).
    const shell = page?.querySelector(':scope > .auth-shell');
    expect(shell).toBeTruthy();
    const layout = shell?.querySelector(':scope > .auth-layout');
    expect(layout).toBeTruthy();
    // Kart ve tanıtım paneli ızgaranın doğrudan çocuklarıdır.
    expect(layout?.querySelector(':scope > .auth-intro')).toBeTruthy();
    expect(layout?.querySelector(':scope > .auth-card')).toBeTruthy();
    // Kart, .auth-page'in doğrudan çocuğu OLMAMALI (eski hata).
    expect(page?.querySelector(':scope > .auth-card')).toBeNull();
  });
});

describe('kurulum tanılaması', () => {
  it('veritabanında hiç hesap yoksa hangi depoya bakıldığını ve komutu yazar', async () => {
    session.response = {
      authenticated: false,
      user: null,
      csrfToken: null,
      setup: { required: true, driver: 'file', label: 'yerel dosya deposu (geliştirme)' },
    };
    renderLogin();

    expect(await screen.findByText('Bu veritabanında henüz hesap yok')).toBeTruthy();
    expect(screen.getByText('yerel dosya deposu (geliştirme)')).toBeTruthy();
    expect(screen.getByText(/npm run seed:admin/)).toBeTruthy();
    expect(screen.getByText(/npm run user:create/)).toBeTruthy();
  });

  it('hesap varsa kurulum uyarısı gösterilmez', async () => {
    session.response = {
      authenticated: false,
      user: null,
      csrfToken: null,
      setup: { required: false, driver: 'postgres', label: 'Supabase (PostgreSQL)' },
    };
    renderLogin();

    await screen.findByRole('heading', { name: 'Giriş yap' });
    expect(screen.queryByText('Bu veritabanında henüz hesap yok')).toBeNull();
  });
});
