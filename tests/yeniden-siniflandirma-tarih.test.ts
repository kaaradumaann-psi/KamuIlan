/**
 * Yeniden sınıflandırma (kuru çalıştırma) — gerçek veri düzeltmeleri.
 *
 * 16.10.2026 denetiminde kullanıcının Supabase kayıtlarında görülen üç veri hatası:
 *
 *  1) YAYIM TARİHİ YASAL ATIFTAN OKUNMUŞ (2004/2008/2013/2018/2019). Çıkarıcı
 *     düzeltildi ama eski kayıtların tarihi yerinde kaldı; `--apply` bunları
 *     temizleyebilmeli. Kanıt: kayıttaki metinde yayım tarihi YOK.
 *  2) SON BAŞVURU TARİHİ 1991-01-01 (gerçek ilan, 2026) — imkânsız tarih.
 *  3) SON BAŞVURU TARİHİ YAYIMDAN ÖNCE (2025-12-20 < 2026-10-12, Adalet Bakanlığı
 *     kayıtları) — imkânsız sıralama.
 *
 * Ayrıca sayfa kabuğu temizliği ve "değişiklik yoksa boş yama" güvencesi.
 * Dış istek yok; saf fonksiyon testleri.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobDoc } from '../src/db/schemas';
import { FileStore } from '../src/db/file-store';
import { buildReport, planReclassification } from '../src/ingest/reclassify-batch';
import {
  PUBLISHED_DATE_REGRESSION_DAYS,
  UNSUPPORTED_PUBLISHED_DATE_NOTE,
  reclassifyJob,
} from '../src/ingest/reclassify';

const NOW = new Date('2026-10-16T09:00:00+03:00');

/** Kanıttaki alanları verilen, geri kalanı sabit bir kayıt üretir. */
function makeJob(overrides: Partial<JobDoc> = {}): JobDoc {
  const base = {
    id: 'job_test000000000000000001',
    title: 'Örnek Kurum - Sözleşmeli Personel Alım İlanı',
    titleNormalized: 'ornek kurum sozlesmeli personel alim ilani',
    institution: 'Örnek Kurum',
    institutionNormalized: 'ornek kurum',
    unit: null,
    employmentType: 'sozlesmeli',
    status: 'active',
    statusReason: '',
    city: null,
    cityNormalized: '',
    district: null,
    quota: 5,
    applicationStartAt: null,
    applicationEndAt: null,
    applicationEndDate: null,
    publishedAt: null,
    detailUrl: 'https://ornek.test/ilan/1',
    normalizedUrl: 'https://ornek.test/ilan/1',
    applicationUrl: null,
    applicationMethod: null,
    attachments: [],
    requirements: {
      educationLevels: [],
      departments: [],
      kpssScoreTypes: [],
      kpssMinScore: null,
      kpssYear: null,
      qualificationCodes: [],
      minAge: null,
      maxAge: null,
      certificates: [],
      minExperienceYears: null,
      foreignLanguages: [],
      specialConditions: [],
    },
    titles: [],
    textExcerpt:
      'Kurumumuz emrinde istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Başvurular 01.11.2026 - 20.11.2026 tarihleri arasında yapılacaktır.',
    textNormalized: '',
    originalRefNo: null,
    sourceKeys: ['ornek-kaynak'],
    primarySourceKey: 'ornek-kaynak',
    classification: {
      decision: 'accept' as const,
      kind: 'job' as const,
      employmentType: 'sozlesmeli' as const,
      confidence: 0.8,
      reasons: [],
      rules: [],
      negativeSignals: [],
      version: '2026.10.1',
      classifiedAt: '2026-10-15T09:00:00.000Z',
    },
    extractionConfidence: 0.8,
    fieldSources: {},
    evidence: {},
    uncertainties: [],
    provenance: 'scraped' as const,
    contentHash: 'hash-0000000000000001',
    dedupeKey: 'dedupe-000000000000001',
    version: 1,
    firstSeenAt: '2026-10-15T09:00:00.000Z',
    lastSeenAt: '2026-10-15T09:00:00.000Z',
    lastVerifiedAt: null,
    createdAt: '2026-10-15T09:00:00.000Z',
    updatedAt: '2026-10-15T09:00:00.000Z',
  };
  return { ...base, ...overrides } as JobDoc;
}

