/**
 * Turkish text helpers.
 *
 * Sources publish with mixed casing, missing diacritics, NBSP and soft hyphens.
 * All comparisons in classification/dedupe run on `normalizeTr` output.
 */

const TR_LOWER: Record<string, string> = { I: 'ı', İ: 'i', Ş: 'ş', Ğ: 'ğ', Ü: 'ü', Ö: 'ö', Ç: 'ç' };

/** Lowercases with Turkish casing rules (I -> ı, İ -> i). */
export function lowerTr(value: string): string {
  let out = '';
  for (const ch of value) out += TR_LOWER[ch] ?? ch.toLowerCase();
  return out;
}

export function upperTr(value: string): string {
  return value.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
}

const FOLD: Record<string, string> = {
  ı: 'i',
  İ: 'i',
  ş: 's',
  Ş: 's',
  ğ: 'g',
  Ğ: 'g',
  ü: 'u',
  Ü: 'u',
  ö: 'o',
  Ö: 'o',
  ç: 'c',
  Ç: 'c',
  â: 'a',
  î: 'i',
  û: 'u',
};

/** Folds Turkish diacritics so "ŞÖLEN"/"Solen" compare equal. */
export function foldTr(value: string): string {
  let out = '';
  for (const ch of value) out += FOLD[ch] ?? ch;
  return out;
}

