// @vitest-environment jsdom
/**
 * Giriş kapısı regresyonu: oturumsuz kullanıcı uygulama kabuğunu hiç
 * görmemeli; her uygulama yolu giriş ekranına düşmelidir (psikolog modeli).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ loggedIn: false, sessionError: false }));

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/api/auth/session')) {
        if (authState.sessionError) throw new Error('Sunucu 12 saniye içinde yanıt vermedi.');
        // Gerçek ağ gecikmesi: oturum cevabı anında gelmez. Bu gecikme
        // olmadan jsdom yarışı gizler (önbellek çoktan güncellenir).
        if (authState.loggedIn) await new Promise((resolve) => setTimeout(resolve, 50));
        return authState.loggedIn
          ? {
              user: {
                id: 'usr_test',
                email: 'aday@ornek.test',
                displayName: 'Test Aday',
                role: 'admin',
                status: 'active',
                emailVerified: true,
              },
            }
          : { user: null };
      }
      throw Object.assign(new Error('Oturum yok'), { statusCode: 401, code: 'unauthorized' });
    }),
    post: vi.fn(async (url: string) => {
      if (url.includes('/api/auth/login')) {
        authState.loggedIn = true;
        return { needsEmailVerification: false };
      }
      return {};
    }),
    patch: vi.fn(async () => ({})),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { default: App } = await import('../src/App');
const { SessionProvider } = await import('../src/lib/session');

afterEach(() => cleanup());

describe('Giriş kapısı', () => {
  it('oturumsuz kullanıcıda kabuk açılmaz, giriş ekranı gelir', async () => {
    authState.loggedIn = false;
    authState.sessionError = false;
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

  it('oturum API hatasında spinnerda veya yanlış giriş yönlendirmesinde kalmaz', async () => {
    authState.loggedIn = false;
    authState.sessionError = true;
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

    expect(await screen.findByRole('heading', { name: 'Oturum doğrulanamadı' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Sunucu 12 saniye içinde yanıt vermedi.');
    expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Giriş yap' })).toBeNull();
  });
});

describe('giriş sonrası geçiş', () => {
  it('giriş başarılı olunca kullanıcı giriş ekranında takılmaz, uygulamaya geçer', async () => {
    authState.loggedIn = false;
    authState.sessionError = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/giris']}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/E-posta/), { target: { value: 'aday@ornek.test' } });
    fireEvent.change(screen.getByLabelText(/Parola/), { target: { value: 'parola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));

    // Kapı eski oturum bilgisiyle geri atarsa bu başlık hiç gelmez (regresyon).
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Kamu personel alım ilanları' },
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Giriş yap' })).toBeNull());
  });
});