describe('desteksiz yayım tarihi temizlenir', () => {
  it('gövdeden türetilmiş ve metinde doğrulanamayan eski tarih kaldırılır (Göç İdaresi 2013 vakası)', () => {
    const job = makeJob({
      publishedAt: '2013-07-11',
      // Gerçek kayıttaki metin: yayım tarihi yok, yalnızca YÖNETMELİK atfı var.
      textExcerpt:
        'İçişleri Bakanlığı’na bağlı Göç İdaresi Başkanlığı taşra teşkilatında boş bulunan kadrolara 11 Temmuz 2013 tarihli ve 28704 sayılı Resmî Gazete’de yayımlanan İl Göç Uzmanlığı Yönetmeliği hükümleri uyarınca giriş sınavı ile il göç uzman yardımcısı alınacaktır.',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2013-07-11' } },
      applicationEndDate: '2026-09-09',
    });
    const result = reclassifyJob(job, NOW);

    expect(result.patch.publishedAt).toBeNull();
    expect(result.patch.uncertainties).toContain(UNSUPPORTED_PUBLISHED_DATE_NOTE);
    expect(result.changed).toBe(true);
  });

  it('2004 tarihli Ceza Kanunu atfından gelen tarihi de kaldırır (AFAD vakası)', () => {
    const job = makeJob({
      publishedAt: '2004-09-26',
      textExcerpt:
        'ÖSYM yerleştirme sonuçlarına göre kadrolara yerleştirilen adayların belgelerini 14.08.2026 tarihine kadar teslim etmeleri gerekmektedir. Gerçeğe aykırı beyanda bulunanlar hakkında 26/9/2004 tarihli ve 5237 sayılı Türk Ceza Kanunu’nun ilgili hükümleri uygulanır.',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2004-09-26' } },
    });
    expect(reclassifyJob(job, NOW).patch.publishedAt).toBeNull();
  });

  it('metinde gerçek yayım tarihi varsa tarih KORUNUR', () => {
    const job = makeJob({
      publishedAt: '2026-10-14',
      textExcerpt: 'Yayım Tarihi: 14.10.2026\nKurumumuz 5 sözleşmeli personel alacaktır.',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2026-10-14' } },
    });
    expect(reclassifyJob(job, NOW).patch.publishedAt).toBeUndefined();
  });

  it('yakın tarihli (bir yıldan yeni) kayıt korunur — YÖK haberleri vakası', () => {
    const job = makeJob({
      // Kayıt 2026-10-14'te ilk görüldü; 2026-04-20 tarihi pencerenin içinde.
      publishedAt: '2026-04-20',
      firstSeenAt: '2026-10-14T09:00:00.000Z',
      textExcerpt: 'BAŞKANLIK Başkan Genel Kurul Yürütme Kurulu Mevzuat KVKK Aydınlatma Metni Misyon ve Vizyon',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2026-04-20' } },
    });
    expect(reclassifyJob(job, NOW).patch.publishedAt).toBeUndefined();
    expect(177).toBeLessThan(PUBLISHED_DATE_REGRESSION_DAYS);
  });

  it('liste katmanından gelen tarih (otorite) hiç sorgulanmaz', () => {
    const job = makeJob({
      publishedAt: '2018-07-15',
      firstSeenAt: '2026-10-13T09:00:00.000Z',
      fieldSources: { publishedAt: { kind: 'listing', snippet: '2018-07-15' } },
    });
    expect(reclassifyJob(job, NOW).patch.publishedAt).toBeUndefined();
  });

  it('gelecek yayım tarihi zaten reddedilir (mevcut davranış korunur)', () => {
    const job = makeJob({ publishedAt: '2026-11-12', textExcerpt: 'Yayım Tarihi: 12.11.2026 ifadesi.' });
    expect(reclassifyJob(job, NOW).patch.publishedAt).toBeNull();
  });

  it('yayım tarihi silinince son başvuru kapısı yalnızca 2000 alt sınırını uygular (bilinen sınır)', () => {
    // Yayım tarihi desteksiz çıkarsa karşılaştırma tabanı kalkar; tarih 2000'den
    // sonra olduğu sürece KORUNUR. Kural uydurmamak için bilinçli sınır: kayıtta
    // kalır, uygulama öncesi kuru çalıştırma sayacı ("imkânsız son başvuru")
    // kullanıcıya gerçek etkiyi gösterir.
    const job = makeJob({
      publishedAt: '2013-07-11',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2013-07-11' } },
      textExcerpt:
        '11 Temmuz 2013 tarihli ve 28704 sayılı Resmî Gazete’de yayımlanan Yönetmelik uyarınca giriş sınavı yapılacaktır.',
      applicationEndDate: '2019-05-05',
    });
    const result = reclassifyJob(job, NOW);
    expect(result.patch.publishedAt).toBeNull();
    expect(result.patch.applicationEndDate).toBeUndefined();
  });

  it('alan kaynağı olmayan eski kayıtta çökmez', () => {
    const job = makeJob({ publishedAt: '2013-07-11', fieldSources: {} });
    const result = reclassifyJob(job, NOW);
    expect(result.patch.publishedAt).toBeNull();
  });
});

