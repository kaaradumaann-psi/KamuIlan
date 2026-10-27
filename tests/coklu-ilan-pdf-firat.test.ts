/**
 * Üretim bulgusu (27.10.2026): RG 26.10.2026-4-4 (Fırat Üniversitesi) tek PDF'te iki ilan taşıyor:
 *  1) Öğretim üyesi: 65 kadro (21 Prof., 22 Doç., 22 Dr. Öğr. Üyesi); "Başvurular ilan yayım
 *     tarihinden itibaren 15 gündür" → son başvuru 09.11.2026; şahsen teslim.
 *  2) Öğretim elemanı: 15 kadro (12 Arş. Gör., 3 Öğr. Gör.); son başvuru 10.11.2026; 16.11.2026
 *     SINAV tarihidir.
 * Eski davranış: tek kayıt, son başvuru 16.11.2026 (sınav günü), yöntem "e-Devlet, şahsen veya posta".
 * Metin resmî PDF'ten (pdfjs) çıkarılmıştır: fixtures/resmigazete/20261026-4-4-firat.txt.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extract, extractApplicationWindow, stripNonApplicationDates } from '../src/extraction/engine';
import { splitResmiGazeteAnnouncements } from '../src/sources/adapters/resmigazete';

const text = readFileSync(new URL('../fixtures/resmigazete/20261026-4-4-firat.txt', import.meta.url), 'utf8');
const PUBLISHED = '2026-10-26T00:00:00+03:00';

describe('Resmî Gazete çoklu ilan PDF (Fırat Ü.)', () => {
  const segments = splitResmiGazeteAnnouncements(text);

  it('iki ayrı ilana bölünür', () => {
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatch(/ÖĞRETİM ÜYESİ ALIM İLANI/u);
    expect(segments[1]).toMatch(/^Fırat Üniversitesi Rektörlüğünden:/u);
    expect(segments[1]).toMatch(/Öğretim Elemanı alınacaktır/u);
  });

  it('öğretim üyesi ilanı: 65 kadro, son başvuru 09.11.2026 (yayım günü dahil 15 gün)', () => {
    const job = extract({ title: 'Fırat Üniversitesi Rektörlüğünden: ÖĞRETİM ÜYESİ ALIM İLANI', body: segments[0], listing: { publishedAt: PUBLISHED }, bodySource: 'document' });
    expect(job.applicationEndDate).toBe('2026-11-09');
    expect(job.quota).toBe(65);
    const byTitle = job.openings.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.title]: (acc[o.title] ?? 0) + o.quota }), {});
    expect(byTitle).toEqual({ Profesör: 21, Doçent: 22, 'Doktor Öğretim Üyesi': 22 });
    expect(job.applicationMethod ?? '').not.toMatch(/posta/iu);
  });

  it('öğretim elemanı ilanı: son başvuru 10.11.2026; 16.11.2026 sınav tarihi son başvuru sayılmaz', () => {
    const job = extract({ title: 'Fırat Üniversitesi Rektörlüğünden: ÖĞRETİM ELEMANI ALIM İLANI', body: segments[1], listing: { publishedAt: PUBLISHED }, bodySource: 'document' });
    expect(job.applicationEndDate).toBe('2026-11-10');
    expect(job.applicationStartAt?.slice(0, 10)).toBe('2026-10-26');
  });

  it('ayraçsız tek ilan bölünmez', () => {
    expect(splitResmiGazeteAnnouncements('Kurumdan: ilan metni')).toEqual(['Kurumdan: ilan metni']);
  });
});

describe('başvuru penceresi etiketleri', () => {
  it('sınav/sonuç etiketli tarihler çıkarılır', () => {
    const cleaned = stripNonApplicationDates('Sınava Giriş Tarih : 16.11.2026 Sınav Açıklama Tarihi : 18.11.2026 Son Başvuru Tarihi : 10.11.2026');
    expect(cleaned).not.toMatch(/16\.11\.2026|18\.11\.2026/u);
    expect(cleaned).toMatch(/10\.11\.2026/u);
  });

  it('iş günü cinsinden göreli süreden tarih üretilmez', () => {
    const window = extractApplicationWindow('İlan', 'Başvurular ilan tarihinden itibaren 10 iş günü içinde yapılır.', { publishedAt: PUBLISHED });
    expect(window.end).toBeNull();
  });
});

describe('ilan.gov.tr metin artıkları (madde 13)', () => {
  it('logo yolu, kod, slug, &nbsp; ve zaman damgası gösterilmez; ilan metni korunur', async () => {
    const { makeExcerpt } = await import('../src/domain/text');
    const raw =
      '2269389 ILN02579840 Enformasyon Memurluğu Sınavı Hakkında Duyuru kamu-akademik-personel-kamu-personel-alim-ve-sinavlari-enformasyon-memurlugu-sinavi-hakkinda-duyuru İSTANBUL Beşiktaş AdvertiserLogo/5f5aa26e7fbe682aa4aac796.png M057822 TÜRKİYE SEYAHAT ACENTALARI BİRLİĞİ Basın İlan Kurumu ILN /AdSourceLogo/ILN.png Giresun&nbsp;Üniversitesi&nbsp;Rektörlüğünden /ilan/2269389/kamu-akademik-personel-x YYN-000647 SABAH 2026-10-05T00:00:00Z IlanEki/2026/10/26/ILN02579840/thumb/6adf5e.jpg Son başvuru Tarihi 03.11.2026 https://pdb.giresun.edu.tr/a-b-c-d';
    const clean = makeExcerpt(raw, 5000);
    expect(clean).not.toMatch(/AdvertiserLogo|AdSourceLogo|IlanEki|&nbsp;|ILN02579840|M057822|YYN-000647|2026-10-05T|kamu-akademik-personel-kamu/u);
    expect(clean).toMatch(/Giresun Üniversitesi Rektörlüğünden/u);
    expect(clean).toMatch(/Son başvuru Tarihi 03\.11\.2026/u);
    expect(clean).toMatch(/Enformasyon Memurluğu Sınavı/u);
  });
});
