// @vitest-environment jsdom
/**
 * Arayüz kabuğu testleri (jsdom).
 *
 * Bu testler tarayıcı gerektirmez ama arayüzün çalışma zamanı sözleşmesini
 * doğrular: kabuk giriş yapmış kullanıcıda çizilebiliyor mu, site giriş
 * kapılıyken oturumsuz kullanıcı giriş ekranına düşüyor mu ve **dışarıdan
 * kayıt bağlantısı hiçbir yerde yok mu**.
 *
 * Ağ erişimi yoktur: `src/lib/api` modülü sahte yanıtlarla değiştirilir.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const { api } = await import('../src/lib/api');

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
  vi.clearAllMocks();
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
  responses.set('/api/jobs', {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    pages: 1,
    sort: 'newest',
    generatedAt: new Date().toISOString(),
  });
  responses.set('/api/jobs/deadlines/upcoming', {
    items: [],
    days: 14,
    generatedAt: new Date().toISOString(),
  });
  responses.set('/api/sources', {
    sources: [],
    planned: [],
    summary: { total: 9, enabled: 8, verified: 3, built: 5, failing: 0, stale: 8, planned: 18 },
    disclaimer: 'Kapsam eksiktir.',
    generatedAt: new Date().toISOString(),
  });
  responses.set('/api/health/worker', {
    checkedAt: new Date().toISOString(),
    workers: { total: 0, running: 0, starting: 0, stale: 0 },
  });
  responses.set('/api/health', {
    status: 'degraded',
    app: 'Kamuİlan',
    version: '2026.10.1',
    environment: 'test',
    checkedAt: new Date().toISOString(),
    database: { driver: 'file', healthy: true, latencyMs: 1, detail: null },
    versions: { classification: '2026.10.1', extraction: '2026.10.1', dedupe: '2026.10.1' },
    scans: {
      lastSuccessAt: null,
      lastFailureAt: null,
      minutesSinceSuccess: null,
      totalRuns: 0,
      failedRuns: 0,
    },
    workers: { total: 0, running: 0, stale: 0, items: [] },
    queue: { backend: 'database', pending: 0, active: 0, dead: 0 },
    sources: { total: 9, enabled: 8, verified: 3, built: 5, failing: 0, stale: 8, planned: 18 },
    warnings: [],
  });
});

afterEach(() => {
  cleanup();
});

/** Oturum açmış test kullanıcısı (site giriş kapılıdır). */
function loginAsTestUser(): void {
  responses.set('/api/auth/session', {
    authenticated: true,
    user: {
      id: 'usr_test',
      email: 'aday@ornek.test',
      displayName: 'Test Aday',
      role: 'user',
      status: 'active',
      emailVerified: true,
      emailVerifiedAt: '2026-10-13T09:00:00+03:00',
      createdAt: '2026-10-13T09:00:00+03:00',
      lastLoginAt: '2026-10-13T09:00:00+03:00',
    },
    csrfToken: 'test-csrf',
  });
}

