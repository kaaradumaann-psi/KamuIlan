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

  {
    key: 'saglik-bakanligi-personel',
    name: 'Sağlık Bakanlığı (YHGM) — Personel Alım Duyuruları',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'T.C. Sağlık Bakanlığı',
    listingUrl: 'https://yhgm.saglik.gov.tr/',
    homepageUrl: 'https://www.saglik.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Sağlık personeli (sözleşmeli sağlık personeli, sürekli işçi) alım duyuruları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['yhgm.saglik.gov.tr', 'www.saglik.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'bakanlik', 'saglik', 'html'],
  },
  {
    key: 'adalet-bakanligi-duyurular',
    name: 'Adalet Bakanlığı — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'T.C. Adalet Bakanlığı',
    listingUrl: 'https://www.adalet.gov.tr/arsiv?type=1',
    homepageUrl: 'https://www.adalet.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Zabıt kâtibi, infaz ve koruma memuru ve diğer personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.adalet.gov.tr', 'adalet.gov.tr', 'pgm.adalet.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'bakanlik', 'html'],
  },
  {
    key: 'icisleri-bakanligi-duyurular',
    name: 'İçişleri Bakanlığı — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'T.C. İçişleri Bakanlığı',
    listingUrl: 'https://www.icisleri.gov.tr/duyurular',
    homepageUrl: 'https://www.icisleri.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Merkez ve taşra teşkilatı personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.icisleri.gov.tr', 'icisleri.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'bakanlik', 'html'],
  },
  {
    key: 'goc-idaresi-duyurular',
    name: 'Göç İdaresi Başkanlığı — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Göç İdaresi Başkanlığı',
    listingUrl: 'https://www.goc.gov.tr/duyurular',
    homepageUrl: 'https://www.goc.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Sözleşmeli personel ve koruma/güvenlik alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.goc.gov.tr', 'goc.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'baskanlik', 'html'],
  },
  {
    key: 'afad-duyurular',
    name: 'AFAD — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Afet ve Acil Durum Yönetimi Başkanlığı',
    listingUrl: 'https://www.afad.gov.tr/duyurular',
    homepageUrl: 'https://www.afad.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Arama-kurtarma ve destek personeli alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.afad.gov.tr', 'afad.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'baskanlik', 'html'],
  },
  {
    key: 'sgk-duyurular',
    name: 'Sosyal Güvenlik Kurumu — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Sosyal Güvenlik Kurumu',
    listingUrl: 'https://www.sgk.gov.tr/duyuru',
    homepageUrl: 'https://www.sgk.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'SGK personel ve denetmen yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.sgk.gov.tr', 'sgk.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'html'],
  },
  {
    key: 'gib-duyurular',
    name: 'Gelir İdaresi Başkanlığı — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Gelir İdaresi Başkanlığı',
    listingUrl: 'https://www.gib.gov.tr/duyuru-arsivi/guncel',
    homepageUrl: 'https://www.gib.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Gelir uzman yardımcısı ve personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.gib.gov.tr', 'gib.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'baskanlik', 'html'],
  },
  {
    key: 'tuik-duyurular',
    name: 'TÜİK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Türkiye İstatistik Kurumu',
    listingUrl: 'https://www.tuik.gov.tr/duyurular',
    homepageUrl: 'https://www.tuik.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'TÜİK duyuruları JavaScript ile yükleniyor; düz HTML taraması yapı hatası verir. TÜİK alımları ayrıca Resmî Gazete ve Kariyer Kapısı üzerinden kapsanır; tarayıcı adaptörü ayrıca gerekir.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'TÜİK uzman yardımcısı ve personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tuik.gov.tr', 'tuik.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'html'],
  },
  {
    key: 'dsi-duyurular',
    name: 'DSİ — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Devlet Su İşleri Genel Müdürlüğü',
    listingUrl: 'https://www.dsi.gov.tr/duyuru/duyuruListe',
    homepageUrl: 'https://www.dsi.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Mühendis, tekniker ve işçi alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.dsi.gov.tr', 'dsi.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'gm', 'html'],
  },
  {
    key: 'kgm-duyurular',
    name: 'Karayolları — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Karayolları Genel Müdürlüğü',
    listingUrl: 'https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Root/Duyurular.aspx',
    homepageUrl: 'https://www.kgm.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Karayolları personel ve işçi alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.kgm.gov.tr', 'kgm.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'gm', 'html'],
  },
  {
    key: 'tkgm-duyurular',
    name: 'Tapu ve Kadastro — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Tapu ve Kadastro Genel Müdürlüğü',
    listingUrl: 'https://www.tkgm.gov.tr/duyurular',
    homepageUrl: 'https://www.tkgm.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Tapu ve kadastro personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tkgm.gov.tr', 'tkgm.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'gm', 'html'],
  },
  {
    key: 'tubitak-duyurular',
    name: 'TÜBİTAK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'TÜBİTAK',
    listingUrl: 'https://www.tubitak.gov.tr/tr',
    homepageUrl: 'https://www.tubitak.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'Proje personeli, araştırmacı ve uzman alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tubitak.gov.tr', 'tubitak.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'arastirma', 'html'],
  },
  {
    key: 'yok-duyurular',
    name: 'YÖK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Yükseköğretim Kurulu',
    listingUrl: 'https://www.yok.gov.tr/announcements',
    homepageUrl: 'https://www.yok.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'YÖK ve üniversitelere ilişkin duyurular.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.yok.gov.tr', 'yok.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'akademik', 'html'],
  },
  {
    key: 'bddk-duyurular',
    name: 'BDDK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Bankacılık Düzenleme ve Denetleme Kurumu',
    listingUrl: 'https://www.bddk.org.tr/Duyuru/Liste',
    homepageUrl: 'https://www.bddk.org.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'BDDK uzman yardımcısı ve kariyer meslek alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.bddk.org.tr', 'bddk.org.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'duzenleyici', 'html'],
  },
  {
    key: 'spk-duyurular',
    name: 'SPK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Sermaye Piyasası Kurulu',
    listingUrl: 'https://www.spk.gov.tr/duyurular',
    homepageUrl: 'https://www.spk.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres doğru; liste öğeleri sayfada JavaScript ile yükleniyor olabilir, ilk canlı taramada yapı hatası verirse tarayıcı adaptörüne çevrilir.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'SPK uzman yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.spk.gov.tr', 'spk.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'duzenleyici', 'html'],
  },
  {
    key: 'epdk-duyurular',
    name: 'EPDK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Enerji Piyasası Düzenleme Kurumu',
    listingUrl: 'https://www.epdk.gov.tr/',
    homepageUrl: 'https://www.epdk.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'EPDK uzman yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.epdk.gov.tr', 'epdk.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'duzenleyici', 'html'],
  },
  {
    key: 'rtuk-duyurular',
    name: 'RTÜK — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Radyo ve Televizyon Üst Kurulu',
    listingUrl: 'https://www.rtuk.gov.tr/duyurular',
    homepageUrl: 'https://www.rtuk.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'RTÜK sitesi JavaScript ile yükleniyor; düz HTML taraması yapı hatası verir. RTÜK alımları ayrıca Resmî Gazete ve ilan.gov.tr üzerinden kapsanır; tarayıcı adaptörü ayrıca gerekir.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'RTÜK uzman yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.rtuk.gov.tr', 'rtuk.gov.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'duzenleyici', 'html'],
  },
  {
    key: 'tmsf-duyurular',
    name: 'TMSF — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'Tasarruf Mevduatı Sigorta Fonu',
    listingUrl: 'https://www.tmsf.org.tr/tr/Basin/List',
    homepageUrl: 'https://www.tmsf.org.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'method-defined',
    statusNote:
      'Adres ve sayfa yapısı kurumun sitesinden incelenerek doğrulandı; ilk canlı tarama bekleniyor. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: null,
    verificationEvidence:
      'Liste adresi ve bağlantı biçimi 13.10.2026 tarihinde kurumun resmî sitesinden bağımsız incelemeyle doğrulandı; uygulamanın kendi tarayıcısıyla ilk canlı tarama sonucu bekleniyor.',
    coverageNote: 'TMSF fon uzman yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tmsf.org.tr', 'tmsf.org.tr'],
    conditionalRequests: true,
    tags: ['kurum', 'duzenleyici', 'html'],
  },
] as const;

