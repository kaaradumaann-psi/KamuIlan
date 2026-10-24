import { describe, expect, it } from 'vitest';
import type { PreferenceFilters } from '../src/types';
import { hasActivePreferences } from '../src/lib/home-personalization';

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

  it('yalnız KPSS puanı girilmişse de kişiselleştirme sayılır', () => {
    expect(hasActivePreferences(filters({ kpssMinScore: 70 }))).toBe(true);
  });
});
