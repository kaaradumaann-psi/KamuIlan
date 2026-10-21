/**
 * Resmî toplam: birden çok kalem ("6 (altı) Uzman ve 1 (bir) Destek Personeli … alımı yapılacaktır").
 *
 * Eski davranış (gerçek OCR metni, Orta Anadolu Kalkınma Ajansı, RG 19.10.2026-4-7): resmî toplam
 * cümlesi tanınmıyordu ("alımı yapılacak", iki kalem, OCR'ın "1" yerine okuduğu "|"); kontenjan
 * alttaki tablo gürültüsünden ("UZMAN PERSONEL -2 2 Personel — 1 İçin") **2** okunuyordu. Doğrusu 7.
 * Aşağıdaki alıntı kurumsal ilan metnidir (kişi verisi yok).
 */
import { describe, expect, it } from 'vitest';
import { extractQuota } from '../src/extraction/engine';

const ORAN_OCR = `T.C. Orta Anadolu Kalkınma Ajansı'na (ORAN), 4 sayılı Bakanlıklara Bağlı, İlgili, İlişkili Kurum
ve Kuruluşlar ile Diğer Kurum ve Kuruluşların Teşkilatı Hakkında Cumhurbaşkanlığı Kararnamesi ve
Kalkınma Ajansları Personel Yönetmeliği hükümleri çerçevesinde;
hâkim ve seyahat engeli olmayan 6 (altı) Uzman ve | (bir) Destek Personeli (Büro Görevlisi) alımı
yapılacaktır.
Tablo 2. Uzman Personel İçin İlgili Pozisyon Öğrenim Dalı ve KPSS Puan Türü
UZMAN PERSONEL -2 2 Personel — 1 İçin KPSS Pi, P2, P3`;

describe('extractQuota — çok kalemli resmî toplam', () => {
  it('gerçek OCR: 6 Uzman + 1 Destek Personeli = 7 (OCR "|" yazıyla "(bir)" doğrulanır)', () => {
    const quota = extractQuota(ORAN_OCR);
    expect(quota?.value).toBe(7);
    expect(quota?.snippet).toContain('6 (altı) Uzman');
  });

  it('"alımı yapılacaktır" ve "alınacaktır" fiilleri; tek kalem; birleşik yazı ("Onbir")', () => {
    expect(extractQuota('… yerleştirme ile 11 (Onbir) Sözleşmeli Bilişim Personeli alınacaktır.')?.value).toBe(11);
    expect(extractQuota('Kurumumuza 3 (üç) Mühendis ve 2 (iki) Tekniker alımı yapılacaktır.')?.value).toBe(5);
    expect(extractQuota('Toplam 25 (yirmi beş) Zabıta Memuru alınacaktır.')?.value).toBe(25);
  });

  it('rakam ile yazı çelişirse bu kural kullanılmaz (uydurma toplam yok)', () => {
    expect(extractQuota('6 (yedi) Uzman alımı yapılacaktır.')).toBeNull();
  });

  it('okunamayan rakam yazıyla doğrulanmadıysa kabul edilmez', () => {
    expect(extractQuota('| Uzman alımı yapılacaktır.')).toBeNull();
  });

  it('mevcut kalıplar korunur', () => {
    expect(extractQuota('2 (iki) Sözleşmeli Bilişim Personeli alınacaktır.')?.value).toBe(2);
    expect(extractQuota('Kontenjan 25 kişidir.')?.value).toBe(25);
    expect(extractQuota('3 adet vesikalık fotoğraf')).toBeNull();
  });
});