describe('arayüz kabuğu', () => {
  it('ana sayfayı giriş yapmış kullanıcıda kabuk içinde çizer; teknik ayrıntı ve tekrar eden uyarı yok', async () => {
    loginAsTestUser();
    renderApp('/');

    expect((await screen.findAllByText('Kamuİlan')).length).toBeGreaterThan(0);
    expect(
      await screen.findByRole('heading', { level: 1, name: /Kamu personel alım ilanları/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Arama terimi')).toBeTruthy();
    // Güncellik kartı sade dille yazılır: son güncelleme + takip edilen kaynak sayısı.
    expect(await screen.findByText('Henüz güncelleme yok')).toBeTruthy();
    expect(screen.getByText(/resmî kaynak takip ediliyor/)).toBeTruthy();
    // Kapsam feragati kabukta (yan menü/alt bilgi) tekrar edilmez; tarama süreci terimleri görünmez.
    expect(screen.queryByText(/Her ilanı bulamayabiliriz/)).toBeNull();
    expect(screen.queryByText(/worker/i)).toBeNull();
    // Normal durumda üst durum bandı hiç çizilmez.
    expect(document.querySelector('.cloud-sync-banner')).toBeNull();
    const healthRequests = vi.mocked(api.get).mock.calls.filter(([path]) => path === '/api/health');
    expect(healthRequests).toHaveLength(1);
  });

  it('durum bandı yalnızca liste bir günden eskiyse kısa ve teknik olmayan bir uyarı gösterir', async () => {
    loginAsTestUser();
    const health = responses.get('/api/health') as { scans: Record<string, unknown> };
    responses.set('/api/health', {
      ...health,
      scans: {
        ...health.scans,
        lastSuccessAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        minutesSinceSuccess: 2 * 24 * 60,
      },
    });
    renderApp('/');

    expect(await screen.findByText(/yeni ilanlar gecikebilir/)).toBeTruthy();
    expect(screen.getByText('Güncelleme gecikti')).toBeTruthy();
    expect(screen.queryByText(/worker/i)).toBeNull();
  });

  it('ilan listesi filtre formunu gösterir', async () => {
    loginAsTestUser();
    renderApp('/ilanlar');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kamu personel alım ilanları' }),
    ).toBeTruthy();
    expect(await screen.findByRole('form', { name: 'İlan filtreleri' })).toBeTruthy();
    expect(screen.getByLabelText('İl')).toBeTruthy();
    expect(screen.getByLabelText('Ne arıyorsunuz?')).toBeTruthy();
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

  it('kaynaklar sayfası sade liste gösterir; kapalı kaynağı hata gibi sunmaz', async () => {
    loginAsTestUser();
    const health = {
      lastRunAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      totalRuns: 0,
      successRuns: 0,
      failureRuns: 0,
      avgDurationMs: null,
      lastError: null,
      itemsFound: 0,
      emptyStreak: 0,
    };
    const base = {
      group: 'kurum',
      statusNote: 'Test',
      verified: true,
      built: true,
      lastVerifiedAt: '2026-10-14',
      verificationEvidence: 'Fixture',
      coverageNote: 'Kapsam testi',
      intervalMinutes: 60,
      lastRun: null,
    };
    responses.set('/api/sources', {
      sources: [
        {
          ...base,
          key: 'taranan',
          name: 'Taranan Kaynak (JSON API)',
          institution: 'Test kurumu',
          status: 'verified',
          enabled: true,
          termsGated: false,
          health: { ...health, lastSuccessAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
        },
        {
          ...base,
          key: 'sartli',
          name: 'Şart Onayı Bekleyen Kaynak',
          institution: 'Başka kurum',
          status: 'verified',
          enabled: true,
          termsGated: true,
          health: { ...health, consecutiveFailures: 3 },
        },
        {
          ...base,
          key: 'elle',
          name: 'Elle Takip Kaynağı',
          institution: 'Üçüncü kurum',
          status: 'needs-manual-method',
          enabled: true,
          health,
        },
      ],
      planned: [],
      summary: { total: 3, enabled: 3, verified: 3, built: 0, failing: 1, stale: 2, planned: 0 },
      disclaimer: 'Kapsam eksiktir.',
      generatedAt: new Date().toISOString(),
    });
    renderApp('/kaynaklar');

    expect(await screen.findByRole('heading', { level: 1, name: 'İlanları nereden alıyoruz?' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Kaynak listesi' });
    const rows = within(list).getAllByRole('listitem');
    // Sıra: taranan → elle takip → şimdilik kapalı.
    expect(rows.map((row) => row.querySelector('.source-item-name')?.textContent)).toEqual([
      'Taranan Kaynak',
      'Elle Takip Kaynağı',
      'Şart Onayı Bekleyen Kaynak',
    ]);
    expect(within(rows[0]!).getByText('Taranıyor')).toBeTruthy();
    expect(within(rows[0]!).getByText(/Son güncelleme:/)).toBeTruthy();
    expect(within(rows[1]!).getByText('Elle takip')).toBeTruthy();
    expect(within(rows[2]!).getByText('Şimdilik kapalı')).toBeTruthy();
    // Kullanım şartı kapısı ve geçmiş hata sayacı kullanıcıya hata olarak yansımaz.
    expect(screen.queryByText(/ulaşılamadı|sorunlu|hata/i)).toBeNull();
    // Teknik ayrıntı ve tekrar eden feragat kutusu yok.
    expect(screen.queryByText(/ortalama süre|Sayfa kapsamı|denemenin|uyarlayıcı|adaptör|worker/i)).toBeNull();
    expect(screen.queryByText('Durumlar ne demek?')).toBeNull();
    expect(screen.queryByText(/Kapsam eksiktir/)).toBeNull();
  });
});
