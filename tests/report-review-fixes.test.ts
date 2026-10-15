import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { isSiteChromeTitle } from '../src/domain/text';
import { plausibleApplicationEnd } from '../src/domain/dates';
import { computeStatus } from '../src/ingest/jobs-service';
import { reclassifyJob } from '../src/ingest/reclassify';
import type { JobDoc } from '../src/db/schemas';

/**
 * Supabase dry-run raporunda (2026-10-14) görülen gerçek başlıklar. Gövdeler raporun
 * kısa özetinden alınmıştır; kararlar başlık düzeyindeki kurallara dayanır.
 */
const run = (title: string, body = '') => classify({ title, body, sourceCategory: '' });

describe('rapor: sayfa kabuğu ve kategori başlıkları reddedilir', () => {
  it.each([
    [
      'T.C. İÇİŞLERİ BAKANLIĞI T.C. İÇİŞLERİ BAKANLIĞI BAKANLIK BAKANLIK Bakanımız Hakkımızda Teşkilat Şeması',
      'Sözleşmeli personel alımı giriş sınavı',
    ],
    [
      'Daha yüksek erişilebilirlik modunu aç Daha yüksek erişilebilirlik modunu kapat Karayolları Genel Müdürlüğü',
      'Karayolları Genel Müdürlüğü 50 işçi alımı',
    ],
    [
      'Sizlere daha iyi hizmet verebilmek için sitemizde çerezlere yer veriyoruz 🍪 Çerez politikamız hakkında bilgi',
      'İşçi alım ilanları',
    ],
    ['Ana Sayfa İlanlar Kurumdışı Kamu İşçi Alım İlanları', 'Erişilebilirlik Menüsü kamu işçi alımı'],
    ['Kamu Memur Alım İlanları', 'Erişilebilirlik Menüsü Ekran Okuyucu'],
    ['Kurumdışı Kamu İşçi Alım ...', 'Erişilebilirlik Menüsü Çerez Ayarları'],
    ['PERSONEL DAİRESİ BAŞKANLIĞI', 'Anasayfa Tarım ve Orman Bakanlığı'],
    [
      'ARAZİ TOPLULAŞTIRMASI ETÜT VE PROJELENDİRME DAİRESİ BAŞKANLIĞI',
      'Giriş sınavı Personel alım ilanı menü bağlantıları',
    ],
  ])('reddedilir: %s', (title, body) => {
    const result = run(title, body);
    expect(result.decision).toBe('reject');
    expect(result.kind).toBe('job');
  });

  it('sayfa kabuğu başlığı adaptörde de ilan olarak alınmaz', () => {
    expect(isSiteChromeTitle('Sizlere daha iyi hizmet verebilmek için çerezlere yer veriyoruz')).toBe(true);
    expect(isSiteChromeTitle('Daha yüksek erişilebilirlik modunu aç')).toBe(true);
    expect(
      isSiteChromeTitle('Karayolları Genel Müdürlüğüne Bağlı İşyerlerine 50 İşçi Personel Alımı Hk.'),
    ).toBe(false);
    expect(isSiteChromeTitle('Erzurum İlindeki İş Yerlerimize 1 Engelli İşçi Alınacaktır')).toBe(false);
  });
});

describe('rapor: gerçek ilanlar reddedilmez (negatif kontrol)', () => {
  it.each([
    [
      'Karayolları Genel Müdürlüğüne Bağlı İşyerlerine 50 İşçi Personel Alımı Hk.',
      'Karayolları Genel Müdürlüğü işyerlerine 50 işçi alınacaktır. Başvuru şartları aşağıdadır.',
    ],
    [
      'Erzurum İlindeki İş Yerlerimize 1 Engelli İşçi Alınacaktır',
      'İşyerimize 1 engelli işçi alınacaktır. Başvurular kariyer kapısı üzerinden yapılır.',
    ],
    [
      'BANKACILIK DÜZENLEME VE DENETLEME KURUMU BAŞKANLIĞI (BDDK) - BANKACILIK DÜZENLEME VE DENETLEME KURUMU 2026 YILI MESLEK PERSONELİ GİRİŞ SINAVI İLANI',
      'Bankacılık Uzman Yardımcısı giriş sınavı yazılı ve sözlü olmak üzere iki aşamalıdır. İstanbul.',
    ],
    [
      'ÖZELLEŞTİRME İDARESİ BAŞKANLIĞI - 2026-2 ÖZELLEŞTİRME İDARESİ BAŞKANLIĞI UZMAN YARDIMCILIĞI GİRİŞ SINAVI DUYURUSU',
      'Uzman yardımcılığı giriş sınavı ile 14 adet kadroya atama yapılacaktır.',
    ],
    [
      'Kamu Personel Alım İlanı 2026',
      'Kamu kurumunda personel alım ilanı. Kadro sayısı 5. Başvuru şartları aşağıdadır.',
    ],
  ])('kabul kalır: %s', (title, body) => {
    const result = run(title, body);
    expect(result.decision).not.toBe('reject');
  });
});

