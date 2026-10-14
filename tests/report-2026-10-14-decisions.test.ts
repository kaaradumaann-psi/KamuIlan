/**
 * 2026-10-14 Supabase dry-run raporunun gerçek başlıkları üzerinden karar testleri.
 *
 * Kararlar (kullanıcı onaylı):
 *  A) Kurum içi görevde yükselme sınavı / tercih duyuruları → süreç duyurusu (akışta, bildirimsiz).
 *  B) Rektör adaylığı → reddedilir.
 *  C) Kurum içi yeterlik sınavı (Hazine muhasebe) → süreç duyurusu.
 *  D) Adalet "Başvuru Sonuçları" → yalnızca gövdede gerçek sonuç kanıtı varsa süreç (dar kural).
 *  E) Süreç kayıtlarında "Açık/Aktif" durumu gösterilmez; tarihi bilinmeyen kayıt "açık" sayılmaz.
 *
 * Koruma: raporda doğru reddedilen kayıtlar reddedilmeye devam eder; süreç duyuruları silinmez.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { JobDoc } from '../src/db/schemas';
import { computeStatus, applyRawAnnouncement } from '../src/ingest/jobs-service';
import { reclassifyJob } from '../src/ingest/reclassify';
import { fixedClock } from '../src/lib/clock';
import { toPublicJobSummary } from '../src/server/serializers';
import { sonucDuyurusu } from './fixtures/announcements';

const NOW = new Date('2026-10-14T09:00:00+03:00');

/** Görevde yükselme sınavı / tercih duyuruları (A kararı). */
const GOREVDE_YUKSELME_PROCESS: Array<[string, string]> = [
  [
    'İçişleri Bakanlığı Bakanlık Merkez Ve Taşra Teşkilatı Personeli Görevde Yükselme Ve Ünvan Değişikliği Sınav Duyurusu',
    '657 sayılı Devlet Memurları Kanunu, Kamu Kurum ve Kuruluşlarında Görevde Yükselme ve Unvan Değişikliği Esaslarına Dair Genel Yönetmelik kapsamında görevde yükselme sınavına tabi kadrolar için sınav duyurusu.',
  ],
  [
    'ÇEVRE, ŞEHİRCİLİK VE İKLİM DEĞİŞİKLİĞİ BAKANLIĞI - GÖREVDE YÜKSELME SINAVI İLANI (Şube Müdürü (Teknik), Şube Müdürü (İdari) ve Memur Kadroları)',
    'Bakanlığımız merkez ve taşra birimlerinde münhal bulunan Şube Müdürü (Teknik), Şube Müdürü (İdari) ve Memur kadrolarına görevde yükselme sınavı yapılacaktır.',
  ],
  [
    'Görevde Yükselme ve Ünvan Değişikliği Sınavlarında Başarılı Olanların Tercih Başvurularına İlişkin Duyuru Personel Genel Müdürlüğü',
    'Görevde yükselme ve ünvan değişikliği yazılı ve sözlü sınavları sonuçlarına göre kadrolara atama için tercih başvuruları alınacaktır.',
  ],
];

/** Hazine muhasebe yeterlik sınavı (C kararı): kurum içi, mevcut Muhasebe Uzman Yardımcıları için. */
const MUHASEBE_YETERLIK_TITLE = 'HAZİNE VE MALİYE BAKANLIĞI - MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU';
const MUHASEBE_YETERLIK_BODY =
  'T.C. HAZİNE VE MALİYE BAKANLIĞI MUHASEBE UZMANLIĞI YETERLİK SINAVI DUYURUSU I-SINAVA İLİŞKİN BİLGİLER Hazine ve Maliye Bakanlığı taşra teşkilatında Muhasebe Uzman Yardımcısı kadrosunda bulunanlardan; en az üç yıllık fiili hizmet süresini yazılı sınav tarihi itibarıyla dolduranların Muhasebe Uzmanı kadrosuna atanabilmeleri amacıyla yeterlik sınavı yapılacaktır.';

