/**
 * Ünvan/kadro + alım/temin kalıpları regresyonu (2026-10-16 canlı koşum bulgusu).
 *
 * Canlı panelde görülen sorun: gerçek personel alımı başlıkları — "Hemşire, ebe
 * ve sağlık teknikeri alımı", "destek personeli alımı", "veri hazırlama ve
 * kontrol işletmeni alımı", "uzman erbaş temin ilanı" — kanıt kapısından
 * geçemediği için `reject` oluyordu. Kayıp ilanlar akışa hiç girmiyordu.
 *
 * Bu dosya iki yönlü kilitler:
 *  1) gerçek ünvan/temin başlıkları artık kabul edilir (yanlış negatif yok),
 *  2) tedarik/dizin gürültüsü reddedilmeye DEVAM eder (yanlış pozitif yok).
 */
import { describe, expect, it } from 'vitest';
import { classify, preFilterListingItem } from '../src/classification/engine';
import { POSITION_RECRUITMENT_PATTERN, RECRUITMENT_EVIDENCE_PATTERN } from '../src/classification/rules';
import { normalizeTr } from '../src/domain/text';

/** Gerçek alım başlıkları: hepsi akışa girmeli. */
const REAL_TITLES = [
  'HEMŞİRE, EBE VE SAĞLIK TEKNİKERİ ALIMI',
  'AŞÇI, ŞOFÖR VE TEMİZLİK GÖREVLİSİ ALIMI',
  'VERİ HAZIRLAMA VE KONTROL İŞLETMENİ ALIMI',
  'MÜBAŞİR, ZABIT KÂTİBİ VE İNFAZ VE KORUMA MEMURU ALIMI',
  'DESTEK PERSONELİ ALIMI',
  'T.C. İÇİŞLERİ BAKANLIĞI 300 SÖZLEŞMELİ KORUMA VE GÜVENLİK GÖREVLİSİ ALIMI',
  'ARAŞTIRMA GÖREVLİSİ VE ÖĞRETİM GÖREVLİSİ ALIMI',
  'TÜBİTAK BİLGEM 2026 YILI 30 PROJE PERSONELİ ALIMI',
  'MİLLÎ SAVUNMA BAKANLIĞI 2026 YILI MUVAZZAF SUBAY/ASTSUBAY TEMİNİ',
  'JANDARMA GENEL KOMUTANLIĞI 2027 YILI UZMAN ERBAŞ TEMİN İLANI',
  'SAHİL GÜVENLİK KOMUTANLIĞI SÖZLEŞMELİ ERBAŞ VE ER TEMİNİ DUYURUSU',
  'JANDARMA VE SAHİL GÜVENLİK AKADEMİSİ BAŞKANLIĞI - 2027 YILI J.GN.K.LIĞI MUVAZZAF SUBAY TEMİNİ',
] as const;

/** Tedarik ve dizin gürültüsü: hiçbiri kabul edilmemeli. */
const NOISE_TITLES = [
  'BİLGİSAYAR VE DONANIM ALIMI',
  'TIBBİ CİHAZ ALIMI İHALESİ',
  'AKARYAKIT ALIMI',
  'YAZILIM ALIMI VE GELİŞTİRME HİZMETİ',
  'KIRTASİYE MALZEMESİ ALIMI',
  'TEMİZLİK HİZMET ALIMI',
  'GÜVENLİK HİZMETİ ALIMI',
  'YEMEK HİZMETİ ALIMI İHALESİ',
  'ARAÇ KİRALAMA HİZMETİ',
  'MAL ALIMI İHALESİ (2026/100)',
  'İNŞAAT YAPIM İŞİ İHALESİ',
  'Sıkça Sorulan Sorular',
  'Bilgi Güvenliği Politikası',
  'HABERLER & DUYURULAR',
  'SEMPOZYUM VE SERGİLER',
  'GENERAL TECHNICAL SPECIFICATIONS',
  '2026 Yılı Eylül Ayı Rayiç Fiyatları',
  'KGM Heyeti Japonya’da Teknik İncelemelerde Bulundu',
  'Ana Sayfa İlanlar Kamu Memur Alım İlanları',
  '9 Eylül 2026 e-YDS 2026/10 (İngilizce): Başvuruların Alınması',
  '2224-Bilimsel Etkinliklere Katılımı Destekleme Programları 2026 Yılı 3. Dönem Çağrıları Açıldı',
  'GüncelTapu Arşivleri Dijital Dönüşüm (TADD) Projesi',
] as const;

