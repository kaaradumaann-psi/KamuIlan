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
  /**
   * İncelenmiş robots.txt `Disallow` kuralları (`User-agent: *`); HTTP istemcisi eşleşen
   * adrese istek göndermez. İnceleme tarihi/kaynağı `config/source-terms.json` notundadır.
   */
  robotsDisallow?: string[];
  /** İçerik değişmediyse (ETag/Last-Modified) ayrıntı isteği yapılmaz. */
  conditionalRequests?: boolean;
  /**
   * Ortak liste adaptörü için kaynağa özgü ayrıştırma ayarları (canlı sayfada doğrulanmış):
   * `listContainer` liste kapsayıcısının CSS seçicisi, `pathPattern` detay bağlantısı deseni
   * (RegExp kaynağı; yol + sorgu üzerinde, büyük/küçük harf duyarsız).
   */
  listing?: { listContainer?: string; pathPattern?: string };
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
      'Günlük nüshadaki "Çeşitli İlânlar" bölümü HTML olarak okunur; ilan metni PDF içinde olduğundan PDF metni çıkarılır. ' +
      "HTTP başlık zaman aşımına uğrarsa bölüm ve PDF'ler tarayıcı oturumundan okunur; belge indirme bütçesi dolarsa kalan ilanlar sonraki taramaya kalır.",
    lastVerifiedAt: VERIFIED_AT,
    verificationEvidence:
      `${VERIFIED_AT} canlı doğrulama: /fihrist?tarih=2026-10-12 sayfası açıldı; ` +
      '/ilanlar/eskiilanlar/2026/10/20261012-4.htm içinde 7 ilan başlığı ve her birine ait PDF bağlantısı ' +
      '(ör. 20261012-4-5.pdf) görüldü; PDF metni metin katmanından okunabildi. ' +
      '4. koşum (13.10.2026): HTTP zaman aşımı sonrası tarayıcı yedeği çalıştı; 2026-10-13 nüshasından bütçe sınırıyla 5 PDF işlenip kayıt üretildi (önceki 3 koşumda kaynak hata veriyordu). ' +
      '5. koşumda da tarayıcı yolu 5 kayıt üretti (sınır notu tekilleştirilmiş haliyle).',
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
    status: 'scraper-built',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: sertifika zinciri doğrulanamadı (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Node 22.15+ ile yeniden doğrulanana kadar doğrulanmış sayılmaz.',
    lastVerifiedAt: null,
    verificationEvidence:
      "22.10.2026 canlı deneme: TLS: www.ilan.gov.tr ara sertifikayı göndermiyor; certs/intermediates/geotrust-tls-rsa-ca-g1.pem ile Mozilla kökleri üzerinden doğrulandı (yalnız kökle UNABLE_TO_VERIFY_LEAF_SIGNATURE). Liste HTML'i Angular kabuğu (0 satır); veriyi Ad/AdsByFilter API'si veriyor ve tarayıcı dışı istemciye 403 dönüyor → Chromium gerekir (SOURCE_BROWSER_FALLBACK=1). Kullanım şartları incelemesi: BLOCKED. " +
      '14.10.2026 canlı koşumunda bu adres TLS zinciri hatasıyla okunamadı. Aşağıdaki gözlemler ' +
      `tarihseldir (${VERIFIED_AT} ve 13.10.2026): personel-alimi listesi açıldı (157 ilan, 14 sayfa); ` +
      'örnek ilanlarda kurum adı, YOK***/DPB***/ILN*** tipi resmî ilan numaraları ve detay bağlantıları görüldü. ' +
      '13.10.2026 tarihsel koşumlarda düz HTTP ve tarayıcı yolları incelendi; beş sayfada 60 satır görülüp 40 kayıt işlendi. ' +
      'Bu gözlemler o tarihteki yapıya/koda aittir; güncel erişim, TLS yolu, parser ve tam kapsamı kanıtlamaz.',
    coverageNote:
      'Üniversite ve belediye ilanlarının büyük bölümü burada tek listede toplanır; yüzlerce kurum sayfasını ayrı ayrı taramamak için birincil toplayıcı.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 2000,
    maxConcurrency: 1,
    allowedHosts: ['ilan.gov.tr', 'www.ilan.gov.tr', 'medya.ilan.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/*tebligat'],
    tags: ['cekirdek', 'toplayici', 'html'],
  },
  {
    key: 'ilan-gov-tr-api-personel',
    name: 'ilan.gov.tr — Personel alımı havuzu (JSON API)',
    group: 'ulusal',
    sourceType: 'official-portal',
    institution: 'Basın İlan Kurumu',
    listingUrl: 'https://www.ilan.gov.tr/ilan/tum-ilanlar/personel-alimi?ats=5',
    homepageUrl: 'https://www.ilan.gov.tr/',
    adapterKey: 'ilan-gov-tr-api',
    method: 'json-api',
    status: 'scraper-built',
    statusNote:
      '14.10.2026 ekosistem araştırmasıyla API sözleşmesi keşfedildi (github.com/Ruchanbas/rg-ilan-botu ' +
      'canlı doğrulaması: AdsByFilter + GetAdDetail GitHub Actions runner’larından 200 döner). ' +
      'Fixture testleriyle doğrulandı; bu ortamdan canlı çalıştırma henüz yapılmadı. İlk canlı taramada ' +
      'HTTP durum kodları ve tarama notları kontrol edilmeli.',
    lastVerifiedAt: null,
    verificationEvidence:
      "22.10.2026 canlı deneme: POST /api/api/services/app/Ad/AdsByFilter: eski gövde ({keys:{q:[..]}}) 500, sayfanın gövdesi ({keys:{ats:['5']}}) 403 (erişim kısıtı; aşılmadı). Kullanım şartları incelemesi: BLOCKED. " +
      'github.com/Ruchanbas/rg-ilan-botu/src/rgbot/ilanapi.py (canlı doğrulanmış API sözleşmesi: ' +
      'POST /api/api/services/app/Ad/AdsByFilter {"keys":{"q":[terim]}} + GET AdDetail/GetAdDetail); ' +
      'tests/ilan-gov-tr-api.test.ts sözleşmenin fixture doğrulaması. HTML liste adaptörünün ' +
      'doğrulaması docs/envanter-dogrulama-2026-10-11.md §3.',
    coverageNote:
      'HTML liste adaptörünün tamamlayıcısı: metin aramasıyla geniş havuz (5 terim × offset sayfaları, ' +
      'skipCount), yapılandırılmış alanlar (kurum, il, resmî ilan no, "Son Başvuru" filtresi). Alakasız ' +
      'kayıtlar sınıflandırma hattının ret belleğiyle elenir; ihale/sonuç ilanları kapsam dışıdır.',
    enabled: true,
    intervalMinutes: 90,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['ilan.gov.tr', 'www.ilan.gov.tr', 'medya.ilan.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/*tebligat'],
    tags: ['toplayici', 'json-api'],
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
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): 447 duyuru bağlantısı bulundu; detay bütçesiyle 2 kayıt işlendi. ' +
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
    status: 'access-restricted',
    statusNote:
      'Sayfa artık yalnız il haritası ve il başına ilan SAYISI veriyor; ilan satırları yalnız `?idId=&il=` sorgulu ' +
      'sayfalarda. robots.txt `Disallow: /*?*` ve `/api/` ile bunları yasaklıyor → satır okunamaz; kısıt aşılmaz (kaynak şartları kaydı ayrıca güncellenmeli).',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '22.10.2026 canlı inceleme: liste HTML’inde .clickable-row satırı yok (0); il seçimi `?idId=..&il=..` adresine gider; robots.txt (User-agent: *) `Disallow: /*?*`, `/api/`. JSON ucu robots ile yasak. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 3 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Memur ve sözleşmeli personel duyurularının İŞKUR tarafındaki yayını.',
    enabled: true,
    intervalMinutes: 120,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['iskur.gov.tr', 'www.iskur.gov.tr'],
    // robots.txt (21.10.2026, User-agent *): /api/ ve sorgu dizeli adresler yasak.
    robotsDisallow: ['/api/', '/*?*'],
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
    status: 'access-restricted',
    statusNote:
      'Sayfa artık yalnız il haritası ve il başına ilan SAYISI veriyor; ilan satırları yalnız `?idId=&il=` sorgulu ' +
      'sayfalarda. robots.txt `Disallow: /*?*` ve `/api/` ile bunları yasaklıyor → satır okunamaz; kısıt aşılmaz (kaynak şartları kaydı ayrıca güncellenmeli).',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '22.10.2026 canlı inceleme: liste HTML’inde .clickable-row satırı yok (0); il seçimi `?idId=..&il=..` adresine gider; robots.txt (User-agent: *) `Disallow: /*?*`, `/api/`. JSON ucu robots ile yasak. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 3 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Kamu işçisi (sürekli/geçici işçi) alımlarının İŞKUR yayını.',
    enabled: true,
    intervalMinutes: 180,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['iskur.gov.tr', 'www.iskur.gov.tr'],
    // robots.txt (21.10.2026, User-agent *): /api/ ve sorgu dizeli adresler yasak.
    robotsDisallow: ['/api/', '/*?*'],
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
    method: 'html-list',
    status: 'verified',
    statusNote:
      'Liste (#pnlIlanlar) sunucu tarafında üretilir: önce düz HTTP denenir; canlıda HTTP 200 dönmesine ' +
      'rağmen satır gelmedi (alınan sayfanın başlığı tanı için notlara yazılıyor), tarayıcı yolu (Playwright + ' +
      'Chromium) listenin tamamını okur — 5. koşumda 27 satırın tümü, dış "İlana Git" başvuruları dahil. ' +
      'Detayda kararlı öğe kimliklerinden ilan numarası (ILN...), tür, başvuru tarihleri, kontenjan ve ' +
      "e-Devlet başvuru adresi okunur (13.10.2026, gerçek sayfa HTML'i ile doğrulandı). Detay bütçesi " +
      'önce daha önce görülmemiş ilanlara harcanır.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Liste resmî anonim JSON ucundan (api.kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage) okundu: 32 aktif ilan; detay GetIlanPreviewPublic ile ILN no/tarih/metin alındı. Chromium gerekmez. ' +
      "13.10.2026: liste ve detay sayfalarının gerçek HTML'i kullanıcıdan alındı; satır/detay yapısı " +
      'birim testlerine fikstür olarak işlendi (tests/sources.test.ts). Canlı koşumda henüz kayıt üretilmedi ' +
      '(3. koşum: ok, 0 kayıt — eski tablo varsayımı); yeniden yazım sonrası koşum bekleniyor. ' +
      '4. koşum (13.10.2026, yeniden yazım öncesi kod): tarayıcı ile 23 kayıt üretildi; gönderilen sayfa ' +
      'HTML\'iyle karşılaştırınca 4 dış "İlana Git" satırının eksik olduğu görüldü — eksik, yeniden yazımla ' +
      'kapatıldı. 5. koşum (13.10.2026, yeni kod): 27 kaydın tamamı üretildi (23 iç detay bağlantısı + 4 dış ' +
      'başvuru); liste tarayıcı ile okundu, detaylardan ilan numarası/tarihler/metin alındı.',
    coverageNote:
      'Kurumların merkezî başvuru ekranı. Dış "İlana Git" satırları kurumun kendi başvuru sayfasına gider; ' +
      'iç detaylarda resmî başvuru adresi e-Devlet bağlantısıdır.',
    enabled: true,
    intervalMinutes: 60,
    minRequestIntervalMs: 3000,
    maxConcurrency: 1,
    allowedHosts: ['kariyerkapisi.gov.tr', 'www.kariyerkapisi.gov.tr', 'api.kariyerkapisi.gov.tr'],
    tags: ['cekirdek', 'tarayici', 'playwright'],
  },
  {
    key: 'meb-personel-duyurular',
    name: 'MEB Personel Genel Müdürlüğü — Duyurular',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'T.C. Millî Eğitim Bakanlığı',
    listingUrl: 'https://personel.meb.gov.tr/meb_iys_dosyalar/xml/rss_duyurular.xml',
    homepageUrl: 'https://personel.meb.gov.tr/',
    adapterKey: 'meb-duyuru-listesi',
    method: 'html-list',
    status: 'verified',
    statusNote:
      'Liste sayfası JS ile yüklendiği için kurumun resmî RSS beslemesi kullanılır (meb_iys_dosyalar/xml/rss_duyurular.xml). Canlı koşumlarda doğrulandı.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): RSS beslemesinde 50 kayıt; detay bütçesiyle 2 kayıt işlendi. ' +
      'RSS beslemesi 13.10.2026 tarihinde bağımsız incelemeyle açıldı: Haberler (kategori 1) ve Duyurular (kategori 2) kayıtları /www/<slug>/icerik/<id> bağlantıları ve yayın tarihleriyle geliyor. ' +
      '13.10.2026 canlı koşumlarında (1-5) beslemeden her seferinde 50 kayıt okundu, 30 yeni kayıt işlendi.',
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): ul#nav2 zaman çizelgesinden 101 ilan okundu; sayfanın "101 ilan" sayacıyla eşleşti (kapsam tam). Önceki kod ?kod= sorgusunu atıp 101 ilanı 1\'e indiriyordu. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 4 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
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
    name: 'İŞKUR e-Şube — Kamu Açık İş İlanları',
    group: 'ulusal',
    sourceType: 'institution-page',
    institution: 'Türkiye İş Kurumu (İŞKUR)',
    listingUrl: 'https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx',
    homepageUrl: 'https://esube.iskur.gov.tr/',
    adapterKey: 'iskur-esube-kamu',
    method: 'html-list',
    status: 'verified',
    statusNote:
      'Arama ekranı ASP.NET postback + viewstate ile çalışır; form "Kamu" işyeri türüyle gönderilir, sonuçlar ' +
      '"Sonraki Sayfa" postback ile en fazla 30 sayfa izlenir, ayrıntı girişsiz açılan ilan sayfasından okunur. ' +
      'CAPTCHA/oturum zorunluluğu çıkarsa tarama durur (atlatma yok). Site sahibi onayı: 23.10.2026.',
    lastVerifiedAt: '2026-10-23',
    verificationEvidence:
      '23.10.2026 canlı deneme (kimlikli UA, istekler arası ≥5 sn, robots uyumlu): robots.txt yalnız ' +
      '"Disallow: /Meslek/ViewMeslekDetayPopUp.aspx/". Arama formu kamuRadio ile gönderildi: "Toplam Kayıt: 90", ' +
      '6 sonuç sayfası (15 satır/sayfa); 1→2→3. sayfa btnNext postback ile farklı ilan numaraları geldi. ' +
      'Detay (AcikIsIlanDetay.aspx?uiID=…) girişsiz açıldı: genel hususlar, özel şartlar, meslek ve öğrenim ' +
      'bölümleri okundu. CAPTCHA ya da kullanım şartı metni görülmedi.',
    coverageNote:
      'İŞKUR aracılığıyla kamu kurumlarının açtığı işçi talepleri (çoğu kuralı). Her İŞKUR ilan numarası ' +
      '(il il açılan talepler dahil) kendi il/kontenjan/son başvurusuyla ayrı ilandır.',
    enabled: true,
    intervalMinutes: 150,
    minRequestIntervalMs: 5000,
    maxConcurrency: 1,
    allowedHosts: ['esube.iskur.gov.tr'],
    // robots.txt (23.10.2026, User-agent *): yalnız meslek açıklaması açılır penceresi yasak.
    robotsDisallow: ['/Meslek/ViewMeslekDetayPopUp.aspx/'],
    tags: ['cekirdek', 'isci', 'html', 'postback'],
  },

  {
    key: 'saglik-bakanligi-personel',
    name: 'Sağlık Bakanlığı (YHGM) — Personel Alım Duyuruları',
    group: 'kurum',
    sourceType: 'institution-page',
    institution: 'T.C. Sağlık Bakanlığı',
    listingUrl: 'https://yhgm.saglik.gov.tr/TR-10084/duyurular.html',
    homepageUrl: 'https://www.saglik.gov.tr/',
    adapterKey: 'kurum-duyuru-listesi',
    method: 'html-list',
    status: 'verified',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: liste yapısı tanınmadı. Sayfa örneği (HTML) alınmadan seçici düzeltilemez; doğrulanmış sayılmaz.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Liste adresi anasayfa yerine /TR-10084/duyurular.html (#ada_AltSayfalar_items) yapıldı; 15 duyuru bağlantısı, detayla 2 kayıt işlendi. ' +
      '14.10.2026 canlı koşumu: sayfa alındı ancak ilan listesi ayrıştırılamadı. Doğrulanmış sayılmaz.',
    coverageNote: 'Sağlık personeli (sözleşmeli sağlık personeli, sürekli işçi) alım duyuruları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['yhgm.saglik.gov.tr', 'www.saglik.gov.tr'],
    conditionalRequests: true,
    listing: { listContainer: '#ada_AltSayfalar_items', pathPattern: '/TR-\\d+/[^/]+\\.html$' },
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): 5 duyuru bağlantısı; detayla 2 kayıt işlendi. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 14 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Zabıt kâtibi, infaz ve koruma memuru ve diğer personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.adalet.gov.tr', 'adalet.gov.tr', 'pgm.adalet.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/yonetim/'],
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 17 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Merkez ve taşra teşkilatı personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.icisleri.gov.tr', 'icisleri.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/kullanicilar', '/ortak_icerik', '/kurumlar', '/Kurumlar', '/Kullanicilar'],
    conditionalRequests: true,
    listing: { listContainer: '.announcement' },
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 25 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Sözleşmeli personel ve koruma/güvenlik alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.goc.gov.tr', 'goc.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/kullanicilar', '/ortak_icerik', '/kurumlar', '/Kurumlar', '/Kullanicilar'],
    conditionalRequests: true,
    listing: { listContainer: '.announcement' },
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): ISAY CMS listesi betikle açılan display:none blokta; iskelet temizliği düzeltildi. .announcement içinde 8 bağlantı, detayla 2 kayıt. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 25 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Arama-kurtarma ve destek personeli alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.afad.gov.tr', 'afad.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/kullanicilar', '/ortak_icerik', '/kurumlar', '/Kurumlar', '/Kullanicilar'],
    conditionalRequests: true,
    listing: { listContainer: '.announcement' },
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 25 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
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
    status: 'needs-manual-method',
    statusNote:
      'Site (Next.js) listeyi istemci tarafında oluşturuyor; düz HTTP isteği boş kabuk döndürüyor (13.10.2026 canlı koşum). Doğrudan tarama yapılamıyor; GIB personel/sınav duyuruları Resmî Gazete, ilan.gov.tr ve Kariyer Kapısı üzerinden de yayımlanır ve oradan izlenir. Tarayıcı tabanlı yöntem eklenene dek kapalı.',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '13.10.2026 canlı koşum (kullanıcı ağı): sayfa düz HTTP ile içeriksiz döndü; bağımsız tarayıcılı incelemede de boş JS kabuğu görüldü. Doğrudan taranamadığı canlıda doğrulandı.',
    coverageNote: 'Gelir uzman yardımcısı ve personel alımları.',
    enabled: false,
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
    status: 'needs-manual-method',
    statusNote:
      'Site JavaScript uygulaması; /duyurular adresi düz HTTP’de 404/boş kabuk döndürüyor (13.10.2026 canlı koşum). Doğrudan tarama yapılamıyor; TÜİK personel alımları Resmî Gazete ve Kariyer Kapısı üzerinden de yayımlanır ve oradan izlenir. Tarayıcı tabanlı yöntem eklenene dek kapalı.',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '13.10.2026 canlı koşum (kullanıcı ağı): sayfa düz HTTP ile içeriksiz döndü; bağımsız tarayıcılı incelemede de boş JS kabuğu görüldü. Doğrudan taranamadığı canlıda doğrulandı.',
    coverageNote: 'TÜİK uzman yardımcısı ve personel alımları.',
    enabled: false,
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
    status: 'verified',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: liste yapısı tanınmadı. Sayfa örneği (HTML) alınmadan seçici düzeltilemez; doğrulanmış sayılmaz.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Liste sayfayı saran WebForms <form> içinde; iskelet temizliği formu silmeyecek şekilde düzeltildi. 10 duyuru bağlantısı (/Duyuru/Detay/<id>) bulundu, detayla 1 kayıt işlendi. ' +
      '14.10.2026 canlı koşumu: sayfa alındı ancak ilan listesi ayrıştırılamadı. Doğrulanmış sayılmaz.',
    coverageNote: 'Mühendis, tekniker ve işçi alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.dsi.gov.tr', 'dsi.gov.tr'],
    conditionalRequests: true,
    listing: { pathPattern: '/Duyuru/Detay/\\d+' },
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
    status: 'scraper-built',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: liste yapısı tanınmadı. Sayfa örneği (HTML) alınmadan seçici düzeltilemez; doğrulanmış sayılmaz.',
    lastVerifiedAt: null,
    verificationEvidence:
      '14.10.2026 canlı koşumu: sayfa alındı ancak ilan listesi ayrıştırılamadı. Doğrulanmış sayılmaz.',
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
    status: 'verified',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: liste yapısı tanınmadı. Sayfa örneği (HTML) alınmadan seçici düzeltilemez; doğrulanmış sayılmaz.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Next.js akışlı çizim (<div hidden id="S:n">) içeriği artık silinmiyor; 6 duyuru bağlantısı, detayla 2 kayıt. ' +
      '14.10.2026 canlı koşumu: sayfa alındı ancak ilan listesi ayrıştırılamadı. Doğrulanmış sayılmaz.',
    coverageNote: 'Tapu ve kadastro personel alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tkgm.gov.tr', 'tkgm.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: ['/intranet/', '/api/', '/login/', '/preview/'],
    conditionalRequests: true,
    listing: { pathPattern: '^/duyurular/[^/]+$' },
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): 20 duyuru bağlantısı; detayla 2 kayıt işlendi. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 25 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
    coverageNote: 'Proje personeli, araştırmacı ve uzman alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tubitak.gov.tr', 'tubitak.gov.tr'],
    // robots.txt incelemesi 22.10.2026 (config/source-terms.json notu).
    robotsDisallow: [
      '/core/',
      '/profiles/',
      '/admin/',
      '/comment/reply/',
      '/filter/tips',
      '/node/add/',
      '/search/',
      '/user/',
      '/media/oembed',
      '/*/media/oembed',
      '/index.php/',
    ],
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): <body id="a11y-body-root"> artık iskelet sayılmıyor; 15 duyuru bağlantısı, detayla 2 kayıt. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 17 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
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
    status: 'verified',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: sertifika zinciri doğrulanamadı (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Node 22.15+ ile yeniden doğrulanana kadar doğrulanmış sayılmaz.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Sunucu artık tam zinciri gönderiyor (TLS sorunu giderilmiş). .kategoriList içinde 1052 /Duyuru/Detay bağlantısı; istek adresinde www korunuyor (bddk.org.tr ENOTFOUND hatası giderildi). Detayla 2 kayıt işlendi. ' +
      '14.10.2026 canlı koşumu: TLS zinciri hatası nedeniyle sayfa okunamadı. Doğrulanmış sayılmaz.',
    coverageNote: 'BDDK uzman yardımcısı ve kariyer meslek alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.bddk.org.tr', 'bddk.org.tr'],
    conditionalRequests: true,
    listing: { listContainer: '.kategoriList', pathPattern: '/Duyuru/Detay/\\d+' },
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
    status: 'verified',
    statusNote:
      'Adres ve sayfa yapısı doğrulandı; 13.10.2026 canlı koşumda çalıştı. Yapı değişirse tarama boş dönmez, hata kaydeder.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): 32 duyuru bağlantısı; detayla 2 kayıt işlendi. ' +
      '13.10.2026 canlı doğrulama koşumunda (kullanıcı ağı, npm run test:live) gerçek tarama çalıştı: 2 ham kayıt döndü (iş ilanı olmayanlar sınıflandırma hattında elenir).',
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
    status: 'verified',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: liste yapısı tanınmadı. Sayfa örneği (HTML) alınmadan seçici düzeltilemez; doğrulanmış sayılmaz.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Anasayfa duyuru kaydırıcısı (#duyuru-kaydir) ile menü gürültüsü ayıklandı: 12 bağlantı, detayla 2 kayıt. ' +
      '14.10.2026 canlı koşumu: sayfa alındı ancak ilan listesi ayrıştırılamadı. Doğrulanmış sayılmaz.',
    coverageNote: 'EPDK uzman yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.epdk.gov.tr', 'epdk.gov.tr'],
    conditionalRequests: true,
    listing: { listContainer: '#duyuru-kaydir', pathPattern: '/Detay/Icerik/\\d+-\\d+/' },
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
    status: 'needs-manual-method',
    statusNote:
      'Site JavaScript uygulaması; düz HTTP isteği boş kabuk/404 döndürüyor (13.10.2026 canlı koşum). Doğrudan tarama yapılamıyor; RTÜK personel alımları Resmî Gazete ve Kariyer Kapısı üzerinden de yayımlanır ve oradan izlenir. Tarayıcı tabanlı yöntem eklenene dek kapalı.',
    lastVerifiedAt: '2026-10-13',
    verificationEvidence:
      '13.10.2026 canlı koşum (kullanıcı ağı): sayfa düz HTTP ile içeriksiz döndü; bağımsız tarayıcılı incelemede de boş JS kabuğu görüldü. Doğrudan taranamadığı canlıda doğrulandı.',
    coverageNote: 'RTÜK uzman yardımcısı alımları.',
    enabled: false,
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
    status: 'verified',
    statusNote:
      'Canlı doğrulama (14.10.2026) başarısız: sertifika zinciri doğrulanamadı (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Node 22.15+ ile yeniden doğrulanana kadar doğrulanmış sayılmaz.',
    lastVerifiedAt: '2026-10-22',
    verificationEvidence:
      '22.10.2026 canlı deneme (kimlikli UA, ≥2 sn aralık, robots uyumlu, TLS doğrulaması açık): Sunucu ara sertifikayı göndermiyor; certs/intermediates/geotrust-tls-rsa-ca-g1.pem ile doğrulandı. Basın tablosu (form içinde) 10 bağlantı verdi; detayla 1 kayıt işlendi. ' +
      '14.10.2026 canlı koşumu: TLS zinciri hatası nedeniyle sayfa okunamadı. Doğrulanmış sayılmaz.',
    coverageNote: 'TMSF fon uzman yardımcısı alımları.',
    enabled: true,
    intervalMinutes: 360,
    minRequestIntervalMs: 2500,
    maxConcurrency: 1,
    allowedHosts: ['www.tmsf.org.tr', 'tmsf.org.tr'],
    conditionalRequests: true,
    listing: { listContainer: 'table.table-striped', pathPattern: '/tr/Basin/List/[^/]+$' },
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
    indirectCoverage:
      'İlanlar ilan.gov.tr ve Resmî Gazete üzerinden kısmen gelir; Sağlık Bakanlığı kaynağı hastane dışı alımları kapsar.',
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
