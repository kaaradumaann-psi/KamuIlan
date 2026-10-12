/**
 * Kaynak envanteri.
 *
 * DÜRÜSTLÜK KURALI: Burada yalnızca gerçekten doğrulanmış kaynak kayıtları
 * "verified"/"scraper-built" durumuyla yer alır. `verificationEvidence` alanı
 * neyin, ne zaman ve nasıl doğrulandığını yazar. Doğrulanmamış kurumlar
 * SOURCE_DEFINITIONS'a alınmaz; PLANNED_SOURCES listesinde "henüz entegre
 * edilmedi" olarak durur ve kapsam raporunda açıkça gösterilir.
 *
 * Kaynak ekleme adımları: docs/source-onboarding.md
 */

export type SourceGroup = 'ulusal' | 'kurum' | 'universite' | 'belediye' | 'sinav';
export type SourceMethod = 'html-list' | 'pdf-index' | 'json-api' | 'browser' | 'manual-entry';
export type SourceType =
  | 'official-portal'
  | 'official-index'
  | 'institution-page'
  | 'exam-authority'
  | 'regional-restricted'
  | 'manual';
export type SourceStatus =
  | 'verified'
  | 'scraper-built'
  | 'accessible'
  | 'method-defined'
  | 'researched'
  | 'not-researched'
  | 'temporary-error'
  | 'access-restricted'
  | 'needs-manual-method'
  | 'disabled';

export interface SourceDefinition {
  /** Kalıcı anahtar (DB `sources.sourceKey` ve loglarda kullanılır). */
  key: string;
  name: string;
  group: SourceGroup;
  /** DB şemasındaki kaynak türü (kapsam raporunda kullanılır). */
  sourceType: SourceType;
  institution: string;
  listingUrl: string;
  homepageUrl: string;
  adapterKey: string;
  method: SourceMethod;
  status: SourceStatus;
  statusNote: string;
  /** Son doğrulama tarihi (YYYY-MM-DD). Doğrulanmadıysa null. */
  lastVerifiedAt: string | null;
  verificationEvidence: string;
  /** Kapsam: bu kaynağın hangi ilanları getirdiği. */
  coverageNote: string;
  enabled: boolean;
  intervalMinutes: number;
  minRequestIntervalMs: number;
  maxConcurrency: number;
  allowedHosts: string[];
  /** İçerik değişmediyse (ETag/Last-Modified) ayrıntı isteği yapılmaz. */
  conditionalRequests?: boolean;
  tags: string[];
}

const VERIFIED_AT = '2026-10-12';

