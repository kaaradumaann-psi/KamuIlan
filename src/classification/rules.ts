/**
 * Deterministik sınıflandırma kuralları (Türkçe).
 *
 * Kalıplar `normalizeTr()` çıktısı üzerinde çalışır: metin küçük harfe çevrilir,
 * Türkçe aksanlar katlanır (ı→i, ş→s, ğ→g, ü→u, ö→o, ç→c) ve noktalama sadeleşir.
 * Örnek: "SÖZLEŞMELİ PERSONEL ALIMI" → "sozlesmeli personel alimi".
 *
 * Kural grupları:
 *  - POSITIVE_RULES      : ilanın personel alımı olduğuna dair kanıt (puanlanır)
 *  - TITLE_REJECT_RULES  : başlık, ilanın personel alımı olmadığını kesinleştirir
 *  - BODY_REJECT_RULES   : gövdede kesinleştiren ifadeler (ihale, icra, kurs …)
 *  - SOFT_NEGATIVE_RULES : puan kıran, tek başına karar vermeyen ifadeler
 *
 * Önemli: "657 sayılı Devlet Memurları Kanunu" gibi ifadeler gerçek alım
 * ilanlarında geçtiği için mevzuat kuralı yalnızca Yönetmelik/Genelge/Tebliğ
 * başlıklarında uygulanır.
 */
import type { EmploymentType } from '../domain';
import { SITE_CHROME_TITLE_PATTERN } from '../domain/text';

export interface KeywordRule {
  id: string;
  /** İnsan tarafından okunabilir gerekçe (sınıflandırma çıktısına yazılır). */
  reason: string;
  pattern: RegExp;
  weight: number;
}

/**
 * Kamu ünvan/kadro sözlüğü (Türkçe katlanmış, küçük harf biçimler).
 *
 * 2026-10-16 canlı koşum bulgusu: "Hemşire, ebe ve sağlık teknikeri alımı",
 * "destek personeli alımı", "veri hazırlama ve kontrol işletmeni alımı",
 * "uzman erbaş temin ilanı" gibi başlıklarda alım/temin ifadesi ÜNVANDAN sonra
 * gelir. Eski kalıplar yalnızca "personel alımı" / "işçi alımı" biçimini
 * tanıyordu; bu başlıklar kanıt kapısında (RECRUITMENT_EVIDENCE_PATTERN)
 * reddediliyor ve gerçek ilanlar akışa hiç girmiyordu.
 *
 * Kapsam bilinçli olarak ünvana dar tutulur: "bilgisayar alımı", "hizmet alımı"
 * gibi tedarik başlıkları bu sözlükte yoktur ve reddedilmeye devam eder.
 */
const POSITION_NOUN = [
  'personel',
  'memur',
  'isci',
  'uzman',
  'muftes',
  'denetci',
  'kontrolor',
  'hemsire',
  'ebe',
  'saglik',
  'tekniker',
  'teknisyen',
  'laborant',
  'gorevli',
  'isletmen',
  'asci',
  'sofor',
  'mubasir',
  'katip',
  'muhandis',
  'mimar',
  'avukat',
  'psikolog',
  'fizyoterapist',
  'diyetisyen',
  'eczaci',
  'veteriner',
  'hekim',
  'doktor',
  'ogretmen',
  'okutman',
  'ogretim',
  'arastirma',
  'bekci',
  'polis',
  'subay',
  'astsubay',
  'erbas',
  'zabita',
  'itfaiye',
  'hizmetli',
  'kaloriferci',
  'bahcivan',
  'murakip',
  'imam',
  'muezzin',
  'vaiz',
  'kutuphaneci',
  'arkeolog',
  'grafiker',
  'tercuman',
  'programci',
  'cozumleyici',
  'restorator',
  'antrenor',
  'rehber',
  'biyolog',
  'kimyager',
  'istatistikci',
  'ekonomist',
  'muhasebeci',
].join('|');

/**
 * Ünvan + alım/temin kalıbı: "teknikeri alımı", "memuru alımı",
 * "subay temini", "erbaş ve er temini", "temin ilanı".
 */
export const POSITION_RECRUITMENT_PATTERN = new RegExp(
  `\\b(?:${POSITION_NOUN})\\w*\\s+al(?:i?m|inacak)\\w*` +
    `|\\b(?:${POSITION_NOUN}|er)\\w*\\s+temin\\w*` +
    `|\\btemin\\s+ilan\\w*`,
);

/**
 * İŞKUR aracılı alım: "3 (üç) temizlik görevlisi Türkiye İş Kurumu aracılığıyla alınacaktır",
 * "İŞKUR üzerinden … alınacak" (her iki sıra). Olumlu kural VE kanıt kapısı aynı tanımı kullanır.
 */
const ISKUR_RECRUITMENT_PATTERN =
  /\b(?:turkiye\s+is\s+kurumu|iskur)\w*\s+(?:araciligiyla|uzerinden)[\s\S]{0,80}?\bal(?:i?m|inacak)\w*|\bal(?:inacak|inacaktir)\w*[\s\S]{0,60}?\b(?:turkiye\s+is\s+kurumu|iskur)\w*\s+(?:araciligiyla|uzerinden)/;

/** "4857 sayılı İş Kanunu kapsamında çalıştırılmak üzere" (işçi statüsünde istihdam). */
const LABOUR_LAW_EMPLOYMENT_PATTERN = /\b4857\s+sayili\s+is\s+kanunu[\s\S]{0,80}?\bcalistirilmak\s+uzere/;

/** "Açıktan atama/alım … sınav ilanı": kurum dışından yeni personel (olumlu kural VE kanıt kapısı). */
const ACIKTAN_RECRUITMENT_PATTERN = /\baciktan\b[\s\S]{0,80}?\b(?:atama\w*|atan\w*|alim\w*|alin\w*|sinav\w*)/;

