/**
 * Yanlış personel ilanı regresyonu (kullanıcı spesifikasyonu, 15 Ekim 2026).
 *
 * Kural: kurumun resmî sitesinde yayımlanan her içerik personel alımı değildir.
 * Haber, öğrenci kabulü, eğitim programı, konferans, rapor ve kurum duyuruları
 * normal ilan listesinde (accept/job) GÖRÜNMEMELİDİR.
 *
 * Bu testler iki gövde ile çalışır:
 *  - NEWS_BODY: tipik kurum haberi gövdesi (alım ifadesi yok).
 *  - ADVERSARIAL_BODY: "başvuru", "kontenjan", "sözleşmeli personel alımı" gibi
 *    ilan dili içeren bir gövde. Başlık alım kanıtı taşımıyorsa bile kabul
 *    edilmemeli (en fazla inceleme).
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';

const NEWS_BODY =
  'Kurum internet sitesinde yayımlanan haber metni. Ayrıntılar için kurum sayfasını ziyaret ediniz. Basın birimi tarafından paylaşılmıştır.';

const ADVERSARIAL_BODY =
  'Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır. Kadro ve unvan bilgileri aşağıdadır. Sözleşmeli personel alımı yapılacak olup kontenjan 5 kişidir. Başvuru yöntemi e-Devlet üzerinden olacaktır. Lisans mezunu olmak şartı aranır.';

/** Spesifikasyondaki personel alımı OLMAYAN içerikler. */
const NOT_RECRUITMENT_TITLES: string[] = [
  'Türkiye’nin Suriye’deki eğitim desteği yeni döneme taşınıyor',
  'Koç Üniversitesi ile Bitlis Eren Üniversitesi kardeş oldu',
  'Üniversitelerde yeni eğitim anlayışı: Daha az ders, daha fazla uygulama',
  'Yükseköğretim Kurulundan Teknoloji Transfer Ofislerine üretim tesisi kurma ve işletme yetkisi',
  "Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere sınav uyarısı",
  "Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere müfredat çağrısı",
  "Yükseköğretim Kurulu Başkanı Özvar'dan İmam Buhârî'nin ilmî mirasının yaşatılması mesajı",
  "Yükseköğretim Kurulu Başkanı Özvar'dan İzmir'de Terörsüz Türkiye mesajı",
  '2026-YKS Ek Yerleştirme Tercihleri Başladı',
  'Öncelikli Alanlardaki Doktora Programlarına Öğrenci Seçme Sınavı',
  '2026 Sağlık Lisans Tamamlama Başvuru ve Tercih İşlemleri',
  'Hindistan Teknik ve Ekonomik İşbirliği Eğitim Programı kapsamındaki uzmanlık eğitimleri',
  'Üniversite İzleme ve Değerlendirme Raporu',
  'Uluslararası Kirletmeden Üretmek Mümkün konferansı',
  'Uluslararası araştırma programlarına başvuru duyurusu',
];

describe('personel alımı olmayan içerikler normal ilan listesine girmez', () => {
  for (const title of NOT_RECRUITMENT_TITLES) {
    it(`haber gövdesi: "${title.slice(0, 60)}" iş ilanı olarak kabul edilmez`, () => {
      const result = classify({ title, body: NEWS_BODY, sourceCategory: 'Haberler' });
      expect(result.decision).not.toBe('accept');
    });

    it(`ilan dilli gövde: "${title.slice(0, 60)}" yalnızca gövde kanıtıyla kabul edilmez`, () => {
      const result = classify({ title, body: ADVERSARIAL_BODY, sourceCategory: 'Duyurular' });
      expect(result.decision).not.toBe('accept');
    });
  }

  it('rektör adaylığı başvurusu (B kararı) reddedilmeye devam eder', () => {
    const result = classify({
      title: '5 Üniversite için Rektör Adaylığı Başvuru İlanı',
      body: ADVERSARIAL_BODY,
      sourceCategory: 'Duyurular',
    });
    expect(result.decision).toBe('reject');
  });
});

describe('başlık kanıtı olmadan gövdeden kabul edilmez (inceleme kuyruğu)', () => {
  it('başlıkta alım ifadesi yok, gövde ilan dilinde → review (accept değil)', () => {
    const result = classify({
      title: 'Kurum Duyurusu',
      body: ADVERSARIAL_BODY,
      sourceCategory: 'Duyurular',
    });
    expect(result.decision).toBe('review');
    expect(result.reasons.join(' ')).toContain('Başlıkta personel alımı ifadesi yok');
  });

  it('başlıkta alım ifadesi varsa gövde kanıtıyla kabul edilebilir (gerçek ilan regresyonu)', () => {
    const result = classify({
      title: 'Sözleşmeli Bilişim Personeli Alımı İlanı',
      body: ADVERSARIAL_BODY,
      sourceCategory: 'Duyurular',
    });
    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('job');
  });
});

describe('gerçek personel alımları reddedilmez', () => {
  it('Millî Eğitim Bakanlığı Sözleşmeli Bilişim Personeli Alımı → iş ilanı (accept)', () => {
    const result = classify({
      title: 'Millî Eğitim Bakanlığı Sözleşmeli Bilişim Personeli Alımı',
      body: ADVERSARIAL_BODY,
      sourceCategory: 'Personel Alımı',
    });
    expect(result.decision).toBe('accept');
    expect(result.kind).toBe('job');
  });

  it('kaynak kategorisi personel alımı ise başlık zayıf olsa da kabul (kategori kanıtı)', () => {
    const result = classify({
      title: 'Duyuru No 2026/14',
      body: ADVERSARIAL_BODY,
      sourceCategory: 'personel alımı',
    });
    expect(result.decision).toBe('accept');
  });
});

describe('personel süreç duyurusu iş ilanı olarak sunulmaz', () => {
  it('sözlü sınava çağrı duyurusu → süreç (accept/process), iş ilanı değil', () => {
    const result = classify({
      title: 'Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru',
      body: NEWS_BODY,
      sourceCategory: 'Haberler',
    });
    expect(result.kind).toBe('process');
  });
});
