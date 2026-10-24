import { describe, expect, it } from 'vitest';
import type { PreferenceFilters } from '../src/types';
import {
  hasActivePreferences,
  jobQueryFromPreferences,
  preferenceListPath,
} from '../src/lib/home-personalization';

function filters(overrides: Partial<PreferenceFilters> = {}): PreferenceFilters {
  return {
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
    ...overrides,
  };
}

describe('hasActivePreferences', () => {
  it('boş tercih için false döner', () => {
    expect(hasActivePreferences(filters())).toBe(false);
    expect(hasActivePreferences(null)).toBe(false);
    expect(hasActivePreferences(filters({ keywords: ['  '] }))).toBe(false);
  });

  it('en az bir filtre doluysa true döner', () => {
    expect(hasActivePreferences(filters({ cities: ['Ankara'] }))).toBe(true);
    expect(hasActivePreferences(filters({ employmentTypes: ['kadrolu'] }))).toBe(true);
  });
});

describe('jobQueryFromPreferences', () => {
  it('ilk anahtar kelimeyi q yapar, dizileri aynen taşır, açık+son güne sabitler', () => {
    const query = jobQueryFromPreferences(
      filters({
        keywords: ['mühendis', 'teknisyen'],
        cities: ['Ankara', 'İzmir'],
        employmentTypes: ['kadrolu', 'sozlesmeli'],
        educationLevels: ['lisans'],
        departments: ['İnşaat Mühendisliği'],
        kpssScoreTypes: ['p3'],
        institutions: ['Sağlık Bakanlığı', 'MEB'],
      }),
    );
    expect(query.q).toBe('mühendis');
    expect(query.city).toEqual(['Ankara', 'İzmir']);
    expect(query.employmentType).toEqual(['kadrolu', 'sozlesmeli']);
    expect(query.education).toEqual(['lisans']);
    expect(query.department).toEqual(['İnşaat Mühendisliği']);
    expect(query.kpssType).toEqual(['p3']);
    expect(query.institution).toBe('Sağlık Bakanlığı');
    expect(query.status).toBe('active');
    expect(query.sort).toBe('deadline');
    expect(query.pageSize).toBe(6);
  });

  it('anahtar kelime yoksa ilk unvana düşer', () => {
    const query = jobQueryFromPreferences(filters({ titles: ['Bilgisayar İşletmeni'] }));
    expect(query.q).toBe('Bilgisayar İşletmeni');
  });

  it('boş alanları sorguya eklemez', () => {
    const query = jobQueryFromPreferences(filters({ cities: ['Ankara'] }));
    expect(query).not.toHaveProperty('q');
    expect(query).not.toHaveProperty('employmentType');
    expect(query).not.toHaveProperty('institution');
  });

  it('pageSize dışarıdan ayarlanabilir', () => {
    expect(jobQueryFromPreferences(filters(), 3).pageSize).toBe(3);
  });
});

describe('preferenceListPath', () => {
  it('tek değerli parametrelerle /ilanlar bağlantısı üretir', () => {
    const path = preferenceListPath(
      filters({ keywords: ['hemşire'], cities: ['Ankara', 'İzmir'], employmentTypes: ['sozlesmeli'] }),
    );
    const url = new URL(path, 'https://example.test');
    expect(url.pathname).toBe('/ilanlar');
    expect(url.searchParams.get('q')).toBe('hemşire');
    expect(url.searchParams.get('city')).toBe('Ankara');
    expect(url.searchParams.get('employmentType')).toBe('sozlesmeli');
    expect(url.searchParams.get('status')).toBe('active');
    expect(url.searchParams.get('sort')).toBe('deadline');
  });
});