/** Personel alımı ilanı olduğunu gösteren olumlu kanıtlar. */
export const POSITIVE_RULES: readonly KeywordRule[] = [
  {
    id: 'pozitif.personel-alimi',
    reason: 'İlanda personel alımı ifadesi geçiyor',
    // "personel alımı", "personel alınacak", "destek personeli alımı", "personel alım ilanı"
    pattern: /\bpersonel\w*\s+al(?:i?m|inacak|imi|imlari|imina)/,
    weight: 3,
  },
  {
    id: 'pozitif.alim-ilani',
    reason: 'Alım ilanı/duyurusu ifadesi var',
    // "alım ilanı", "alım ilanları", "alım duyurusu"
    pattern: /\bal(?:i?m)\s+(?:ilan|duyuru)\w*/,
    weight: 3,
  },
  {
    id: 'pozitif.sozlesmeli-personel',
    reason: 'Sözleşmeli personel alımı ifadesi var',
    // "sözleşmeli personel", "sözleşmeli hekim", "4/B sözleşmeli"
    pattern: /\bsozlesmeli\s+(?:personel|bilisim|hekim|ogretmen|avukat|muhendis|tekniker|saglik|destek)/,
    weight: 3,
  },
  {
    id: 'pozitif.kadrolu-memur',
    reason: 'Kadrolu/memur alımı ifadesi var',
    // "kadrolu memur alımı", "memur alımı", "kadro karşılığı"
    pattern: /\b(?:kadrolu|memur)\s+(?:personel\s+)?al(?:i?m|inacak|imi)/,
    weight: 3,
  },
  {
    id: 'pozitif.isci-alimi',
    reason: 'İşçi alımı ifadesi var',
    // "sürekli işçi alımı", "geçici işçi alınacak"
    pattern: /\b(?:(?:surekli|gecici|mevsimlik)\s+)?(?:kamu\s+)?isci\s+al(?:i?m|inacak|imi)/,
    weight: 3,
  },
  {
    id: 'pozitif.akademik-alim',
    reason: 'Akademik kadro alımı ifadesi var',
    // "öğretim üyesi alımı", "araştırma görevlisi alınacak"
    pattern:
      /\b(?:ogretim\s+uyesi|ogretim\s+elemani|arastirma\s+gorevlisi|ogretim\s+gorevlisi)[\s\S]{0,40}?\bal(?:i?m|inacak|imi)/,
    weight: 3,
  },
  {
    id: 'pozitif.akademik-kadro',
    reason: 'Akademik kadro ilanı',
    // "Öğretim Üyesi Alım İlanı", "Öğretim Elemanı İlanı", "Öğretim Üyesi Kadrosu"
    pattern: /\b(?:ogretim\s+uyesi|ogretim\s+elemani)[\s\S]{0,30}?\b(?:ilan|duyuru|kadro|alim)\w*/,
    weight: 2.5,
  },
  {
    id: 'pozitif.kariyer-meslek',
    reason: 'Kariyer meslek / uzman yardımcılığı sınav ilanı',
    // "uzman yardımcılığı", "müfettiş yardımcılığı", "denetçi yardımcılığı", "fon uzman yardımcılığı"
    // "SPK Meslek Personel Yardımcılığı Giriş Sınavı" (23.10.2026 canlı: başlık kanıtı sayılmadığı için incelemeye düşüyordu).
    pattern: /\b(?:uzman|mufettis|denetci|kontrolor|aktor|avukat|stajyer\s+uzman|(?:meslek\s+)?personel)\s+yardimciligi/,
    weight: 3,
  },
  {
    id: 'pozitif.aciktan-atama',
    reason: 'Açıktan atama/alım (kurum dışından yeni personel) ifadesi var',
    // "2026 Yılı Açıktan İcra Müdür ve İcra Müdür Yardımcılığı Sınav İlanı", "açıktan atama yapılacaktır"
    pattern: ACIKTAN_RECRUITMENT_PATTERN,
    weight: 3,
  },
  {
    id: 'pozitif.isci-personel-istihdami',
    reason: 'İşçi/personel istihdamı ifadesi var',
    // "166 Sürekli İşçi İstihdamı", "sözleşmeli personel istihdam edilecektir"
    pattern: /\b(?:(?:surekli|gecici|mevsimlik|kamu)\s+)?(?:isci|personel)\w*\s+istihdam\w*/,
    weight: 3,
  },
  {
    id: 'pozitif.giris-sinavi-ilani',
    reason: 'Giriş/sözlü sınav ilanı (personel alımına ilişkin)',
    // "giriş sınavı ilanı", "giriş sınavı duyurusu", "sözlü sınav ilanı"
    pattern: /\b(?:giris|sozlu|yazili|uygulamali)?\s*sinav\w*\s+(?:ilan|duyuru)\w*/,
    weight: 2.5,
  },
  {
    id: 'pozitif.alim-sinavi',
    reason: 'Alım amacıyla sınav yapılacağı belirtiliyor',
    // "sınavla personel alınacak", "sınav sonucunda atama yapılacak"
    pattern: /\bsinav\w*[\s\S]{0,40}?(?:personel|kadro|memur|isci|uzman)\b/,
    weight: 1.5,
  },
  {
    id: 'pozitif.kontenjan',
    reason: 'Kontenjan/kadro sayısı bilgisi var',
    // "kontenjan", "kadro sayısı", "5 kişi alınacak", "12 adet sözleşmeli"
    pattern: /\b(?:kontenjan|kadro\s+sayisi|\d+\s+(?:kisi|adet|pozisyon|eleman)\b|\d+\s+sozlesmeli)/,
    weight: 2,
  },
  {
    id: 'pozitif.basvuru-penceresi',
    reason: 'Başvuru tarih aralığı belirtiliyor',
    // "başvurular 12-26 Ekim arasında", "son başvuru tarihi", "başvuru süresi"
    pattern: /\b(?:basvuru\s+tarihleri|basvuru\s+suresi|son\s+basvuru|basvurular\b[\s\S]{0,40}?\barasinda)/,
    weight: 1.5,
  },
  {
    id: 'pozitif.kpss',
    reason: 'KPSS puan/puan türü şartı belirtiliyor',
    // "KPSS P3", "2026 KPSS puanı", "KPSS'den en az 70 puan"
    pattern: /\bkpss\w*[\s\S]{0,40}?(?:puan|p1|p2|p3|p10|p93|p94|p121|p124|dhbt)/,
    weight: 1.5,
  },
  {
    id: 'pozitif.kadro-pozisyon',
    reason: 'Kadro/pozisyon atamasından söz ediliyor',
    // "kadroya atama", "atanmak üzere", "pozisyona yerleştirilecek"
    pattern: /\b(?:kadroya\s+atama|atanmak\s+uzere|atanma\s+islemi|pozisyona\s+yerlestir)/,
    weight: 1.5,
  },
  {
    id: 'pozitif.istihdam',
    reason: 'İstihdam ifadesi var',
    // "istihdam edilecek", "istihdam edilmek üzere"
    pattern: /\bistihdam\s+edil\w*/,
    weight: 1.5,
  },
  {
    id: 'pozitif.sozlesmeli-statuye',
    reason: 'Sözleşmeli statüde istihdam (4/B)',
    pattern: /\b4\s*\/?\s*b\b/,
    weight: 1.5,
  },
  {
    id: 'pozitif.personel-temin',
    reason: 'Personel temini ifadesi var',
    // "muvazzaf subay temini", "uzman erbaş temin ilanı", "erbaş ve er temini"
    pattern: /\b(?:subay|astsubay|uzman\s+er\w*|erbas|er|bekci|polis|jandarma|personel|memur)\w*\s+temin\w*|\btemin\s+ilan\w*/,
    weight: 2.5,
  },
  {
    id: 'pozitif.unvan-alimi',
    reason: 'Ünvan/kadro belirtilerek alım veya temin yapılıyor',
    // "hemşire, ebe ve sağlık teknikeri alımı", "veri hazırlama ve kontrol işletmeni alımı"
    pattern: POSITION_RECRUITMENT_PATTERN,
    weight: 3,
  },
  {
    id: 'pozitif.iskur-araciligiyla-alim',
    reason: 'Türkiye İş Kurumu (İŞKUR) aracılığıyla alım yapılıyor',
    // "3 (üç) temizlik görevlisi Türkiye İş Kurumu aracılığıyla alınacaktır",
    // "İŞKUR üzerinden ... işçi alınacak" (her iki sıra; 22.10.2026 canlı ölçümünde kurallarca reddedildi).
    pattern: ISKUR_RECRUITMENT_PATTERN,
    weight: 3,
  },
  {
    id: 'pozitif.is-kanunu-calistirma',
    reason: '4857 sayılı İş Kanunu kapsamında çalıştırılmak üzere alım',
    pattern: LABOUR_LAW_EMPLOYMENT_PATTERN,
    weight: 2.5,
  },
  {
    id: 'pozitif.basvuru-sarti',
    reason: 'Başvuru şartları/koşulları belirtiliyor',
    // "başvuru şartları", "aranan nitelikler", "adaylarda aranacak şartlar"
    pattern: /\b(?:basvuru\s+sartlari|aranan\s+nitelikler|aranacak\s+sartlar|basvuru\s+kosullari)/,
    weight: 1.5,
  },
];

