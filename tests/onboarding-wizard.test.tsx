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
  choicesFromPreference,
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
    // Sihirbazın sormadığı alanlar gövdeye yazılmaz (sunucu birleştirir, mevcutlar korunur).
    expect('mode' in body).toBe(false);
    expect('institutions' in body.filters).toBe(false);
    expect('minDaysUntilDeadline' in body.filters).toBe(false);
    expect('skills' in body.candidateProfile).toBe(false);
    expect(body.filters.titles).toEqual(['Hemşire']);
    expect(body.filters.keywords).toEqual(['rehberlik']);
    expect(body.filters.cities).toEqual(['Ankara', 'İstanbul']);
    expect(body.filters.employmentTypes).toEqual(['kadrolu']);
    expect(body.filters.educationLevels).toEqual(['lisans']);
    expect(body.filters.departments).toEqual(['Hemşirelik']);
    expect(body.filters.kpssScoreTypes).toEqual(['P3']);
    expect(body.filters.kpssMinScore).toBe(100);
    expect(body.candidateProfile.profession).toBe('Hemşire');
    expect(body.candidateProfile.departments).toEqual(['Hemşirelik']);
    expect(body.profilePersonalizationEnabled).toBe(true);
    expect(body.includeAcademicJobs).toBe(false);
  });

  it('meslek yoksa profil kişiselleştirmesini açmaz', () => {
    const body = buildWizardPayload({ ...INITIAL_WIZARD_CHOICES, keywords: ['zabıta'] });
    expect(body.candidateProfile.profession).toBe('');
    // Unvan yoksa alan gönderilmez: Panel'de açılmış profil eşleşmesi kapanmaz.
    expect(body.profilePersonalizationEnabled).toBeUndefined();
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

describe('choicesFromPreference', () => {
  it("kayıtlı tercihle başlar (Panel'den açılan sihirbaz mevcut seçimleri silmez)", () => {
    const choices = choicesFromPreference({
      onlyNewJobs: false,
      notifyOnChanges: true,
      includeWorkerJobs: false,
      includeAcademicJobs: true,
      candidateProfile: { profession: 'Hemşire', educationLevel: 'lisans', departments: [], skills: ['Excel'], experienceYears: 3 },
      filters: {
        keywords: ['sağlık'],
        titles: ['Hemşire'],
        institutions: ['Sağlık Bakanlığı'],
        cities: ['Ankara'],
        employmentTypes: ['sozlesmeli'],
        educationLevels: ['lisans'],
        departments: ['Hemşirelik'],
        kpssScoreTypes: ['P3'],
        kpssMinScore: 70,
        minDaysUntilDeadline: null,
      },
    } as unknown as Parameters<typeof choicesFromPreference>[0]);
    expect(choices.titles).toEqual(['Hemşire']);
    expect(choices.cities).toEqual(['Ankara']);
    expect(choices.kpssMinScore).toBe(70);
    expect(choices.includeWorkerJobs).toBe(false);
    expect(choices.onlyNewJobs).toBe(false);
    expect(choicesFromPreference(null)).toEqual(INITIAL_WIZARD_CHOICES);
  });
});