describe('imkânsız son başvuru tarihleri temizlenir', () => {
  it('1991-01-01 (2000 öncesi) temizlenir ve durum yeniden hesaplanır', () => {
    const job = makeJob({
      title: 'SAVUNMA SANAYİİ BAŞKANLIĞI - Savunma Sanayii Uzman Yardımcılığı Giriş Sınavı - 2026',
      textExcerpt:
        'Savunma Sanayii Başkanlığında Genel İdare Hizmetleri sınıfından kadrolara atanmak üzere Giriş Sınavı ile 22 (yirmi iki) Savunma Sanayii Uzman Yardımcısı alınacaktır.',
      applicationEndDate: '1991-01-01',
      applicationEndAt: '1991-01-01T23:59:00+03:00',
      status: 'closed',
    });
    const result = reclassifyJob(job, NOW);

    expect(result.patch.applicationEndDate).toBeNull();
    expect(result.patch.applicationEndAt).toBeNull();
    expect(result.statusTo).toBe('unknown');
  });

  it('yayımdan önceki son başvuru tarihi temizlenir (Adalet Bakanlığı vakası)', () => {
    const job = makeJob({
      title: 'Sözleşmeli Zabıt Katibi Uygulamalı Sınav Metinleri ve Değerlendirme Kriterleri',
      textExcerpt:
        'Adalet Bakanlığı Memur Sınav, Atama ve Nakil Yönetmeliği uyarınca 1 Ağustos 2026 tarihinde yapılacak olan sözleşmeli zabıt kâtibi uygulamalı sınav metinleri aşağıda yer almaktadır.',
      publishedAt: '2026-10-12',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2026-10-12' } },
      applicationEndDate: '2025-12-20',
      status: 'closed',
    });
    const result = reclassifyJob(job, NOW);

    expect(result.patch.applicationEndDate).toBeNull();
    expect(result.patch.publishedAt).toBeUndefined();
  });

  it('geçerli gelecek tarihli son başvuru KORUNUR', () => {
    const job = makeJob({
      applicationEndDate: '2026-11-20',
      status: 'active',
      textExcerpt:
        'Kurumumuz emrinde istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Son başvuru tarihi 20.11.2026 olup başvurular e-Devlet üzerinden alınacaktır.',
    });
    const result = reclassifyJob(job, NOW);
    expect(result.patch.applicationEndDate).toBeUndefined();
    expect(result.statusTo).toBe('active');
  });
});

