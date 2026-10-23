/** @vitest-environment jsdom */
/**
 * İlan sayfası filtre bağlantısı — regresyon testi.
 *
 * Bulunan hata: eğitim, bölüm ve KPSS filtreleri formda gösteriliyor ve
 * URL'ye yazılıyordu, ancak sayfanın API isteğine EKLENMİYORDU; kullanıcı
 * filtre seçtiğini sanıyor, liste hiç değişmiyordu. Bu test, URL'deki her
 * gelişmiş filtrenin isteğe gerçekten gittiğini sabitler.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsPage } from '../src/pages/Jobs';

const getMock = vi.hoisted(() =>
  vi.fn(async () => ({
    items: [],
    total: 0,
    page: 1,
    pages: 1,
    generatedAt: '2026-10-12T09:00:00.000Z',
  })),
);

vi.mock('../src/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  errorMessage: (error: unknown) => String(error),
}));


/** Sayfa başlığındaki filtre paneli düğmesi (aria-controls ile kesin seçim). */
function panelToggle(): HTMLElement {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => candidate.getAttribute('aria-controls') === 'filtre-paneli');
  if (!button) throw new Error('Filtre paneli düğmesi bulunamadı');
  return button;
}

afterEach(() => cleanup());

describe('ilan sayfası filtre bağlantısı', () => {
  it('URL’deki eğitim, bölüm ve KPSS filtrelerini API isteğine gönderir', async () => {
    getMock.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            '/ilanlar?education=lisans&department=hemsirelik&kpssType=P3&kpssScore=72&city=ankara&employmentType=sozlesmeli',
          ]}
        >
          <JobsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    const [, params] = getMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params.education).toBe('lisans');
    expect(params.department).toBe('hemsirelik');
    expect(params.kpssType).toBe('P3');
    expect(params.kpssMaxScore).toBe(72);
    expect(params.city).toBe('ankara');
    expect(params.employmentType).toBe('sozlesmeli');
  });

  it('gelişmiş filtre URL’den geliyorsa bölüm açık başlar, gelmiyorsa kapalı', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const first = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ilanlar?education=lisans']}>
          <JobsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Panel filtresi URL'den geliyorsa panel açık başlar.
    expect(await screen.findByLabelText('Eğitim düzeyi')).toBeTruthy();
    first.unmount();

    const second = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ilanlar?city=ankara']}>
          <JobsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // İl arama satırındadır (her zaman görünür); panel kapalı başlar.
    expect(await screen.findByLabelText('İl')).toBeTruthy();
    expect(screen.queryByLabelText('Eğitim düzeyi')).toBeNull();
    panelToggle().click();
    expect(await screen.findByLabelText('Eğitim düzeyi')).toBeTruthy();
    second.unmount();
  });
});

describe('eğitim düzeyi filtresi', () => {
  it('yalnızca kanonik düzeyler sunulur (takma ad yok)', async () => {
    getMock.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ilanlar']}>
          <JobsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Filtre paneli varsayılan kapalıdır; düğmeye basıp aç.
    panelToggle().click();
    const select = (await waitFor(() => {
      const found = document.getElementById('filter-education');
      expect(found).toBeTruthy();
      return found as HTMLSelectElement;
    })) as HTMLSelectElement;
    const values = [...select.options].map((option) => option.value);
    // Kanonik ortaöğretim sunulur; 'lise' (hiçbir kayıtla eşleşmeyen takma ad)
    // ve sunucunun reddettiği 'belirtilmemis' sunulmaz.
    expect(values).toContain('ortaogretim');
    expect(values).toContain('lisans');
    expect(values).not.toContain('lise');
    expect(values).not.toContain('belirtilmemis');
    // Etiket Türkçe ve anlaşılır kalır.
    const orta = [...select.options].find((option) => option.value === 'ortaogretim');
    expect(orta?.textContent).toContain('Ortaöğretim');
  });

  it('eski paylaşılmış bağlantıdaki education=lise kanonik değere çevrilir', async () => {
    getMock.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ilanlar?education=lise']}>
          <JobsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    const lastCall = getMock.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(lastCall[1]?.['education']).toBe('ortaogretim');
  });
});