describe('sınıflandırma: ünvan + alım/temin kanıtı', () => {
  it.each([...REAL_TITLES])('gerçek başlığı kabul eder: %s', (title) => {
    const result = classify({ title, sourceKey: 'regresyon' });

    expect(result.decision).toBe('accept');
    expect(result.contentType).toBe('personnel_recruitment');
    expect(result.rules).toContain('pozitif.unvan-alimi');
  });

  it.each([...REAL_TITLES])('gerçek başlık kanıt kapısından geçer: %s', (title) => {
    expect(RECRUITMENT_EVIDENCE_PATTERN.test(normalizeTr(title))).toBe(true);
    expect(POSITION_RECRUITMENT_PATTERN.test(normalizeTr(title))).toBe(true);
  });

  it('liste ön filtresi gerçek ünvan başlığını atlamaz (detay indirilir)', () => {
    const filtered = preFilterListingItem({ title: 'HEMŞİRE, EBE VE SAĞLIK TEKNİKERİ ALIMI' });

    expect(filtered.action).not.toBe('skip');
    expect(filtered.decision.decision).toBe('accept');
  });

  it('ünvan türü belirsiz kalmaz: askerî/kolluk temini bir istihdam türüne bağlanır', () => {
    const result = classify({ title: 'JANDARMA GENEL KOMUTANLIĞI 2027 YILI UZMAN ERBAŞ TEMİN İLANI' });

    expect(result.employmentType).toBe('diger-kamu');
    expect(result.reasons.join(' ')).not.toContain('belirlenemedi');
  });

  it('gövde ile desteklenen temin ilanı kabul edilir', () => {
    const result = classify({
      title: 'UZMAN ERBAŞ TEMİN İLANI',
      body: 'Başvurular 01-30 Kasım 2026 tarihleri arasında alınacaktır. Adaylarda aranacak şartlar ve kontenjan bilgileri ilanda yer almaktadır.',
      sourceKey: 'regresyon',
    });

    expect(result.decision).toBe('accept');
    expect(result.contentType).toBe('personnel_recruitment');
  });

  it.each([...NOISE_TITLES])('tedarik/dizin gürültüsünü reddetmeye devam eder: %s', (title) => {
    const result = classify({ title, sourceKey: 'regresyon' });

    expect(result.decision).toBe('reject');
    expect(result.contentType).not.toBe('personnel_recruitment');
  });

  it('tedarik başlıkları ünvan sözlüğüne takılmaz (yanlış pozitif koruması)', () => {
    for (const title of ['BİLGİSAYAR ALIMI', 'AKARYAKIT ALIMI', 'HİZMET ALIMI', 'ARAÇ ALIMI']) {
      expect(POSITION_RECRUITMENT_PATTERN.test(normalizeTr(title))).toBe(false);
    }
  });
});

/**
 * Süreç duyurusu / yeni ilan sınırı (2026.10-16 canlı panel dökümü).
 *
 * Kanıt kalıpları ünvan+alım/temin başlıklarını yakalayacak şekilde
 * genişletilince, sürmekte olan bir alımın AŞAMA duyuruları ("…alımı sınav
 * duyurusu") yeni iş ilanı gibi kabul edilip bildirim üretmeye başlamıştı.
 * Bu başlıklar `kind: 'process'` kategorisinde kalmalı; "giriş sınavı" içeren
 * başlıklar ise GERÇEK ilandır ve dışlamayla korunur.
 */
