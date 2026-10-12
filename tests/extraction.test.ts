/**
 * Çıkarım motoru testleri — Türkçe tarih, kontenjan, şehir, şartlar.
 * Metinler gerçek ilan diline yakın örneklerdir; dış kaynağa istek atılmaz.
 */
import { describe, expect, it } from 'vitest';
import {
  collectAttachmentLinks,
  extract,
  extractAge,
  extractApplicationUrl,
  extractCity,
  extractEducationLevels,
  extractKpss,
  extractQuota,
} from '../src/extraction/engine';

describe('tarih çıkarımı', () => {
  it('Türkçe tarih aralığını doğru ayrıştırır', () => {
    const result = extract({
      title: 'Sözleşmeli Personel Alım İlanı',
      body:
        'Başvurular 14/09/2026 (09:00) – 24/09/2026 (23:59) tarihleri arasında e-Devlet üzerinden yapılacaktır.',
    });
    expect(result.applicationStartAt).toBe('2026-09-14T09:00:00+03:00');
    expect(result.applicationEndAt).toBe('2026-09-24T23:59:00+03:00');
    expect(result.applicationEndDate).toBe('2026-09-24');
  });

  it('"son başvuru tarihi" kalıbını okur', () => {
    const result = extract({
      title: 'Sürekli İşçi Alım İlanı',
      body: 'Son başvuru tarihi: 26.10.2026 olup başvurular e-Devlet üzerinden alınacaktır.',
    });
    expect(result.applicationEndDate).toBe('2026-10-26');
  });

  it('ortak ay/yıl kullanan aralığı aritmetikle çözer', () => {
    const result = extract({
      title: 'Kamu İşçisi Alım İlanı',
      body: 'Başvurular 12-26 Ekim 2026 tarihleri arasında yapılacaktır.',
    });
    expect(result.applicationStartAt?.slice(0, 10)).toBe('2026-10-12');
    expect(result.applicationEndAt?.slice(0, 10)).toBe('2026-10-26');
  });

  it('yıl yoksa tarih uydurmaz ve bunu not olarak bildirir', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Son başvuru 24 Eylül tarihine kadar yapılacaktır. Başvuru formu ektedir.',
    });
    expect(result.applicationEndAt).toBeNull();
    expect(result.applicationEndDate).toBeNull();
    expect(result.notes.join(' ')).toContain('yıl belirtilmediği');
  });

  it('tarih içermeyen metinde tarih üretmez', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Başvurular başlamıştır. Detaylar kurumumuz internet sitesinde yer almaktadır.',
    });
    expect(result.applicationStartAt).toBeNull();
    expect(result.applicationEndAt).toBeNull();
  });

  it('kaynağın verdiği yapılandırılmış tarihleri korur', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Başvurular e-Devlet üzerinden alınacaktır.',
      applicationEndAt: '2026-11-01T23:59:00+03:00',
      bodySource: 'listing',
    });
    expect(result.applicationEndDate).toBe('2026-11-01');
    expect(result.fieldSources.applicationEndDate).toBe('listing');
  });
});

describe('kontenjan ve şehir', () => {
  it('kontenjanı kişi/adet ifadesinden çıkarır', () => {
    expect(extractQuota('Kontenjan 25 kişidir.').quota).toBe(25);
    expect(extractQuota('30 adet sözleşmeli personel alınacaktır.').quota).toBe(30);
    expect(extractQuota('Toplam 120 personel alınacak.').quota).toBe(120);
  });

  it('kanun/puan sayılarını kontenjan sanmaz', () => {
    expect(extractQuota('657 sayılı Devlet Memurları Kanunu kapsamında alım yapılacaktır.').quota).toBeNull();
  });

  it('metinden ili bulur', () => {
    expect(extractCity('Görev yeri Ankara’dır. Ankara ve İstanbul için kontenjan ayrılmıştır.').city).toBe('Ankara');
    expect(extractCity('İlan metninde şehir bilgisi yoktur.').city).toBeNull();
  });

  it('il bilgisini ilan çıktısına taşır', () => {
    const result = extract({
      title: 'Hemşire Alım İlanı',
      body: 'Görev yeri Şanlıurfa olup 40 kişi alınacaktır.',
    });
    expect(result.city).toBe('Şanlıurfa');
    expect(result.quota).toBe(40);
  });
});