/**
 * Başlık düzeyinde kesin ret kuralları.
 * Başlıkta bu ifadeler geçiyorsa kayıt yeni bir alım ilanı değildir
 * (örnek: "Personel Alımı Sonuçları", "İhale İlanı", "Yönetmelik").
 */
export const TITLE_REJECT_RULES: readonly KeywordRule[] = [
  {
    id: 'ret-baslik.mal-hizmet-alimi',
    reason: 'Başlık mal/hizmet alımı ya da danışmanlık duyurusu — personel alımı değil',
    // "Hizmet Alımı İlanı", "Temizlik Hizmeti Alımı", "Bireysel Danışmanlık Hizmeti Duyurusu"
    pattern:
      /\b(?:hizmet|mal|arac|yemek|temizlik|kirtasiye|tasima|insaat|guvenlik|danismanlik|musavirlik|sigorta)\s+(?:hizmet\w*\s+)?alim\w*/,
    weight: 0,
  },
  {
    id: 'ret-baslik.sonuc-duyurusu',
    reason: 'Başlık bir sonuç/atama/liste duyurusu — yeni alım ilanı değil',
    // "sonuçları açıklandı", "yerleştirme sonuçları", "asıl ve yedek liste", "kazananlar"
    pattern:
      /\b(?:sonuc\w*|kazanan\w*|asil\s+ve\s+yedek|yedek\s+liste|nihai\s+liste|puan\s+siralamasi|atanmaya\s+hak\s+kazanan|alim\s+sonuc\w*)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.ihale',
    reason: 'Başlık ihale/artırma/kiralama ilanı — personel alımı değil',
    pattern:
      /\b(?:ihale\w*|artirma\w*|eksiltme\w*|kiraya\s+ver\w*|kiralama\w*|satis\s+ihalesi|isletme\s+hakki|ruhsat\s+saha\w*|tasInmaz\s+satis)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.mevzuat',
    reason: 'Başlık yönetmelik/genelge/tebliğ — personel alım ilanı değil',
    pattern: /\b(?:yonetmelik\w*|genelge\w*|teblig\w*|usul\s+ve\s+esaslar|karar\s+sayisi|mukerrer)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.yargi',
    reason: 'Başlık yargı/icra/tebligat ilanı — personel alımı değil',
    // `icra` istisnası: "Açıktan İcra Müdür ve İcra Müdür Yardımcılığı Sınav İlanı" /
    // "İcra Müdür Yardımcılarını Seçme Sınavı" bir kadro alımıdır (23.10.2026 canlı ölçümü:
    // Kariyer Kapısı + ÖSYM'de reddediliyordu). "İcra Müdürlüğünden: … artırma ilanı" yine düşer.
    pattern:
      /\b(?:iflas\w*|icra(?!\s+mudur(?:u|leri)?\s+(?:ve\s+icra\s+mudur(?:u|leri)?\s+)?(?:yardimci\w*|secme\s+sinav\w*|sinav\w*|alim\w*))\w*|tebligat\w*|ilam\w*|haciz\w*|dava\s+dilekcesi|yargi\s+ilani)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.staj-burs',
    reason: 'Başlık staj/burs/öğrenci programı — personel alımı değil',
    // `burs(?!a)`: "Bursa" ili (Bursa Valiliği, Bursa Uludağ Üniversitesi…) burs sayılmaz;
    // eski `burs\w*` Bursa kurumlarının TÜM ilanlarını başlıkta reddediyordu.
    pattern:
      /\b(?:burs(?!a)\w*|ulusal\s+staj|staj\s+program\w*|staj\s+basvuru\w*|ogrenci\s+alim\w*|yatay\s+gecis|yatili\s+ogretim|ozel\s+yetenek\s+sinavi)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.sinav-lojistigi',
    reason: 'Başlık sınav kılavuzu/lojistik duyurusu — yeni alım ilanı değil',
    pattern:
      /\b(?:cevap\s+anahtari|soru\s+kitapcigi|sinav\s+giris\s+belgesi|basvuru\s+merkezleri|sinav\s+merkezleri|sinav\s+takvimi)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.personel-hareketi',
    reason: 'Başlık mevcut personelin yer değiştirme/nakil duyurusu — yeni alım değil',
    pattern:
      /\b(?:yer\s+degistirme|mazerete\s+bagli|norm\s+kadro\s+fazlasi|atama\s+ve\s+nakil|kadro\s+aktarim\w*|nakil\s+sonuc\w*|gorevde\s+yukselme|unvan\s+degisikligi)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.esatis',
    reason: 'Başlık UYAP e-satış/icra satış duyurusu',
    pattern: /\b(?:uyap|e-?satis|acik\s+arttirma)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.egitim-programi',
    reason: 'Başlık eğitim/kurs programı duyurusu — personel alımı değil',
    pattern:
      /\b(?:mesleki\s+egitim\s+kursu|isbasi\s+egitim\s+programi|hizmet\s+ici\s+egitim|kursiyer|seminer|panel\s+duyurusu)/,
    weight: 0,
  },
  {
    // Denetim 27.10.2026: ÖSYM e-TEP/e-YDTS yeterlik sınavı ve TÜBİTAK kış/yaz okulu duyuruları
    // "kontenjan" ve "başvuru tarihleri" geçtiği için incelemeye düşüyor, LLM'e gidiyordu.
    id: 'ret-baslik.yeterlik-sinavi-okul',
    reason: 'Başlık dil yeterlik sınavı ya da kış/yaz okulu duyurusu — personel alımı değil',
    // "Uzmanlık Yeterlik Sınavı" gibi kurum giriş sınavları alımdır; yalnız DİL yeterlik sınavı reddedilir.
    pattern: /\b(?:(?:ingilizce|yabanci\s+dil|dil)\s+yeterlik\s+sinav\w*|e-?tep\b|e-?ydts\b|kis\s+okulu\w*|yaz\s+okulu\w*)/,
    weight: 0,
  },
  {
    // Ekosistem deseni (github.com/berketez/is-basvuru-botu): genel başvuru /
    // özgeçmiş havuzu ilanları belirli bir kadro açığı değil, ilerideki
    // pozisyonlar için havuz toplamadır — "yeni ilan" sayılmaz.
    id: 'ret-baslik.genel-basvuru',
    reason: 'Başlık genel başvuru/özgeçmiş havuzu duyurusu — belirli bir kadro açığı değil',
    pattern:
      /\b(?:genel\s+basvuru(?:lar)?(?:\s+(?:ilan|duyuru|ilanlari))?|ozgecmis\s+havuz\w*|cv\s+havuz\w*|talent\s+pool)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.basin-konferans-rapor',
    reason: 'Başlık basın duyurusu, konferans, sempozyum, rapor ya da eğitim programı — iş ilanı değil',
    pattern:
      /\b(?:basin\s+(?:duyuru|aciklama|bulten)\w*|konferans\w*|sempozyum\w*|kongre\w*|calistay\w*|seminer\w*|egitim\s+programlari\w*|uzmanlik\s+egitim\w*|izleme\s+ve\s+degerlendirme|degerlendirme\s+raporu|faaliyet\s+raporu|arastirma\s+programlari)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.yer-degistirme-satis',
    reason: 'Başlık yer değiştirme, gayrimenkul satışı ya da çerez bildirimi — iş ilanı değil',
    pattern:
      /\b(?:yer\s+degistirme\w*|satis\s+ilan\w*|satis\s+duyur\w*|gayrimenkul\s+satis\w*|cerez\w*|cookie\w*)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.sinav-metni-kura',
    reason: 'Başlık sınav metni, sınav yeri/tarihi, kura ya da çağrı listesi — yeni alım ilanı değil',
    pattern:
      /\b(?:sinav\s+metin\w*|sinav\s+yeri\w*|sinav\s+tarih\w*|cagrilacak\s+adaylar|noter\s+kura\w*|kura\s+duyur\w*)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.ogrenci-kabul-tercih',
    reason: 'Başlık öğrenci kabulü, yerleştirme ya da tercih duyurusu — personel alımı değil',
    pattern:
      /\b(?:ogrenci\s+secme|ogrenci\s+kabul\w*|dikey\s+gecis|ek\s+yerlestirme|yerlestirme\s+sonuc\w*|tercih\w*|rektor\s+adayligi|yks\b)/,
    weight: 0,
  },
  {
    // Sayfa kabuğu: menü, erişilebilirlik, çerez metni. Kaynak adaptörü bunları
    // bağlantı olarak almışsa (örn. İçişleri "Sizlere daha iyi hizmet…") kayıt olmamalı.
    id: 'ret-baslik.sayfa-arayuzu',
    reason: 'Başlık sayfa menüsü, erişilebilirlik ya da çerez metni — ilan değil',
    pattern: SITE_CHROME_TITLE_PATTERN,
    weight: 0,
  },
  {
    // Kategori/liste sayfası: "Kamu Memur Alım İlanları", "Kurumdışı Kamu İşçi Alım ..."
    // (normalizasyon noktaları boşluğa çevirir, bu yüzden `...` kısaltması da düşer).
    id: 'ret-baslik.kategori-sayfasi',
    reason: 'Başlık ilan kategorisi/liste sayfası — tek bir ilan değil',
    pattern:
      /\b(?:kamu|kurumdisi)\s+(?:memur|isci|personel)\s+alim\w*(?:\s+ilanlari)?$|\balim\w*\s+ilanlari$/,
    weight: 0,
  },
  {
    // Yalnızca birim/daire adı: "PERSONEL DAİRESİ BAŞKANLIĞI", "… ETÜT VE PROJELENDİRME DAİRESİ BAŞKANLIĞI".
    // Kurum dizinindeki birim bağlantısıdır; alım/sınav/ilan kelimesi taşımayan başlık ilan sayılmaz.
    id: 'ret-baslik.sadece-birim-adi',
    reason: 'Başlık yalnızca bir birim/daire adı — ilan başlığı değil',
    pattern:
      /^(?!.*\b(?:alim|sinav|ilan|duyur|basvuru|sozlesmeli|giris|kadro|uzman|memur|isci|kura|sonuc|istihdam|kontenjan|tercih|yeterlik|gorevde)\w*)(?:.*\s)?(?:daire\s+baskanligi|genel\s+mudurlugu|baskanligi|mudurlugu)$/,
    weight: 0,
  },
  {
    id: 'ret-baslik.proje-cagri',
    reason: 'Başlık proje/hibe çağrısı ya da destek programı — iş ilanı değil',
    pattern: /\b(?:proje\s+cagri\w*|cagrisi\s+acildi|cagri\s+acildi|hibe\s+programi\w*|destek\s+programi\w*)/,
    weight: 0,
  },
  {
    // 2026-10-15 canlı çıktısı: "Sıkça Sorulan Sorular" %49 güvenle ilgililik incelemesine
    // düşmüştü. Yardım sayfası ilan değildir.
    id: 'ret-baslik.sss',
    reason: 'Başlık sıkça sorulan sorular/yardım sayfası — ilan değil',
    pattern: /\b(?:sikca\s+sorulan\s+sorular?|sss)\b/,
    weight: 0,
  },
  {
    // "Bilgi Güvenliği Politikası", "Gizlilik ve Çerez Politikası", "Açık Veri Politikası".
    id: 'ret-baslik.politika-belgesi',
    reason: 'Başlık politika/yükümlülük belgesi — ilan değil',
    pattern:
      /\b(?:gizlilik|cerez|cerezler|bilgi\s+guvenligi|kisisel\s+veriler\w*|kvkk|acik\s+veri|erisilebilirlik|kalite|etik|insan\s+haklari|veri\s+paylasimi|sifir\s+atik)\s+politika\w*|\bpolitika\s+(?:metni|belgesi)\b/,
    weight: 0,
  },
  {
    // "SEMPOZYUM VE SERGİLER", "Başkan'ın Konuşmaları", "TEKNOFEST", fuar/kongre haberleri.
    id: 'ret-baslik.etkinlik-konusma',
    reason: 'Başlık etkinlik/sempozyum/konuşma duyurusu — personel alımı değil',
    // Alım/istihdam kelimesi taşıyan başlıklar kurala takılmaz ("Sergi salonu için personel alımı").
    pattern:
      /^(?!.*\b(?:alim\w*|istihdam\w*|personel\w*|memur\w*|isci\w*|kadro\w*|sozlesmeli\w*|hemsire\w*|sofor\w*|gorevli\w*|kura|atama\w*))(?=.*\b(?:sempozyum\w*|kongre\w*|calistay\w*|sergi(?:ler|si|leri)?|teknofest|anma\s+(?:gunu|programi)|odul\s+(?:ceremonisi|toreni)|baskanin\s+konusmalari|baskanlik\s+konusmasi|mesajlari)\b).+$/,
    weight: 0,
  },
  {
    // Yalnızca dizin/kategori adı olan başlıklar: "HABERLER & DUYURULAR", "Basın Açıklamaları",
    // "projeler", "İç Kontrol Çalışmaları", "Arşiv", "İstatistikler".
    id: 'ret-baslik.dizin-sayfasi',
    reason: 'Başlık bir dizin/arsiv sayfası adı — tek bir ilan değil',
    pattern:
      /^(?:haberler?\s*(?:ve\s*)?(?:duyurular?|etkinlikler?|basin)?\s*|duyurular?\s*|duyuru\s+(?:listesi|arsivi)\s*|basin\s+(?:aciklamalari|duyurulari|bultenleri)\s*|ilanlar?\s*|arsiv(?:ler|ler\s+sayfasi)?\s*|projeler?\s*|ic\s+kontrol\s+calismalari\s*|calismalar\s*|istatistikler?\s*|multimedya\s*|foto(?:graf)?\s+galeri(?:leri)?\s*|video\s+galeri(?:leri)?\s*|yayinlar?\s*|faaliyet\s+rapor(?:u|lari)\s*|kutuphane\s*|kurumsal\s+tarihce\s*|sikca\s+sorulan\s+sorular\s*|sss\s*|iletisim\s*|insan\s+kaynaklari\s*|kurumsal\s*|hakkinda\s*|basvuru\s*|basvurular\s*)$/i,
    weight: 0,
  },
  {
    // "Radar uygulama sayıları", "… istatistikleri", "rakamlarla 2026": sayı/istatistik sayfaları.
    id: 'ret-baslik.sayi-istatistik',
    reason: 'Başlık sayısal özet/istatistik sayfası — ilan değil',
    pattern:
      /^(?!.*\b(?:alim\w*|istihdam\w*|personel\w*|memur\w*|isci\w*|sozlesmeli\w*|kadrolu\w*))(?=.*\b(?:sayilari|sayisi|istatistikleri|istatistikler|verileri|tablolar?|rakamlarla\s+\w+)\s*$).+$/,
    weight: 0,
  },
  {
    // ÖSYM çıktıları: "e-YDS 2026/10 İngilizce Sınavı Başvuruları", "2026-TUS 2. Dönem
    // Tercih İşlemleri" %53-57 güvenle incelemeye düşmüştü. Dil/akademik sınav duyuruları
    // personel alımı değildir; başlıkta alım/istihdam kelimesi varsa kural devreye girmez.
    id: 'ret-baslik.dil-akademik-sinav',
    reason: 'Başlık dil/akademik sınav duyurusu (YDS, ALES, TUS, DUS, YDUS) — personel alımı değil',
    pattern:
      /^(?!.*\b(?:alim\w*|istihdam\w*|personel\w*|memur\w*|isci\w*|kadro\w*|sozlesmeli\w*|uzman\s+yardimcisi|hemsire\w*|sofor\w*|gorevli\w*|kura|atama\w*|giris\s+sinavi|sozlesme))\s*(?=.*\b(?:e-yds|yds|yokdil|ales|ydus|tus|dus|tip\s+uzmanligi|dis\s+hekimligi\s+uzmanlik|yabanci\s+dil\s+bilgisi\s+seviye\s+tespit)\b)(?=.*\b(?:sinav\w*|basvuru\w*|tercih\w*|kilavuz\w*|sonuc\w*|donem|aciklandi)).+/,
    weight: 0,
  },
  {
    // 2026-10-16 canlı panel dökümü (KGM/DSİ/SPK/İçişleri): "2026 Yılı Rayiç
    // Fiyatları", "… Restorasyon Çalışmasının Açılışı", "GICC Heyeti Ziyareti",
    // "Japonya Heyeti ile Görüşme", "… İş Birliği Protokolü İmza Töreni",
    // "… Yarışması". Bunlar kurumsal etkinlik/tören ve fiyat duyurularıdır;
    // inceleme kuyruğunu dolduruyordu. Alım/istihdam/temin/başvuru kelimesi
    // taşıyan başlıklar kurala takılmaz (yanlış pozitif koruması).
    id: 'ret-baslik.kurumsal-etkinlik',
    reason: 'Başlık kurumsal etkinlik, tören, ziyaret ya da fiyat listesi duyurusu — personel alımı değil',
    pattern:
      /^(?!.*\b(?:alim\w*|istihdam\w*|personel\w*|memur\w*|isci\w*|kadro\w*|sozlesmeli\w*|hemsire\w*|sofor\w*|gorevli\w*|kura|atama\w*|giris\s+sinavi|temin\w*|basvuru\w*|yeterlik))(?=.*\b(?:rayic\s+fiyat\w*|fiyat\s+listesi|fiyat\s+tarifesi|tarife\s+listesi|acilis\w*|temel\s+atma|heyet\w*|ziyaret\w*|protokol\s+imza|imza\s+toreni|is\s+birligi\s+protokolu|yarisma\w*|festival\w*|fuar\w*|turnuva\w*|kutlama\w*|bayram\s+mesaji|yeni\s+yil\s+mesaji|taziye|bassagligi|anma\s+etkinligi|odul\s+toreni)\b).+$/,
    weight: 0,
  },
];