describe('sayfa kabuğu temizliği', () => {
  it('başlığa karışmış kabuk ifadesi temizlenir, ilan kısmı korunur', () => {
    const job = makeJob({
      title: 'Sözleşmeli Personel Alım İlanı — Sıkça Sorulan Sorular',
      textExcerpt:
        'Kurumumuz emrinde istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Son başvuru tarihi 20.11.2026.',
    });
    const result = reclassifyJob(job, NOW);
    expect(result.titleCleaned).toBe(true);
    expect(result.patch.title).toBe('Sözleşmeli Personel Alım İlanı —');
    expect(result.patch.title ?? '').not.toContain('Sıkça Sorulan Sorular');
  });

  it('tamamen kabuk olan başlık ham kalır (kanıt) ama kayıt reddedilir', () => {
    // Karayolları vakası (canlı koşum, tests/report-review-fixes.test.ts): kayıtlı
    // başlık sayfanın erişilebilirlik çubuğundan geliyordu. Metin tamamen kabuk
    // olduğu için temizlenince geriye bir şey kalmaz; ham başlık denetim izi
    // olarak korunur, KARAR ise güncel kuralla redde döner.
    const job = makeJob({
      title: 'Daha yüksek erişilebilirlik modunu aç Daha yüksek erişilebilirlik modunu kapat Erişilebilirlik Menüsü',
    });
    const result = reclassifyJob(job, NOW);
    expect(result.titleCleaned).toBe(false);
    expect(result.decisionTo).toBe('reject');
    expect(result.classification.rules).toContain('ret-baslik.sayfa-arayuzu');
  });

  it('gövdedeki çerez/erişilebilirlik iskeleti ayıklanır', () => {
    // Dizeler canlı koşum kayıtlarından alındı: tests/html-chrome.test.ts,
    // tests/report-review-fixes.test.ts, tests/classification-dizin-gurultusu.test.ts.
    const job = makeJob({
      textExcerpt:
        'Erişilebilirlik Menüsü Ekran Okuyucu Seçili Alan Okuyucu Bağlantı Vurgula Büyük Metin Solgunlaştır Çerez Ayarları Kurumumuz 5 sözleşmeli personel alacaktır.',
      classification: { ...makeJob().classification, version: '2026.10.4' },
    });
    const result = reclassifyJob(job, NOW);
    expect(result.patch.textExcerpt ?? '').toContain('5 sözleşmeli personel alacaktır');
    expect(result.patch.textExcerpt ?? '').not.toContain('Ekran Okuyucu');
    expect(result.patch.textExcerpt ?? '').not.toContain('Çerez Ayarları');
  });
});

describe('değişiklik yoksa yama boş kalır', () => {
  it('güncel kayıtta gereksiz yazma üretilmez', () => {
    const job = makeJob({
      classification: {
        ...makeJob().classification,
        version: '2026.10.4',
        kind: 'job',
      },
      applicationEndDate: '2026-11-20',
      status: 'active',
      textExcerpt:
        'Kurumumuz emrinde istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Son başvuru tarihi 20.11.2026 olup başvurular e-Devlet üzerinden alınacaktır.',
    });
    const result = reclassifyJob(job, NOW);
    expect(result.patch).toEqual({});
    expect(result.changed).toBe(false);
  });
});

