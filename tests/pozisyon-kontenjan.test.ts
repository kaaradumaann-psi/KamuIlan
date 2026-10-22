/**
 * Bakanlık/kurum ilanlarında pozisyon başına kontenjan ("N. Unvan" + "(K Kişi – …)").
 *
 * Eski davranış: Sayıştay (RG 16.10.2026-4-1) ilanında resmî toplam (2) okunuyordu ama
 * pozisyon kırılımı (`openings`) boştu; detayda hangi pozisyona kaç kişi alındığı yoktu.
 * Gerçek metin: `fixtures/gercek-ilanlar/2026-10-akademik-kadro-tablolari.json` (kurumsal
 * metin, kişi verisi yok). Diğer örnekler sentetiktir (kural sınırları).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractOpenings, extractPositionOpenings } from '../src/extraction/openings';
import { extract } from '../src/extraction/engine';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-akademik-kadro-tablolari.json'), 'utf8'),
) as { items: { id: string; text: string }[] };
const sayistay = fixture.items.find((item) => item.id === 'rg-20261016-4-1')?.text ?? '';

const run = (body: string) =>
  extract({ title: 'Kamu Kurumu Personel Alım İlanı', body, listing: {}, links: [], attachments: [], bodySource: 'document' } as never);

describe('extractPositionOpenings — gerçek Sayıştay ilanı', () => {
  it('iki pozisyon, her biri 1 kişi, kanıt satırıyla', () => {
    const rows = extractOpenings(sayistay);
    expect(rows).toEqual([
      expect.objectContaining({
        title: 'Kıdemli .Net Yazılım Geliştirme Uzmanı ve Çözüm Mimarı (B Grubu)',
        quota: 1,
        serviceClass: null,
        degree: null,
      }),
      expect.objectContaining({ title: 'Yazılım Geliştirme Uzmanı (.Net) (D Grubu)', quota: 1 }),
    ]);
    expect(rows[0]?.evidence).toContain('(1 Kişi');
  });

  it('kontenjan resmî toplamla aynı (2) ve tutarsızlık notu yok', () => {
    const result = run(sayistay);
    expect(result.quota).toBe(2);
    expect(result.openings).toHaveLength(2);
    expect(result.uncertainties.join(' ')).not.toContain('Kontenjan tutarsız');
  });
});

describe('extractPositionOpenings — kural sınırları (sentetik)', () => {
  it('resmî toplam pozisyon toplamından farklıysa tutarsızlık kaydedilir (sessizce ezilmez)', () => {
    const body = [
      'Kurumumuza 3 (üç) Sözleşmeli Bilişim Personeli alınacaktır.',
      '1. Sistem Uzmanı (B Grubu)',
      '(1 Kişi – Tam Zamanlı)',
      'a) şart',
      '2. Ağ Uzmanı (C Grubu)',
      '(1 Kişi – Tam Zamanlı)',
    ].join('\n');
    const result = run(body);
    expect(result.openings).toHaveLength(2);
    // Yazıyla doğrulanmış resmî toplam, eksik okunmuş olabilecek kırılımdan güçlüdür.
    expect(result.quota).toBe(3);
    expect(result.uncertainties.join(' ')).toContain('Kontenjan tutarsız: resmî toplam 3 (yazıyla doğrulandı)');
  });

  it('başlık iki satıra bölünmüşse birleştirilir; büyük harf "KİŞİ" okunur', () => {
    const rows = extractPositionOpenings(
      ['1. Kıdemli Veri Tabanı Yöneticisi', 've Sistem Mimarı (A Grubu)', '(2 KİŞİ – Tam Zamanlı)', '2. Yazılım Uzmanı', '(3 Kişi)'].join('\n'),
    );
    expect(rows.map((row) => [row.title, row.quota])).toEqual([
      ['Kıdemli Veri Tabanı Yöneticisi ve Sistem Mimarı (A Grubu)', 2],
      ['Yazılım Uzmanı', 3],
    ]);
  });

  it('numaralar ardışık değilse hiç pozisyon üretilmez', () => {
    expect(extractPositionOpenings(['1. Uzman', '(1 Kişi)', '3. Uzman', '(1 Kişi)'].join('\n'))).toEqual([]);
  });

  it('"Kişi" satırı olmayan numaralı maddeler pozisyon sayılmaz', () => {
    expect(extractPositionOpenings(['1. Başvuru şartları', 'a) şart', '2. Belgeler', '(3 adet vesikalık fotoğraf)'].join('\n'))).toEqual([]);
  });

  it('sınır dışı kişi sayısı (0) pozisyonları geçersiz kılar', () => {
    expect(extractPositionOpenings(['1. Uzman', '(0 Kişi)'].join('\n'))).toEqual([]);
  });
});

/**
 * Taranmış belge (OCR) biçimi: başlık ve kişi sayısı aynı satırda; rakam yazıyla da verilir.
 * Alıntı İŞKUR RG 18.10.2026-4-4 OCR çıktısından (kurumsal metin, kişi verisi yok); OCR ilk
 * pozisyonda "1"i "|" okudu.
 */
