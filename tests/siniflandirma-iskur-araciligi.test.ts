/**
 * İŞKUR aracılı alım (4857 sayılı İş Kanunu) — 22.10.2026 Groq canlı ölçümünde bulunan yanlış ret.
 *
 * Eski davranış: "3 (üç) temizlik görevlisi Türkiye İş Kurumu aracılığıyla alınacaktır" hiçbir olumlu
 * kurala uymuyordu ve kayıt "yeterli ifade yok" gerekçesiyle REDDEDİLİYORDU (LLM kapısına bile gitmedi).
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';

const BODY =
  'Kurumumuz bünyesinde 4857 sayılı İş Kanunu kapsamında çalıştırılmak üzere 3 (üç) temizlik görevlisi ' +
  'Türkiye İş Kurumu aracılığıyla alınacaktır. Başvurular 05.11.2026 tarihine kadar İŞKUR internet sitesi ' +
  'üzerinden yapılacaktır. Adayların en az ilköğretim mezunu olması gerekmektedir.';

describe('İŞKUR aracılı alım', () => {
  it('belirsiz başlıkta ret değil inceleme (LLM kapısına gider)', () => {
    const result = classify({ title: 'Duyuru', body: BODY, sourceCategory: null });
    expect(result.decision).toBe('review');
    expect(result.rules).toEqual(expect.arrayContaining(['pozitif.iskur-araciligiyla-alim', 'pozitif.is-kanunu-calistirma']));
  });

  it('ters sıra: "İŞKUR üzerinden … alınacak"', () => {
    const result = classify({
      title: 'Duyuru',
      body: 'İŞKUR üzerinden yayımlanan ilanla belediyemize 5 (beş) park bahçe görevlisi alınacaktır. Başvurular İŞKUR hizmet merkezine yapılacaktır ve kura noter huzurunda çekilecektir.',
      sourceCategory: null,
    });
    expect(result.rules).toContain('pozitif.iskur-araciligiyla-alim');
  });

  it('İŞKUR istatistik haberi alım sayılmaz', () => {
    const result = classify({
      title: 'İŞKUR yıllık raporu yayımlandı',
      body: 'Türkiye İş Kurumu aracılığıyla geçen yıl bir milyondan fazla kişi işe yerleştirildi. Raporda il bazında istihdam verileri ve meslek dağılımları yer almaktadır. Basın birimi tarafından paylaşılmıştır.',
      sourceCategory: null,
    });
    expect(result.rules).not.toContain('pozitif.iskur-araciligiyla-alim');
    expect(result.decision).not.toBe('accept');
  });
});
