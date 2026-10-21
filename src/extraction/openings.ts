/**
 * Çoklu kadro (unvan × kontenjan) çıkarımı.
 *
 * Kapsam (bilinçli olarak dar): Mahalli İdarelere İlk Defa Atanacaklara Dair Sınav
 * ve Atama Yönetmeliği'nin standart tablosu — belediye/il özel idaresi ilanlarında
 * "Sıra No | Kadro/Pozisyon Unvanı | Hizmet Sınıfı | Derece | Adedi | Niteliği | …"
 * sütunları. PDF metin katmanında her satır "1 Mühendis TH 8 2" biçiminde gelir
 * (gerçek örnekler: Resmî Gazete 14.10.2026 Keşan Belediyesi, 18.10.2026
 * Karabağlar Belediyesi).
 *
 * Kurallar (kanıtsız değer üretilmez):
 *  - Tablo başlığı metinde doğrulanmadan hiçbir satır okunmaz.
 *  - Sıra numaraları 1'den başlayıp birer artmalıdır; aksi hâlde tablo güvenilmez
 *    sayılır ve sonuç boş döner (yarım/yanlış tablo yerine hiç tablo).
 *  - Her kadro, okunduğu satırı `evidence` olarak taşır.
 *  - İl/ilçe bu tabloda yoktur; ilanın kendi `city` alanı kullanılır (uydurulmaz).
 */
export interface JobOpening {
  title: string;
  quota: number;
  /** Hizmet sınıfı kısaltması (GİH, TH, SH, AH, YH, EÖH, DH). */
  serviceClass: string | null;
  /** Kadro/pozisyon derecesi. */
  degree: number | null;
  /** "Niteliği" sütunu (öğrenim/bölüm şartı), kaynaktan birebir; yoksa null. */
  qualification: string | null;
  /** Kaynak metindeki satır (kanıt). */
  evidence: string;
}

const SERVICE_CLASSES = ['GİH', 'GIH', 'TH', 'SH', 'AH', 'YH', 'EÖH', 'EOH', 'DH'];

const HEADER_PATTERNS: readonly RegExp[] = [
  /\b(?:kadro|pozisyon)\s+[üu]nvan[ıi]/iu,
  /\bhizmet\s+s[ıi]n[ıi]f[ıi]/iu,
  /\badedi\b/iu,
];

const ROW_PATTERN = new RegExp(
  String.raw`^(\d{1,3})\s+(\S.{0,80}?)\s+(` +
    SERVICE_CLASSES.join('|') +
    String.raw`)\s+(\d{1,2})\s+(\d{1,4})(?=\s|$)`,
  'u',
);

/** "Niteliği" sütununun bittiği yer: cinsiyet/KPSS sütunu, yeni satır ya da yeni bölüm. */
const QUALIFICATION_END = /^(?:\/?\s*(?:erkek|kad[ıi]n)(?![\p{L}])|p\d{1,3}(?![\p{L}\d])|kpss(?![\p{L}])|ba[şs]vuru(?![\p{L}])|\d{1,3}\s)/iu;

const MAX_ROWS = 200;

export function extractOpenings(text: string): JobOpening[] {
  if (!text) return [];
  const flattened = text.replace(/\s+/g, ' ');
  if (!HEADER_PATTERNS.every((pattern) => pattern.test(flattened))) return [];

  const lines = text.split('\n').map((rawLine) => rawLine.replace(/\s+/g, ' ').trim());
  const openings: JobOpening[] = [];
  let expected = 1;
  for (const [index, line] of lines.entries()) {
    const match = ROW_PATTERN.exec(line);
    if (!match) continue;
    if (Number(match[1]) !== expected) return [];
    const quota = Number(match[5]);
    const degree = Number(match[4]);
    const title = (match[2] ?? '').trim();
    if (!Number.isInteger(quota) || quota < 1 || title.length < 2) return [];
    openings.push({
      title,
      quota,
      serviceClass: (match[3] ?? '').replace('GIH', 'GİH').replace('EOH', 'EÖH'),
      degree: degree >= 1 && degree <= 15 ? degree : null,
      qualification: qualificationAfter(lines, index),
      evidence: line.slice(0, 200),
    });
    expected += 1;
    if (openings.length >= MAX_ROWS) break;
  }
  return openings;
}

function qualificationAfter(lines: readonly string[], rowIndex: number): string | null {
  const parts: string[] = [];
  for (const line of lines.slice(rowIndex + 1, rowIndex + 9)) {
    if (line.length === 0) continue;
    if (QUALIFICATION_END.test(line) || ROW_PATTERN.test(line)) break;
    parts.push(line);
  }
  const text = parts.join(' ').replace(/\s+([,.])/g, '$1').trim();
  if (text.length < 8) return null;
  return text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text;
}
