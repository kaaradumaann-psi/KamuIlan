/**
 * Üniversite kadro tabloları ve çok pozisyonlu ilanlarda toplam kontenjan (gerçek RG metinleri).
 *
 * Eski davranış: yalnız mahalli idare tablosu okunuyordu; 37 kadrolu Bursa Uludağ ilanında
 * kadro kırılımı ve kontenjan boştu. Sayıştay ilanında "2 (iki) … Personeli alınacaktır"
 * toplamı varken ilk pozisyonun "(1 Kişi" ifadesi kontenjan sayılıyordu.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAcademicOpenings, extractOpenings } from '../src/extraction/openings';
import { extract } from '../src/extraction/engine';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/gercek-ilanlar/2026-10-akademik-kadro-tablolari.json'), 'utf8'),
) as { items: { id: string; text: string }[] };
const text = (id: string): string => fixture.items.find((item) => item.id === id)?.text ?? '';
const total = (rows: { quota: number }[]): number => rows.reduce((sum, row) => sum + row.quota, 0);

describe('extractAcademicOpenings — gerçek tablolar', () => {
  it('Bursa Uludağ Ü. (16.10-4-14): 37 ilan no → 37 kadro; kaynaktaki yazım hatalı numaralar da okunur', () => {
    const rows = extractAcademicOpenings(text('rg-20261016-4-14'));
    expect(rows).toHaveLength(37);
    expect(total(rows)).toBe(37);
    expect(rows[0]).toMatchObject({ title: 'Doktor Öğretim Üyesi — DEVLET KONSERVATUVARI TÜRK MÜZİĞİ BESTECİLİK ANASANAT DALI', quota: 1, degree: 1 });
    expect(rows[0]?.qualification).toContain('Müzik programlarında lisans');
    // Kaynakta "202620302" (9 hane) yazılmış satır: birim yine doğru okunur.
    expect(rows[1]?.title).toBe('Profesör — DİŞ HEKİMLİĞİ FAKÜLTESİ TEMEL BİLİMLER TEMEL BİLİMLER');
    expect(new Set(rows.map((row) => row.title.split(' — ')[0]))).toEqual(
      new Set(['Doktor Öğretim Üyesi', 'Profesör', 'Doçent']),
    );
  });

  it('Akdeniz Ü. (20.10-4-9): iki tablo (öğretim üyesi + öğretim görevlisi), sıra no her tabloda 1\'den', () => {
    const rows = extractAcademicOpenings(text('rg-20261020-4-9'));
    expect(rows).toHaveLength(29);
    expect(rows.filter((row) => row.title.startsWith('Öğretim Görevlisi'))).toHaveLength(8);
    expect(rows.find((row) => row.title.startsWith('Öğretim Görevlisi (ders vermekle görevli)'))).toMatchObject({
      quota: 1,
      degree: 5,
    });
  });

  it('Atatürk Ü. (15.10-4-10): tek satırlı küçük harfli tablo', () => {
    const rows = extractAcademicOpenings(text('rg-20261015-4-10'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quota: 1, degree: 1 });
    expect(rows[0]?.title).toMatch(/^Doktor Öğretim Üyesi — Tıp Fakültesi/);
  });

  it('başlık yoksa ya da sıra numarası bozuksa tablo üretilmez (kanıtsız satır yok)', () => {
    expect(extractAcademicOpenings('1 EĞİTİM FAKÜLTESİ PROFESÖR 1 1 açıklama 2 FEN FAKÜLTESİ DOÇENT 1 1')).toEqual([]);
    const header = 'S.N. BİRİM BÖLÜM ÜNVAN DER. ADET İLAN ŞARTLARI\n';
    expect(
      extractAcademicOpenings(`${header}1 EĞİTİM FAKÜLTESİ PROFESÖR 1 1 şart 3 FEN FAKÜLTESİ DOÇENT 1 1 şart`),
    ).toEqual([]);
    expect(
      extractAcademicOpenings(`${header}1 EĞİTİM FAKÜLTESİ PROFESÖR 1 1 şart 2 FEN FAKÜLTESİ DOÇENT 1 1 şart`),
    ).toHaveLength(2);
  });

  it('mahalli idare tablosu varsa önceliklidir (davranış değişmez)', () => {
    const municipal =
      'S.No Kadro/Pozisyon Unvanı Hizmet Sınıfı Derecesi Adedi Niteliği\n1 Mühendis TH 8 1 İnşaat Mühendisliği lisans\n';
    expect(extractOpenings(municipal)[0]?.serviceClass).toBe('TH');
  });
});

describe('kontenjan — çok pozisyonlu ilanlar', () => {
  const run = (body: string) =>
    extract({ title: 'Kamu Kurumu Personel Alım İlanı', body, listing: {}, links: [], attachments: [], bodySource: 'document' } as never);

  it('üniversite ilanında kontenjan tablo toplamıdır', () => {
    expect(run(text('rg-20261016-4-14')).quota).toBe(37);
    expect(run(text('rg-20261020-4-9')).quota).toBe(29);
  });

  it('Sayıştay (16.10-4-1): "2 (iki) … Personeli alınacaktır" toplamı pozisyon başı "(1 Kişi" önüne geçer', () => {
    expect(run(text('rg-20261016-4-1')).quota).toBe(2);
  });
});