/** Canonical comparison form: lowercase, diacritics folded, punctuation collapsed. */
export function normalizeTr(value: string): string {
  return collapseWhitespace(
    foldTr(lowerTr(value))
      .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
      .replace(/[’'`´]/g, '')
      // Cümle sonu noktası boşluğa çevrilir; sayı içindeki nokta (12.10.2026) korunur.
      .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
      .replace(/[^\p{L}\p{N}+./%()\-\s]/gu, ' ')
      // Yalnızca sayı/ifade bağlayan işaretlerin çevresi sadeleşir (parantez boşlukları korunur).
      .replace(/\s*([+/%\-])\s*/g, '$1'),
  );
}

/**
 * Kurum sitelerinin menü, erişilebilirlik ve çerez metinleri. Başlık olarak
 * geçtiğinde kayıt bir ilan değil sayfa kabuğudur. Normalize edilmiş metinde
 * (küçük harf, Türkçe harf sadeleşmiş) aranır.
 */
export const SITE_CHROME_TITLE_PATTERN =
  /\b(?:daha yuksek erisilebilirlik|erisilebilirlik (?:menusu|ayar\w*|modu\w*)|erisilebilirlik$|ana icerige atla|serit komutlar\w*|sayfa haritasi|sharepoint|oturum ac\b|sizlere daha iyi hizmet|cerez\w*|cookie\w*|kabul ediyorum|hizlierisim|anasayfa\s*\/|ana sayfa\b|tarih araligi|sikca sorulan|teskilat semasi|bakanimiz hakkimizda|bilgi guvenligi politikas\w*|bakanlik bakanlik|secili alan okuyucu|okuma kilavuzu)\b|^(?:anasayfa|duyurular|haberler|iletisim)$/;

/** Başlık site kabuğu (menü/çerez/erişilebilirlik) metni mi? */
export function isSiteChromeTitle(value: string): boolean {
  return SITE_CHROME_TITLE_PATTERN.test(normalizeTr(value));
}

export function collapseWhitespace(value: string): string {
  return value.replace(/[\s\u00A0\u2028\u2029]+/g, ' ').trim();
}

/**
 * HTML etiketlerini ayıklayıp düz metin döndürür.
 *
 * Blok sınırları (`<br>`, `</p>`, `</div>`, `</li>`, `</tr>`, başlık kapanışları)
 * SATIR SONU OLARAK KORUNUR. Bu ayrım liste ayrıştırıcıları için zorunludur:
 * bir ilan kartında kurum, il ve tarih ayrı bloklarda durur; satır sonları
 * kaybolursa alanlar tek paragrafta birleşir ve hiçbiri güvenle çıkarılamaz.
 * Satır İÇİ boşluklar (birden fazla boşluk, sekme, nbsp) sadeleştirilir.
 */
export function stripHtmlTags(html: string): string {
  const withoutMarkup = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

  return withoutMarkup
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function tokenize(value: string, minLength = 2): string[] {
  return normalizeTr(value)
    .split(' ')
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length >= minLength);
}

export function slugifyTr(value: string): string {
  return foldTr(lowerTr(value))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Token-set Jaccard similarity on tokens of length >= 3. */
/**
 * Saf kümeleme sonuçlarının sınırlı önbelleği (en eski kayıt atılır).
 *
 * Tekilleştirme her yeni ilanı ~400 adayla karşılaştırır; yeni ilanın metni 400 kez,
 * adayların metinleri de her ilanda yeniden parçalanıyordu (yerel ölçüm: ilan başına
 * p50 130 ms). Sonuç girdinin saf işlevi olduğundan önbellek davranışı değiştirmez.
 */
const SET_CACHE_LIMIT = 4_096;
function cachedSet(cache: Map<string, Set<string>>, key: string, build: () => Set<string>): Set<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = build();
  if (cache.size >= SET_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}
const tokenSetCache = new Map<string, Set<string>>();
const shingleSetCache = new Map<string, Set<string>>();

export function jaccardSimilarity(a: string, b: string): number {
  const setA = cachedSet(tokenSetCache, a, () => new Set(tokenizeShingles(a)));
  const setB = cachedSet(tokenSetCache, b, () => new Set(tokenizeShingles(b)));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Character n-gram (shingle) similarity — robust for short titles where token
 * overlap is too coarse ("Vakıf Uzman Yardımcılığı Sınav İlanı" variants).
 */
export function diceSimilarity(a: string, b: string, n = 3): number {
  const gramsA = cachedSet(shingleSetCache, `${n}|${a}`, () => shingles(normalizeTr(a), n));
  const gramsB = cachedSet(shingleSetCache, `${n}|${b}`, () => shingles(normalizeTr(b), n));
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let intersection = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) intersection += 1;
  return (2 * intersection) / (gramsA.size + gramsB.size);
}

function shingles(value: string, n: number): Set<string> {
  const compact = value.replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  if (compact.length <= n) {
    if (compact.length > 0) out.add(compact);
    return out;
  }
  for (let i = 0; i + n <= compact.length; i += 1) out.add(compact.slice(i, i + n));
  return out;
}

function tokenizeShingles(value: string): string[] {
  return tokenize(value, 3);
}

const EMAIL_ADDRESS =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?![\p{L}\p{N}-])/giu;
const TURKISH_PHONE_NUMBER =
  /(?<![\p{L}\p{N}])(?:(?:(?:\+|00)\s*90|90)[\s().-]*)?(?:0[\s().-]*)?(?:(?:\((?:[2-5]\d{2}|850)\)|(?:[2-5]\d{2}|850))[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}|444[\s.-]*\d[\s.-]*\d{3})(?![\p{L}\p{N}])/gu;

/** Replaces common email addresses and Turkish phone-number formats in text. */
export function redactContactDetails(value: string): string {
  return value
    .replace(EMAIL_ADDRESS, '[e-posta gizlendi]')
    .replace(TURKISH_PHONE_NUMBER, '[telefon gizlendi]');
}

/** Extracts a readable, contact-redacted excerpt of at most `max` chars. */
const HTML_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

/**
 * Portal JSON'undan (ilan.gov.tr GetAdDetail) metne karışan teknik artıkları siler:
 * HTML varlıkları (`&nbsp;`), logo/ek dosya yolları, URL kısaltmaları (slug), ilan/kurum
 * kodları (ILN02579840, YOK853553, M057822, YYN-000647) ve ISO zaman damgaları. Bunlar
 * ilan metni değildir; kullanıcıya ve bildirimlere gösterilmemeli (27.10.2026: 55
 * ilan.gov.tr kaydının 50'sinde `&nbsp;`, 8'inde logo yolu vardı).
 */
export function stripPortalArtifacts(value: string): string {
  return value
    .replace(/&(#\d{1,5}|[a-z]{2,8});/giu, (entity, name: string) => {
      if (name.startsWith('#')) {
        const code = Number(name.slice(1));
        return code > 31 && code < 0x10000 ? String.fromCharCode(code === 160 ? 32 : code) : ' ';
      }
      return HTML_ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/(?:^|\s)\/?(?:AdvertiserLogo|AdSourceLogo|IlanEki)\/\S+/gu, ' ')
    .replace(/(?:^|\s)\/ilan\/\d+\/[a-z0-9-]+/gu, ' ')
    .replace(/(?<![\w/.:-])[a-z0-9]+(?:-[a-z0-9]+){3,}-?(?![\w/.-])/gu, ' ')
    .replace(/\b(?:ILN|YOK)\d{5,}\b|\bYYN-\d{3,}\b|\bM\d{6}\b/gu, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, ' ')
    .replace(/\bBasın İlan Kurumu ILN\b|\bYüksek Öğretim Kurumu YOK\b/gu, ' ');
}

export function makeExcerpt(value: string, max = 1200): string {
  const clean = collapseWhitespace(redactContactDetails(stripPortalArtifacts(value)));
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function uniquePreserve<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Masks an e-mail address for logs: a***@example.com */
/**
 * Kullanıcı/kaynak içeriğini düzenli ifade KAYNAĞI olarak güvenli hâle getirir.
 *
 * Arama kutusuna `(((((((a)+)+)` yazan bir kullanıcı (ya da başlığında regex
 * karakteri geçen taranmış bir ilan) aksi hâlde ya isteği 500'e düşürür ya da
 * düzenli ifade motorunu kilitler (ReDoS). Arama daima DÜZ METİN eşleşmesidir;
 * `%`, `*` gibi karakterler özel anlam taşımaz.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Sitelerin arayüz (sayfa kabuğu) ifadeleri. Bunlar ilan metni değildir; başlığa,
 * kuruma ya da gövdeye karışırsa "Daha yüksek erişilebilirlik modunu aç" gibi sahte
 * başlıklar üretir. Yalnızca açık arayüz ifadeleri çıkarılır; ilan içeriğine dokunulmaz.
 *
 * 16.10.2026 denetimi: çıkarım aşaması bu ifadeleri HTML seviyesinde
 * (PAGE_CHROME_SELECTORS) zaten atıyor; ancak kayıt bu temizlikten ÖNCE
 * alınmışsa gövdeye yapışmış kabuk metni kalıyordu ve yeniden sınıflandırma
 * kayıttaki metni temizleyemiyordu. Liste, 16.10.2026 kuru çalıştırma
 * raporundaki GERÇEK kayıt gövdelerinde birebir geçen dizelerle genişletildi
 * (Karayolları "Daha yüksek erişilebilirlik modunu aç … Şerit Komutlarını Atla",
 * DSİ "HızlıErişim", İŞKUR "Erişilebilirlik Ayarlarını Temizle … Kabul
 * Ediyorum", İçişleri filtre kutusu "Tarih aralığı seçiniz …"). İlan metninde
 * masum şekilde geçebilecek genel kelimeler (ör. "Kontrast", "Filtrele",
 * "Ara", "temizle") bilinçli olarak DIŞARIDA bırakıldı.
 */
export const UI_CHROME_PHRASES: readonly string[] = [
  'Ana içeriğe atla',
  'Daha yüksek erişilebilirlik modunu aç',
  'Daha yüksek erişilebilirlik modunu kapat',
  'Erişilebilirlik modunu aç',
  'Erişilebilirlik Menüsü',
  'Erişilebilirlik Ayarlarını Temizle',
  'Şerit Komutlarını Atla',
  'Animasyonları Kapat',
  'Animasyonları Aç',
  'Ekran Okuyucu',
  'Seçili Alan Okuyucu',
  'Bağlantı Vurgula',
  'Büyük Metin',
  'Metni Sola Hizala',
  'İmleç Okuma Kılavuzu',
  'Okuma Maskesi',
  'Kontrast Solgunlaştırma',
  'Solgunlaştırma',
  'Düşük Doygunluk',
  'Yüksek Doygunluk',
  'Şu anda seçili',
  'HızlıErişim',
  'Sizlere daha iyi hizmet',
  'Sitemizde çerezlere yer veriyoruz',
  'Web sitemizde sunulan ve açıkça talep etmiş olduğunuz hizmetler',
  'Çerez Aydınlatma Metni',
  'Çerez Ayarları',
  'Zorunlu Çerezler',
  'Analitik Çerezler',
  'Kabul Ediyorum',
  'Kabul Etmiyorum',
  'Tarih aralığı seçiniz',
  'Başlangıç tarihi seçiniz',
  'Bitiş tarihi seçiniz',
  'Gizlilik ve Çerez Politikası',
  'Oturum Aç',
  'SharePoint',
  'Takip Et',
  'Sıkça Sorulan Sorular',
  'Kurumsal Kimlik',
  'Bilgi Güvenliği Politikası',
  'Teşkilat Şeması',
  'Çerez politikamız',
  'Çerez politikası',
];
const UI_CHROME_PATTERN = new RegExp(UI_CHROME_PHRASES.map((phrase) => escapeRegExp(phrase)).join('|'), 'gi');

/**
 * Menü/gezinme etiketleri: gövde metni yerine sayfa iskeleti düşmüşse bu
 * etiketler metnin çoğunluğunu kaplar.
 *
 * 16.10.2026 gerçek kayıt incelemesi (kullanıcının Supabase verisi): Karayolları,
 * TMSF, DSİ ve İŞKUR kayıtlarının 2500 karakterlik gövdesi BAŞTAN SONA bu tür
 * iskelet metniydi; ilan başlığı ve son başvuru tarihi ancak 2400. karakterden
 * sonra geliyordu ve kırpma sınırı yüzünden kayda hiç girmemişti. Bu kayıtlar
 * "şehir/kadro/son tarih yok" ve "durum: bilinmiyor" olarak görünüyordu.
 *
 * Ölçüm: metnin ne kadarı bu etiketlerden oluşuyor? Yarısından fazlası ise gövde
 * ilan metni değil, sayfa iskeletidir. Etiketler menüye özgüdür; ilan cümlesinde
 * geçen genel kelimeler (ör. "personel", "başvuru") listeye ALINMAZ.
 */
export const PAGE_CHROME_NAV_TERMS: readonly string[] = [
  'ana sayfa',
  'anasayfa',
  'kurumsal kimlik',
  'kurumsal yapı',
  'teşkilat şeması',
  'organizasyon şeması',
  'organizasyon yapısı',
  'görev ve sorumluluklarımız',
  'görevleri',
  'yönetim',
  'tarihçe',
  'hakkımızda',
  'mevzuat',
  'etik komisyonu',
  'faaliyet raporları',
  'faaliyet raporu',
  'hizmet standartları',
  'bilgi edinme',
  'sıkça sorulan sorular',
  'görüş & öneri',
  'dilek ve şikayet',
  'iletişim',
  'duyuru detayı',
  'tüm haberler',
  'duyuru arşivi',
  'tüm duyurular arşiv',
  'yayınlar',
  'istatistikler',
  'sunumlar',
  'başkanın mesajı',
  'vizyonumuz',
  'misyonumuz',
  'bilgi güvenliği politikamız',
  'kişisel verilerin işlenmesi ve korunması',
  'mevduat sigortacılığı',
  'banka çözümleme',
  'kayyımlık',
  'zaman aşımı',
  'il müdürlükleri',
  'iş arayan',
  'işveren',
  'teşvikler',
  'özel istihdam büroları',
  'aktif işgücü',
  'işsizlik sigortası',
  'mesleki eğitim kursları',
  'işbaşı eğitim programları',
  'personel bilgileri',
  'merkez teşkilatı',
  'bölgeler',
  'yol ağı bilgileri',
  'bütçe ödenekleri',
  'stratejik planlama',
  'performans programı',
  'uluslararası ilişkiler',
  'basın ve halkla ilişkiler',
  'destek hizmetleri',
  'bilgi teknolojileri',
  'hukuk müşavirliği',
  'iç denetim birimi',
  'kamu hizmet standartları',
  'hızlıerişim',
  'önceki başkanlar',
  'genel sekreterlik',
  'daire başkanlıkları',
];

/** Ölçüm eşiği: 16.10.2026 gerçek kayıtlarıyla kalibre edildi (bkz. test govde-iskelet-olcumu). */
export const PAGE_CHROME_SHARE_THRESHOLD = 0.15;

/** İlan metni sinyali: gerçek ilan gövdesinde bulunup menü dökümünde bulunmayan kalıplar. */
export const NOTICE_TEXT_PATTERN =
  /(alın|yapıl|istihdam edil|atan|görevlendiril|seçil|yerleştiril|başvurul|çağrıl|başlatıl)\w*(acak|ecek)tır|son başvuru|başvuru (tarih|şart|için|süre)|(kadro|kontenjan)\w*|şartlar\w*/i;

/**
 * Gövde metni ilan metni mi, sayfa iskeleti mi?
 *
 * İki sinyal birlikte aranır: metinde hiç ilan cümlesi kalıbı YOKSA ve metnin
 * büyük bölümü bilinen arayüz/menü ifadelerinden oluşuyorsa "ilan metni yok"
 * denir. Kısa metinler bu ölçümle yargılanmaz.
 *
 * Bu fonksiyon yalnızca DENETİM/ÖLÇÜM amaçlıdır: kaydın gövdesi menü dökümü
 * olduğunda alan çıkarımının neye dayandığını görünür kılar. Toplama hattının
 * davranışını değiştirmez (düzeltme canlı HTML örneği gerektirir).
 */
export function looksLikePageChromeText(value: string): boolean {
  const raw = collapseWhitespace(value ?? '');
  if (raw.length < 300) return false;
  if (NOTICE_TEXT_PATTERN.test(raw)) return false;
  const folded = normalizeTr(raw);
  const stripped = collapseWhitespace(stripUiChrome(raw));
  let matched = Math.max(0, raw.length - stripped.length);
  for (const term of PAGE_CHROME_NAV_TERMS) {
    const needle = normalizeTr(term);
    if (!needle) continue;
    let index = folded.indexOf(needle);
    while (index >= 0) {
      matched += needle.length;
      index = folded.indexOf(needle, index + needle.length);
    }
  }
  return matched / raw.length >= PAGE_CHROME_SHARE_THRESHOLD;
}

/**
 * Metnin ne kadarı bilinen arayüz/menü ifadelerinden oluşuyor (oran, 0–1)?
 * Denetim çıktısında sayı olarak raporlanır.
 */
export function pageChromeShare(value: string): number {
  const raw = collapseWhitespace(value ?? '');
  if (!raw) return 0;
  const folded = normalizeTr(raw);
  const stripped = collapseWhitespace(stripUiChrome(raw));
  let matched = Math.max(0, raw.length - stripped.length);
  for (const term of PAGE_CHROME_NAV_TERMS) {
    const needle = normalizeTr(term);
    if (!needle) continue;
    let index = folded.indexOf(needle);
    while (index >= 0) {
      matched += needle.length;
      index = folded.indexOf(needle, index + needle.length);
    }
  }
  return Math.min(1, matched / raw.length);
}

/** Sayfa kabuğu ifadelerini çıkarır ve boşlukları toparlar. */
export function stripUiChrome(text: string): string {
  return collapseWhitespace(text.replace(UI_CHROME_PATTERN, ' '));
}
