/**
 * LLM kanıt doğrulayıcısı sıkılaştırması (denetim 27.10.2026, HANDOFF §5 fix #2 ve süreç bağlamı).
 * Tatarlı Bld. düzeltmesi: model "İlk Defa Atanmak Üzere Memur Alım İlanımızda" alıntısıyla
 * `ilan` dedi ve doğrulayıcıdan geçti. Önceki ilana atıf yeni alım kanıtı değildir.
 */
import { describe, expect, it } from 'vitest';
import { validateClassifierOutput } from '../src/ai/classifier';
import { normalizeTr } from '../src/domain/text';

function ilan(evidence: string, haystack: string) {
  return validateClassifierOutput({
    output: { karar: 'ilan', icerikTuru: 'personnel_recruitment', istihdamTuru: 'belirsiz', guven: 0.8, ozet: 'x', kanitlar: { alimIfadesi: evidence } },
    titleNormalized: normalizeTr('Belediye duyurusu'),
    haystack,
  });
}

describe('LLM ilan kanıtı', () => {
  it('önceki ilana atıf (…Alım İlanımızda) reddedilir', () => {
    const text = '17.10.2026 tarihinde yayımlanan İlk Defa Atanmak Üzere Memur Alım İlanımızda zabıta memuru kadrosunun nitelikleri düzeltilmiştir.';
    const result = ilan('İlk Defa Atanmak Üzere Memur Alım İlanımızda', text);
    expect(result.failure).not.toBeNull();
    expect(result.failure).toContain('önceki bir ilana atıf');
  });

  it('gelecek zamanlı alım cümlesi kabul edilir', () => {
    const text = 'Üniversitemize 9 Öğretim Üyesi alınacaktır.';
    expect(ilan('9 Öğretim Üyesi alınacaktır.', text).verdict).toBe('ilan');
  });
});

describe('LLM süreç kanıtı', () => {
  it('personel bağlamı olmayan süreç sinyali reddedilir', () => {
    const text = 'Taşınmaz kiralama ihalesi sonuç duyurusu: ihale sonuçları açıklanmıştır.';
    const result = validateClassifierOutput({
      output: { karar: 'surec', icerikTuru: 'personnel_process_announcement', istihdamTuru: 'belirsiz', guven: 0.8, ozet: 'x', kanitlar: { surecIfadesi: 'ihale sonuçları açıklanmıştır' } },
      titleNormalized: normalizeTr('Kiralama ihalesi sonuç duyurusu'),
      haystack: text,
    });
    expect(result.failure).not.toBeNull();
  });
});