/**
 * Gövdede kesinleştiren ret kuralları. Yalnızca personel alımı ilanlarında
 * asla geçmeyecek ifadeler burada tutulur.
 */
export const BODY_REJECT_RULES: readonly KeywordRule[] = [
  {
    id: 'ret-govde.ihale',
    reason: 'Gövde ihale/artırma/kiralama metni içeriyor',
    pattern:
      /\b(?:ihaleye\s+cikaril|ihale\s+edilecek|acik\s+arttirma|kapali\s+teklif|kiraya\s+verilecek|isletme\s+hakki)/,
    weight: 0,
  },
  {
    id: 'ret-govde.mal-hizmet-alimi',
    reason: 'Gövde mal/hizmet alımı duyurusu',
    pattern: /\b(?:hizmet\s+alimi\s+yapilacak|mal\s+alimi\s+yapilacak|dogrudan\s+temin|yapim\s+isi\s+ihale)/,
    weight: 0,
  },
  {
    id: 'ret-govde.yargi',
    reason: 'Gövde icra/iflas/tebligat metni içeriyor',
    pattern: /\b(?:icra\s+dosyasi|iflas\s+karari|tebligat\s+yoluyla|haciz\s+islemi)/,
    weight: 0,
  },
  {
    id: 'ret-govde.ogrenci',
    reason: 'Gövde öğrenci alımı/staj programı duyurusu',
    pattern: /\b(?:ogrenci\s+alim\w*|yatay\s+gecis\s+basvuru|ulusal\s+staj\s+programi)/,
    weight: 0,
  },
];