describe('kuru çalıştırma özeti ve raporu tarih düzeltmelerini gösterir', () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kamuilan-tarih-'));
    store = new FileStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const bozukKayitlar = (): JobDoc[] => [
    makeJob({
      id: 'job_yayimhatali000000000001',
      publishedAt: '2013-07-11',
      fieldSources: { publishedAt: { kind: 'detail', snippet: '2013-07-11' } },
      textExcerpt:
        'İçişleri Bakanlığı’na bağlı Göç İdaresi Başkanlığı taşra teşkilatında boş bulunan kadrolara 11 Temmuz 2013 tarihli ve 28704 sayılı Resmî Gazete’de yayımlanan İl Göç Uzmanlığı Yönetmeliği uyarınca giriş sınavı ile il göç uzman yardımcısı alınacaktır.',
      applicationEndDate: '2026-09-09',
    }),
    makeJob({
      id: 'job_1991tarihli0000000000002',
      applicationEndDate: '1991-01-01',
      applicationEndAt: '1991-01-01T23:59:00+03:00',
      status: 'closed',
    }),
    makeJob({
      id: 'job_saglamkayit00000000000003',
      publishedAt: '2026-10-10',
      fieldSources: { publishedAt: { kind: 'listing', snippet: '2026-10-10' } },
      applicationEndDate: '2026-11-20',
      status: 'active',
      textExcerpt:
        'Kurumumuz emrinde istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Son başvuru tarihi 20.11.2026 olup başvurular e-Devlet üzerinden yapılacaktır.',
    }),
  ];

  it('özet sayaçları silinecek tarihleri ayrı gösterir', () => {
    const { summary } = planReclassification(bozukKayitlar(), NOW);
    // Yalnızca desteksiz yayım tarihi ve 1991 tarihli bitiş temizlenir.
    // İlk kaydın bitiş tarihi (2026-09-09) geçmiş ama makul: dokunulmaz.
    expect(summary.publishedAtCleared).toBe(1);
    expect(summary.applicationEndCleared).toBe(1);
    expect(summary.total).toBe(3);
  });

  it('rapor ham değeri ve yazılacak değeri birlikte gösterir', async () => {
    const jobs = bozukKayitlar();
    for (const job of jobs) await store.insertOne('jobs', job);
    const { planned } = planReclassification(jobs, NOW);
    const rows = await buildReport(store, planned);

    const goc = rows.find((row) => row.id === 'job_yayimhatali000000000001');
    // Ham değer: kayıtta saklı yanlış tarih. Sonrası: temizlenmiş.
    expect(goc?.publishedAt).toBe('2013-07-11');
    expect(goc?.publishedAtAfter).toBeNull();

    const savunma = rows.find((row) => row.id === 'job_1991tarihli0000000000002');
    expect(savunma?.applicationEndDate).toBe('1991-01-01');
    expect(savunma?.applicationEndDateAfter).toBeNull();

    const saglam = rows.find((row) => row.id === 'job_saglamkayit00000000000003');
    expect(saglam?.publishedAtAfter).toBe('2026-10-10');
    expect(saglam?.applicationEndDateAfter).toBe('2026-11-20');
  });
});

/**
 * Kayıtlardaki kabuk metni — GERÇEK verilerden birebir alındı.
 *
 * 16.10.2026 kuru çalıştırma raporundaki kayıt gövdeleri (kullanıcının Supabase
 * verisi). Bu dizeler kayıtlarda birebir böyle duruyor ve gövde metnini çöpe
 * çeviriyordu. Sınıflandırmanın menü metnini "içerik kanıtı" saymaması için
 * temizlik kapsamı bu dizelerle sabitlendi.
 */