/** Adalet "Başvuru Sonuçları" (D kararı): gövdede gerçek sonuç duyurusu. */
const ADALET_SONUC_TITLE =
  'Bakanlığımız Merkez Teşkilatı ve Personel Eğitim Merkezi Müdürlükleri ile Adli Destek ve Mağdur Hizmetleri Müdürlüklerinde Çalıştırılmak Üzere Sözleşmeli Personel Alımı Personel Genel Müdürlüğü';
const ADALET_SONUC_BODY =
  'Anasayfa / Duyurular Bakanlığımız Merkez Teşkilatı ve Personel Eğitim Merkezi Müdürlükleri ile Adli Destek ve Mağdur Hizmetleri Müdürlüklerinde Çalıştırılmak Üzere Sözleşmeli Personel Alımı [Psikolog, Sosyal Çalışmacı, Koruma ve Güvenlik Görevlisi, Destek Personeli (Şoför, Aşçı, Hizmetli)] Başvuru Sonuçları Bakanlığımız merkez teşkilatı ve Personel Eğitim Merkezi Müdürlükleri ile Adli Destek ve Mağdur Hizmetleri Müdürlüklerinde çalıştırılmak üzere sözleşmeli Psikolog, Sosyal Çalışmacı, Koruma ve Güvenlik Görevlisi pozisyonları için sözlü sınava katılmaya hak kazanan adaylar aşağıdadır.';

/** Raporda doğru reddedilen kayıtlar (Rektör adaylığı dahil; B kararı). Bunlar reddedilmeye devam etmeli. */
const CORRECT_REJECTS: string[] = [
  'Daha yüksek erişilebilirlik modunu aç',
  'T.C. İÇİŞLERİ BAKANLIĞI T.C. İÇİŞLERİ BAKANLIĞI T.C. İÇİŞLERİ BAKANLIĞI BAKANLIK BAKANLIK Bakanımız Hakkımızda Teşkilat Şeması Tarihçe Projeler Yayınlar Mevzuat Kurumsal Kimlik Bilgi Güvenliği Politikası Sıkça Sorulan Sorular BAKANLIK BİRİMLERİ HİZMET BİRİMLERİ Nüfus ve Vatandaşlık İşleri Genel Müdürlüğü Hukuk Hizmetleri Genel Müdürlüğü AB ve Dış İlişkiler Dairesi Başkanlığı KİHBİ Dairesi Başkanlığı',
  'Özbekistan / Güzel Sanatlar Eğitimi Alanlarında Pedagojik ve Uzman Personelin Yeniden Eğitimi ve Mesleki Gelişimi',
  '2026-YKS Ek Yerleştirme Tercihleri Başladı',
  'Koç Üniversitesi ile Bitlis Eren Üniversitesi kardeş oldu',
  'Üniversitelerde yeni eğitim anlayışı: “Daha az ders, daha fazla uygulama ve yaparak öğrenme”',
  'Yükseköğretim Kurulundan Teknoloji Transfer Ofislerine üretim tesisi kurma ve işletme yetkisi',
  "Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere sınav uyarısı: “Çoktan seçmeli sınav yönteminin yaygınlaşmasını doğru bulmuyoruz”",
  "Yükseköğretim Kurulu Başkanı Özvar'dan üniversitelere müfredat çağrısı: “Dersleri sadeleştirin”",
  "Yükseköğretim Kurulu Başkanı Özvar'dan İmam Buhârî'nin ilmî mirasının yaşatılması mesajı",
  "Yükseköğretim Kurulu Başkanı Özvar'dan İzmir'de Terörsüz Türkiye mesajı",
  'PERSONEL DAİRESİ BAŞKANLIĞI',
  'Uluslararası Araştırma Programları (AKAP, DOSAP, GEP) 2026 Yılı 4. Dönem Başvuru Duyurusu',
  '5 Üniversite için Rektör Adaylığı Başvuru İlanı',
  'Uluslararası Kirletmeden Üretmek Mümkün ( Pollute-Less Production Posibble) Konferansı',
  'Öncelikli Alanlardaki Doktora Programlarına Öğrenci Seçme Sınavı için Başvurular uzatılmıştır',
  '2026 Dikey Geçiş Sınavı, 2026 Sağlık Lisans Tamamlama , 2026 Teknik Öğretmenler İçin Mühendislik Tamamlama Mazeretli Kayıt Başvuruları',
  '2026 Sağlık Lisans Tamamlama Başvuru ve Tercih İşlemleri',
  'Hindistan Teknik ve Ekonomik İşbirliği Eğitim Programı (ITEC) Kapsamında Verilen Uzmanlık Eğitimlerine Başvurular',
  'Üniversite İzleme ve Değerlendirme Raporu',
  'Türkiye’nin Suriye’deki eğitim desteği yeni döneme taşınıyor',
  'Ana Sayfa İlanlar Kurumdışı Kamu İşçi Alım İlanları',
  'Kurumdışı Kamu İşçi Alım ...',
  'ARAZİ TOPLULAŞTIRMASI ETÜT VE PROJELENDİRME DAİRESİ BAŞKANLIĞI',
  'Bank Mellat Basın Duyurusu',
  'Param Şirketleri Basın Duyurusu',
  'Kamu Memur Alım İlanları',
];

