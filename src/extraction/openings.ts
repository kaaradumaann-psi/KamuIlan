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

/** Kadro kırılımı: önce mahalli idare tablosu, yoksa üniversite (öğretim elemanı) tablosu. */
export function extractOpenings(text: string): JobOpening[] {
  const municipal = extractMunicipalOpenings(text);
  return municipal.length > 0 ? municipal : extractAcademicOpenings(text);
}

function extractMunicipalOpenings(text: string): JobOpening[] {
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

/* ---------------------------------------------------------------------------
 * Üniversite öğretim elemanı tabloları (2547 sayılı Kanun ilanları).
 *
 * Gerçek biçimler (Resmî Gazete, kopukluğu giderilmiş PDF metni):
 *  - Bursa Uludağ Ü. 16.10.2026-4-14: "İLAN NO. BİRİM BÖLÜM ANABİLİM DALI KADRO ÜNV. K.D. AD. AÇIKLAMA"
 *    satır: "20260301 DEVLET KONSERVATUVARI … DOKTOR ÖĞRETİM ÜYESİ 1 1 <açıklama>"
 *  - Akdeniz Ü. 20.10.2026-4-9: "S.N. BİRİM BÖLÜM … ÜNVAN DER. ADET İLAN ŞARTLARI"
 *    satır: "1 EĞİTİM FAKÜLTESİ … PROFESÖR 1 1 <şartlar>"; aynı belgede ikinci tablo 1'den başlar.
 *  - Atatürk Ü. 15.10.2026-4-10: "… KADRO ÜNVANI KADRO DERECE KADRO ADEDİ AÇIKLAMA"
 *    satır: "1 Tıp Fakültesi … Dr. Öğr. Üyesi 1 1 <açıklama>"
 *
 * Kurallar (kanıtsız değer yok): unvan + derece + adet sütun başlığı doğrulanmadan
 * satır okunmaz; her satır "UNVAN DERECE ADET" üçlüsüyle bulunur; satır numaraları
 * (8 haneli ilan no ya da sıra no) bir başlık bölümü içinde ardışık değilse o bölüm
 * güvenilmez sayılır ve hiç tablo üretilmez.
 * ------------------------------------------------------------------------- */

/** Türkçe küçük harfe çevrilmiş unvan (JS `/iu` "İ"yi "i"ye katlamaz). */
const ACADEMIC_RANKS: readonly [RegExp, string][] = [
  [/^(?:doktor öğretim üyesi|dr\. ?öğr\. ?üyesi)$/u, 'Doktor Öğretim Üyesi'],
  [/^profesör$/u, 'Profesör'],
  [/^doçent$/u, 'Doçent'],
  [/^öğretim görevlisi$/u, 'Öğretim Görevlisi'],
  [/^(?:araştırma görevlisi|arş\. ?gör\.)$/u, 'Araştırma Görevlisi'],
];

const ACADEMIC_ROW = new RegExp(
  String.raw`(?<![\p{L}.])(DOKTOR ÖĞRETİM ÜYESİ|Doktor Öğretim Üyesi|DR\. ?ÖĞR\. ?ÜYESİ|Dr\. ?Öğr\. ?Üyesi|PROFESÖR|Profesör|DOÇENT|Doçent|ÖĞRETİM GÖREVLİSİ|Öğretim Görevlisi|ARAŞTIRMA GÖREVLİSİ|Araştırma Görevlisi|ARŞ\. ?GÖR\.|Arş\. ?Gör\.)(?:\s*\(([^()]{2,40})\))?\s+([1-9])\s+(\d{1,2})(?=\s|$)`,
  'gu',
);

/** Sütun başlığı: unvan … derece … adet (sırayla, yakın). */
const ACADEMIC_HEADER =
  /(?:ÜNV\.|ÜNVAN|ÜNVANI|UNVAN|UNVANI)[^\n]{0,40}?(?:\n[^\n]{0,40}?){0,3}?(?:K\.D\.|DER\.|DERECE)[^\n]{0,40}?(?:\n[^\n]{0,40}?){0,3}?(?:AD\.|ADET|ADEDİ)/gu;

/**
 * Satırın başındaki sıra no ("1 EĞİTİM …") ya da ilan no ("20260301 DEVLET …").
 * İlan no 6–10 hane kabul edilir: kaynakta yazım hatası olur (RG 16.10-4-14:
 * "202620302", "20230330").
 */
const ROW_INDEX = /(?:^|\s)(\d{6,10}|\d{1,3})\s+(?=\p{Lu})/gu;

function normalizeRank(raw: string): string | null {
  const flat = raw.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr');
  for (const [pattern, label] of ACADEMIC_RANKS) if (pattern.test(flat)) return label;
  return null;
}

function tidy(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
  if (text.length < 3) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function extractAcademicOpenings(text: string): JobOpening[] {
  if (!text) return [];
  const headers = [...text.matchAll(ACADEMIC_HEADER)];
  if (headers.length === 0) return [];
  const openings: JobOpening[] = [];
  for (const [headerIndex, header] of headers.entries()) {
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[headerIndex + 1]?.index ?? text.length;
    // PDF hücrelerinde unvan ve sayılar ayrı satırlarda gelir ("DOKTOR\nÖĞRETİM\nÜYESİ\n1 1").
    const section = text.slice(start, end).replace(/\s+/g, ' ');
    const rows = [...section.matchAll(ACADEMIC_ROW)];
    const sectionOpenings: JobOpening[] = [];
    const indexes: number[] = [];
    let cursor = 0;
    for (const [rowIndex, row] of rows.entries()) {
      // Öğretim görevlisi satırı: "ÖĞRETİM GÖREVLİSİ (DERS VERMEKLE GÖREVLİ) 5 1" (Akdeniz Ü.).
      const baseRank = normalizeRank(row[1] ?? '');
      const qualifier = row[2] ? tidy(row[2].toLocaleLowerCase('tr'), 40) : null;
      const rank = baseRank && qualifier ? `${baseRank} (${qualifier})` : baseRank;
      const degree = Number(row[3]);
      const quota = Number(row[4]);
      if (!rank || !Number.isInteger(quota) || quota < 1 || quota > 50) return [];
      const rowStart = row.index ?? 0;
      // Birim: önceki satırın sonu ile unvan arasındaki SON sıra numarasından sonrası.
      const before = section.slice(cursor, rowStart);
      const numbers = [...before.matchAll(ROW_INDEX)];
      const last = numbers[numbers.length - 1];
      let unit: string | null = null;
      if (last) {
        indexes.push(Number(last[1]));
        unit = tidy(before.slice((last.index ?? 0) + last[0].length), 140);
      }
      // Açıklama/şartlar: adetten sonra, sonraki satırın sıra numarasına kadar.
      const afterStart = rowStart + row[0].length;
      const nextRow = rows[rowIndex + 1];
      const afterEnd = nextRow?.index ?? section.length;
      const after = section.slice(afterStart, afterEnd);
      const nextIndex = [...after.matchAll(ROW_INDEX)].pop();
      const qualification = tidy(nextIndex && nextRow ? after.slice(0, nextIndex.index ?? after.length) : after, 240);
      sectionOpenings.push({
        title: unit ? `${rank} — ${unit}` : rank,
        quota,
        serviceClass: null,
        degree,
        qualification,
        evidence: tidy(`${before.slice(-140)} ${row[0]}`, 200) ?? row[0],
      });
      cursor = afterStart;
    }
    // Her satırın numarası olmalı. Sıra no (1, 2, 3 …) bölüm içinde ardışık; ilan no
    // (6+ hane) bir kimliktir: benzersiz olmalı (kaynaktaki yazım hatası ardışıklığı bozar).
    if (indexes.length > 0) {
      if (indexes.length !== sectionOpenings.length) return [];
      const ids = indexes.every((value) => value >= 100_000);
      if (ids) {
        if (new Set(indexes).size !== indexes.length) return [];
      } else {
        for (let i = 1; i < indexes.length; i += 1) if (indexes[i] !== (indexes[i - 1] as number) + 1) return [];
      }
    }
    openings.push(...sectionOpenings);
    if (openings.length >= MAX_ROWS) break;
  }
  return openings;
}
