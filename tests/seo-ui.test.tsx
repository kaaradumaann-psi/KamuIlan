// @vitest-environment jsdom
/** SEO — sayfa başlığı ve açıklaması istemci tarafında güncellenir. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) =>
      url === '/api/jobs' ? { items: [], total: 0, page: 1, pageSize: 20 } : { items: [] },
    ),
    post: vi.fn(async () => ({})),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { JobsPage } = await import('../src/pages/Jobs');

afterEach(() => cleanup());

describe('sayfa metaverisi', () => {
  it('ilan listesi başlığı ve açıklaması ayarlanır', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ilanlar']}>
          <JobsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.title).toBe('Kamu personel alım ilanları | Kamuİlan'));
    const description = document.head.querySelector('meta[name="description"]')?.getAttribute('content');
    expect(description).toMatch(/resmî kaynaklardan/i);
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      document.title,
    );
  });
});