/** Süreç duyuruları (kura, sınav yeri, yedek aday) — raporda akışta kalan beş kayıt. */
const KEPT_PROCESS_TITLES: string[] = [
  'Karayolları Genel Müdürlüğü 50 İşçi Alımına İlişkin Noter Kurası Duyurusu',
  'Sözleşmeli Zabıt Katibi Uygulamalı Sınav Metinleri ve Değerlendirme Kriterleri Personel Genel Müdürlüğü',
  'Bakanlık Merkez Teşkilatı ve Ankara Bekir Bozdağ Personel Eğitim Merkezi Müdürlüğü Destek Personeli (Şoför) Uygulamalı Sınav Yeri ve Tarihlerine İlişkin Duyuru Personel Genel Müdürlüğü',
  'Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru',
  "20 Nisan 2026 Tarihli ve 33230 Sayılı Resmi Gazete'de Yayımlanan 35 Sözleşmeli Personel Alımı Yedek Aday Duyurusu",
];

describe('A) kurum içi görevde yükselme → süreç duyurusu', () => {
  for (const [title, body] of GOREVDE_YUKSELME_PROCESS) {
    it(`"${title.slice(0, 60)}…" süreç, kabul`, () => {
      const result = classify({ title, body });
      expect(result.kind).toBe('process');
      expect(result.decision).toBe('accept');
      expect(result.rules).toEqual(['süreç.gorevde-yukselme-sinavi']);
    });
  }

  it('görevde yükselme ifadesi sınav/tercih içermezse reddedilmeye devam eder', () => {
    const result = classify({ title: 'Görevde Yükselme Kadro Duyurusu', body: 'Kadro listesi.' });
    expect(result.decision).toBe('reject');
    expect(result.kind).toBe('job');
  });

  it('yer değiştirme ile görevde yükselme sınavı süreç sayılmaz (yanlış pozitif koruması)', () => {
    const result = classify({
      title: 'Görevde Yükselme Yer Değiştirme Sınavı Duyurusu',
      body: 'Yer değiştirme başvuruları alınacaktır.',
    });
    expect(result.kind).not.toBe('process');
  });

  it('öğrenci yerleştirme tercihi görevde yükselme sayılmaz', () => {
    const result = classify({
      title: 'Görevde Yükselme Ek Yerleştirme Tercihleri Başladı',
      body: 'Öğrenci yerleştirme tercihleri.',
    });
    expect(result.kind).not.toBe('process');
  });
});

describe('B) rektör adaylığı reddedilir', () => {
  it('5 Üniversite için Rektör Adaylığı Başvuru İlanı reddedilir', () => {
    const result = classify({
      title: '5 Üniversite için Rektör Adaylığı Başvuru İlanı',
      body: 'Rektör adaylığı başvuruları alınacaktır.',
    });
    expect(result.decision).toBe('reject');
    expect(result.kind).toBe('job');
  });
});