export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  {
    key: 'resmigazete-cestili-ilanlar',
    name: 'Resmî Gazete — Çeşitli İlânlar (personel alım ilanları)',
    group: 'ulusal',
    sourceType: 'official-index',
    institution: 'T.C. Resmî Gazete',
    listingUrl: 'https://www.resmigazete.gov.tr/ilanlar',
    homepageUrl: 'https://www.resmigazete.gov.tr/',
    adapterKey: 'resmigazete-cestili',
    method: 'pdf-index',
    status: 'verified',
    statusNote:
      'Günlük nüshadaki "Çeşitli İlânlar" bölümü HTML olarak okunur; ilan metni PDF içinde olduğundan PDF metni çıkarılır.',
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence:
      `${VERIFIED_AT} canlı doğrulama: /fihrist?tarih=2026-10-12 sayfası açıldı; ` +
      '/ilanlar/eskiilanlar/2026/10/20261012-4.htm içinde 7 ilan başlığı ve her birine ait PDF bağlantısı ' +
      '(ör. 20261012-4-5.pdf) görüldü; PDF metni metin katmanından okunabildi.',
    coverageNote:
      'Personel alım ilanlarının hukuken yayımlandığı asıl kaynak. Yargı (-2), ihale (-3) ve Merkez Bankası (-5) bölümleri kapsam dışıdır.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 1500,
    maxConcurrency: 1,
    allowedHosts: ['resmigazete.gov.tr', 'www.resmigazete.gov.tr'],
    conditionalRequests: true,
    tags: ['cekirdek', 'resmi-gazete', 'pdf'],
  },
  {
    key: 'ilan-gov-tr-personel',
    name: 'ilan.gov.tr — Kamu / Akademik Personel kategorisi',
    group: 'ulusal',
    sourceType: 'official-portal',
    institution: 'Basın İlan Kurumu',
    listingUrl: 'https://www.ilan.gov.tr/ilan/tum-ilanlar/personel-alimi?ats=5',
    homepageUrl: 'https://www.ilan.gov.tr/',
    adapterKey: 'ilan-gov-tr',
    method: 'html-list',
    status: 'verified',
    statusNote:
      '"Personel Alımı" filtresi (ats=5) sayfa sayfa okunur; ilan detayında kurum, ilan numarası ve metin bulunur.',
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence:
      `${VERIFIED_AT} canlı doğrulama: personel-alimi listesi açıldı (157 ilan, 14 sayfa); ` +
      'örnek ilanlarda kurum adı, YOK***/DPB***/ILN*** tipi resmî ilan numaraları ve detay bağlantıları görüldü.',
    coverageNote:
      'Üniversite ve belediye ilanlarının büyük bölümü burada tek listede toplanır; yüzlerce kurum sayfasını ayrı ayrı taramamak için birincil toplayıcı.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 2000,
    maxConcurrency: 1,
    allowedHosts: ['ilan.gov.tr', 'www.ilan.gov.tr', 'medya.ilan.gov.tr'],
    tags: ['cekirdek', 'toplayici', 'html'],
  },
  {
    key: 'osym-duyurular',
    name: 'ÖSYM — Duyurular (sınav ve alım duyuruları)',
    group: 'sinav',
    sourceType: 'exam-authority',
    institution: 'ÖSYM Başkanlığı',
    listingUrl: 'https://www.osym.gov.tr/Duyurular/Index',
    homepageUrl: 'https://www.osym.gov.tr/',
    adapterKey: 'osym-duyuru',
    method: 'html-list',
    status: 'verified',
    statusNote:
      'Duyuru listesi ve duyuru detayları HTML olarak okunur; ekler PDF bağlantısı olarak saklanır.',
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence:
      `${VERIFIED_AT} canlı doğrulama: ana sayfa duyuru bloklarında tarih + başlık + detay bağlantısı görüldü ` +
      '(ör. "2026-YDS/2 Geç Başvuru", başvuru penceresi 14.10.2026 10:00–23:59, ücret 1.800,00 TL). AİS (ais.osym.gov.tr) giriş gerektirir; kapsam dışıdır.',
    coverageNote:
      'ÖSYM alım/sınav duyuruları. Sonuç, kılavuz, cevap anahtarı türü duyurular sınıflandırma motoru tarafından reddedilir.',
    enabled: true,
    intervalMinutes: 120,
    minRequestIntervalMs: 2000,
    maxConcurrency: 1,
    allowedHosts: ['osym.gov.tr', 'www.osym.gov.tr', 'dokuman.osym.gov.tr'],
    tags: ['cekirdek', 'sinav', 'html'],
  },
  {
    key: 'iskur-kamu-memur-alim',
    name: 'İŞKUR — Kamu Memur Alım İlanları',
    group: 'ulusal',
    sourceType: 'institution-page',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    listingUrl: 'https://www.iskur.gov.tr/ilanlar/kamu-memur-alim-ilanlari/',
    homepageUrl: 'https://www.iskur.gov.tr/',
    adapterKey: 'iskur-ilan-listesi',
    method: 'html-list',
    status: 'scraper-built',
    statusNote:
      'Listeleme adresi İŞKUR ana sayfasındaki resmî bağlantıdan alındı; liste HTML yapısı bu ortamda canlı doğrulanamadı (ağ erişimi yok), bu yüzden adaptör sayfa değişirse boş liste yerine yapı hatası bildirir.',
    lastVerifiedAt: null,
    verificationEvidence:
      'URL, iskur.gov.tr ana sayfasındaki "Kamu Memur Alımı" bağlantısından alındı. Liste yapısı doğrulanmadı; ' +
      'canlı doğrulama `npm run test:live` ile yapılır.',
    coverageNote: 'Memur ve sözleşmeli personel duyurularının İŞKUR tarafındaki yayını.',
    enabled: true,
    intervalMinutes: 120,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['iskur.gov.tr', 'www.iskur.gov.tr'],
    tags: ['cekirdek', 'html'],
  },
  {
    key: 'iskur-kurumdisi-kamu-isci',
    name: 'İŞKUR — Kurum Dışı Kamu İşçi Alım İlanları',
    group: 'ulusal',
    sourceType: 'institution-page',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    listingUrl: 'https://www.iskur.gov.tr/ilanlar/kurumdisi-kamu-isci-alim-ilanlari/',
    homepageUrl: 'https://www.iskur.gov.tr/',
    adapterKey: 'iskur-ilan-listesi',
    method: 'html-list',
    status: 'scraper-built',
    statusNote:
      'Adres İŞKUR ana sayfasındaki "Kurum Dışı Kamu İşçi Alımı İlanı" bağlantısından alındı; liste yapısı canlı doğrulanmadı.',
    lastVerifiedAt: null,
    verificationEvidence:
      'URL, iskur.gov.tr ana sayfasındaki bağlantıdan alındı. Liste yapısı doğrulanmadı.',
    coverageNote: 'Kamu işçisi (sürekli/geçici işçi) alımlarının İŞKUR yayını.',
    enabled: true,
    intervalMinutes: 180,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['iskur.gov.tr', 'www.iskur.gov.tr'],
    tags: ['cekirdek', 'isci', 'html'],
  },
  {
    key: 'kariyerkapisi-isealim',
    name: 'Kariyer Kapısı — Kamu İşe Alım',
    group: 'ulusal',
    sourceType: 'official-portal',
    institution: 'T.C. Cumhurbaşkanlığı (Kariyer Kapısı)',
    listingUrl: 'https://kariyerkapisi.gov.tr/isealim',
    homepageUrl: 'https://kariyerkapisi.gov.tr/',
    adapterKey: 'kariyer-kapisi-isealim',
    method: 'browser',
    status: 'accessible',
    statusNote:
      'Sayfa açılıyor ancak ilan listesi tarayıcıda (JavaScript) oluşturuluyor; düz HTTP isteğiyle liste okunamaz. Playwright kuruluysa devreye girer, değilse tarama "atlandı" olarak kaydedilir ve panelde görünür.',
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence:
      `${VERIFIED_AT} canlı doğrulama: /isealim sayfası HTTP 200 döndü; "Aktif İlanlar" tablosu o an boş geldi ` +
      '("Şu an aktif bir ilan bulunmamaktadır.") ve ilan satırları sunucu HTML’inde yok — istemci tarafında üretiliyor.',
    coverageNote:
      'Kurumların merkezî başvuru ekranı. Liste Playwright ile okunur; her ilanın resmî başvuru bağlantısı buradadır.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 3000,
    maxConcurrency: 1,
    allowedHosts: ['kariyerkapisi.gov.tr', 'www.kariyerkapisi.gov.tr'],
    tags: ['cekirdek', 'tarayici', 'playwright'],
  },
  {
    key: 'meb-personel-duyurular',
    name: 'MEB Personel Genel Müdürlüğü — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'T.C. Millî Eğitim Bakanlığı',
    listingUrl: 'https://personel.meb.gov.tr/www/haberler/kategori/1',
    homepageUrl: 'https://personel.meb.gov.tr/',
    adapterKey: 'meb-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Liste adresi MEB Personel Genel Müdürlüğü ana sayfasındaki "TÜM HABERLER" bağlantısından alındı; sayfa yapısı canlı doğrulanmadı.',
    lastVerifiedAt: null,
    verificationEvidence:
      'URL ana sayfadaki bağlantıdan alındı; mevcut duyurular ağırlıklı olarak öğretmen yer değiştirme/atama ' +
      'içerikliydi ve sınıflandırma motoru bunları reddeder.',
    coverageNote:
      'Öğretmen ve personel alım duyuruları. Yoğun atama/yer değiştirme içeriği nedeniyle yalnızca alım ilanları kabul edilir.',
    enabled: true,
    intervalMinutes: 180,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['personel.meb.gov.tr'],
    tags: ['kurum', 'bakanlik', 'html'],
  },
  {
    key: 'kamuilan-sbb',
    name: 'Kamu İlan (Strateji ve Bütçe Başkanlığı)',
    group: 'ulusal',
    sourceType: 'regional-restricted',
    institution: 'T.C. Cumhurbaşkanlığı Strateji ve Bütçe Başkanlığı',
    listingUrl: 'https://kamuilan.sbb.gov.tr/',
    homepageUrl: 'https://kamuilan.sbb.gov.tr/',
    adapterKey: 'sbb-kamuilan',
    method: 'html-list',
    status: 'access-restricted',
    statusNote:
      'Merkezî kamu ilan ekranı. Bu ortamdan erişim WAF tarafından 403 "Geographic Restriction" ile engellendi; ' +
      'Türkiye’den çalışan bir kurulumda açılabilir. Kısıt aşılmaya çalışılmaz, ancak engellenmediği ortamlarda otomatik açılır.',
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence: `${VERIFIED_AT}: HTTP 403 — "Geographic Restriction / Access Denied" (WAF).`,
    coverageNote:
      'Memur, sözleşmeli, işçi ve akademik ilanları kurum ayrımı olmadan listeleyen en geniş merkezî kaynak.',
    enabled: true,
    intervalMinutes: 120,
    minRequestIntervalMs: 3000,
    maxConcurrency: 1,
    allowedHosts: ['kamuilan.sbb.gov.tr'],
    tags: ['cekirdek', 'toplayici', 'erisim-kisitli'],
  },
  {
    key: 'iskur-esube-acik-is',
    name: 'İŞKUR e-Şube — Açık İş İlanları',
    group: 'ulusal',
    sourceType: 'institution-page',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    listingUrl: 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx',
    homepageUrl: 'https://esube.iskur.gov.tr/',
    adapterKey: 'manual-entry',
    method: 'manual-entry',
    status: 'needs-manual-method',
    statusNote:
      'Arama ekranı ASP.NET postback + oturum (viewstate) ile çalışır. Otomatik toplama kaynağın kullanım koşullarını zorlayacağı için KAPALI tutulur ve ilanlar manuel eklenir; sistem bunu kapsam raporunda açıkça gösterir.',
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence:
      'Ekran incelendi: filtreler postback ile gönderiliyor, oturum/viewstate gerekiyor. CAPTCHA/erişim kontrolü aşılmaz.',
    coverageNote:
      'Kamu işçisi ilanlarının bir bölümü. Kapsam İŞKUR ilan listeleri ve Resmî Gazete üzerinden dolaylı sağlanır; bu kaynak manuel girişle beslenir.',
    enabled: false,
    intervalMinutes: 360,
    minRequestIntervalMs: 5000,
    maxConcurrency: 1,
    allowedHosts: ['esube.iskur.gov.tr'],
    tags: ['manuel', 'erisim-kisitli'],
  },
] as const;