describe('rapor: süreç duyuruları ayrı kategoride kalır', () => {
  it('yedek aday duyurusu (sonuç aşaması) süreç olur', () => {
    const result = run(
      "20 Nisan 2026 Tarihli ve 33230 Sayılı Resmi Gazete'de Yayımlanan 35 Sözleşmeli Personel Alımı Yedek Aday Duyurusu",
      'Yedek aday listesi aşağıdadır.',
    );
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
  });

  it('bilişim sınavı çağrı listesi süreç olarak kalır (regresyon)', () => {
    const result = run(
      'Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru',
      'Sınav tarihleri için tıklayınız.',
    );
    expect(result.kind).toBe('process');
  });
});

describe('rapor: süreç ayrımı yalnızca başlığa bakar (gövde-yalnız durum)', () => {
  it('başlığı iş ilanı olan, gövdesinde sonuç/kura geçen kayıt süreç olmaz', () => {
    const result = run(
      'Örnek Müdürlüğü Sözleşmeli Personel Alımı İlanı',
      'Sınav sonuçları ve kura tarihi ilerleyen günlerde duyurulacaktır.',
    );
    expect(result.kind).toBe('job');
    expect(result.decision).toBe('accept');
  });
});

describe('rapor: yanlış son başvuru tarihleri kayda girmez', () => {
  it.each([
    ['Savunma Sanayii (1991 tarihi)', { endAt: '1991-01-01', endDate: '1991-01-01', publishedAt: null }],
    [
      'Adalet (yayından önceki tarih)',
      { endAt: '2025-12-20', endDate: '2025-12-20', publishedAt: '2026-10-12' },
    ],
    [
      'MEB Bilişim (yayından önceki tarih)',
      { endAt: '2026-09-14', endDate: '2026-09-14', publishedAt: '2026-09-22T14:31:34.000Z' },
    ],
  ])('%s düşürülür', (_label, input) => {
    expect(plausibleApplicationEnd(input)).toEqual({ applicationEndAt: null, applicationEndDate: null });
  });

  it('meşru son tarih korunur', () => {
    expect(
      plausibleApplicationEnd({ endAt: '2026-10-26', endDate: '2026-10-26', publishedAt: '2026-10-05' }),
    ).toEqual({ applicationEndAt: '2026-10-26', applicationEndDate: '2026-10-26' });
    expect(plausibleApplicationEnd({ endAt: null, endDate: null, publishedAt: null })).toEqual({
      applicationEndAt: null,
      applicationEndDate: null,
    });
  });
});

describe('rapor: durum hesabı yanlış son başvuruyla kapatmaz', () => {
  const now = new Date('2026-10-14T09:00:00+03:00');
  it('1991 son başvurulu açık ilan kapanmaz (mevcut satır için de)', () => {
    const status = computeStatus({
      applicationStartAt: null,
      applicationEndAt: '1991-01-01',
      applicationEndDate: '1991-01-01',
      publishedAt: '2026-10-01',
      now,
    });
    expect(status).not.toBe('closed');
  });
  it('yayından önceki son başvurulu ilan kapanmaz', () => {
    const status = computeStatus({
      applicationStartAt: null,
      applicationEndAt: '2025-12-20',
      applicationEndDate: '2025-12-20',
      publishedAt: '2026-10-12',
      now,
    });
    expect(status).not.toBe('closed');
  });
  it('gerçek geçmiş son başvuru hâlâ kapanır', () => {
    const status = computeStatus({
      applicationStartAt: null,
      applicationEndAt: '2026-10-01',
      applicationEndDate: '2026-10-01',
      publishedAt: '2026-09-20',
      now,
    });
    expect(status).toBe('closed');
  });
});

describe('rapor: mevcut kayıttaki yanlış son başvuru yeniden sınıflandırmada temizlenir', () => {
  const now = new Date('2026-10-14T09:00:00+03:00');
  const existing = (over: Partial<JobDoc>) =>
    ({
      id: 'job-x',
      title: 'Örnek Kurumu Sözleşmeli Personel Alımı İlanı',
      institution: 'Örnek Kurumu',
      publishedAt: '2026-10-12',
      applicationStartAt: null,
      applicationEndAt: '2025-12-20',
      applicationEndDate: '2025-12-20',
      status: 'closed',
      statusReason: 'Son başvuru tarihi geçti',
      textExcerpt: 'Sözleşmeli personel alımı ilanı. Başvurular elektronik ortamda yapılır.',
      classification: { kind: 'job', decision: 'accept' },
      ...over,
    }) as unknown as JobDoc;

  it('yayından önceki son başvuru temizlenir ve kayıt açık sayılır', () => {
    const result = reclassifyJob(existing({}), now);
    expect(result.patch.applicationEndDate).toBeNull();
    expect(result.patch.applicationEndAt).toBeNull();
    expect(result.patch.status).not.toBe('closed');
  });

  it('gerçek geçmiş son başvuru kayıtta korunur', () => {
    const result = reclassifyJob(
      existing({
        publishedAt: '2026-09-01',
        applicationEndAt: '2026-09-30',
        applicationEndDate: '2026-09-30',
        status: 'active',
      }),
      now,
    );
    expect(result.patch.applicationEndDate).toBeUndefined();
    expect(result.patch.status).toBe('closed');
  });
});