describe('C) kurum içi yeterlik sınavı → süreç duyurusu', () => {
  it('Hazine muhasebe yeterlik sınavı (raporun gövdesiyle) süreç, kabul', () => {
    const result = classify({ title: MUHASEBE_YETERLIK_TITLE, body: MUHASEBE_YETERLIK_BODY });
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
    expect(result.rules).toEqual(['süreç.kurum-ici-yeterlik']);
  });

  it('kamuya açık yeterlik sınavı (kurum içi kanıtı yok) süreç olmaz', () => {
    const result = classify({
      title: 'Kamu Kurumu Uzmanlık Yeterlik Sınavı Duyurusu',
      body: 'Dışarıdan uzman yardımcısı alınmak üzere tüm adayların başvurusuna açıktır; yeni personel alımı yapılacaktır.',
    });
    expect(result.kind).toBe('job');
    expect(result.decision).toBe('accept');
  });
});

describe('D) gövdede gerçek başvuru sonuçları → süreç (dar kural)', () => {
  it('Adalet Başvuru Sonuçları (gövde kanıtıyla) süreç, kabul', () => {
    const result = classify({ title: ADALET_SONUC_TITLE, body: ADALET_SONUC_BODY });
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
    expect(result.rules).toEqual(['süreç.basvuru-sonuclari-govde']);
  });

  it('"sonuç" kelimesi genel olarak geçse de ilan iş ilanı kalır (genel kural yok)', () => {
    const result = classify({
      title: ADALET_SONUC_TITLE,
      body: 'Sözleşmeli personel alımı ilanıdır. Başvurular 20.10.2026 tarihine kadar alınacaktır. Sınav sonuçları ilerleyen günlerde ilan edilecektir.',
    });
    expect(result.kind).toBe('job');
  });

  it('"Başvuru Sonuçları" başlıkta değil de gövdenin çok gerisinde ise süreç olmaz', () => {
    const filler = 'Sözleşmeli personel alımı ilanı, başvuru koşulları ve ayrıntılar. '.repeat(12);
    const result = classify({
      title: ADALET_SONUC_TITLE,
      body: `${filler} Başvuru Sonuçları sözlü sınava katılma`,
    });
    expect(result.kind).toBe('job');
  });

  it('"Başvuru Sonuçları" var ama sınava katılma listesi yoksa süreç olmaz', () => {
    const result = classify({
      title: ADALET_SONUC_TITLE,
      body: 'Anasayfa / Duyurular Başvuru Sonuçları sözleşmeli personel alımı için başvurular 20.10.2026 tarihine kadar alınacaktır.',
    });
    expect(result.kind).toBe('job');
  });
});

describe('raporda doğru reddedilen kayıtlar reddedilmeye devam eder', () => {
  it.each(CORRECT_REJECTS)('"%s" reddedilir', (title) => {
    expect(classify({ title, body: '' }).decision).toBe('reject');
    expect(classify({ title, body: 'Kurum duyurusu ve genel bilgiler.' }).decision).toBe('reject');
  });
});

describe('raporda akışta kalan süreç duyuruları süreç olarak kalır', () => {
  it.each(KEPT_PROCESS_TITLES)('"%s" süreç, kabul', (title) => {
    const result = classify({ title, body: '' });
    expect(result.kind).toBe('process');
    expect(result.decision).toBe('accept');
  });
});

describe('E) durum: tarihi bilinmeyen kayıt "başvuru açık" sayılmaz', () => {
  const now = NOW;
  it('başlangıcı geçmiş, bitişi bilinmeyen ilan açık sayılmaz', () => {
    const status = computeStatus({
      applicationStartAt: '2026-10-01T00:00:00+03:00',
      applicationEndAt: null,
      applicationEndDate: null,
      publishedAt: '2026-10-01',
      now,
    });
    expect(status).toBe('unknown');
  });

  it('bitiş tarihi gelecekte olan ilan hâlâ açıktır (regresyon)', () => {
    const status = computeStatus({
      applicationStartAt: null,
      applicationEndAt: '2026-10-26',
      applicationEndDate: '2026-10-26',
      publishedAt: '2026-10-05',
      now,
    });
    expect(status).toBe('active');
  });

  it('süreç duyurusunun özet etiketi "Süreç duyurusu"dur; başvuru durumu etiketi gösterilmez', () => {
    const job = {
      id: 'job-process-label',
      title: 'Örnek Kurum Uzman Yardımcılığı Sınav Duyurusu',
      institution: 'Örnek Kurum',
      unit: null,
      classification: { kind: 'process', decision: 'accept' },
      employmentType: 'belirsiz',
      status: 'active',
      city: null,
      district: null,
      quota: null,
      applicationStartAt: null,
      applicationEndAt: null,
      applicationEndDate: '2026-10-26',
      publishedAt: '2026-10-05',
      detailUrl: 'https://example.test/ilan',
      applicationUrl: null,
      attachments: [],
      titles: [],
      sourceKeys: [],
      extractionConfidence: 0.8,
      lastVerifiedAt: NOW.toISOString(),
      version: 1,
      updatedAt: NOW.toISOString(),
      provenance: 'scraped',
    } as unknown as JobDoc;
    const summary = toPublicJobSummary(job, NOW);
    expect(summary.kind).toBe('process');
    expect(summary.statusLabel).toBe('Süreç duyurusu');
  });
});

