// @vitest-environment jsdom
/**
 * Arayüz kabuğu testleri (jsdom).
 *
 * Bu testler tarayıcı gerektirmez ama arayüzün çalışma zamanı sözleşmesini
 * doğrular: kabuk çizilebiliyor mu, kamuya açık sayfalar oturumsuz açılıyor mu,
 * oturum gerektiren sayfa giriş kartı gösteriyor mu ve **dışarıdan kayıt
 * bağlantısı hiçbir yerde yok mu**.
 *
 * Ağ erişimi yoktur: `src/lib/api` modülü sahte yanıtlarla değiştirilir.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const responses = new Map<string, unknown>();

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (responses.has(path)) return responses.get(path);
      throw new Error(`Beklenmeyen istek: ${path}`);
    }),
    post: vi.fn(async () => ({ message: 'ok' })),
    put: vi.fn(async () => ({ message: 'ok' })),
    patch: vi.fn(async () => ({ message: 'ok' })),
    del: vi.fn(async () => ({ message: 'ok' })),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'bilinmeyen hata'),
}));

const { default: App } = await import('../src/App');
const { SessionProvider } = await import('../src/lib/session');

function renderApp(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <SessionProvider>{children}</SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(<App />, { wrapper: Wrapper });
}

beforeEach(() => {
  responses.clear();
  responses.set('/api/auth/session', { authenticated: false, user: null, csrfToken: null });
  responses.set('/api/jobs/stats', {
    total: 0,
    active: 0,
    upcoming: 0,
    closed: 0,
    closingSoon: 0,
    addedToday: 0,
    byEmploymentType: [],
    lastSuccessfulScanAt: null,
  });
  responses.set('/api/jobs', { items: [], total: 0, page: 1, pageSize: 20, pages: 1, sort: 'newest', generatedAt: new Date().toISOString() });
  responses.set('/api/jobs/deadlines/upcoming', { items: [], days: 14, generatedAt: new Date().toISOString() });
  responses.set('/api/sources', {
    sources: [],
    planned: [],
    summary: { total: 9, enabled: 8, verified: 3, built: 5, failing: 0, stale: 8, planned: 18 },
    disclaimer: 'Kapsam eksiktir.',
    generatedAt: new Date().toISOString(),
  });
  responses.set('/api/health', {
    status: 'degraded',
    app: 'Kamuİlan',
    version: '2026.10.1',
    environment: 'test',
    checkedAt: new Date().toISOString(),
    database: { driver: 'file', healthy: true, latencyMs: 1, detail: null },
    versions: { classification: '2026.10.1', extraction: '2026.10.1', dedupe: '2026.10.1' },
    scans: { lastSuccessAt: null, lastFailureAt: null, minutesSinceSuccess: null, totalRuns: 0, failedRuns: 0 },
    workers: { total: 0, running: 0, stale: 0, items: [] },
    queue: { backend: 'database', pending: 0, active: 0, dead: 0 },
    sources: { total: 9, enabled: 8, verified: 3, built: 5, failing: 0, stale: 8, planned: 18 },
    warnings: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('arayüz kabuğu', () => {
  it('kamuya açık ana sayfayı kabuk içinde çizer', async () => {
    renderApp('/');

    expect(screen.getAllByText('Kamuİlan').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { level: 1, name: /Kamu personel alım ilanları/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Arama terimi')).toBeTruthy();
    // Dürüstlük notu kabukta ve ana sayfada görünür.
    expect(screen.getAllByText(/Kapsam eksiktir/).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/Sistem kısmen sorunlu|Sistem normal/)).toBeTruthy());
  });

  it('ilan listesi filtre formunu ve paylaşılabilir adres notunu gösterir', async () => {
    renderApp('/ilanlar');

    expect(screen.getByRole('heading', { level: 1, name: 'Kamu personel alım ilanları' })).toBeTruthy();
    expect(await screen.findByRole('form', { name: 'İlan filtreleri' })).toBeTruthy();
    expect(screen.getByLabelText('İl')).toBeTruthy();
    expect(screen.getByText(/adres çubuğuna yazılır/)).toBeTruthy();
  });

  it('oturumsuz panelde giriş kartı gösterir ve kayıt bağlantısı sunmaz', async () => {
    renderApp('/panel');

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
    expect(await screen.findByText('Halka açık kayıt yoktur')).toBeTruthy();
    expect(screen.getByText(/Hesabınız yönetici tarafından açılır/)).toBeTruthy();
    // Dışarıdan kayıt kapalıdır: hiçbir yerde kayıt bağlantısı olmamalı.
    expect(screen.queryByText(/Kayıt ol/i)).toBeNull();
    expect(document.querySelector('a[href="/kayit"]')).toBeNull();
  });

  it('bilgi sayfaları kendi kabuğuyla açılır', async () => {
    renderApp('/sss');
    expect(screen.getByRole('heading', { level: 1, name: 'Sıkça sorulan sorular' })).toBeTruthy();
    expect(screen.getByText(/Halka açık kayıt yoktur/)).toBeTruthy();
  });

  it('kaynaklar sayfası kapsam özetini dürüst etiketlerle yazar', async () => {
    renderApp('/kaynaklar');

    expect(await screen.findByRole('heading', { level: 1, name: 'Kaynaklar ve kapsam' })).toBeTruthy();
    expect(await screen.findByText('Canlı doğrulanmış')).toBeTruthy();
    expect(screen.getByText('Adaptörü yazılmış')).toBeTruthy();
    expect(screen.getAllByText(/Kapsam eksiktir/).length).toBeGreaterThan(0);
  });
});
