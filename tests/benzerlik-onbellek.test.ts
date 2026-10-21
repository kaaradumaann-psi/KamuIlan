/**
 * Tekilleştirme benzerlik önbelleği: sonuç önbelleksiz hesapla birebir aynı kalmalı.
 * (Yerel ölçüm: 400 adaylı karar p50 130 ms → 1,6 ms; scripts/bench-pipeline.ts.)
 */
import { describe, expect, it } from 'vitest';
import { diceSimilarity, jaccardSimilarity, normalizeTr } from '../src/domain/text';

/** Önbelleksiz başvuru hesabı (eski uygulama ile aynı tanım). */
function referenceDice(a: string, b: string, n = 3): number {
  const grams = (value: string) => {
    const compact = normalizeTr(value).replace(/\s+/g, ' ').trim();
    const out = new Set<string>();
    if (compact.length <= n) {
      if (compact.length > 0) out.add(compact);
      return out;
    }
    for (let i = 0; i + n <= compact.length; i += 1) out.add(compact.slice(i, i + n));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let common = 0;
  for (const gram of ga) if (gb.has(gram)) common += 1;
  return (2 * common) / (ga.size + gb.size);
}

describe('benzerlik önbelleği', () => {
  it('tekrarlanan çağrı ve önbellek sınırını aşan girdilerde sonuç değişmez', () => {
    const titles = Array.from({ length: 5_000 }, (_, index) => `Kurum ${index} Sözleşmeli Personel Alım İlanı`);
    for (const [index, title] of titles.entries()) {
      const other = titles[(index * 7) % titles.length] ?? '';
      expect(diceSimilarity(title, other)).toBeCloseTo(referenceDice(title, other), 12);
    }
    // İlk girdiler önbellekten çoktan atılmıştır: yeniden hesap da aynı sonucu verir.
    expect(diceSimilarity(titles[0] ?? '', titles[1] ?? '')).toBeCloseTo(referenceDice(titles[0] ?? '', titles[1] ?? ''), 12);
    const text = 'Kurumumuza sözleşmeli personel alınacaktır. Başvurular e-Devlet üzerinden yapılır.';
    const first = jaccardSimilarity(text, `${text} Ek koşul.`);
    expect(jaccardSimilarity(text, `${text} Ek koşul.`)).toBe(first);
    expect(diceSimilarity('', 'x')).toBe(0);
  });
});
