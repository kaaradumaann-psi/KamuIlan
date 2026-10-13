// @vitest-environment jsdom
/**
 * Yönetim paneli geri bildirim testleri (jsdom).
 *
 * Kural: arayüzde hiçbir eylem sessizce başarısız olmaz. Bu dosya iki gerçek
 * gerilemeyi kilitler:
 *  1. İnceleme kuyruğunda karar isteği başarısız olursa kullanıcı nedeni görür
 *     ("Karar kaydedilemedi: …"). Bu blok eksikken buton hiçbir şey yapmıyor
 *     gibi görünüyordu.
 *  2. `ErrorNotice` buton etiketi özelleştirilebilir (kapatma amacıyla).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const responses = new Map<string, unknown>();
/** `post` çağrıları bu hata ile reddedilir (boşsa `{ message: 'ok' }` döner). */
let postError: Error | null = null;

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (responses.has(path)) return responses.get(path);
      throw new Error(`Beklenmeyen istek: ${path}`);
    }),
    post: vi.fn(async () => {
      if (postError) throw postError;
      return { message: 'ok' };
    }),
    put: vi.fn(async () => ({ message: 'ok' })),
    patch: vi.fn(async () => ({ message: 'ok' })),
    del: vi.fn(async () => ({ message: 'ok' })),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'bilinmeyen hata'),
}));

const { default: App } = await import('../src/App');
const { SessionProvider } = await import('../src/lib/session');
const { ErrorNotice } = await import('../src/components/ui');

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
  postError = null;
  responses.clear();
  responses.set('/api/auth/session', {
    authenticated: true,
    user: {
      id: 'usr_admin',
      email: 'admin@kamuilan.test',
      displayName: 'Yönetici',
      role: 'admin',
      status: 'active',
      emailVerified: true,
      emailVerifiedAt: '2026-10-13T09:00:00+03:00',
      createdAt: '2026-10-13T09:00:00+03:00',
      lastLoginAt: '2026-10-13T09:00:00+03:00',
    },
    csrfToken: 'test-csrf',
  });
  responses.set('/api/health', {
    status: 'ok',
    app: 'Kamuİlan',
    version: '2026.10.1',
    environment: 'test',
    checkedAt: new Date().toISOString(),
    database: { driver: 'file', healthy: true, latencyMs: 1, detail: null },
    versions: { classification: '2026.10.1', extraction: '2026.10.1', dedupe: '2026.10.1' },
    scans: { lastSuccessAt: null, lastFailureAt: null, minutesSinceSuccess: null, totalRuns: 0, failedRuns: 0 },
    workers: { total: 0, running: 0, stale: 0, items: [] },
    queue: { backend: 'database', pending: 0, active: 0, dead: 0 },
    sources: { total: 1, enabled: 1, verified: 1, built: 0, failing: 0, stale: 0, planned: 0 },
    warnings: [],
  });
  responses.set('/api/admin/overview', {
    jobs: { total: 3, active: 1, addedToday: 0 },
    reviewQueue: { total: 1 },
    runs: { total: 2, failed: 0, avgDurationMs: 12 },
    auditEntries: 4,
    workerWarning: null,
    workers: [
      {
        workerId: 'kamuilan-1',
        role: 'worker',
        stale: false,
        lastHeartbeatAt: new Date().toISOString(),
        processedJobs: 1,
      },
    ],
    queue: { backend: 'database', counts: { pending: 0, active: 0 }, dead: 0 },
    outbox: { pending: 0, sending: 0, accepted: 0, failed: 0, dead: 0 },
    coverage: { summary: { enabled: 1, verified: 1, failing: 0, planned: 0 } },
  });
  responses.set('/api/admin/review-queue', {
    items: [
      {
        id: 'rev_1',
        kind: 'classification',
        sourceKey: 'osym',
        title: 'Örnek ilan',
        url: 'https://example.test/ilan/1',
        reason: 'İlgili olabilir',
        confidence: 0.8,
        payload: {},
        candidateJobIds: [],
        status: 'open',
        createdAt: '2026-10-13T09:00:00+03:00',
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      },
    ],
    counts: { total: 1, classification: 1, dedupe: 0, extraction: 0 },
    candidateTitles: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('yönetim paneli geri bildirimi', () => {
  it('inceleme kararı başarısız olursa nedeni görünür olur', async () => {
    renderApp('/yonetim');
    expect(await screen.findByRole('heading', { level: 1, name: 'Yönetim paneli' })).toBeTruthy();

    fireEvent.click(await screen.findByRole('tab', { name: 'İncelenecek ilanlar' }));
    expect(await screen.findByText('Örnek ilan')).toBeTruthy();

    postError = new Error('Sunucuya ulaşılamadı');
    fireEvent.click(screen.getByRole('button', { name: 'İlanı kabul et' }));

    // Hata sessiz kalmaz: neden + kapatma düğmesi görünür.
    expect(await screen.findByText(/Karar kaydedilemedi: Sunucuya ulaşılamadı/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kapat' })).toBeTruthy();
  });

  it('ErrorNotice yeniden deneme etiketi özelleştirilebilir', () => {
    render(<ErrorNotice message="Bir hata oldu" onRetry={() => {}} retryLabel="Kapat" />);
    expect(screen.getByRole('button', { name: 'Kapat' })).toBeTruthy();
    cleanup();
    render(<ErrorNotice message="Bir hata oldu" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeTruthy();
  });

  it('mutasyon başarılı olduğunda başarı mesajı gösterilir', async () => {
    renderApp('/yonetim');
    await screen.findByRole('heading', { level: 1, name: 'Yönetim paneli' });
    fireEvent.click(await screen.findByRole('tab', { name: 'İncelenecek ilanlar' }));
    await screen.findByText('Örnek ilan');

    fireEvent.click(screen.getByRole('button', { name: 'İlanı kabul et' }));
    await waitFor(() => expect(screen.getByText(/^ok$/)).toBeTruthy());
    expect(screen.queryByText(/Karar kaydedilemedi/)).toBeNull();
  });
});
