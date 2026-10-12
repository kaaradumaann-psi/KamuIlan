/**
 * Kaynak envanteri.
 *
 * DÜRÜSTLÜK KURALI: Burada yalnızca gerçekten doğrulanmış bilgiler "verified"
 * olarak işaretlenir. `verification.evidence` alanı neyin, ne zaman ve nasıl
 * doğrulandığını yazar. URL'si veya listeleme yapısı doğrulanmamış kurumlar
 * SOURCE_DEFINITIONS'a alınmaz; PLANNED_SOURCES listesinde "henüz entegre
 * edilmedi" olarak durur ve kapsam raporunda açıkça gösterilir.
 */
import type { SourceMethod, SourceStatus, SourceType } from '../domain';

export interface SourceDefinition {
  /** Adaptör anahtarı: aynı adaptör birden fazla kaynak kaydını besleyebilir. */
  adapterKey: string;
  name: string;
  institution: string;
  homepageUrl: string;
  listingUrl: string;
  sourceType: SourceType;
  method: SourceMethod;
  enabled: boolean;
  scrapeIntervalMinutes: number;
  minRequestIntervalMs: number;
  maxConcurrency: number;
  status: SourceStatus;
  statusNote: string;
  coverageNotes: string;
  allowHosts: string[];
  tags: string[];
  /** Listeleme sayfası başına en fazla kaç sayfa taranır. */
  maxListingPages: number;
  verification: {
    verified: boolean;
    verifiedAt: string | null;
    method: string;
    evidence: string;
    scope: string;
  };
}

const VERIFIED_AT = '2026-10-12';

