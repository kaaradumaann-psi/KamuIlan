/**
 * Öneri listeleri (otomatik tamamlama) için temel bütünlük testleri:
 * boş değiller, yinelenme yok, baştaki/sondaki boşluk yok. Bu listeler
 * yalnızca öneridir; kullanıcı listede olmayan değer de girebilir.
 */
import { describe, expect, it } from 'vitest';
import { PROFESSION_SUGGESTIONS } from '../src/domain/professions';
import { DEPARTMENT_SUGGESTIONS } from '../src/domain/departments';
import { INSTITUTION_SUGGESTIONS } from '../src/domain/institutions';

const LISTS: Record<string, readonly string[]> = {
  professions: PROFESSION_SUGGESTIONS,
  departments: DEPARTMENT_SUGGESTIONS,
  institutions: INSTITUTION_SUGGESTIONS,
};

describe('öneri listeleri', () => {
  for (const [name, list] of Object.entries(LISTS)) {
    describe(name, () => {
      it('boş değildir', () => {
        expect(list.length).toBeGreaterThan(0);
      });

      it('her değer kırpılmıştır (baş/son boşluk yok) ve en az 2 karakterdir', () => {
        for (const value of list) {
          expect(value).toBe(value.trim());
          expect(value.length).toBeGreaterThanOrEqual(2);
        }
      });

      it('yinelenen değer yoktur (Türkçe locale)', () => {
        const keys = list.map((value) => value.toLocaleLowerCase('tr'));
        expect(new Set(keys).size).toBe(list.length);
      });
    });
  }

  it('beklenen kabaca boyutlara ulaşır', () => {
    expect(PROFESSION_SUGGESTIONS.length).toBeGreaterThanOrEqual(90);
    expect(DEPARTMENT_SUGGESTIONS.length).toBeGreaterThanOrEqual(70);
    expect(INSTITUTION_SUGGESTIONS.length).toBeGreaterThanOrEqual(60);
  });
});