/** Puan kıran ifadeler — tek başına karar vermez. */
export const SOFT_NEGATIVE_RULES: readonly KeywordRule[] = [
  {
    id: 'ret-yumusak.sonuc',
    reason: 'Metinde sonuç/açıklama ifadesi geçiyor',
    // "sonuçlar açıklanmıştır", "ilan edilmiştir"
    pattern: /\b(?:sonuclar\w*|aciklanmistir|ilan\s+edilmistir|yayimlanmistir)/,
    weight: 2,
  },
  {
    id: 'ret-yumusak.kilavuz',
    reason: 'Metin kılavuz/rehber ağırlıklı olabilir',
    pattern: /\b(?:kilavuz|rehber|takvim|bilgilendirme)\b/,
    weight: 2,
  },
  {
    id: 'ret-yumusak.duzeltme',
    reason: 'Metin düzeltme/iptal/ek ilan olabilir',
    pattern: /\b(?:duzeltme\s+ilan\w*|iptal\s+ilan\w*|ek\s+ilan|ilan\s+iptal\w*)/,
    weight: 1.5,
  },
  {
    id: 'ret-yumusak.mevzuat-atfi',
    reason: 'Metin ağırlıklı olarak mevzuat atfı içeriyor',
    pattern: /\b(?:usul\s+ve\s+esaslari\s+hakkinda\s+yonetmelik|yonetmelikte\s+degisiklik)/,
    weight: 1,
  },
  {
    id: 'ret-yumusak.satin-alma',
    reason: 'Metinde satın alma/sipariş ifadesi geçiyor',
    pattern: /\b(?:satin\s+alma\s+birimine|siparis\s+verilecektir|fiyat\s+teklifi)/,
    weight: 1.5,
  },
  {
    // "İleride açılacak pozisyonlar için" havuz ilanı sinyali — gerçek bir kadro
    // açığı olabilir ama sıklıkla hayalet ilandır (ekosistem: berketez/is-basvuru-botu).
    id: 'ret-yumusak.genel-basvuru',
    reason: 'Metin genel başvuru/havuz toplama ya da ileride açılacak pozisyon ifadesi içeriyor',
    pattern:
      /\b(?:genel\s+basvuru(?:lar)?(?:dan|ya|de|da)?|ozgecmis\s+havuz|cv\s+havuz|ileride\s+acil\w*\s+pozisyon|acilacak\s+pozisyonlar\s+icin|expression\s+of\s+interest|talent\s+pool)/,
    weight: 1.5,
  },
];