export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  {
    adapterKey: 'resmigazete-ilan',
    name: 'Resmî Gazete — Çeşitli İlânlar (personel alım ilanları)',
    institution: 'T.C. Cumhurbaşkanlığı İdari İşler Başkanlığı — Resmî Gazete',
    homepageUrl: 'https://www.resmigazete.gov.tr/',
    listingUrl: 'https://www.resmigazete.gov.tr/fihrist',
    sourceType: 'official-index',
    method: 'pdf-index',
    enabled: true,
    scrapeIntervalMinutes: 60,
    minRequestIntervalMs: 1500,
    maxConcurrency: 1,
    status: 'verified',
    statusNote:
      'Günlük fihrist sayfası ve Çeşitli İlânlar bölümü (…-4.htm) HTML olarak okunuyor; her ilan ayrı PDF.',
    coverageNotes:
      'Kamu personel alım ilanlarının hukuken yayımlandığı asıl yer. Yargı ilanları (…-2.htm), ihale ilanları (…-3.htm) ve Merkez Bankası değerleri (…-5.htm) kapsam dışıdır.',
    allowHosts: ['resmigazete.gov.tr'],
    tags: ['core', 'official-gazette', 'pdf'],
    maxListingPages: 2,
    verification: {
      verified: true,
      verifiedAt: VERIFIED_AT,
      method: 'HTTP GET + HTML ayrıştırma (canlı doğrulama)',
      evidence:
        '12.10.2026 sayılı nüsha: /ilanlar/eskiilanlar/2026/10/20261012-4.htm içinde 7 ilan başlığı ve her birine ait PDF bağlantısı (örn. 20261012-4-5.pdf Şırnak Üniversitesi Sürekli İşçi Alım İlanı) okundu.',
      scope: 'İlan başlığı, kurum, PDF bağlantısı ve yayım tarihi (sayfa başlığından) çıkarılıyor.',
    },
  },
  {
    adapterKey: 'ilan-gov-tr',
    name: 'ilan.gov.tr — Kamu/Akademik Personel kategorisi',
    institution: 'Basın İlan Kurumu (ilan.gov.tr)',
    homepageUrl: 'https://www.ilan.gov.tr/',
    listingUrl: 'https://www.ilan.gov.tr/ilan/tum-ilanlar/personel-alimi?ats=5',
    sourceType: 'official-portal',
    method: 'html-list',
    enabled: true,
    scrapeIntervalMinutes: 60,
    minRequestIntervalMs: 2000,
    maxConcurrency: 1,
    status: 'verified',
    statusNote: 'Liste sayfaları (14 sayfa, 157 aktif ilan) ve ilan detay sayfaları sunucu tarafında HTML üretiliyor.',
    coverageNotes:
      'Üniversite ve belediye ilanlarının büyük bölümü burada tek listeye düşüyor; aynı ilanları yüzlerce kurum sitesinden ayrı ayrı çekmemek için birincil toplayıcı kaynak.',
    allowHosts: ['ilan.gov.tr'],
    tags: ['core', 'aggregator', 'html'],
    maxListingPages: 4,
    verification: {
      verified: true,
      verifiedAt: VERIFIED_AT,
      method: 'HTTP GET + HTML ayrıştırma (canlı doğrulama)',
      evidence:
        'Liste sayfası 1 okundu: 157 ilanın ilk sayfasında 10 kayıt; başlık, kurum, ilan numarası (DPB845507 / YOK853479) ve şehir alanları doğrulandı.',
      scope: 'Başlık, kurum, ilan numarası, şehir, detay bağlantısı ve yayım tarihi çıkarılıyor.',
    },
  },
  {
    adapterKey: 'osym-duyuru',
    name: 'ÖSYM — Duyurular (sınav ve alım duyuruları)',
    institution: 'ÖSYM Başkanlığı',
    homepageUrl: 'https://www.osym.gov.tr/',
    listingUrl: 'https://www.osym.gov.tr/Duyurular/Index',
    sourceType: 'exam-authority',
    method: 'html-list',
    enabled: true,
    scrapeIntervalMinutes: 120,
    minRequestIntervalMs: 2000,
    maxConcurrency: 1,
    status: 'verified',
    statusNote: 'Duyuru listesi ve duyuru detay sayfaları HTML olarak okunuyor; PDF ekleri bağlantı olarak saklanıyor.',
    coverageNotes:
      'ÖSYM personel alım/sınav duyuruları buradan izlenir. Sınav sonucu, kılavuz, cevap anahtarı, yerleştirme sonucu gibi duyurular sınıflandırma motoru tarafından reddedilir.',
    allowHosts: ['osym.gov.tr', 'dokuman.osym.gov.tr'],
    tags: ['core', 'exam', 'html'],
    maxListingPages: 2,
    verification: {
      verified: true,
      verifiedAt: VERIFIED_AT,
      method: 'HTTP GET + HTML ayrıştırma (canlı doğrulama)',
      evidence:
        'Ana sayfa duyuru blokları okundu: tarih + başlık + detay bağlantısı (örn. "2026-ALES/3: Başvuruların Alınması").',
      scope: 'Duyuru tarihi, başlık ve detay bağlantısı; detay sayfasından metin çıkarımı.',
    },
  },
  {
    adapterKey: 'iskur-liste',
    name: 'İŞKUR — Kamu Memur Alım İlanları',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    homepageUrl: 'https://www.iskur.gov.tr/',
    listingUrl: 'https://www.iskur.gov.tr/ilanlar/kamu-memur-alim-ilanlari/',
    sourceType: 'institution-page',
    method: 'html-list',
    enabled: true,
    scrapeIntervalMinutes: 120,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    status: 'method-defined',
    statusNote:
      'Listeleme adresi İŞKUR ana sayfasındaki resmî bağlantıdan alındı; liste HTML yapısı bu ortamdan doğrulanamadı (ağ erişimi yok). Canlı doğrulama: npm run test:live',
    coverageNotes: 'Memur ve sözleşmeli personel duyurularının İŞKUR tarafındaki yayını.',
    allowHosts: ['iskur.gov.tr'],
    tags: ['core', 'html'],
    maxListingPages: 2,
    verification: {
      verified: false,
      verifiedAt: null,
      method: 'HTTP GET + HTML ayrıştırma (yapı doğrulanmadı)',
      evidence: 'Adres, iskur.gov.tr ana sayfasındaki "Kamu Memur Alımı" bağlantısından alındı.',
      scope: 'Başlık, tarih ve detay bağlantısı hedefleniyor; doğrulanmadı.',
    },
  },
  {
    adapterKey: 'iskur-liste',
    name: 'İŞKUR — Kurum Dışı Kamu İşçi Alım İlanları',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    homepageUrl: 'https://www.iskur.gov.tr/',
    listingUrl: 'https://www.iskur.gov.tr/ilanlar/kurumdisi-kamu-isci-alim-ilanlari/',
    sourceType: 'institution-page',
    method: 'html-list',
    enabled: true,
    scrapeIntervalMinutes: 180,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    status: 'method-defined',
    statusNote:
      'Adres İŞKUR ana sayfasındaki "Kurum Dışı Kamu İşçi Alımı İlanı" bağlantısından alındı; liste yapısı bu ortamdan doğrulanamadı.',
    coverageNotes: 'Kamu işçisi (sürekli/geçici işçi) alımlarının İŞKUR yayını.',
    allowHosts: ['iskur.gov.tr'],
    tags: ['core', 'worker-jobs', 'html'],
    maxListingPages: 2,
    verification: {
      verified: false,
      verifiedAt: null,
      method: 'HTTP GET + HTML ayrıştırma (yapı doğrulanmadı)',
      evidence: 'Adres, iskur.gov.tr ana sayfasındaki bağlantıdan alındı.',
      scope: 'Başlık, tarih ve detay bağlantısı hedefleniyor; doğrulanmadı.',
    },
  },
  {
    adapterKey: 'meb-personel',
    name: 'MEB Personel Genel Müdürlüğü — Duyurular',
    institution: 'T.C. Millî Eğitim Bakanlığı',
    homepageUrl: 'https://personel.meb.gov.tr/',
    listingUrl: 'https://personel.meb.gov.tr/www/haberler/kategori/1',
    sourceType: 'institution-page',
    method: 'html-list',
    enabled: true,
    scrapeIntervalMinutes: 180,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    status: 'method-defined',
    statusNote:
      'Liste adresi MEB Personel Genel Müdürlüğü ana sayfasındaki "TÜM HABERLER" bağlantısından alındı; sayfa yapısı bu ortamdan doğrulanamadı.',
    coverageNotes:
      'Öğretmen atama/yer değiştirme duyuruları çok yoğun; sınıflandırma motoru yalnızca personel alımına ilişkin duyuruları kabul eder.',
    allowHosts: ['personel.meb.gov.tr'],
    tags: ['institution', 'ministry', 'html'],
    maxListingPages: 2,
    verification: {
      verified: false,
      verifiedAt: null,
      method: 'HTTP GET + HTML ayrıştırma (yapı doğrulanmadı)',
      evidence: 'Adres, personel.meb.gov.tr ana sayfasındaki bağlantıdan alındı; liste HTML yapısı doğrulanmadı.',
      scope: 'Başlık, tarih ve detay bağlantısı hedefleniyor; doğrulanmadı.',
    },
  },
  {
    adapterKey: 'kariyerkapisi',
    name: 'Kariyer Kapısı — Kamu İşe Alım',
    institution: 'T.C. Cumhurbaşkanlığı (Kariyer Kapısı)',
    homepageUrl: 'https://kariyerkapisi.gov.tr/',
    listingUrl: 'https://kariyerkapisi.gov.tr/isealim',
    sourceType: 'official-portal',
    method: 'browser',
    enabled: false,
    scrapeIntervalMinutes: 60,
    minRequestIntervalMs: 3000,
    maxConcurrency: 1,
    status: 'accessible',
    statusNote:
      'Sayfa açılıyor ancak ilan listesi tarayıcıda (JavaScript) oluşturuluyor. Düz HTTP isteğiyle liste okunamaz; Playwright gerekir. Varsayılan olarak kapalı.',
    coverageNotes:
      'Aktif ilan bulunmadığında sayfa "Şu an aktif bir ilan bulunmamaktadır." gösterir. Bu kaynak açıldığında kurum bazlı alım ilanlarının birincil başvuru ekranı izlenir.',
    allowHosts: ['kariyerkapisi.gov.tr'],
    tags: ['core', 'requires-browser', 'disabled-by-default'],
    maxListingPages: 1,
    verification: {
      verified: false,
      verifiedAt: null,
      method: 'HTTP GET (liste JS ile üretiliyor)',
      evidence:
        '12.10.2026 canlı kontrol: sayfa 200 döndü, "Aktif İlanlar" bölümü boş geldi; ilan tablosu sunucu HTML’inde yok.',
      scope: 'Liste çıkarımı doğrulanmadı; tarayıcı tabanlı adaptör gerekir.',
    },
  },
  {
    adapterKey: 'esube-iskur',
    name: 'İŞKUR e-Şube — Açık İş İlanları',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    homepageUrl: 'https://esube.iskur.gov.tr/',
    listingUrl: 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx',
    sourceType: 'institution-page',
    method: 'manual-entry',
    enabled: false,
    scrapeIntervalMinutes: 360,
    minRequestIntervalMs: 5000,
    maxConcurrency: 1,
    status: 'needs-manual-method',
    statusNote:
      'İlan arama ekranı ASP.NET postback + oturum (viewstate) ile çalışıyor. Otomatik toplama, kaynağın kullanım koşullarını zorlayacağı için kapalı tutulur; manuel kayıt veya resmî duyuru bağlantısı ile izlenir.',
    coverageNotes:
      'Kamu işçisi ilanlarının bir kısmı burada yayımlanır; ilan.gov.tr ve Resmî Gazete üzerinden dolaylı kapsama sağlanır.',
    allowHosts: ['esube.iskur.gov.tr'],
    tags: ['access-constraint', 'manual'],
    maxListingPages: 1,
    verification: {
      verified: false,
      verifiedAt: null,
      method: 'İncelendi: otomatik toplama uygun değil',
      evidence: 'Ekran postback tabanlı; oturum/viewstate gerekiyor. CAPTCHA veya erişim kontrolü aşılmaz.',
      scope: 'Kapsam dışı (manuel yöntem).',
    },
  },
  {
    adapterKey: 'kamuilan-sbb',
    name: 'Kamu İlan (Strateji ve Bütçe Başkanlığı)',
    institution: 'T.C. Cumhurbaşkanlığı Strateji ve Bütçe Başkanlığı',
    homepageUrl: 'https://kamuilan.sbb.gov.tr/',
    listingUrl: 'https://kamuilan.sbb.gov.tr/',
    sourceType: 'regional-restricted',
    method: 'html-list',
    enabled: false,
    scrapeIntervalMinutes: 120,
    minRequestIntervalMs: 3000,
    maxConcurrency: 1,
    status: 'access-restricted',
    statusNote:
      'Kamu ilanlarını kurum ayrımı yapmadan listeleyen merkezî ekran. Bu ortamdan erişim coğrafi/WAF kısıtıyla 403 döndü ("Geographic Restriction"). Türkiye’den çalışan bir dağıtımda açılabilir; kısıt aşılmaya çalışılmaz.',
    coverageNotes: 'Erişim sağlandığında memur, sözleşmeli, işçi ve akademik ilanları tek listeden toplayan en geniş kaynak.',
    allowHosts: ['kamuilan.sbb.gov.tr'],
    tags: ['core', 'aggregator', 'access-restricted'],
    maxListingPages: 2,
    verification: {
      verified: false,
      verifiedAt: null,
      method: 'HTTP GET (canlı deneme)',
      evidence: '12.10.2026: HTTP 403 — "Geographic Restriction / Access Denied" (altosec WAF).',
      scope: 'Erişim engeli nedeniyle kapsam alınamadı.',
    },
  },
] as const;