describe('sınıflandırma: süreç duyurusu / yeni ilan sınırı', () => {
  it('sürmekte olan alımın sınav duyurusu süreç kategorisinde kalır', () => {
    const result = classify({
      title: 'Destek personeli alımı sınav duyurusu',
      body: 'Sözleşmeli destek personeli alımı kapsamında yapılacak sınava ilişkin bilgiler aşağıda yer almaktadır.',
      sourceKey: 'regresyon',
    });

    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('process');
    expect(result.contentType).toBe('personnel_process_announcement');
    expect(result.rules).toContain('süreç.personel-alimi');
  });

  it.each([
    'Sözleşmeli personel alımı sözlü sınav sonuçları',
    'Hemşire alımı kura duyurusu',
    'Personel alımı mülakat sonuçları açıklandı',
    'İşçi alımı nihai liste duyurusu',
  ])('aşama duyurusu süreç sayılır: %s', (title) => {
    const result = classify({ title, sourceKey: 'regresyon' });
    expect(result.decision).toBe('accept');
    expect(result.kind, JSON.stringify(result.reasons)).toBe('process');
  });

  it('"giriş sınavı" içeren başlık GERÇEK ilandır, sürece düşürülmez', () => {
    const result = classify({
      title: 'Uzman Yardımcılığı Giriş Sınavı Duyurusu',
      body: 'Kurumumuzda istihdam edilmek üzere 10 uzman yardımcısı alınacaktır. Başvurular e-Devlet üzerinden yapılacaktır.',
      sourceKey: 'regresyon',
    });

    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('job');
    expect(result.contentType).toBe('personnel_recruitment');
  });

  it('kurum içi görevde yükselme sınavı süreç kategorisinde kalır', () => {
    const result = classify({ title: 'Görevde yükselme sınavı duyurusu', sourceKey: 'regresyon' });
    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('process');
  });
});

/**
 * Kurumsal etkinlik/tören/fiyat duyuruları (KGM/DSİ/SPK/İçişleri dökümü):
 * inceleme kuyruğunu dolduran başlıklar kesin ret olur; alım ifadesi taşıyan
 * başlıklar kurala takılmaz.
 */
describe('sınıflandırma: kurumsal etkinlik başlıkları', () => {
  it.each([
    '2026 Yılı Rayiç Fiyatları',
    'Tarihi Köprünün Restorasyon Çalışmasının Açılışı Yapıldı',
    'GICC 2026 Kapsamında Heyet Ziyareti Gerçekleştirildi',
    'Japonya Heyeti ile Görüşme',
    'Kurumlar Arası İş Birliği Protokolü İmza Töreni',
    'Uluslararası Akıllı Ulaşım Sistemleri Yarışması',
    'Karayolları Fuarı Katılım Duyurusu',
  ])('etkinlik/tören/fiyat başlığı reddedilir: %s', (title) => {
    const result = classify({ title, sourceKey: 'regresyon' });
    expect(result.decision, JSON.stringify(result.reasons)).toBe('reject');
    expect(result.rules).toContain('ret-baslik.kurumsal-etkinlik');
  });

  it.each([
    'Ziyaretçi kabulünde görevlendirilecek 10 güvenlik personeli alımı',
    'Fuar alanında çalıştırılmak üzere 5 temizlik işçisi alımı',
    'Açılışı yapılan hizmet binasında görevlendirilecek sözleşmeli memur alımı',
    'Yarışma salonunda görevlendirilecek destek personeli temin ilanı',
  ])('alım ifadesi taşıyan başlık reddedilmez: %s', (title) => {
    const result = classify({
      title,
      body: 'Başvurular 01-30 Kasım 2026 tarihleri arasında alınacaktır. Adaylarda aranacak şartlar ilanda yer almaktadır.',
      sourceKey: 'regresyon',
    });
    expect(result.decision, JSON.stringify(result.reasons)).not.toBe('reject');
  });
});
