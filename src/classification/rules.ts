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

export interface KeywordRule {
  id: string;
  /** İnsan tarafından okunabilir gerekçe (sınıflandırma çıktısına yazılır). */
  reason: string;
  pattern: RegExp;
  weight: number;
}

/** Personel alımı ilanı olduğunu gösteren olumlu kanıtlar. */
export const POSITIVE_RULES: readonly KeywordRule[] = [
  {
    id: 'pozitif.personel-alimi',
    reason: 'İlanda personel alımı ifadesi geçiyor',
    // "personel alımı", "personel alınacak", "personel alımları", "personel alım ilanı"
    pattern: /\bpersonel\s+al(?:i?m|inacak|imi|imlari|imina)/,
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
    pattern: /\b(?:uzman|mufettis|denetci|kontrolor|aktor|avukat|stajyer\s+uzman)\s+yardimciligi/,
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
    // "muvazzaf subay temini", "personel temin edilecek"
    pattern: /\b(?:subay|astsubay|uzman\s+er|personel|memur)\s+temin\w*/,
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
    pattern: /\b(?:iflas\w*|icra\w*|tebligat\w*|ilam\w*|haciz\w*|dava\s+dilekcesi|yargi\s+ilani)/,
    weight: 0,
  },
  {
    id: 'ret-baslik.staj-burs',
    reason: 'Başlık staj/burs/öğrenci programı — personel alımı değil',
    pattern:
      /\b(?:burs\w*|ulusal\s+staj|staj\s+program\w*|staj\s+basvuru\w*|ogrenci\s+alim\w*|yatay\s+gecis|yatili\s+ogretim|ozel\s+yetenek\s+sinavi)/,
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
    id: 'ret-baslik.proje-cagri',
    reason: 'Başlık proje/hibe çağrısı ya da destek programı — iş ilanı değil',
    pattern: /\b(?:proje\s+cagri\w*|cagrisi\s+acildi|cagri\s+acildi|hibe\s+programi\w*|destek\s+programi\w*)/,
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
export const RECRUITMENT_EVIDENCE_PATTERN =
  /\b(?:personel\s+alim\w*|alim\s+ilan\w*|alim\s+yapil\w*|alim\s+duyur\w*|isci\s+alim\w*|memur\s+alim\w*|sozlesmeli\s+(?:\w+\s+){0,3}personel|sozlesmeli\s+personel|kadro\w*|istihdam\w*|giris\s+sinavi|uzman\s+yardimci\w*|alinacak\w*|alinmak\s+uzere|alinacaktir|basvuru\s+(?:yapabilir|yapilacak|sarti))/;

/**
 * Süreç duyuruları: gerçek bir personel alımının kura, sınav, mülakat, sonuç gibi
 * devam eden aşamaları. Yeni iş ilanı değildir; ayrı `kind: 'process'` kategorisinde
 * akışta tutulur. Başlıkta hem personel bağlamı hem süreç sinyali zorunludur.
 */
export const PROCESS_TITLE_CONTEXT_PATTERN =
  /\b(?:personel\w*|alim\w*|isci\w*|memur\w*|sozlesmeli\w*|kadro\w*|istihdam\w*|uzman\s+yardimci\w*)\b/;

export const PROCESS_TITLE_SIGNAL_PATTERN =
  /\b(?:kura\w*|cagrilacak\s+adaylar|sinav\s+(?:yeri|tarih|metin|sonuc|takvim|kilavuz)\w*|sozlu\s+sinav\w*|uygulamali\s+sinav\w*|mulakat\w*|sonuc\w*|kazanan\w*|yedek\s+liste\w*|asil\s+ve\s+yedek\w*|nihai\s+liste\w*)/;

/** Bu ifadelerden biri varsa başlık süreç duyurusu sayılmaz (kurum içi, eğitim, yer değiştirme vb.). */
export const PROCESS_TITLE_EXCLUDE_PATTERN =
  /\b(?:yer\s+degistirme\w*|gorevde\s+yukselme\w*|unvan\s+degisiklig\w*|satis\w*|ihale\w*|basin\w*|konferans\w*|tercih\w*|ek\s+yerlestirme|dikey\s+gecis|yks\b|ogrenci\w*|egitim\s+programlari\w*|uzmanlik\s+egitim\w*|rektor\w*|cerez\w*|kira\w*|proje\s+cagri\w*|arastirma\s+programlari)/;

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
    reason: 'Genel personel alımı ifadesi',
    pattern: /\bpersonel\s+al(?:i?m|inacak|imi)|alim\s+ilan\w*/,
  },
];
