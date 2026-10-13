/**
 * Çıkarım sözlükleri (Türkçe kamu personel alımı alanı).
 *
 * Bu sözlükler yalnızca metinde geçen DEĞERİ tanımak için kullanılır; eksik
 * bilgi doldurmak için asla kullanılmaz. Sözlükte olmayan bir unvan/alan
 * güvenle çıkarılamıyorsa alan "belirtilmemiş" kalır.
 */
import { normalizeTr } from '../domain/text';

export const PROVINCES: readonly string[] = [
  'Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara', 'Antalya', 'Ardahan',
  'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu',
  'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Düzce', 'Edirne',
  'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkâri', 'Hatay',
  'Iğdır', 'Isparta', 'İstanbul', 'İzmir', 'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars', 'Kastamonu',
  'Kayseri', 'Kırıkkale', 'Kırklareli', 'Kırşehir', 'Kilis', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya',
  'Manisa', 'Mardin', 'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye', 'Rize',
  'Sakarya', 'Samsun', 'Siirt', 'Sinop', 'Sivas', 'Şanlıurfa', 'Şırnak', 'Tekirdağ', 'Tokat', 'Trabzon',
  'Tunceli', 'Uşak', 'Van', 'Yalova', 'Yozgat', 'Zonguldak',
];

/** İl adlarının normalize edilmiş biçimleri (metinde arama için). */
export const PROVINCE_NEEDLES: readonly { name: string; needle: string }[] = PROVINCES.map((name) => ({
  name,
  needle: ` ${normalizeTr(name)} `,
}));

/** Sık geçen unvanlar. Daha uzun unvanlar önce eşleşir (kısmi eşleşmeyi engeller). */
export const JOB_TITLES: readonly string[] = [
  'Doktor Öğretim Üyesi',
  'Araştırma Görevlisi',
  'Öğretim Görevlisi',
  'Hemşire',
  'Ebe',
  'Sağlık Teknikeri',
  'Sağlık Memuru',
  'Laborant',
  'Röntgen Teknisyeni',
  'Anestezi Teknikeri',
  'Tıbbi Sekreter',
  'Diyetisyen',
  'Psikolog',
  'Sosyal Çalışmacı',
  'Veteriner Hekim',
  'Eczacı',
  'Zabıt Kâtibi',
  'İnfaz ve Koruma Memuru',
  'Veri Hazırlama ve Kontrol İşletmeni',
  'Bilgisayar İşletmeni',
  'Uzman Yardımcısı',
  'Denetçi Yardımcısı',
  'Kariyer Uzmanı',
  'Mühendis',
  'Mimar',
  'Şehir Plancısı',
  'Tekniker',
  'Teknisyen',
  'Avukat',
  'Öğretmen',
  'Kütüphaneci',
  'İtfaiye Eri',
  'Güvenlik Görevlisi',
  'Temizlik Personeli',
  'Şoför',
  'Aşçı',
  'Bahçıvan',
  'Kaloriferci',
  'Bekçi',
  'Memur',
  'Sözleşmeli Personel',
  'Kamu İşçisi',
  'İşçi',
];

/** Çalışma biçimi ipuçları (cümle içinde aranır). */
export const EMPLOYMENT_TYPE_KEYWORDS: readonly { type: string; needles: readonly string[] }[] = [
  {
    type: 'kadrolu',
    needles: ['kadrolu', '657 sayılı devlet memurları', 'memur alım', 'kadro karşılığı', 'kadrolu memur'],
  },
  {
    type: 'sozlesmeli',
    needles: ['4/b', '4b', 'sözleşmeli', 'sözleşmeli personel', '4-c', '4c', 'geçici personel'],
  },
  {
    type: 'kamu-isci',
    needles: ['işçi alım', 'sürekli işçi', 'geçici işçi', 'kamu işçisi', 'toplu iş sözleşmesi', 'işkur'],
  },
  {
    type: 'akademik',
    needles: ['öğretim üyesi', 'araştırma görevlisi', 'öğretim görevlisi', 'doçent', 'profesör', '2547'],
  },
  {
    type: 'kariyer-meslek',
    needles: ['uzman yardımcılığı', 'denetçi yardımcılığı', 'müfettiş yardımcılığı', 'kariyer memur'],
  },
  {
    type: 'kuruma-ozel-sinav',
    needles: ['kuruma özel', 'giriş sınavı', 'sözlü sınav', 'yazılı sınav', 'uygulama sınavı'],
  },
];