/**
 * Kapsam hedefi — HENÜZ ENTEGRE EDİLMEMİŞ kaynaklar.
 *
 * Buradaki kayıtlar "eksik kapsam"ı dürüstçe gösterir; hiçbiri çalışan bir
 * kaynak gibi sunulmaz. Kimisi zaten merkezî kaynaklarla (Resmî Gazete,
 * ilan.gov.tr) dolaylı kapsanır — bu da coverageNote ile belirtilir.
 */
export interface PlannedSource {
  id: string;
  name: string;
  institution: string;
  /** Dolaylı kapsam: bu kurumun ilanları hangi merkezî kaynaktan zaten geliyor? */
  indirectCoverage: string | null;
  /** Bilinen listeleme adresi (doğrulanmadıysa null — uydurulmaz). */
  candidateUrl: string | null;
  note: string;
}

export const PLANNED_SOURCES: readonly PlannedSource[] = [
  {
    id: 'saglik-bakanligi',
    name: 'Sağlık Bakanlığı — personel alım duyuruları',
    institution: 'T.C. Sağlık Bakanlığı',
    indirectCoverage: 'Kurum ilanları Resmî Gazete ve ilan.gov.tr üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı. Onboarding: doğrulanınca adaptör + kaynak kaydı eklenir.',
  },
  {
    id: 'adalet-bakanligi',
    name: 'Adalet Bakanlığı — zabıt kâtibi / infaz koruma memuru alımları',
    institution: 'T.C. Adalet Bakanlığı',
    indirectCoverage: 'İlanlar ağırlıklı olarak Resmî Gazete ve ilan.gov.tr üzerinden gelir.',
    candidateUrl: null,
    note: 'Kuruma özel sayfa izlenebilir; mevcut kapsam merkezî kaynaklarla sağlanıyor.',
  },
  {
    id: 'icisleri-bakanligi',
    name: 'İçişleri Bakanlığı — personel alımları',
    institution: 'T.C. İçişleri Bakanlığı',
    indirectCoverage: 'ilan.gov.tr üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'goc-idaresi',
    name: 'Göç İdaresi Başkanlığı — sözleşmeli personel alımları',
    institution: 'T.C. İçişleri Bakanlığı Göç İdaresi Başkanlığı',
    indirectCoverage: 'Resmî Gazete üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'afad',
    name: 'AFAD — personel alımları',
    institution: 'Afet ve Acil Durum Yönetimi Başkanlığı',
    indirectCoverage: null,
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı; öncelikli onboarding hedefi.',
  },
  {
    id: 'sgk',
    name: 'Sosyal Güvenlik Kurumu — personel alımları',
    institution: 'Sosyal Güvenlik Kurumu',
    indirectCoverage: 'Resmî Gazete üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'gib',
    name: 'Gelir İdaresi Başkanlığı — gelir uzman yardımcılığı vb.',
    institution: 'T.C. Hazine ve Maliye Bakanlığı Gelir İdaresi Başkanlığı',
    indirectCoverage: 'Resmî Gazete üzerinden gelir.',
    candidateUrl: null,
    note: 'Sınav duyuruları kendi sayfasında; adres doğrulanmadı.',
  },
  {
    id: 'tuik',
    name: 'TÜİK — personel alımları',
    institution: 'Türkiye İstatistik Kurumu',
    indirectCoverage: 'Resmî Gazete üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'dsi',
    name: 'Devlet Su İşleri Genel Müdürlüğü — personel alımları',
    institution: 'DSİ Genel Müdürlüğü',
    indirectCoverage: 'ilan.gov.tr ve Resmî Gazete üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'kgm',
    name: 'Karayolları Genel Müdürlüğü — personel alımları',
    institution: 'KGM',
    indirectCoverage: 'ilan.gov.tr üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'tapu-kadastro',
    name: 'Tapu ve Kadastro Genel Müdürlüğü — personel alımları',
    institution: 'Tapu ve Kadastro Genel Müdürlüğü',
    indirectCoverage: 'Resmî Gazete üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'tubitak',
    name: 'TÜBİTAK — proje personeli ve uzman alımları',
    institution: 'TÜBİTAK',
    indirectCoverage: null,
    candidateUrl: null,
    note: 'Listeleme adresi doğrulanmadı.',
  },
  {
    id: 'yok',
    name: 'Yükseköğretim Kurulu — akademik ilan duyuruları',
    institution: 'YÖK',
    indirectCoverage: 'Akademik ilanlar ilan.gov.tr ve üniversite sayfaları üzerinden gelir.',
    candidateUrl: null,
    note: 'ÖSYM/ilan.gov.tr ile kısmi kapsam; kurul sayfası onboarding ile eklenir.',
  },
  {
    id: 'devlet-universiteleri',
    name: 'Devlet üniversiteleri (125 kurum) ve rektörlükleri',
    institution: 'Çeşitli devlet üniversiteleri',
    indirectCoverage:
      'İlanların çoğu ilan.gov.tr ve Resmî Gazete üzerinden gelir; kuruma özel ek ilanlar (ör. hastane alımları) eksik kalabilir.',
    candidateUrl: null,
    note: 'Yüzlerce site tek tek taranmaz; merkezî kaynaklar birincil. Kuruma özel sayfalar onboarding listesine eklenir.',
  },
  {
    id: 'universite-hastaneleri',
    name: 'Üniversite hastaneleri — sözleşmeli sağlık personeli',
    institution: 'Üniversite hastaneleri',
    indirectCoverage: 'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden kısmen gelir.',
    candidateUrl: null,
    note: 'Bazı hastaneler yalnızca kendi sitesinde ilan yayımlar; onboarding hedefi.',
  },
  {
    id: 'buyuksehir-belediyeleri',
    name: 'Büyükşehir belediyeleri ve bağlı idareleri',
    institution: 'Büyükşehir belediyeleri',
    indirectCoverage: 'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden büyük ölçüde gelir.',
    candidateUrl: null,
    note: 'İstanbul, Ankara, İzmir vb. kuruma özel sayfalar onboarding ile eklenir.',
  },
  {
    id: 'il-ilce-belediyeleri',
    name: 'İl ve ilçe belediyeleri',
    institution: 'İl/ilçe belediyeleri',
    indirectCoverage: 'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden gelir.',
    candidateUrl: null,
    note: 'Tek tek tarama yerine merkezî kaynaklar kullanılır.',
  },
  {
    id: 'duzenleyici-kurumlar',
    name: 'Düzenleyici ve denetleyici kurumlar (BDDK, SPK, EPDK, RTÜK, TMSF vb.)',
    institution: 'Düzenleyici kurumlar',
    indirectCoverage: 'Kariyer mesleği ilanları Resmî Gazete üzerinden gelir (ör. TMSF ilanı doğrulandı).',
    candidateUrl: null,
    note: 'Kuruma özel sayfalar onboarding ile eklenir.',
  },
];

export function findSourceDefinition(key: string): SourceDefinition | undefined {
  return SOURCE_DEFINITIONS.find((source) => source.key === key);
}

/** Kapsam özeti: kaynak sayıları (coverage raporunda kullanılır). */
export function sourceInventorySummary(): {
  total: number;
  enabled: number;
  verified: number;
  byStatus: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};
  for (const source of SOURCE_DEFINITIONS) {
    byStatus[source.status] = (byStatus[source.status] ?? 0) + 1;
  }
  return {
    total: SOURCE_DEFINITIONS.length,
    enabled: SOURCE_DEFINITIONS.filter((source) => source.enabled).length,
    verified: SOURCE_DEFINITIONS.filter((source) => source.status === 'verified').length,
    byStatus,
  };
}