describe('gerçek kayıt gövdelerindeki kabuk metni temizlenir', () => {
  it('Karayolları gövde başlangıcı (kgm-duyurular) temizlenir', () => {
    const job = makeJob({
      title: 'Karayolları Genel Müdürlüğüne Bağlı İşyerlerine 50 İşçi Personel Alımı Hk.',
      // Kayıttaki gövdenin ilk 600 karakteri birebir bu metinle başlıyor.
      textExcerpt:
        'Daha yüksek erişilebilirlik modunu aç Daha yüksek erişilebilirlik modunu kapat Şerit Komutlarını Atla ' +
        'Ana içeriğe atla Animasyonları Kapat Animasyonları Aç SharePoint Oturum Aç Takip Et Karayolları Genel Müdürlüğü' +
        'Şu anda seçili DuyuruDetay ANA SAYFA KURUMSAL Tarihçe Görevleri Yönetim Genel Müdürümüz Yol Ağı Bilgileri',
      classification: { ...makeJob().classification, version: '2026.10.4' },
    });
    const result = reclassifyJob(job, NOW);
    const cleaned = result.patch.textExcerpt ?? '';
    expect(cleaned).not.toContain('erişilebilirlik modunu');
    expect(cleaned).not.toContain('Şerit Komutlarını Atla');
    expect(cleaned).not.toContain('Şu anda seçili');
  });

  it('İŞKUR gövdesi (çerez + erişilebilirlik çubuğu) temizlenir', () => {
    const job = makeJob({
      title: 'Kamu Memur Alım İlanları',
      textExcerpt:
        'Erişilebilirlik Menüsü Ekran Okuyucu Seçili Alan Okuyucu Bağlantı Vurgula Büyük Metin Metni Sola Hizala ' +
        'İmleç Okuma Kılavuzu Okuma Maskesi Kontrast Solgunlaştırma Düşük Doygunluk Yüksek Doygunluk ' +
        'Erişilebilirlik Ayarlarını Temizle Web sitemizde sunulan ve açıkça talep etmiş olduğunuz hizmetler için ' +
        'kesinlikle gerekli, birinci taraf oturum çerezleri ve kalıcı çerezler kullanılmaktadır. ' +
        'Daha fazla bilgi için Çerez Aydınlatma Metni Kabul Ediyorum Çerez Ayarları Kabul Etmiyorum ' +
        'Zorunlu Çerezler Analitik Çerezler',
      classification: { ...makeJob().classification, version: '2026.10.4' },
    });
    const cleaned = reclassifyJob(job, NOW).patch.textExcerpt ?? '';
    for (const kabuk of [
      'Ekran Okuyucu',
      'Solgunlaştırma',
      'Düşük Doygunluk',
      'Erişilebilirlik Ayarlarını Temizle',
      'Çerez Aydınlatma Metni',
      'Kabul Ediyorum',
      'Kabul Etmiyorum',
      'Zorunlu Çerezler',
      'Analitik Çerezler',
    ]) {
      expect(cleaned, kabuk).not.toContain(kabuk);
    }
  });

  it('DSİ gövdesi ("HızlıErişim") ve İçişleri filtre kutusu temizlenir', () => {
    const dsi = makeJob({
      title: 'ARAZİ TOPLULAŞTIRMASI ETÜT VE PROJELENDİRME DAİRESİ BAŞKANLIĞI',
      textExcerpt:
        'HızlıErişim Anasayfa Tarım ve Orman Bakanlığı TR TR ANA SAYFA KURUMSAL YAPI HAKKIMIZDA DSİ MEVZUATI ' +
        'TOPRAK VE SU KAYNAKLARI BAKAN BAKAN YARDIMCISI GENEL MÜDÜR YÖNETİM MERKEZ TEŞKİLATI',
      classification: { ...makeJob().classification, version: '2026.10.4' },
    });
    expect(reclassifyJob(dsi, NOW).patch.textExcerpt ?? '').not.toContain('HızlıErişim');

    const icisleri = makeJob({
      title: 'Görevde Yükselme ve Ünvan Değişikliği Sınav Duyurusu',
      textExcerpt:
        'Tarih aralığı seçiniz Başlangıç tarihi seçiniz Ocak Şubat Mart Nisan Mayıs Haziran Temmuz Ağustos ' +
        'Bitiş tarihi seçiniz Ocak Şubat Mart Nisan Mayıs Haziran Temmuz Ağustos Eylül Ekim Kasım Aralık ' +
        'temizleFiltrele 11 Eyl 2026 İçişleri Bakanlığı Bakanlık Merkez Ve Taşra Teşkilatı Personeli',
      classification: { ...makeJob().classification, version: '2026.10.4' },
    });
    const temiz = reclassifyJob(icisleri, NOW).patch.textExcerpt ?? '';
    expect(temiz).not.toContain('Tarih aralığı seçiniz');
    expect(temiz).not.toContain('Bitiş tarihi seçiniz');
    // Gerçek içerik (duyuru başlığı ve tarihi) korunur.
    expect(temiz).toContain('11 Eyl 2026');
  });

  it('gerçek ilan metni kabuk temizliğinden zarar görmez', () => {
    const job = makeJob({
      textExcerpt:
        'Kurumumuz emrinde istihdam edilmek üzere 5 sözleşmeli personel alınacaktır. Başvurular 01.11.2026 - 20.11.2026 tarihleri arasında e-Devlet üzerinden yapılacaktır. Kabul edilen belgelerin aslı istenir; çerez politikası hakkında bilgi için kurum sayfasına bakınız.',
    });
    const result = reclassifyJob(job, NOW);
    const metin = result.patch.textExcerpt ?? job.textExcerpt;
    expect(metin).toContain('5 sözleşmeli personel alınacaktır');
    expect(metin).toContain('20.11.2026');
  });
});