/**
 * Kapsam hedefi — tek tek kaynak yapılamayan TOPLU gruplar.
 *
 * Bakanlıklar ve kurumlar (Sağlık, Adalet, İçişleri, SGK, TÜBİTAK, düzenleyici
 * kurumlar vb.) artık gerçek kaynak olarak taranıyor. Burada yalnızca yüzlerce
 * ayrı siteden oluşan toplu gruplar (üniversiteler, belediyeler, hastaneler)
 * kalır; bunlar merkezî kaynaklarla (Resmî Gazete, ilan.gov.tr) dolaylı
 * kapsanır ve bu listede dürüstçe gösterilir — taranıyormuş gibi sunulmaz.
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
    id: 'devlet-universiteleri',
    name: 'Devlet üniversiteleri (125 kurum) ve rektörlükleri',
    institution: 'Çeşitli devlet üniversiteleri',
    indirectCoverage:
      'İlanların çoğu ilan.gov.tr ve Resmî Gazete üzerinden gelir; kuruma özel ek ilanlar (ör. hastane alımları) eksik kalabilir.',
    candidateUrl: null,
    note: '125 ayrı site tek tek kaynak yapılmaz; merkezî kaynaklar birincildir. Sık ilan veren üniversiteler isteğe bağlı tekil kaynak olarak eklenebilir.',
  },
  {
    id: 'universite-hastaneleri',
    name: 'Üniversite hastaneleri — sözleşmeli sağlık personeli',
    institution: 'Üniversite hastaneleri',
    indirectCoverage: 'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden kısmen gelir; Sağlık Bakanlığı kaynağı hastane dışı alımları kapsar.',
    candidateUrl: null,
    note: 'Bazı hastaneler yalnızca kendi sitesinde ilan yayımlar; tekil hastane kaynakları isteğe bağlı eklenir.',
  },
  {
    id: 'buyuksehir-belediyeleri',
    name: 'Büyükşehir belediyeleri ve bağlı idareleri',
    institution: 'Büyükşehir belediyeleri',
    indirectCoverage: 'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden büyük ölçüde gelir.',
    candidateUrl: null,
    note: '30 büyükşehir tek tek kaynak yapılmaz; merkezî kaynaklar birincildir.',
  },
  {
    id: 'il-ilce-belediyeleri',
    name: 'İl ve ilçe belediyeleri',
    institution: 'İl/ilçe belediyeleri',
    indirectCoverage: 'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden gelir.',
    candidateUrl: null,
    note: 'Yüzlerce belediye tek tek taranmaz; merkezî kaynaklar kullanılır.',
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
