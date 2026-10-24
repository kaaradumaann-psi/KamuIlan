// @vitest-environment jsdom
/**
 * Başlangıç sihirbazı: (1) seçimlerden PUT gövdesini üreten saf fonksiyon,
 * (2) bileşen akışı — adımlar arasında gezinip Tamamla'ya basınca doğru
 * gövdeyle onComplete çağrılır.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWizardPayload,
  hasAnyChoice,
  INITIAL_WIZARD_CHOICES,
  type WizardChoices,
} from '../src/lib/wizard-payload';
import { OnboardingWizard } from '../src/components/OnboardingWizard';

afterEach(cleanup);

describe('buildWizardPayload', () => {
  it('seçimleri sunucu şemasına uygun gövdeye çevirir', () => {
    const choices: WizardChoices = {
      ...INITIAL_WIZARD_CHOICES,
      titles: ['Hemşire', 'hemşire'], // yinelenme elenir
      keywords: ['rehberlik', 'x'], // 'x' çok kısa, elenir
      departments: ['Hemşirelik'],
      cities: ['Ankara', ' İstanbul '], // kırpılır
      employmentTypes: ['kadrolu'],
      educationLevels: ['lisans'],
      educationLevel: 'lisans',
      kpssScoreTypes: ['P3'],
      kpssMinScore: 150, // 100'e sıkıştırılır
      includeAcademicJobs: false,
    };
    const body = buildWizardPayload(choices);

    expect(body.enabled).toBe(true);
    expect(body.paused).toBe(false);
    expect(body.mode).toBe('instant');
    expect(body.filters.titles).toEqual(['Hemşire']);
    expect(body.filters.keywords).toEqual(['rehberlik']);
    expect(body.filters.institutions).toEqual([]);
    expect(body.filters.cities).toEqual(['Ankara', 'İstanbul']);
    expect(body.filters.employmentTypes).toEqual(['kadrolu']);
    expect(body.filters.educationLevels).toEqual(['lisans']);
    expect(body.filters.departments).toEqual(['Hemşirelik']);
    expect(body.filters.kpssScoreTypes).toEqual(['P3']);
    expect(body.filters.kpssMinScore).toBe(100);
    expect(body.filters.minDaysUntilDeadline).toBeNull();
    expect(body.candidateProfile.profession).toBe('Hemşire');
    expect(body.candidateProfile.departments).toEqual(['Hemşirelik']);
    expect(body.profilePersonalizationEnabled).toBe(true);
    expect(body.includeAcademicJobs).toBe(false);
  });

  it('meslek yoksa profil kişiselleştirmesini açmaz', () => {
    const body = buildWizardPayload({ ...INITIAL_WIZARD_CHOICES, keywords: ['zabıta'] });
    expect(body.candidateProfile.profession).toBe('');
    expect(body.profilePersonalizationEnabled).toBe(false);
  });

  it('boş seçim anlamlı sayılmaz', () => {
    expect(hasAnyChoice(INITIAL_WIZARD_CHOICES)).toBe(false);
    expect(hasAnyChoice({ ...INITIAL_WIZARD_CHOICES, titles: ['Hemşire'] })).toBe(true);
  });
});

describe('OnboardingWizard akışı', () => {
  it('adımları gezip Tamamla ile doğru gövdeyi gönderir', () => {
    const onComplete = vi.fn();
    const onClose = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} onClose={onClose} />);

    // Adım 1 / 10 karşılama
    expect(screen.getByText('Adım 1 / 10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /İleri/ }));

    // Adım 2: unvan
    const titles = screen.getByLabelText('Hedef unvanlar') as HTMLInputElement;
    fireEvent.change(titles, { target: { value: 'Hemşire' } });
    fireEvent.keyDown(titles, { key: 'Enter' });
    expect(screen.getByText('Hemşire')).toBeTruthy();

    // Son adıma kadar İleri'ye bas (10 ekran, index 1 -> 9)
    for (let step = 0; step < 8; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: /İleri/ }));
    }

    // Son adım: özet + Tamamla
    expect(screen.getByText('Adım 10 / 10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Tamamla ve bildirimleri aç/ }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const body = onComplete.mock.calls[0]![0];
    expect(body.filters.titles).toEqual(['Hemşire']);
    expect(body.candidateProfile.profession).toBe('Hemşire');
    expect(body.enabled).toBe(true);
  });

  it('hiçbir şey seçilmezse Tamamla devre dışıdır', () => {
    render(<OnboardingWizard onComplete={vi.fn()} onClose={vi.fn()} />);
    // Doğrudan son adıma atla: welcome -> İleri, sonra her adımda Atla/İleri
    fireEvent.click(screen.getByRole('button', { name: /İleri/ }));
    for (let step = 0; step < 8; step += 1) {
      const skip = screen.queryByRole('button', { name: 'Atla' });
      fireEvent.click(skip ?? screen.getByRole('button', { name: /İleri/ }));
    }
    const complete = screen.getByRole('button', { name: /Tamamla ve bildirimleri aç/ }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
  });

  it('Vazgeç kapatır', () => {
    const onClose = vi.fn();
    render(<OnboardingWizard onComplete={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sihirbazdan vazgeç' }));
    expect(onClose).toHaveBeenCalled();
  });
});
