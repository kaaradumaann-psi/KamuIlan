/**
 * Çıkarım motoru testleri — Türkçe tarih, kontenjan, şehir, şartlar, kanıt izleri.
 * Metinler gerçek ilan diline yakın örneklerdir; dış kaynağa istek atılmaz.
 */
import { describe, expect, it } from 'vitest';
import {
  extract,
  extractAge,
  extractApplicationUrl,
  extractCity,
  extractEducationLevels,
  extractKpss,
  extractQuota,
  uniqueAttachments,
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

  it('yıl yoksa tarih uydurmaz ve bunu belirsizlik olarak bildirir', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Son başvuru 24 Eylül tarihine kadar yapılacaktır. Başvuru formu ektedir.',
    });
    expect(result.applicationEndAt).toBeNull();
    expect(result.applicationEndDate).toBeNull();
    expect(result.uncertainties.join(' ')).toContain('yıl belirtilmediği');
  });

  it('tarih içermeyen metinde tarih üretmez', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Başvurular başlamıştır. Detaylar kurumumuz internet sitesinde yer almaktadır.',
    });
    expect(result.applicationStartAt).toBeNull();
    expect(result.applicationEndAt).toBeNull();
  });

  it('kaynağın verdiği yapılandırılmış tarihleri korur ve izini "listing" olarak işaretler', () => {
    const result = extract({
      title: 'Personel Alım İlanı',
      body: 'Başvurular e-Devlet üzerinden alınacaktır.',
      listing: { applicationEndAt: '2026-11-01T23:59:00+03:00' },
    });
    expect(result.applicationEndDate).toBe('2026-11-01');
    expect(result.applicationEndAt).toBe('2026-11-01T23:59:00+03:00');
    expect(result.fieldSources.applicationEndDate?.kind).toBe('listing');
  });
});

describe('kontenjan ve şehir', () => {
  it('kontenjanı kişi/adet ifadesinden çıkarır', () => {
    expect(extractQuota('Kontenjan 25 kişidir.')?.value).toBe(25);
    expect(extractQuota('30 adet sözleşmeli personel alınacaktır.')?.value).toBe(30);
    expect(extractQuota('Toplam 120 personel alınacak.')?.value).toBe(120);
  });

  it('kanun/puan sayılarını kontenjan sanmaz', () => {
    expect(extractQuota('657 sayılı Devlet Memurları Kanunu kapsamında alım yapılacaktır.')).toBeNull();
    expect(extractQuota('2026 KPSS P3 puan türünden en az 70 puan almak gerekir.')).toBeNull();
  });

  it('metinden ili bulur', () => {
    expect(extractCity('Görev yeri Ankara’dır. Ankara ve İstanbul için kontenjan ayrılmıştır.')).toBe('Ankara');
    expect(extractCity('İlan metninde şehir bilgisi yoktur.')).toBeNull();
  });

  it('il bilgisini ilan çıktısına taşır', () => {
    const result = extract({
      title: 'Hemşire Alım İlanı',
      body: 'Görev yeri Şanlıurfa olup 40 kişi alınacaktır.',
    });
    expect(result.city).toBe('Şanlıurfa');
    expect(result.quota).toBe(40);
    expect(result.fieldSources.city?.kind).toBe('detail');
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
      listing: { institution: 'ORTAHİSAR BELEDİYE BAŞKANLIĞI' },
    });
    expect(result.institution).toBe('ORTAHİSAR BELEDİYE BAŞKANLIĞI');
    expect(result.fieldSources.institution?.kind).toBe('listing');
  });

  it('unvanları sözlükten bulur ve jenerik unvanları ayıklar', () => {
    const result = extract({
      title: 'Psikolog ve Sosyal Çalışmacı Alım İlanı',
      body: 'Kurumumuza psikolog ve sosyal çalışmacı alınacaktır.',
    });
    // Sözlük görünen adı korur ("Psikolog"), karşılaştırma Türkçe küçük harfle yapılır.
    const titles = result.titles.map((title) => title.toLocaleLowerCase('tr-TR'));
    expect(titles).toContain('psikolog');
    expect(titles).toContain('sosyal çalışmacı');
  });

  it('öğrenim seviyelerini çıkarır', () => {
    expect(extractEducationLevels('En az lisans mezunu olmak')).toEqual(['lisans']);
    expect(extractEducationLevels('Ön lisans mezunları başvurabilir.')).toEqual(['onlisans']);
    expect(extractEducationLevels('Ortaöğretim (lise) mezunu olmak şarttır.')).toEqual(['ortaogretim']);
    expect(extractEducationLevels('Metinde öğrenim bilgisi yer almıyor.')).toEqual([]);
  });

  it('KPSS puan türü, taban puan ve yılı çıkarır', () => {
    const kpss = extractKpss('2026 KPSS P3 puan türünden en az 70 puan almış olmak gerekmektedir.');
    expect(kpss.types).toEqual(['P3']);
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
    const departments = result.departments.map((department) => department.toLocaleLowerCase('tr-TR'));
    expect(departments).toContain('psikoloji');
    expect(departments).toContain('sosyal hizmet');
    expect(result.minExperienceYears).toBe(2);
    expect(result.certificates.length).toBeGreaterThan(0);
    expect(result.foreignLanguages).toContain('İngilizce');
  });

  it('özel koşulları işaretler', () => {
    const result = extract({
      title: 'Güvenlik Görevlisi Alım İlanı',
      body: 'Adayların güvenlik soruşturması ve arşiv araştırması yapılacaktır. Askerliğini yapmış olmak gerekir.',
    });
    expect(result.specialConditions).toContain('Güvenlik soruşturması şartı');
    expect(result.specialConditions).toContain('Askerlik durumu şartı');
  });
});

