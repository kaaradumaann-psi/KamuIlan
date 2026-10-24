// @vitest-environment jsdom
/**
 * Bildirim tercihleri formu (Panel) — regresyon testi.
 *
 * Bulunan hata: eğitim düzeyi kutuları `EDUCATION_LABELS` sözlüğünden
 * ÜRETİLİYORDU. Bu sözlükte görüntüleme takma adları vardır:
 *   - `belirtilmemis` → sunucu bunu geçersiz sayar; kaydetmeye basınca
 *     kullanıcı "Gönderilen alanlar geçersiz." (400) hatası alıyordu.
 *   - `lise` → hiçbir kayıtla eşleşmez; sessizce etkisiz bir tercih olurdu.
 *
 * Bu test, formun yalnızca KANONİK düzeyleri sunduğunu ve kaydetme isteğinin
 * yalnızca kanonik değerler içerdiğini sabitler.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDUCATION_LEVELS } from '../src/domain/types';

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn(async () => ({ message: 'Tercihler kaydedildi.' })));

vi.mock('../src/lib/api', () => ({
  api: { get: getMock, post: vi.fn(async () => ({ message: 'ok' })), put: putMock, del: vi.fn() },
  errorMessage: (error: unknown) => String(error),
}));

vi.mock('../src/lib/session', () => ({
  useAuth: () => ({ user: { id: 'usr_test' }, logout: vi.fn(async () => undefined) }),
}));

const { PanelPage } = await import('../src/pages/Panel');

const PREFERENCES = {
  preference: {
    id: 'npr_1',
    userId: 'usr_test',
    enabled: true,
    paused: false,
    mode: 'instant',
    onlyNewJobs: true,
    notifyOnChanges: true,
    includeWorkerJobs: true,
    includeAcademicJobs: true,
    profilePersonalizationEnabled: false,
    candidateProfile: {
      profession: '',
      educationLevel: null,
      departments: [],
      skills: [],
      experienceYears: null,
    },
    filters: {
      keywords: [],
      titles: [],
      institutions: [],
      cities: [],
      employmentTypes: [],
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      minDaysUntilDeadline: null,
    },
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
  },
  email: 'aday@ornek.test',
  emailVerified: true,
  canReceive: true,
  options: {
    employmentTypes: [],
    educationLevels: [],
    kpssScoreTypes: [],
    modes: [],
  },
  notice: null,
};

const HISTORY = { events: [], emails: [], notice: 'Sağlayıcı raporudur.' };

function renderPanel(): void {
  getMock.mockImplementation(async (path: string) => {
    if (path === '/api/notifications/preferences') return PREFERENCES;
    if (path === '/api/notifications/history') return HISTORY;
    throw new Error(`Beklenmeyen istek: ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/panel']}>
        <PanelPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  putMock.mockClear();
});

describe('panel eğitim düzeyi tercihleri', () => {
  it('yalnızca kanonik düzeyler sunulur (takma ad yok)', async () => {
    renderPanel();
    const chip = await screen.findByLabelText(/Ortaöğretim \(lise\)/);
    expect(chip).toBeTruthy();

    // Kanonik olmayan iki kutunun ETİKETİ de görünmemeli: "Belirtilmemiş"
    // kutunun etiketi metinle aranıyor; "lise" takma adı ayrıca sunulmamalı.
    expect(screen.queryByText('Belirtilmemiş')).toBeNull();
    for (const level of EDUCATION_LEVELS) {
      expect(level).toBeTruthy();
    }
  });

  it('kaydetme isteği yalnızca kanonik düzeyleri gönderir', async () => {
    renderPanel();
    const orta = (await screen.findByLabelText(/Ortaöğretim \(lise\)/)) as HTMLInputElement;
    fireEvent.click(orta);
    const lisans = (await screen.findByLabelText(/^Lisans$/)) as HTMLInputElement;
    fireEvent.click(lisans);

    fireEvent.click(screen.getByRole('button', { name: /Tercihleri kaydet/ }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [, body] = putMock.mock.calls[0] as unknown as [
      string,
      {
        filters: { educationLevels: string[] };
        profilePersonalizationEnabled: boolean;
      },
    ];
    // Bildirim kaydı profil alanlarına dokunmaz (profil ayrı kartta kaydedilir).
    expect(body.profilePersonalizationEnabled).toBeUndefined();
    expect(body.filters.educationLevels).toContain('ortaogretim');
    expect(body.filters.educationLevels).toContain('lisans');
    // Sunucunun reddettiği/takma ad değerler gönderilmez.
    expect(body.filters.educationLevels).not.toContain('lise');
    expect(body.filters.educationLevels).not.toContain('belirtilmemis');
  });

  it('profil kullanımı açıkça seçilmeden opt-out kalır; açılınca profil alanlarını kaydeder', async () => {
    renderPanel();
    const optIn = (await screen.findByLabelText(
      /Profilimi ilanlara özel eşleşme açıklamalarında kullan/,
    )) as HTMLInputElement;
    expect(optIn.checked).toBe(false);

    fireEvent.click(optIn);
    fireEvent.change(screen.getByLabelText(/Mesleğim \/ hedef unvanım/), { target: { value: 'hemşire' } });
    const skills = screen.getByLabelText('Beceriler / belgeler') as HTMLInputElement;
    fireEvent.change(skills, { target: { value: 'ilk yardım' } });
    fireEvent.keyDown(skills, { key: 'Enter' });
    fireEvent.change(skills, { target: { value: 'triyaj' } });
    fireEvent.keyDown(skills, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Profili kaydet' }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [, body] = putMock.mock.calls[0] as unknown as [
      string,
      {
        enabled?: boolean;
        profilePersonalizationEnabled: boolean;
        candidateProfile: { profession: string; skills: string[] };
      },
    ];
    expect(body.enabled).toBeUndefined();
    expect(body.profilePersonalizationEnabled).toBe(true);
    expect(body.candidateProfile.profession).toBe('hemşire');
    expect(body.candidateProfile.skills).toEqual(['ilk yardım', 'triyaj']);
  });

  it('profili ayrıca siler ve eşleştirmeyi kapatır, e-posta tercihlerine dokunmaz', async () => {
    renderPanel();
    fireEvent.click(await screen.findByLabelText(/Profilimi ilanlara özel eşleşme açıklamalarında kullan/));
    fireEvent.change(screen.getByLabelText(/Mesleğim \/ hedef unvanım/), { target: { value: 'mimar' } });
    fireEvent.click(screen.getByRole('button', { name: /Profil bilgilerimi sil/ }));
    expect(await screen.findByRole('heading', { name: 'Profil bilgilerini sil' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Profilimi sil' }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [, body] = putMock.mock.calls[0] as unknown as [
      string,
      {
        enabled?: boolean;
        profilePersonalizationEnabled: boolean;
        candidateProfile: {
          profession: string;
          educationLevel: string | null;
          departments: string[];
          skills: string[];
          experienceYears: number | null;
        };
      },
    ];
    expect(body.enabled).toBeUndefined();
    expect(body.profilePersonalizationEnabled).toBe(false);
    expect(body.candidateProfile).toEqual({
      profession: '',
      educationLevel: null,
      departments: [],
      skills: [],
      experienceYears: null,
    });
  });
});

describe('seçilebilir profil alanları (TagInput) ve kayıt geri bildirimi', () => {
  it('bölüm ve beceri alanlarına yazıp Enter ile etiket eklenir ve kaydedilir', async () => {
    putMock.mockClear();
    renderPanel();
    const departments = (await screen.findByLabelText('Mezun olduğum bölümler')) as HTMLInputElement;
    fireEvent.change(departments, { target: { value: 'Psikoloji' } });
    fireEvent.keyDown(departments, { key: 'Enter' });
    expect(departments.value).toBe('');
    expect(screen.getByText('Psikoloji')).toBeTruthy();

    const skills = screen.getByLabelText('Beceriler / belgeler') as HTMLInputElement;
    fireEvent.change(skills, { target: { value: 'AutoCAD' } });
    fireEvent.keyDown(skills, { key: 'Enter' });
    expect(screen.getByText('AutoCAD')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Profili kaydet' }));
    await waitFor(() => expect(putMock).toHaveBeenCalled());
    const body = (putMock.mock.calls.at(-1) as unknown as [string, { candidateProfile: { departments: string[]; skills: string[] } }])[1];
    expect(body.candidateProfile.departments).toEqual(['Psikoloji']);
    expect(body.candidateProfile.skills).toEqual(['AutoCAD']);
  });

  it('unvan ve il alanları TagInput ile bildirim gövdesine yazılır', async () => {
    putMock.mockClear();
    renderPanel();
    const titles = (await screen.findByLabelText('Unvanlar')) as HTMLInputElement;
    fireEvent.change(titles, { target: { value: 'Hemşire' } });
    fireEvent.keyDown(titles, { key: 'Enter' });
    const cities = screen.getByLabelText('İller') as HTMLInputElement;
    fireEvent.change(cities, { target: { value: 'Ankara' } });
    fireEvent.keyDown(cities, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Tercihleri kaydet ve bildirimleri aç' }));
    await waitFor(() => expect(putMock).toHaveBeenCalled());
    const body = (putMock.mock.calls.at(-1) as unknown as [string, { filters: { titles: string[]; cities: string[] } }])[1];
    expect(body.filters.titles).toEqual(['Hemşire']);
    expect(body.filters.cities).toEqual(['Ankara']);
  });

  it('kayıt sonucu düğmenin yanında gösterilir', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Tercihleri kaydet ve bildirimleri aç' }));
    const notes = await screen.findAllByText(/✓ Tercihler kaydedildi\./);
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe('bildirim ayarları tek kaydetme ile gider', () => {
  it('anahtarlar tıklanınca kaydetmez; Tercihleri kaydet hepsini birlikte gönderir', async () => {
    putMock.mockClear();
    renderPanel();
    fireEvent.click(await screen.findByLabelText(/Takip ettiğim ilanda değişiklik olursa/));
    fireEvent.click(screen.getByLabelText(/Akademik kadro ilanlarını dahil et/));
    expect(putMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tercihleri kaydet ve bildirimleri aç' }));
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const body = (putMock.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ enabled: true, notifyOnChanges: false, includeAcademicJobs: false, onlyNewJobs: true });
    expect(body.candidateProfile).toBeUndefined();
  });
});