describe('kurum, unvan ve şartlar', () => {
  it('Resmî Gazete başlığından kurumu çıkarır', () => {
    const result = extract({
      title: 'Şırnak Üniversitesi Rektörlüğünden:',
      body: 'Üniversitemize sürekli işçi alınacaktır.',
    });
    expect(result.institution).toContain('Şırnak Üniversitesi');
  });

  it('kaynağın verdiği kurumu otoriter kabul eder', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Kurumumuz personel alacaktır.',
      institutionHint: 'ORTAHİSAR BELEDİYE BAŞKANLIĞI',
    });
    expect(result.institution).toBe('ORTAHİSAR BELEDİYE BAŞKANLIĞI');
    expect(result.fieldSources.institution).toBe('listing');
  });

  it('unvanları sözlükten bulur ve jenerik unvanları ayıklar', () => {
    const result = extract({
      title: 'Psikolog ve Sosyal Çalışmacı Alım İlanı',
      body: 'Kurumumuza psikolog ve sosyal çalışmacı alınacaktır.',
    });
    expect(result.titles).toContain('psikolog');
    expect(result.titles).toContain('sosyal çalışmacı');
  });

  it('öğrenim seviyelerini çıkarır', () => {
    expect(extractEducationLevels('En az lisans mezunu olmak').levels).toEqual(['lisans']);
    expect(extractEducationLevels('Ön lisans mezunları başvurabilir.').levels).toEqual(['onlisans']);
    expect(extractEducationLevels('Ortaöğretim (lise) mezunu olmak şarttır.').levels).toEqual(['ortaogretim']);
    expect(extractEducationLevels('Metinde öğrenim bilgisi yer almıyor.').levels).toEqual([]);
  });

  it('KPSS puan türü, taban puan ve yılı çıkarır', () => {
    const kpss = extractKpss('2026 KPSS P3 puan türünden en az 70 puan almış olmak gerekmektedir.');
    expect(kpss.scoreTypes).toEqual(['P3']);
    expect(kpss.minScore).toBe(70);
    expect(kpss.year).toBe(2026);
  });

  it('yaş şartlarını çıkarır', () => {
    const age = extractAge('18 yaşını tamamlamış, 35 yaşını doldurmamış olmak');
    expect(age.minAge).toBe(18);
    expect(age.maxAge).toBe(35);
  });

  it('bölüm, sertifika, deneyim ve dil şartlarını çıkarır', () => {
    const result = extract({
      title: 'Psikolog Alım İlanı',
      body:
        'Psikoloji, Sosyoloji ve Sosyal Hizmet bölümlerinden mezun olmak. ' +
        'En az 2 yıl deneyim sahibi olmak. B sınıfı sürücü belgesi (ehliyet) sahibi olmak. ' +
        'İngilizce bilmek tercih sebebidir.',
    });
    expect(result.requirements.departments).toContain('psikoloji');
    expect(result.requirements.departments).toContain('sosyal hizmet');
    expect(result.requirements.minExperienceYears).toBe(2);
    expect(result.requirements.certificates.length).toBeGreaterThan(0);
    expect(result.requirements.foreignLanguages).toContain('İngilizce');
  });

  it('özel koşulları işaretler', () => {
    const result = extract({
      title: 'Güvenlik Görevlisi Alım İlanı',
      body: 'Adayların güvenlik soruşturması ve arşiv araştırması yapılacaktır. Askerliğini yapmış olmak gerekir.',
    });
    expect(result.requirements.specialConditions).toContain('Güvenlik soruşturması şartı');
    expect(result.requirements.specialConditions).toContain('Askerlik durumu şartı');
  });
});

describe('başvuru bağlantıları ve ekler', () => {
  it('başvuru ekranı bağlantısını bulur', () => {
    const url = extractApplicationUrl([
      { text: 'Aday İşlemleri Sistemi', url: 'https://ais.osym.gov.tr/' },
      { text: 'Ayrıntı', url: 'https://www.osym.gov.tr/duyuru/1' },
    ]);
    expect(url).toContain('ais.osym.gov.tr');
  });

  it('Kariyer Kapısı bağlantısını tanır', () => {
    const url = extractApplicationUrl([{ text: 'Başvuru Yap', url: 'https://kariyerkapisi.gov.tr/isealim' }]);
    expect(url).toContain('kariyerkapisi.gov.tr');
  });

  it('sosyal medya ve belge bağlantılarını başvuru sanmaz', () => {
    const url = extractApplicationUrl([
      { text: 'Başvuru formu', url: 'https://example.gov.tr/basvuru-formu.pdf' },
      { text: 'Twitter', url: 'https://twitter.com/kurum' },
    ]);
    expect(url).toBeNull();
  });

  it('başvuru bağlantısı yoksa uydurmaz', () => {
    const url = extractApplicationUrl([{ text: 'Ana sayfa', url: 'https://ordu.edu.tr' }]);
    expect(url).toBeNull();
  });

  it('PDF eklerini listeler', () => {
    const attachments = collectAttachmentLinks([
      { text: 'İlan Metni (PDF)', url: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-5.pdf' },
      { text: 'Başvuru Formu', url: 'https://example.gov.tr/form.docx' },
      { text: 'Ana sayfa', url: 'https://example.gov.tr/' },
    ]);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]?.kind).toBe('pdf');
    expect(attachments[1]?.kind).toBe('doc');
  });
});
