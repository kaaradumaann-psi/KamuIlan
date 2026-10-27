// @vitest-environment jsdom
/**
 * İlan listesi hazır görünümleri — arayüz.
 *
 * "Arşiv" süresi dolan + iptal edilen ilanları, "Yakında başlayacak" henüz
 * başvurusu açılmamış ilanları getirmelidir; etkin görünüm `aria-pressed` ile
 * işaretlenir. Durum yalnızca bu düğmelerden seçilir; URL'deki tekil durumlar
 * (ör. iptal edildi) kaldırılabilir etiket olarak görünür.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as { url: string; params: Record<string, unknown> | undefined }[]);

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string, params?: Record<string, unknown>) => {
      calls.push({ url, params });
      if (url === '/api/jobs') return { items: [], total: 0, page: 1, pageSize: 20 };
      return {};
    }),
    post: vi.fn(async () => ({})),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { JobsPage } = await import('../src/pages/Jobs');

afterEach(() => {
  cleanup();
  calls.length = 0;
});

function renderJobs(path = '/ilanlar') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <JobsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function lastJobsStatus(): unknown {
  return [...calls].reverse().find((call) => call.url === '/api/jobs')?.params?.status;
}

describe('hazır görünümler', () => {
  it('Arşiv düğmesi kapanan + iptal edilen ilanları ister ve etkin görünür', async () => {
    renderJobs();
    fireEvent.click(await screen.findByRole('button', { name: 'Süresi geçmiş (arşiv)' }));
    await waitFor(() => expect(lastJobsStatus()).toBe('closed,cancelled'));
    expect(screen.getByRole('button', { name: 'Süresi geçmiş (arşiv)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Güncel' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('Tümü düğmesi arşiv dahil tüm ilanları ister', async () => {
    renderJobs();
    fireEvent.click(await screen.findByRole('button', { name: 'Tümü' }));
    await waitFor(() => expect(lastJobsStatus()).toBe('all'));
  });

  it('Yakında başlayacak düğmesi başvurusu henüz açılmamış ilanları ister', async () => {
    renderJobs();
    fireEvent.click(await screen.findByRole('button', { name: 'Yakında başlayacak' }));
    await waitFor(() => expect(lastJobsStatus()).toBe('upcoming'));
  });

  it('filtresiz liste "Güncel" görünümünü etkin işaretler', async () => {
    renderJobs();
    expect((await screen.findByRole('button', { name: 'Güncel' })).getAttribute('aria-pressed')).toBe('true');
  });

  it('URL’deki tekil durum (iptal edildi) etiket olarak görünür ve kaldırılabilir', async () => {
    renderJobs('/ilanlar?status=cancelled');
    await waitFor(() => expect(lastJobsStatus()).toBe('cancelled'));
    expect(screen.queryByLabelText('Durum', { selector: 'select' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Durum: İptal edildi filtresini kaldır' }));
    await waitFor(() => expect(lastJobsStatus()).toBeUndefined());
    expect(screen.getByRole('button', { name: 'Güncel' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('durum düğmesi arama ve il seçimini korur; Güncel yalnızca durumu kaldırır', async () => {
    renderJobs('/ilanlar?q=hemşire&city=Ankara');
    fireEvent.click(await screen.findByRole('button', { name: 'Başvurusu açık' }));
    await waitFor(() => expect(lastJobsStatus()).toBe('active'));
    const last = () => [...calls].reverse().find((call) => call.url === '/api/jobs')?.params;
    expect(last()?.q).toBe('hemşire');
    expect(last()?.city).toBe('Ankara');
    fireEvent.click(screen.getByRole('button', { name: 'Güncel' }));
    await waitFor(() => expect(lastJobsStatus()).toBeUndefined());
    expect(last()?.q).toBe('hemşire');
  });

  it('sıralama sonuç satırından doğrudan uygulanır', async () => {
    renderJobs();
    fireEvent.change(await screen.findByLabelText('Sıralama'), { target: { value: 'deadline' } });
    await waitFor(() =>
      expect([...calls].reverse().find((call) => call.url === '/api/jobs')?.params?.sort).toBe('deadline'),
    );
  });
});