const ISKUR_OCR = [
  'B- ÖZEL ŞARTLAR (NİTELİKLER)',
  'Başvuru genel şartlarına ilave olarak, niteliklerine göre aşağıdaki özel şartlar aranacaktır.',
  '1. KIDEMLİ SİSTEM UZMANI (| (Bir) Kişi — Tam Zamanlı- A Grubu —Aylık Brüt',
  '',
  'Sözleşme Ücret Tavanının 4 (Dört) Katına kadar)',
  '1. Büyük ölçekli bilgi işlem birimine sahip kamu kurum ve kuruluşlarında ya da en az',
  '2. UNIX/Linux sunucu işletim > sistemlerinin kurulumu, bakımı, izlenmesi,',
  '2. KIDEMLİ SİBER GÜVENLİK UZMANI (1 (Bir) Kişi — Tam Zamanlı- A Grubu —Aylık',
  '',
  'Brüt Sözleşme Ücret Tavanının 4 (Dört) Katına kadar)',
  '1. Siber güvenlik alanında en az 7 (yedi) yıl tecrübeye sahip olmak,',
].join('\n');

describe('extractPositionOpenings — OCR satır içi biçim', () => {
  it('gerçek İŞKUR OCR: iki pozisyon, OCR "|" yazıyla (Bir) 1 okunur', () => {
    const rows = extractOpenings(ISKUR_OCR);
    expect(rows.map((row) => [row.title, row.quota])).toEqual([
      ['KIDEMLİ SİSTEM UZMANI', 1],
      ['KIDEMLİ SİBER GÜVENLİK UZMANI', 1],
    ]);
    expect(rows[0]?.evidence).toBe('1. KIDEMLİ SİSTEM UZMANI (| (Bir) Kişi — Tam Zamanlı- A Grubu —Aylık Brüt');
  });

  it('OCR kırılımı eksikse (sayfa sınırı) yazıyla doğrulanmış resmî toplam 11 korunur, fark not edilir', () => {
    const body = [
      'uygulamalı sınavı başarı sırasına göre yapılacak yerleştirme ile 11 (Onbir) Sözleşmeli Bilişim',
      'Personeli alınacaktır.',
      ISKUR_OCR,
    ].join('\n');
    const result = run(body);
    expect(result.quota).toBe(11);
    expect(result.openings).toHaveLength(2);
    expect(result.uncertainties.join(' ')).toContain('okunabilen kadro/pozisyon toplamı 2');
  });

  it('alt satırdaki "(2 (İki) Kişi" biçimi de okunur', () => {
    expect(extractPositionOpenings(['1. Ağ Uzmanı', '(2 (İki) Kişi – Tam Zamanlı)'].join('\n')).map((row) => row.quota)).toEqual([2]);
  });

  it('rakam yazıyla çelişirse hiç pozisyon üretilmez', () => {
    expect(extractPositionOpenings('1. Ağ Uzmanı (2 (Bir) Kişi — Tam Zamanlı)')).toEqual([]);
  });

  it('okunamayan rakam yazısız ise kişi sayısı uydurulmaz', () => {
    expect(extractPositionOpenings('1. Ağ Uzmanı (| Kişi — Tam Zamanlı)')).toEqual([]);
  });

  it('başlık parantezi kişi parantezinden önce gelirse başlıkta kalır', () => {
    expect(extractPositionOpenings('1. Yazılım Uzmanı (.Net) (B Grubu) (1 Kişi – Tam Zamanlı)').map((row) => row.title)).toEqual([
      'Yazılım Uzmanı (.Net) (B Grubu)',
    ]);
  });
});
