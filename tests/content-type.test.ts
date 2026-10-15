/**
 * İçerik türü eşlemesi (deterministik). Yalnızca `personnel_recruitment` ilan sayılır.
 * Negatif örneklerde tür, ilanla karışmayacak bir türdür; belirsiz kayıt `uncertain` olur.
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { contentTypeOf, JOB_CONTENT_TYPES } from '../src/classification/content-type';

const NEWS_BODY =
  'Kurum internet sitesinde yayımlanan haber metni. Ayrıntılar için kurum sayfasını ziyaret ediniz. Basın birimi tarafından paylaşılmıştır.';

const cases: Array<[string, string]> = [
  ['2026-YKS Ek Yerleştirme Tercihleri Başladı', 'student_admission'],
  ['Öncelikli Alanlardaki Doktora Programlarına Öğrenci Seçme Sınavı', 'student_admission'],
  ['2026 Sağlık Lisans Tamamlama Başvuru ve Tercih İşlemleri', 'student_admission'],
  [
    'Hindistan Teknik ve Ekonomik İşbirliği Eğitim Programı kapsamındaki uzmanlık eğitimleri',
    'education_program',
  ],
  ['Üniversite İzleme ve Değerlendirme Raporu', 'report_or_publication'],
  ['Uluslararası Kirletmeden Üretmek Mümkün konferansı', 'event'],
  ["Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere sınav uyarısı", 'news'],
  ['Uluslararası araştırma programlarına başvuru duyurusu', 'other'],
  ['Millî Eğitim Bakanlığı Sözleşmeli Bilişim Personeli Alımı', 'personnel_recruitment'],
  [
    'Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru',
    'personnel_process_announcement',
  ],
];

describe('içerik türü (deterministik eşleme)', () => {
  for (const [title, expected] of cases) {
    it(`"${title.slice(0, 55)}" → ${expected}`, () => {
      const body =
        expected === 'personnel_recruitment'
          ? 'Kadro unvanı Bilişim Personeli. Kontenjan 2. Başvurular 01.10.2026 - 30.10.2026 tarihleri arasında alınacaktır.'
          : NEWS_BODY;
      const result = classify({
        title,
        body,
        // Kategori, eval fixture'ındaki gerçek değerlerle aynıdır: haber kayıtları
        // "Haberler", `other` kaydı "Duyurular" kategorisindedir.
        sourceCategory:
          expected === 'personnel_recruitment' ? 'personel alımı' : expected === 'other' ? 'Duyurular' : 'Haberler',
      });
      expect(result.contentType).toBe(expected);
    });
  }

  it('başlıkta haber ipucu yoksa kaynağın "Haberler" kategorisi ret etiketini news yapar', () => {
    // Regresyon: bu dört başlık eval kümesinde news → other karışıklığı üretiyordu
    // (news recall %50). Karar yine reject'tir; değişen yalnızca alt tür etiketi.
    const titles = [
      'Türkiye’nin Suriye’deki eğitim desteği yeni döneme taşınıyor',
      'Koç Üniversitesi ile Bitlis Eren Üniversitesi kardeş oldu',
      'Üniversitelerde yeni eğitim anlayışı: Daha az ders, daha fazla uygulama',
      'Yükseköğretim Kurulundan Teknoloji Transfer Ofislerine üretim tesisi kurma ve işletme yetkisi',
    ];
    for (const title of titles) {
      const result = classify({ title, body: NEWS_BODY, sourceCategory: 'Haberler' });
      expect(result.decision).toBe('reject');
      expect(result.contentType).toBe('news');
    }
  });

  it('haber kategorisi daha özgül türleri ve kabul kararını EZMEZ', () => {
    const event = classify({
      title: 'Uluslararası Kirletmeden Üretmek Mümkün konferansı',
      body: NEWS_BODY,
      sourceCategory: 'Haberler',
    });
    expect(event.contentType).toBe('event');
    const duyuru = classify({
      title: 'Türkiye’nin Suriye’deki eğitim desteği yeni döneme taşınıyor',
      body: NEWS_BODY,
      sourceCategory: 'Duyurular',
    });
    expect(duyuru.contentType).toBe('other');
  });

  it('yalnızca personel alımı ilan türü sayılır', () => {
    expect(JOB_CONTENT_TYPES).toEqual(['personnel_recruitment']);
  });

  it('review kararı uncertain olur', () => {
    expect(
      contentTypeOf({ decision: 'review', kind: 'job', rules: [], normalizedTitle: 'kurum duyurusu' }),
    ).toBe('uncertain');
  });

  it('accept + process süreç duyurusu olarak eşlenir', () => {
    expect(contentTypeOf({ decision: 'accept', kind: 'process', rules: [], normalizedTitle: '' })).toBe(
      'personnel_process_announcement',
    );
  });

  it('kurala bağlı öğrenci kabulü redde bağlanır (başlık ipucundan önce)', () => {
    expect(
      contentTypeOf({
        decision: 'reject',
        kind: 'job',
        rules: ['ret-baslik.ogrenci-kabul-tercih'],
        normalizedTitle: 'konferans',
      }),
    ).toBe('student_admission');
  });
});
