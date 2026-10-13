/**
 * Görüntüleme biçimlendirmeleri.
 *
 * Zaman damgaları veritabanında ISO tutulur; kullanıcıya Europe/Istanbul
 * saatinde gösterilir (kullanıcı şartı). Tarih ve saat ayrı biçimlenir ki
 * "saat bilinmiyor" durumu net anlaşılsın.
 */

/**
 * İstihdam türü etiketleri — kanonik değerler `src/domain/types.ts`
 * (EMPLOYMENT_TYPES) ile BİREBİR aynıdır. Arayüz kendi sözlüğünü uydurmaz:
 * API'den gelen `kadrolu`, `kamu-isci`, `kariyer-meslek` gibi değerler burada
 * karşılanmazsa her ilan "Belirsiz" görünür ve filtreler hiç sonuç döndürmez.
 */
export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  kadrolu: 'Kadrolu memur',
  sozlesmeli: 'Sözleşmeli personel',
  'kamu-isci': 'Kamu işçisi',
  akademik: 'Akademik kadro',
  'kariyer-meslek': 'Kariyer meslekleri',
  'kuruma-ozel-sinav': 'Kuruma özgü sınavla alım',
  'diger-kamu': 'Diğer kamu personeli',
  belirsiz: 'Belirsiz / incelemede',
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  upcoming: 'Başvuru yakında',
  active: 'Başvuru açık',
  closed: 'Kapandı',
  cancelled: 'İptal edildi',
  unknown: 'Durum belirsiz',
  draft: 'Taslak',
  review: 'İncelemede',
};

export const DEADLINE_LABELS: Record<string, string> = {
  upcoming: 'Başvuru henüz başlamadı',
  active: 'Başvuru sürüyor',
  'closing-soon': 'Son günler',
  closed: 'Süre doldu',
  unknown: 'Tarih belirtilmemiş',
};

/**
 * Eğitim düzeyi ETİKETLERİ.
 *
 * `lise` ve `belirtilmemis` birer GÖRÜNTÜLEME takma adıdır (eski kayıtlarda
 * görülebilir); kanonik değerler `src/domain/types.ts` EDUCATION_LEVELS'tir ve
 * ortaöğretim için `ortaogretim` kullanılır. Form seçenekleri bu sözlükten
 * ÜRETİLMEZ: `belirtilmemis` sunucuda geçersizdir (400), `lise` ise hiçbir
 * kayıtla eşleşmez (filtrede sessizce 0 sonuç veriyordu).
 */
export const EDUCATION_LABELS: Record<string, string> = {
  ilkogretim: 'İlköğretim',
  ortaogretim: 'Ortaöğretim (lise)',
  lise: 'Ortaöğretim (lise)',
  onlisans: 'Ön lisans',
  lisans: 'Lisans',
  yukseklisans: 'Yüksek lisans',
  doktora: 'Doktora',
  belirtilmemis: 'Belirtilmemiş',
};

/** Eski/paylaşılmış bağlantılardaki takma adları kanonik değere çevirir. */
export function normalizeEducationLevel(value: string): string {
  return value === 'lise' ? 'ortaogretim' : value === 'belirtilmemis' ? '' : value;
}

export const SOURCE_STATUS_LABELS: Record<string, string> = {
  verified: 'Çalıştığı kanıtlanmış',
  'scraper-built': 'Hazırlanıyor',
  accessible: 'Ulaşılabiliyor',
  'method-defined': 'Yöntemi hazır',
  researched: 'İncelendi',
  'not-researched': 'Henüz başlamadı',
  'temporary-error': 'Geçici sorun',
  'access-restricted': 'Erişilemiyor',
  'needs-manual-method': 'Elle takip ediliyor',
  disabled: 'Kapalı',
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'Sırada bekliyor',
  running: 'Çalışıyor',
  success: 'Tamamlandı',
  partial: 'Kısmen tamamlandı',
  failed: 'Sorun çıktı',
  skipped: 'Atlandı',
  locked: 'Atlandı (başka tarama sürüyor)',
};

const ISTANBUL = 'Europe/Istanbul';

/** Kullanıcının yerel saatinde göster (varsayılan: Istanbul). */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: ISTANBUL,
  }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'belirtilmemiş';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'belirtilmemiş';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long', timeZone: ISTANBUL }).format(date);
}

/**
 * Gün gösterimi (saat uydurulmaz).
 *
 * İki biçimi de kabul eder:
 *  - `2026-10-30` → doğrudan gün.
 *  - `2026-10-30T00:00:00+03:00` → gün, İSTANBUL saatine göre belirlenir.
 *
 * Eski hata: tam ISO damgası da tarih sanılıp `split('-')` ile parçalanıyordu ve
 * ekrana "NaN Ekim 2026" yazıyordu (her ilan kartında ve ana sayfadaki son gün
 * listesinde görünüyordu).
 */
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return 'belirtilmemiş';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return value;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
        timeZone: ISTANBUL,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(date)
        .split('-');
      return `${Number(day)} ${monthName(Number(month))} ${year}`;
    }
  }
  return `${Number(match[3])} ${monthName(Number(match[2]))} ${match[1]}`;
}

/**
 * Başvuru tarihi/saati: saat metinde GERÇEKTEN yazılıysa saat gösterilir.
 *
 * Çıkarım motoru saati bilinmeyen tarihlerde 00:00 yazar (gün başı). Bunu
 * kullanıcıya "00:00" diye göstermek, ilanda olmayan bir saat uydurmak olur.
 */
export function formatDateMaybeTime(value: string | null | undefined): string {
  if (!value) return 'belirtilmemiş';
  const match = /T(\d{2}):(\d{2})/.exec(value);
  if (!match || (match[1] === '00' && match[2] === '00')) {
    return formatDateOnly(value);
  }
  return formatDateTime(value);
}

function monthName(month: number): string {
  return (
    [
      'Ocak',
      'Şubat',
      'Mart',
      'Nisan',
      'Mayıs',
      'Haziran',
      'Temmuz',
      'Ağustos',
      'Eylül',
      'Ekim',
      'Kasım',
      'Aralık',
    ][month - 1] ?? ''
  );
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('tr-TR').format(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} sn`;
  return `${Math.round(ms / 60_000)} dk`;
}

export function formatRelative(value: string | null | undefined, reference: Date = new Date()): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - reference.getTime();
  const minutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat('tr-TR', { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export function deadlineLabel(daysLeft: number | null, state: string): string {
  if (state === 'closed') return 'Başvuru süresi doldu';
  if (state === 'unknown' || daysLeft === null) return 'Son tarih belirtilmemiş';
  if (daysLeft === 0) return 'Bugün son gün';
  if (daysLeft === 1) return 'Yarın son gün';
  return `${daysLeft} gün kaldı`;
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return 'yüksek güven';
  if (confidence >= 0.6) return 'orta güven';
  return 'düşük güven';
}

/** Türkçe uyumlu baş harf büyütme (i → İ, ı → I). */
export function turkishCapitalize(value: string): string {
  if (value.length === 0) return value;
  const first = value[0] as string;
  const upper = first === 'i' ? 'İ' : first === 'ı' ? 'I' : first.toLocaleUpperCase('tr-TR');
  return `${upper}${value.slice(1)}`;
}
