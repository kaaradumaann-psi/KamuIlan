/**
 * Üretim bulgusu (22.10.2026): taranmış RG belgesinde başlık satırı yoksa başlık "Kurum — tarih"
 * oluyor, sınıflandırıcı gerçek öğretim üyesi ilanını incelemeye düşürüyordu (Pamukkale Ü., 20261021-4-12).
 */
import { describe, expect, it } from 'vitest';
import { deriveTitle, recruitmentRoleFromBody } from '../src/sources/adapters/resmigazete';
import { classify } from '../src/classification/engine';

// OCR çıktısının kısaltılmış, kişisel veri içermeyen biçimi.
const OCR = `Pamukkale Üniversitesi Rektörlüğünden: 10819/1-1
Üniversitemiz birimlerine 2547 sayılı Yükseköğretim Kanunu, Öğretim Üyeliğine Yükseltilme ve Atanma Yönetmeliğinin
ilgili maddeleri, Üniversitemiz Akademik Değerlendirme Yönergesi uyarınca öğretim üyesi alınacaktır.
GENEL AÇIKLAMALAR - 657 sayılı Devlet Memurları Kanunu'nun 48. maddesindeki şartları taşımak.
Başvurular ilanın Resmî Gazete'de yayımlandığı tarihten itibaren 15 gün içinde yapılır. Kadro sayısı: 3`;

describe('RG taranmış ilan başlığı', () => {
  it('gövdedeki alım cümlesinden unvanı bulur', () => {
    expect(recruitmentRoleFromBody(OCR)).toBe('ÖĞRETİM ÜYESİ');
    expect(recruitmentRoleFromBody('Kütahya Kültür Varlıklarını Koruma Bölge Kurulu kararı; parsel tescil edilmiştir.')).toBeNull();
  });

  it('başlık "Kurum: UNVAN ALIM İLANI" olur ve ilan kabul edilir', () => {
    const title = deriveTitle(OCR, 'Pamukkale Üniversitesi Rektörlüğünden', 'Pamukkale Üniversitesi', '2026-10-21');
    expect(title).toBe('Pamukkale Üniversitesi Rektörlüğünden: ÖĞRETİM ÜYESİ ALIM İLANI');
    expect(classify({ title, body: OCR, sourceKey: 'resmigazete-cestili-ilanlar' }).decision).toBe('accept');
  });

  it('alım cümlesi yoksa eski "Kurum — tarih" başlığı korunur', () => {
    expect(deriveTitle('Koruma kurulu kararı. Parsel tescil edildi.', 'Kültür ve Turizm Bakanlığından', null, '2026-10-22')).toBe(
      'Kültür ve Turizm Bakanlığından — 2026-10-22',
    );
  });
});
