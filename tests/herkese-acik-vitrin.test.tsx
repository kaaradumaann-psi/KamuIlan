// @vitest-environment jsdom
/**
 * Herkese açık ilan vitrini (PUBLIC_LISTINGS_ENABLED) — arayüz kapısı.
 *
 * Bayrak açıkken oturumsuz ziyaretçi ilan listesini ve ilan sayfalarını görür;
 * panel, kayıtlı ilanlar ve yönetim YİNE giriş ister. Bayrak kapalıyken eski
 * davranış (her yol girişe düşer) `tests/app-gate.test.tsx` ile korunur.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ publicListings: true, requested: [] as string[] }));

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      state.requested.push(url);
      if (url.includes('/api/auth/session')) {
        return {
          authenticated: false,
          user: null,
          csrfToken: null,
          access: { publicListings: state.publicListings },
        };
      }
      if (url === '/api/jobs') return { items: [], total: 0, page: 1, pageSize: 20 };
      throw Object.assign(new Error('Oturum yok'), { statusCode: 401, code: 'unauthorized' });
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { default: App } = await import('../src/App');
const { SessionProvider } = await import('../src/lib/session');

afterEach(() => {
  cleanup();
  state.requested.length = 0;
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('herkese açık vitrin açıkken', () => {
  it('oturumsuz ziyaretçi ilan listesini görür; kabuk ve "Giriş yap" düğmesi gelir', async () => {
    state.publicListings = true;
    renderAt('/ilanlar');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kamu personel alım ilanları' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Giriş yap/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Giriş yap' })).toBeNull();
    expect(state.requested).toContain('/api/jobs');
  });

  it.each(['/panel', '/panel/kaydedilenler', '/panel/gecmis', '/yonetim'])(
    '%s yine giriş ister (kişisel/yönetim verisi açılmaz)',
    async (path) => {
      state.publicListings = true;
      renderAt(path);
      expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeTruthy();
    },
  );
});

describe('herkese açık vitrin kapalıyken (varsayılan)', () => {
  it('ilan listesi oturumsuz açılmaz, giriş ekranı gelir', async () => {
    state.publicListings = false;
    renderAt('/ilanlar');
    expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Kamu personel alım ilanları' })).toBeNull();
  });
});
