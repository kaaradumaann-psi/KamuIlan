/**
 * Alan çıkarımı değerlendirmesinin TEK alan sözlüğü.
 *
 * Etiketleme sayfası, içe aktarma doğrulaması ve değerlendirme raporu aynı
 * anahtarları kullanır. Böylece "şehir" alanının bir yerde `city`, başka yerde
 * `il` olması sessizce ölçüm dışı bırakmaya yol açmaz.
 */
export type ExtractionFieldKind =
  | 'text'
  | 'number'
  | 'list'
  | 'date'
  | 'datetime'
  | 'url'
  | 'attachments';

export type ExpectedFieldStatus = 'present' | 'absent' | 'ambiguous';

export interface ExpectedFieldEvidence {
  value: string | number | boolean | string[] | null;
  status: ExpectedFieldStatus;
  evidenceQuote: string;
  sourceUrl: string;
  locator: string;
}

export type ExpectedFieldValue = string | number | boolean | string[] | null | ExpectedFieldEvidence;

export interface ExtractionFieldDefinition {
  key: string;
  label: string;
  kind: ExtractionFieldKind;
  /** Eski/insan dostu anahtarlar; içe aktarmada kanonik anahtara çevrilir. */
  aliases?: readonly string[];
}

export const EXTRACTION_FIELD_DEFINITIONS: readonly ExtractionFieldDefinition[] = [
  { key: 'institution', label: 'Kurum', kind: 'text' },
  { key: 'unit', label: 'Birim', kind: 'text' },
  { key: 'employmentType', label: 'İstihdam türü', kind: 'text', aliases: ['employment'] },
  { key: 'city', label: 'İl', kind: 'text', aliases: ['il'] },
  { key: 'district', label: 'İlçe', kind: 'text', aliases: ['ilce'] },
  { key: 'quota', label: 'Kadro/kontenjan', kind: 'number', aliases: ['kontenjan', 'kadro'] },
  { key: 'cadreStatus', label: 'Kadro durumu', kind: 'text' },
  { key: 'titles', label: 'Unvan', kind: 'list', aliases: ['title', 'unvan', 'jobTitle'] },
  { key: 'educationLevels', label: 'Öğrenim', kind: 'list', aliases: ['education', 'ogrenim'] },
  { key: 'departments', label: 'Bölüm', kind: 'list', aliases: ['department', 'bolum'] },
  { key: 'kpssScoreTypes', label: 'KPSS türü', kind: 'list', aliases: ['kpssType', 'kpss'] },
  { key: 'kpssMinScore', label: 'KPSS taban puanı', kind: 'number', aliases: ['kpssBaseScore', 'tabanPuan'] },
  { key: 'kpssYear', label: 'KPSS yılı', kind: 'number' },
  { key: 'minAge', label: 'Alt yaş sınırı', kind: 'number' },
  { key: 'maxAge', label: 'Üst yaş sınırı', kind: 'number' },
  { key: 'certificates', label: 'Sertifika', kind: 'list', aliases: ['sertifika'] },
  { key: 'minExperienceYears', label: 'Deneyim (yıl)', kind: 'number', aliases: ['experience'] },
  { key: 'foreignLanguages', label: 'Yabancı dil', kind: 'list', aliases: ['language', 'dil'] },
  { key: 'specialConditions', label: 'Özel koşul', kind: 'list', aliases: ['ozelKosul'] },
  { key: 'publishedAt', label: 'Yayım tarihi', kind: 'date', aliases: ['yayimTarihi'] },
  {
    key: 'applicationStartAt',
    label: 'Başvuru başlangıcı',
    kind: 'datetime',
    aliases: ['basvuruBaslangic', 'applicationStart'],
  },
  {
    key: 'applicationEndAt',
    label: 'Başvuru bitişi',
    kind: 'datetime',
    aliases: ['basvuruBitis', 'applicationEnd', 'applicationEndDate', 'sonBasvuru'],
  },
  { key: 'applicationMethod', label: 'Başvuru yöntemi', kind: 'text', aliases: ['basvuruYontemi'] },
  { key: 'applicationUrl', label: 'Başvuru URL', kind: 'url', aliases: ['basvuruUrl'] },
  { key: 'attachments', label: 'Ek/PDF', kind: 'attachments', aliases: ['pdf', 'ekler'] },
  { key: 'referenceNo', label: 'Referans no', kind: 'text', aliases: ['ilanNo'] },
] as const;

export const EXTRACTION_FIELD_KEYS = new Set(EXTRACTION_FIELD_DEFINITIONS.map((field) => field.key));

const ALIAS_TO_KEY = new Map<string, string>();
for (const field of EXTRACTION_FIELD_DEFINITIONS) {
  ALIAS_TO_KEY.set(field.key.toLowerCase(), field.key);
  for (const alias of field.aliases ?? []) ALIAS_TO_KEY.set(alias.toLowerCase(), field.key);
}

export function canonicalFieldKey(rawKey: string): string | null {
  return ALIAS_TO_KEY.get(rawKey.trim().toLowerCase()) ?? null;
}

export function fieldDefinition(key: string): ExtractionFieldDefinition | null {
  return EXTRACTION_FIELD_DEFINITIONS.find((field) => field.key === key) ?? null;
}

/** Etiketleme sayfasında kullanılabilecek kanonik anahtarlar (insan okur liste). */
export const EXPECTED_FIELD_KEYS_HELP = EXTRACTION_FIELD_DEFINITIONS.map((field) => field.key).join(', ');