/** Reddedilmesi gereken içerik (personel alımı DEĞİL). */
export const REJECT_KEYWORDS: readonly string[] = [
  'ihale',
  'satın alma',
  'ihalesi',
  'tebliğ',
  'ilanı sonuçları',
  'sonuç açıklandı',
  'atama kararı',
  'yönetmelik',
  'genelge',
  'burs',
  'staj',
  'stajyer',
  'kura sonucu',
  'yerleştirme sonucu',
  'sınav sonucu',
  'cevap anahtarı',
  'değerlendirme sonucu',
  'hizmet alımı',
  'kiralama',
  'devlet malzeme ofisi',
  'yıkım',
  'inşaat işi',
];

export const ACCEPT_KEYWORDS: readonly string[] = [
  'personel alımı',
  'personel alınacak',
  'memur alımı',
  'sözleşmeli personel',
  'işçi alımı',
  'kadro',
  'kontenjan',
  'başvuru şartları',
  'giriş sınavı',
  'uzman yardımcılığı',
  'öğretim üyesi',
  'araştırma görevlisi',
  'hemşire',
  'sağlık teknikeri',
  'zabıt kâtibi',
  'infaz ve koruma memuru',
  'başvuru tarihleri',
  'adayların',
  'KPSS',
];

/** Eğitim düzeyi ifadeleri. */
export const EDUCATION_KEYWORDS: readonly { level: string; needles: readonly string[] }[] = [
  { level: 'ilkogretim', needles: ['ilköğretim', 'ilk ogretim'] },
  { level: 'ortaogretim', needles: ['ortaöğretim', 'lise mezunu', 'lise ve dengi', 'meslek lisesi'] },
  { level: 'onlisans', needles: ['ön lisans', 'önlisans', 'iki yıllık yüksekokul'] },
  { level: 'lisans', needles: ['lisans', 'dört yıllık', 'fakülte mezunu'] },
  { level: 'yukseklisans', needles: ['yüksek lisans', 'tezli yüksek lisans', 'master'] },
  { level: 'doktora', needles: ['doktora', 'sanatta yeterlik', 'sanatta yeterlilik'] },
];

/** KPSS puan türleri. */
export const KPSS_TYPES: readonly string[] = [
  'P1', 'P2', 'P3', 'P10', 'P93', 'P94', 'DHBT', 'P121', 'P124', 'P128', 'P131',
];

/** Bölüm/program adları (başvuru şartlarında geçer). */
export const DEPARTMENTS: readonly string[] = [
  'Hemşirelik',
  'Sağlık Memurluğu',
  'Ebelik',
  'Tıbbi Dokümantasyon ve Sekreterlik',
  'Laboratuvar Teknolojisi',
  'Anestezi',
  'Radyoloji',
  'Fizyoterapi',
  'Beslenme ve Diyetetik',
  'Psikoloji',
  'Sosyal Hizmet',
  'Çocuk Gelişimi',
  'Sosyoloji',
  'Hukuk',
  'Adalet',
  'İşletme',
  'İktisat',
  'Maliye',
  'Muhasebe',
  'Kamu Yönetimi',
  'Çalışma Ekonomisi ve Endüstri İlişkileri',
  'Bilgisayar Mühendisliği',
  'Yazılım Mühendisliği',
  'Elektrik-Elektronik Mühendisliği',
  'Makine Mühendisliği',
  'İnşaat Mühendisliği',
  'Harita Mühendisliği',
  'Endüstri Mühendisliği',
  'Çevre Mühendisliği',
  'Ziraat Mühendisliği',
  'Jeoloji Mühendisliği',
  'Gıda Mühendisliği',
  'Kimya Mühendisliği',
  'Şehir ve Bölge Planlama',
  'Mimarlık',
  'İstatistik',
  'Matematik',
  'Fizik',
  'Kimya',
  'Biyoloji',
  'Türk Dili ve Edebiyatı',
  'Tarih',
  'Coğrafya',
  'İlahiyat',
  'Sınıf Öğretmenliği',
  'Beden Eğitimi ve Spor',
  'Veterinerlik',
  'Eczacılık',
  'Diş Hekimliği',
  'Tıp',
  'Elektrik',
  'Elektronik',
  'Mekatronik',
  'Makine',
  'Motor',
  'Kaynakçılık',
  'Aşçılık',
  'Turizm ve Otel İşletmeciliği',
];