/**
 * Kaynak kategori adı personel alımı kategorisi ise ek güven verir.
 * (Örn. ilan.gov.tr "Kamu-Akademik Personel", "Kamu Personel Alım ve Sınavları")
 */
/**
 * Kabul için zorunlu kanıt: metinde (başlık veya gövde) açık bir personel
 * alım/istihdam ifadesi olmalı. Kaynak kategorisi, sayfa kenar metni ve
 * genel kamu kelimeleri tek başına yeterli değildir.
 */
const RECRUITMENT_EVIDENCE_BASE =
  /\b(?:personel\s+alim\w*|alim\s+ilan\w*|alim\s+yapil\w*|alim\s+duyur\w*|isci\s+alim\w*|memur\s+alim\w*|sozlesmeli\s+(?:\w+\s+){0,3}personel|sozlesmeli\s+personel|kadro\w*|istihdam\w*|giris\s+sinavi|uzman\s+yardimci\w*|alinacak\w*|alinmak\s+uzere|alinacaktir|basvuru\s+(?:yapabilir|yapilacak|sarti))/;

/**
 * Kanıt kapısı: metinde personel alımına ilişkin bir ifade var mı?
 * Ünvan + alım/temin kalıpları da kanıttır (bkz. POSITION_RECRUITMENT_PATTERN).
 */
export const RECRUITMENT_EVIDENCE_PATTERN = new RegExp(
  `${RECRUITMENT_EVIDENCE_BASE.source}|${POSITION_RECRUITMENT_PATTERN.source}` +
    `|${ISKUR_RECRUITMENT_PATTERN.source}|${LABOUR_LAW_EMPLOYMENT_PATTERN.source}|${ACIKTAN_RECRUITMENT_PATTERN.source}`,
);

/**
 * Süreç duyuruları: gerçek bir personel alımının kura, sınav, mülakat, sonuç gibi
 * devam eden aşamaları. Yeni iş ilanı değildir; ayrı `kind: 'process'` kategorisinde
 * akışta tutulur. Başlıkta hem personel bağlamı hem süreç sinyali zorunludur.
 */
export const PROCESS_TITLE_CONTEXT_PATTERN =
  /\b(?:personel\w*|alim\w*|isci\w*|memur\w*|sozlesmeli\w*|kadro\w*|istihdam\w*|uzman\s+yardimci\w*)\b/;

export const PROCESS_TITLE_SIGNAL_PATTERN =
  // `sinav duyur\w*` 2026-10-16 canlı dökümüyle eklendi: "Destek personeli alımı
  // sınav duyurusu" gibi başlıklar sürmekte olan bir alımın AŞAMASINI duyurur;
  // ünvan+alım kanıt kalıpları genişleyince bu başlıklar yeni iş ilanı gibi
  // kabul edilip bildirim üretmeye başlamıştı (yanlış pozitif).
  /\b(?:kura\w*|cagrilacak\s+adaylar|sinav\s+(?:yeri|tarih|metin|sonuc|takvim|kilavuz|duyur)\w*|sozlu\s+sinav\w*|uygulamali\s+sinav\w*|mulakat\w*|sonuc\w*|kazanan\w*|yedek\s+liste\w*|asil\s+ve\s+yedek\w*|yedek\s+aday\w*|nihai\s+liste\w*)/;