describe('yeniden sınıflandırma: reddedilmiş görevde yükselme → süreç; genel reddi açmaz', () => {
  function rejected(title: string, body: string): JobDoc {
    return {
      id: 'job-r',
      title,
      titleNormalized: title.toLowerCase(),
      institution: 'Örnek Kurum',
      institutionNormalized: 'ornek kurum',
      textExcerpt: body,
      textNormalized: body.toLowerCase(),
      publishedAt: '2026-10-05',
      applicationStartAt: null,
      applicationEndAt: null,
      applicationEndDate: '2026-10-26',
      status: 'active',
      statusReason: null,
      classification: { decision: 'reject', kind: 'job', employmentType: 'belirsiz', reasons: [], rules: [] },
      version: 1,
      updatedAt: NOW.toISOString(),
    } as unknown as JobDoc;
  }

  it('görevde yükselme sınav duyurusu süreç olarak akışa döner', () => {
    const [title, body] = GOREVDE_YUKSELME_PROCESS[0] as [string, string];
    const result = reclassifyJob(rejected(title, body), NOW);
    expect(result.patch.classification?.decision).toBe('accept');
    expect(result.patch.classification?.kind).toBe('process');
  });

  it('genel ret kayıtları (basın duyurusu) reddedilmiş kalır', () => {
    const result = reclassifyJob(rejected('Bank Mellat Basın Duyurusu', 'Basın açıklaması.'), NOW);
    expect(result.patch.classification?.decision ?? 'reject').toBe('reject');
  });

  it('rektör adaylığı reddedilmiş kalır', () => {
    const result = reclassifyJob(
      rejected('5 Üniversite için Rektör Adaylığı Başvuru İlanı', 'Rektör adaylığı.'),
      NOW,
    );
    expect(result.patch.classification?.decision ?? 'reject').toBe('reject');
  });
});

describe('süreç duyurusu depoda: durum filtresi ve istatistikler süreç kaydını saymaz', () => {
  let dir: string;
  let store: FileStore;
  let repos: Repos;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kamuilan-decisions-'));
    store = new FileStore(dir);
    await store.init();
    repos = createRepos(store, fixedClock(NOW));
    await repos.sources.seed();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('süreç kaydı durum filtresinde ve "açık ilan" sayısında yer almaz; kind=process ile bulunur', async () => {
    const outcome = await applyRawAnnouncement(
      sonucDuyurusu({
        sourceItemId: 'GY-DEPO-1',
        title: GOREVDE_YUKSELME_PROCESS[0]![0],
        bodyText: GOREVDE_YUKSELME_PROCESS[0]![1],
      }),
      { repos, now: NOW, workerId: 'worker-decisions', provenance: 'scraped' },
    );
    expect(outcome.jobId).toBeTruthy();
    const proc = await repos.jobs.findById(outcome.jobId as string);
    expect(proc?.classification.kind).toBe('process');

    const active = await repos.jobs.search({ status: ['active'] }, { pageSize: 50 });
    expect(active.items.some((job) => job.classification.kind === 'process')).toBe(false);

    const processes = await repos.jobs.search({ kind: 'process' }, { pageSize: 50 });
    expect(processes.items.map((job) => job.id)).toContain(proc?.id);

    const stats = await repos.jobs.dashboardStats(NOW);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
  });
});
