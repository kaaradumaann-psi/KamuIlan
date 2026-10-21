// @vitest-environment jsdom
/**
 * İlan listesi hazır görünümleri — arayüz.
 *
 * "Arşiv" süresi dolan + iptal edilen ilanları, "Yakında başlayacak" henüz
 * başvurusu açılmamış ilanları getirmelidir; etkin görünüm `aria-pressed` ile
 * işaretlenir. Durum filtresinde "İptal edildi" seçeneği bulunmalıdır.
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
    fireEvent.click(await screen.findByRole('button', { name: 'Arşiv' }));
    await waitFor(() => expect(lastJobsStatus()).toBe('closed,cancelled'));
    expect(screen.getByRole('button', { name: 'Arşiv' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Tümü' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('Yakında başlayacak düğmesi başvurusu henüz açılmamış ilanları ister', async () => {
    renderJobs();
    fireEvent.click(await screen.findByRole('button', { name: 'Yakında başlayacak' }));
    await waitFor(() => expect(lastJobsStatus()).toBe('upcoming'));
  });

  it('filtresiz liste "Tümü" görünümünü etkin işaretler', async () => {
    renderJobs();
    expect((await screen.findByRole('button', { name: 'Tümü' })).getAttribute('aria-pressed')).toBe('true');
  });

  it('durum filtresinde İptal edildi ve Arşiv seçenekleri vardır', async () => {
    renderJobs('/ilanlar?status=cancelled');
    fireEvent.click(await screen.findByRole('button', { name: /Filtreler/ }));
    const select = (await screen.findByLabelText('Durum')) as HTMLSelectElement;
    const labels = [...select.options].map((option) => option.textContent);
    expect(labels).toContain('İptal edildi');
    expect(labels).toContain('Arşiv (kapanan + iptal)');
    expect(select.value).toBe('cancelled');
    await waitFor(() => expect(lastJobsStatus()).toBe('cancelled'));
  });
});