/**
 * Bu ifadelerden biri varsa başlık süreç duyurusu sayılmaz (kurum içi, eğitim,
 * yer değiştirme vb.).
 *
 * `giris sinav\w*` bilinçli olarak dışlamadır: "Uzman Yardımcılığı Giriş Sınavı
 * Duyurusu" YENİ bir alımın ilanıdır, sürmekte olan alımın aşaması değil. Bu
 * dışlama olmazsa gerçek ilanlar `kind: 'process'` olur ve kullanıcılara
 * bildirilmez (yanlış negatif).
 */
export const PROCESS_TITLE_EXCLUDE_PATTERN =
  /\b(?:yer\s+degistirme\w*|gorevde\s+yukselme\w*|unvan\s+degisiklig\w*|satis\w*|ihale\w*|basin\w*|konferans\w*|tercih\w*|ek\s+yerlestirme|dikey\s+gecis|yks\b|ogrenci\w*|egitim\s+programlari\w*|uzmanlik\s+egitim\w*|rektor\w*|cerez\w*|kira\w*|proje\s+cagri\w*|arastirma\s+programlari|giris\s+sinav\w*)/;

/**
 * Süreç duyurusu olduğunda bu başlık ret kuralları atlanır. Sonuç, sınav/kura ve
 * yerleştirme ifadeleri yalnızca personel bağlamı + süreç sinyali + dışlama yokken süreç
 * sayılır. `ogrenci-kabul-tercih` kuralının öğrenci/YKS/tercih terimleri PROCESS_TITLE_EXCLUDE_PATTERN
 * içinde olduğundan, bu kuralın süreç için atlanması öğrenci yerleştirmelerini açmaz.
 * Diğer ret kuralları (yer değiştirme, basın, satış, ihale vb.) aynen geçerlidir.
 */
export const PROCESS_BYPASS_RULE_IDS: ReadonlySet<string> = new Set([
  'ret-baslik.sonuc-duyurusu',
  'ret-baslik.sinav-metni-kura',
  'ret-baslik.ogrenci-kabul-tercih',
]);

/**
 * Kurum içi görevde yükselme sınavı ve tercih duyuruları (mevcut personel). Yeni personel
 * alımı değildir; süreç duyurusu olarak akışta kalır, bildirim üretmez. Yalnızca "görevde
 * yükselme" ifadesi ile sınav/tercih sinyali birlikte geçen başlıklar bu kapsamdadır; yer
 * değiştirme, öğrenci, basın vb. dışlamalar aynen geçerlidir.
 */
export const INTERNAL_PROMOTION_CONTEXT_PATTERN = /\bgorevde\s+yukselme\w*/;
export const INTERNAL_PROMOTION_SIGNAL_PATTERN = /\b(?:sinav\w*|tercih\w*)\b/;
export const INTERNAL_PROMOTION_EXCLUDE_PATTERN =
  /\b(?:yer\s+degistirme\w*|satis\w*|ihale\w*|basin\w*|konferans\w*|ogrenci\w*|yks\b|ek\s+yerlestirme|dikey\s+gecis|rektor\w*|cerez\w*|kira\w*|egitim\s+programlari\w*|uzmanlik\s+egitim\w*|arastirma\s+programlari|proje\s+cagri\w*)/;

/**
 * Gövdede gerçek başvuru sonuçlarının duyurulduğunu gösteren dar kanıt: sayfa başlığında
 * "Başvuru Sonuçları" ve sonuç listesine işaret eden "sınava katılma" ifadesi birlikte
 * geçmeli. Genel bir "sonuç" kelimesi süreç sayılmaz.
 */
/**
 * Resmî ilan metninin GİRİŞ cümlesindeki alım hükmü: "... çalıştırılmak üzere öğretim üyesi
 * alınacaktır", "... kadrolarına sözleşmeli personel alınacaktır". Resmî Gazete ilanlarında başlık
 * satırı yoksa başlık bu cümleden türetilir (23.10.2026: Adıyaman/Çankırı Karatekin öğretim üyesi
 * alımları "başlıkta alım ifadesi yok" diye incelemeye düşüyordu). Yalnızca gövdenin ilk
 * {@link OFFICIAL_LEAD_WINDOW} karakterine bakılır; "alınacak" (haber dili) değil "alınacaktır"
 * (resmî hüküm kipi) aranır.
 */
export const OFFICIAL_LEAD_RECRUITMENT_PATTERN =
  /\b(?:ogretim\s+uye\w*|ogretim\s+eleman\w*|ogretim\s+gorevli\w*|arastirma\s+gorevli\w*|personel\w*|memur\w*|isci\w*|uzman\s+yardimci\w*)\s+(?:alinacaktir|istihdam\s+edilecektir)/;
export const OFFICIAL_LEAD_WINDOW = 500;

export const RESULTS_HEADING_PATTERN =/\bbasvuru\s+sonuclari\b/;
export const RESULTS_LIST_CUE_PATTERN = /\bsinava\s+katilma\w*/;
export const RESULTS_HEADING_WINDOW = 500;

export const RECRUITMENT_CATEGORY_PATTERN =
  /\b(?:kamu\s*-?\s*akademik\s+personel|personel\s+alim|alim\s+ve\s+sinav|akademik\s+personel\s+alim|kamu\s+personel)/;

/** İstihdam türü tespiti — sırayla denenir, ilk eşleşen kazanır. */
export const EMPLOYMENT_TYPE_RULES: readonly { type: EmploymentType; pattern: RegExp; reason: string }[] = [
  {
    type: 'akademik',
    reason: 'Akademik kadro ifadesi',
    pattern:
      /\b(?:ogretim\s+uyesi|ogretim\s+elemani|arastirma\s+gorevlisi|docent|profesor|doktor\s+ogretim|akademik\s+kadro|ogretim\s+gorevlisi)/,
  },
  {
    type: 'kamu-isci',
    reason: 'İşçi kadrosu ifadesi',
    pattern:
      /\b(?:surekli\s+isci|gecici\s+isci|isci\s+al(?:i?m|inacak)|kamu\s+iscisi|toplum\s+yararina|isgucu\s+uyum)/,
  },
  {
    type: 'kariyer-meslek',
    reason: 'Kariyer meslek / yardımcılık sınavı',
    pattern: /\b(?:uzman|mufettis|denetci|kontrolor|aktor|avukat|stajyer\s+uzman)\s+yardimciligi/,
  },
  {
    type: 'sozlesmeli',
    reason: 'Sözleşmeli personel ifadesi',
    pattern:
      /\b(?:sozlesmeli\s+personel|sozlesmeli\s+(?:bilisim|hekim|ogretmen|avukat|muhendis|tekniker|saglik|destek)|4\s*\/?\s*b)\b/,
  },
  {
    type: 'kadrolu',
    reason: 'Kadrolu/memur ifadesi',
    pattern: /\b(?:kadrolu|memur\s+al(?:i?m|inacak)|kadro\s+karsiligi)/,
  },
  {
    type: 'kuruma-ozel-sinav',
    reason: 'Kuruma özgü giriş sınavı ifadesi',
    pattern: /\b(?:giris\s+sinavi|kurum\s+sinavi|sozlu\s+sinav|uygulamali\s+sinav)/,
  },
  {
    type: 'diger-kamu',
    reason: 'Ünvan/kadro belirtilmiş alım veya temin ilanı',
    pattern: POSITION_RECRUITMENT_PATTERN,
  },
  {
    type: 'diger-kamu',
    reason: 'Genel personel alımı ifadesi',
    pattern: /\bpersonel\w*\s+al(?:i?m|inacak|imi)|alim\s+ilan\w*/,
  },
];