/**
 * Envanterde olan ancak henüz entegre edilmemiş kaynaklar.
 * Bu liste yönetici panelinde "henüz entegre edilmedi" olarak sayılır ve
 * docs/source-onboarding.md adımlarıyla gerçek kaynağa dönüştürülür.
 */
export interface PlannedSource {
  id: string;
  name: string;
  group: 'bakanlik' | 'kurum' | 'universite' | 'belediye' | 'diger';
  note: string;
}

export const PLANNED_SOURCES: readonly PlannedSource[] = [
  { id: 'saglik-bakanligi', name: 'Sağlık Bakanlığı — personel alım duyuruları', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı; 4/B ve sözleşmeli alım duyuruları kendi sitesinde yayımlanıyor.' },
  { id: 'aile-sosyal-hizmetler', name: 'Aile ve Sosyal Hizmetler Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'adalet-bakanligi', name: 'Adalet Bakanlığı (zabıt kâtibi, infaz koruma memuru)', group: 'bakanlik', note: 'İlanlar çoğunlukla Resmî Gazete ve ilan.gov.tr üzerinden geliyor; kendi sayfası da izlenebilir.' },
  { id: 'icisleri-bakanligi', name: 'İçişleri Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'calisma-sosyal-guvenlik', name: 'Çalışma ve Sosyal Güvenlik Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'genclik-spor-bakanligi', name: 'Gençlik ve Spor Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'hazine-maliye', name: 'Hazine ve Maliye Bakanlığı', group: 'bakanlik', note: 'Uzman yardımcılığı sınavları kendi sayfasında ve Resmî Gazete’de.' },
  { id: 'ticaret-bakanligi', name: 'Ticaret Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'tarim-orman', name: 'Tarım ve Orman Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'ulastirma-altyapi', name: 'Ulaştırma ve Altyapı Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'cevre-sehircilik', name: 'Çevre, Şehircilik ve İklim Değişikliği Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'kultur-turizm', name: 'Kültür ve Turizm Bakanlığı', group: 'bakanlik', note: 'Vakıflar Genel Müdürlüğü ilanları Resmî Gazete’de doğrulandı; bakanlık sayfası ayrıca izlenebilir.' },
  { id: 'sanayi-teknoloji', name: 'Sanayi ve Teknoloji Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'enerji-tabii-kaynaklar', name: 'Enerji ve Tabii Kaynaklar Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'disisleri', name: 'Dışişleri Bakanlığı', group: 'bakanlik', note: 'Kariyer memurluğu sınavları kendi sayfasında.' },
  { id: 'milli-savunma', name: 'Millî Savunma Bakanlığı', group: 'bakanlik', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'goc-idaresi', name: 'Göç İdaresi Başkanlığı', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'afad', name: 'AFAD', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'sgk', name: 'Sosyal Güvenlik Kurumu', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'gelir-idaresi', name: 'Gelir İdaresi Başkanlığı', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'tuik', name: 'TÜİK', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'dsi', name: 'Devlet Su İşleri Genel Müdürlüğü', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'kgm', name: 'Karayolları Genel Müdürlüğü', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'tapu-kadastro', name: 'Tapu ve Kadastro Genel Müdürlüğü', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'tubitak', name: 'TÜBİTAK', group: 'kurum', note: 'İlan listeleme adresi doğrulanmadı.' },
  { id: 'yok', name: 'Yükseköğretim Kurulu (YÖK)', group: 'kurum', note: 'Akademik ilanlar ilan.gov.tr üzerinden doğrulandı; YÖK sayfası ayrıca izlenebilir.' },
  { id: 'universiteler', name: 'Devlet üniversiteleri (125 kurum)', group: 'universite', note: 'Yüzlerce siteyi ayrı ayrı taramamak için ilan.gov.tr akademik kategorisi ve Resmî Gazete kullanılıyor; kuruma özel ekler onboarding ile eklenir.' },
  { id: 'universite-hastaneleri', name: 'Üniversite hastaneleri', group: 'universite', note: 'İlanlar Sağlık Bakanlığı/ilan.gov.tr üzerinden dolaylı izleniyor.' },
  { id: 'buyuksehir-belediyeleri', name: 'Büyükşehir belediyeleri', group: 'belediye', note: 'İlan.gov.tr ve Resmî Gazete üzerinden kapsanıyor; kuruma özel sayfalar onboarding ile eklenir.' },
  { id: 'ilce-belediyeleri', name: 'İlçe belediyeleri', group: 'belediye', note: 'İlan.gov.tr üzerinden kapsanıyor.' },
  { id: 'belediye-bagli-idareler', name: 'Belediye bağlı idareleri ve yerel yönetim kuruluşları', group: 'belediye', note: 'İlan.gov.tr üzerinden kapsanıyor.' },
  { id: 'duzenleyici-kurumlar', name: 'Düzenleyici ve denetleyici kurumlar (BDDK, SPK, EPDK, RTÜK vb.)', group: 'diger', note: 'Kariyer meslek ilanları Resmî Gazete’de doğrulandı (örn. TMSF).' },
] as const;

export function findSourceDefinition(adapterKey: string, listingUrl: string): SourceDefinition | undefined {
  return SOURCE_DEFINITIONS.find((source) => source.adapterKey === adapterKey && source.listingUrl === listingUrl);
}