describe('başvuru bağlantıları ve ekler', () => {
  it('başvuru ekranı bağlantısını bulur', () => {
    const url = extractApplicationUrl(
      [
        { text: 'Aday İşlemleri Sistemi', url: 'https://ais.osym.gov.tr/' },
        { text: 'Ayrıntı', url: 'https://www.osym.gov.tr/duyuru/1' },
      ],
      'Sözleşmeli Personel Alım İlanı',
      'Başvurular Aday İşlemleri Sistemi üzerinden alınacaktır.',
    );
    expect(url).toContain('ais.osym.gov.tr');
  });

  it('Kariyer Kapısı bağlantısını tanır', () => {
    const url = extractApplicationUrl(
      [{ text: 'Başvuru Yap', url: 'https://kariyerkapisi.gov.tr/isealim' }],
      'Personel Alım İlanı',
      'Başvurular Kariyer Kapısı üzerinden yapılacaktır.',
    );
    expect(url).toContain('kariyerkapisi.gov.tr');
  });

  it('sosyal medya ve belge bağlantılarını başvuru sanmaz', () => {
    const url = extractApplicationUrl(
      [
        { text: 'Başvuru formu', url: 'https://example.gov.tr/basvuru-formu.pdf' },
        { text: 'Twitter', url: 'https://twitter.com/kurum' },
      ],
      'Personel Alım İlanı',
      'Başvuru formu ilanda ektedir.',
    );
    expect(url).toBeNull();
  });

  it('ilan listeleme sitelerinin detay bağlantısını başvuru saymaz', () => {
    const url = extractApplicationUrl(
      [{ text: 'İlanı görüntüle', url: 'https://www.ilan.gov.tr/ilan/123456/ornek-kurum-personel-alimi' }],
      'Personel Alım İlanı',
      'İlan metni ekte yer almaktadır.',
    );
    expect(url).toBeNull();
  });

  it('başvuru bağlantısı yoksa uydurmaz', () => {
    const url = extractApplicationUrl(
      [{ text: 'Ana sayfa', url: 'https://ordu.edu.tr' }],
      'Personel Alım İlanı',
      'Başvurular kurumumuz internet sitesinde açıklanacaktır.',
    );
    expect(url).toBeNull();
  });

  it('ekleri tekilleştirir ve sırayı korur', () => {
    const attachments = uniqueAttachments([
      { url: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-5.pdf', label: 'İlan Metni', kind: 'pdf' },
      { url: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261012-4-5.pdf', label: 'İlan Metni (tekrar)', kind: 'pdf' },
      { url: 'https://example.gov.tr/basvuru-formu.docx', label: 'Başvuru Formu', kind: 'doc' },
    ]);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]?.kind).toBe('pdf');
    expect(attachments[1]?.kind).toBe('doc');
  });
});