/**
 * HABER DİLİ — "personel alımından haber veren" başlıklar (ilan değil).
 *
 * Gözlem (21.10.2026, kural tabanlı sınıflandırıcı üzerinde tekrarlanabilir
 * prob): "Vali, personel alımı yapılacağını açıkladı", "Bakan: 100 bin personel
 * alınacak", "Memur alımı müjdesi", "… alımı rekoru", "… hakkında bilgilendirme"
 * gibi başlıklar `accept` alıyordu; yani bir kurumun haber/duyuru metni iş ilanı
 * olarak yayımlanabiliyordu. Bu, projenin bir numaralı doğruluk riskidir.
 *
 * Ayrım ölçütü (deterministik, kanıta dayalı):
 *  - Başlıkta haber/aktarım dili VAR (aşağıdaki kalıplar), VE
 *  - Gövdede somut başvuru kanıtı YOK (son başvuru tarihi ya da "başvurular …
 *    yapılacaktır" gibi bir başvuru yolu).
 * O zaman kayıt reddedilir. Somut kanıt varsa kayıt SİLİNMEZ; insan incelemesine
 * düşer (haber diliyle yazılmış gerçek bir ilan olabilir).
 *
 * Ters koruma: resmî ilan kalıbı "… Alımı Yapılacağı Duyurulur" (edilgen,
 * ilan dili) bu kurala TAKILMAZ; yalnızca aktarma fiilleri (duyurdu/söyledi)
 * haber sayılır.
 */
export const NEWS_TITLE_MARKERS: readonly { id: string; reason: string; pattern: RegExp }[] = [
  {
    id: 'haber.aktarim-fili',
    reason: 'Başlık aktarma/haber fiili içeriyor (açıkladı, söyledi, duyurdu…) — ilan metni değil',
    pattern:
      /\b(?:acikladi|aciklamada\s+bulundu|soyledi|belirtti|ifade\s+etti|duyurdu|bildirdi|kaydetti|vurguladi|aktardi)\b/,
  },
  {
    id: 'haber.konusmaci-aktarimi',
    reason: 'Başlık bir yetkilinin sözünü aktarıyor (Vali/Bakan/Başkan: …)',
    // Not: normalizeTr iki nokta üst üste gibi noktalama işaretlerini siler; bu yüzden
    // "Bakan Yılmaz: …" kalıbı "bakan yilmaz …" olarak gelir (ünvan + ad).
    // Ünvandan sonraki sözcük bir ad olmalıdır: "Müdür Yardımcısı Alım İlanı",
    // "Genel Müdür Alımı", "Vali Yardımcısı Kadrosu" gerçek ilan başlıklarıdır ve
    // eski biçim bunları haber sayıp reddediyordu (bkz. tests/classification-haber-dili.test.ts).
    pattern:
      /^(?:vali|bakan|baskan|baskan\s+yardimcisi|bakan\s+yardimcisi|mudur|genel\s+mudur|sozcu|yetkili)\s+(?!(?:yardimci|alim|alin|kadro|ilan|pozisyon|personel|gorev|unvan|aday|atama|yrd|ve|veya)\w*\b)[a-z]{2,}\b/,
  },
  {
    id: 'haber.isim',
    reason: 'Başlık haber/isim kalıbı (müjde, iddia, rekor, bilgilendirme, önerge…)',
    pattern:
      /\b(?:mujde\w*|iddia\w*|haberi|haberler\w*|rekor\w*|bilgilendirme\w*|soru\s+onergesi|arastirma\s+onergesi|kanun\s+teklifi|genel\s+gorusme|komisyon\s+raporu)\b/,
  },
  {
    id: 'haber.aciklama-basligi',
    reason: 'Başlık "… hakkında açıklama" biçiminde bir basın açıklaması',
    pattern:
      /\b(?:hakkinda|hakkinda\s+olarak|iliskin|dair)\s+(?:bir\s+)?aciklama\w*|\baciklama\w*\s+yapil|\baciklama\s*$/,
  },
];

/**
 * Başlık kendisini ilan olarak adlandırıyor ("… Alım İlanı Hakkında Açıklama").
 * Haber kapısı böyle bir kaydı reddetmez, incelemeye gönderir: mevcut bir ilana
 * dair açıklama/düzeltme olabilir ve sessizce atılmamalıdır.
 */
export const NEWS_GATE_AD_TITLE_PATTERN = /\bilan\w*/;

/** Gövdede aktarma/haber dili: "… söyledi", "… öğrenildi", "… bildirildi". */
export const REPORTED_SPEECH_PATTERN =
  /\b(?:acikladi|soyledi|belirtti|ifade\s+etti|duyurdu|bildirdi|kaydetti|vurguladi|ogrenildi|bildirildi|iddia\s+edildi|aktarildi)\b/;

/**
 * Somut başvuru kanıtı: tarih ya da başvuru yolu. Yalnızca "alınacak/alınacaktır"
 * ifadesi YETMEZ; haber metinleri de bu fiili kullanır.
 */
export const CONCRETE_APPLICATION_EVIDENCE_PATTERN = new RegExp(
  [
    String.raw`son\s+basvuru`,
    String.raw`basvuru\w*\s+\d{1,2}[.\/]\d{1,2}[.\/]\d{4}`,
    String.raw`\d{1,2}[.\/]\d{1,2}[.\/]\d{4}\s*(?:tarih\w*\s*)?(?:ne|na)?\s*kadar`,
    String.raw`basvuru\w*\s+(?:yapilacak|alinacak|baslayacak|edecek|yapilir|alinir)`,
    String.raw`basvuru\s+(?:adresi|merkezi|ekrani|sayfasi|formu|sistemi)`,
    String.raw`e-devlet\s+uzerinden\s+basvuru`,
  ].join('|'),
);