/** Aranan belgeler/sertifikalar. */
export const CERTIFICATES: readonly string[] = [
  'Bilgisayar İşletmenliği',
  'İş Sağlığı ve Güvenliği',
  'İlk Yardım',
  'Sürücü Belgesi',
  'MYK Belgesi',
  'İngilizce Yeterlik Belgesi',
  'Kalorifer Ateşçiliği',
  'Hijyen Eğitimi Belgesi',
  'Güvenlik Görevlisi Kimlik Kartı',
  'Silah Taşıma Ruhsatı',
];

/** Yabancı dil ifadeleri. */
export const FOREIGN_LANGUAGES: readonly string[] = [
  'İngilizce',
  'Almanca',
  'Fransızca',
  'Arapça',
  'Rusça',
  'Farsça',
  'İspanyolca',
  'İtalyanca',
  'Çince',
];

/** Başvuru yöntemi ifadeleri. */
/**
 * Başvuru yöntemi ifadeleri (ilan metninde geçen kalıplar).
 *
 * Not: Sınav adları (ALES/YDS/YÖKDİL) burada DEĞİLDİR — onlar başvuru yöntemi
 * değil, başvuru şartıdır; listede kalınca "Başvuru yöntemi: ALES, YDS"
 * gibi yanlış bir bilgi üretiyorlardı ("uydurma yok" ilkesi).
 *
 * Kalıplar, gerçek ilan diliyle uyumlu olacak şekilde genişletildi:
 * "posta yoluyla", "şahsen veya posta", "elden teslim", "noter kanalıyla"…
 */
export const APPLICATION_METHODS: readonly string[] = [
  'Kariyer Kapısı',
  'e-Devlet',
  'İŞKUR',
  'elektronik ortamda',
  'elektronik başvuru',
  'online başvuru',
  'internet üzerinden',
  'şahsen başvuru',
  'şahsen veya posta',
  'elden başvuru',
  'elden teslim',
  'posta yoluyla',
  'posta ile başvuru',
  'kargo ile başvuru',
  'noter kanalıyla',
  'faks ile başvuru',
  'e-posta ile başvuru',
];

/**
 * Başvuru bağlantısı olarak kabul edilen adresler.
 * Bu liste dışındaki adresler "başvuru bağlantısı" sayılmaz (uydurma link yok).
 */
/**
 * Başvuru ekranı barındıran resmî sistemler.
 *
 * DİKKAT: ilan listeleme/duyuru siteleri (ilan.gov.tr, kamuilan.sbb.gov.tr) burada
 * YER ALMAZ; onlar başvuru ekranı değil, ilan yayın platformudur. Aksi halde bir
 * ilanın kendi detay bağlantısı yanlışlıkla "başvuru bağlantısı" olurdu.
 */
export const APPLICATION_URL_HOSTS: readonly string[] = [
  'kariyerkapisi.gov.tr',
  'isealim.gov.tr',
  'esube.iskur.gov.tr',
  'iskur.gov.tr',
  'turkiye.gov.tr',
  'osym.gov.tr',
  'ais.osym.gov.tr',
];

/** Başvuru bağlantısı metin kalıpları. */
export const APPLICATION_LINK_TEXT_PATTERNS: readonly RegExp[] = [
  /ba[şs]vuru\s+(?:yap|linki|ba[ğg]lant[ıi]s[ıi]|ekran)/i,
  /ba[şs]vuru\s+adresi/i,
  /e-?devlet/i,
  /kariyer\s*kap[ıi]s[ıi]/i,
  /online\s+ba[şs]vuru/i,
];

/** Kanıt alanında kullanılan alan adları (fieldSources). */
export const LISTING_FIELDS = ['baslik', 'kurum', 'il', 'ilce', 'yayim_tarihi', 'ilan_no'] as const;
export const DETAIL_FIELDS = ['metin', 'basvuru_tarihleri', 'kontenjan', 'ekler', 'basvuru_baglantisi'] as const;
