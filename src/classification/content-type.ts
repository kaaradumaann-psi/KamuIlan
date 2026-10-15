/**
 * İçerik türü taksonomisi. Sınıflandırma kararının (accept/review/reject + kind) yanında,
 * her sonucun NEDEN hangi türde olduğunu deterministik olarak açıklar.
 *
 * Amaç: normal ilan listesinde yalnızca `personnel_recruitment` görünsün; diğer türler
 * ayrı etiketlerle izlenebilsin ve etiketli değerlendirmede sınıf bazında ölçülebilsin.
 * Bu bir LLM kararı değildir; yalnızca mevcut kural kimliklerinin ve başlık ipuçlarının eşlemesidir.
 */
import { CONTENT_TYPES } from '../domain/types';
import type { ClassificationDecision, ClassificationKind, ContentType } from '../domain/types';

export { CONTENT_TYPES };
export type { ContentType };

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  personnel_recruitment: 'Personel alımı',
  personnel_process_announcement: 'Personel alımı süreç duyurusu',
  student_admission: 'Öğrenci kabulü / tercih',
  education_program: 'Eğitim programı / burs',
  news: 'Haber / basın duyurusu',
  event: 'Etkinlik (konferans, seminer)',
  report_or_publication: 'Rapor / yayın',
  other: 'Diğer',
  uncertain: 'Belirsiz (inceleme)',
};

/** Yalnızca bu türler normal ilan listesinde (ilan olarak) gösterilir. */
export const JOB_CONTENT_TYPES: readonly ContentType[] = ['personnel_recruitment'];

export interface ContentTypeInput {
  decision: ClassificationDecision;
  kind: ClassificationKind;
  rules: readonly string[];
  /** Normalize edilmiş başlık (küçük harf, Türkçe karakter sadeleştirilmiş). */
  normalizedTitle: string;
  /**
   * Normalize edilmiş kaynak kategorisi (varsa). YALNIZCA reddedilen kaydın
   * alt tür etiketi için kullanılır; kabul/ret kararını ASLA etkilemez.
   * Kaynağın kendisi "Haberler" dediyse ve başlıkta daha özgül bir tür
   * (öğrenci/eğitim/etkinlik/rapor) çıkarılamıyorsa kayıt `news` sayılır —
   * başlıkta haber ipucu yok diye `other`a düşmez.
   */
  normalizedSourceCategory?: string;
}

/** Başlık ipuçlarıyla alt tür (basın/konferans/rapor kuralı ortaktır). */
function titleSubtype(title: string): ContentType {
  if (/\b(?:konferans|sempozyum|seminer|calistay|panel|etkinlik|forum)\w*/.test(title)) return 'event';
  if (/\b(?:egitim\s+programi|kurs|uzmanlik\s+egitim\w*|burs)\b/.test(title)) return 'education_program';
  if (/\b(?:rapor\w*|degerlendirme\s+raporu)\b/.test(title)) return 'report_or_publication';
  if (/\b(?:basin|haber|mesaj\w*|aciklama\w*|ziyaret\w*|uyari\w*|baskan\w*)\b/.test(title)) return 'news';
  return 'other';
}

const STUDENT_RULES = new Set(['ret-baslik.ogrenci-kabul-tercih', 'ret-govde.ogrenci']);
const EDUCATION_RULES = new Set(['ret-baslik.egitim-programi', 'ret-baslik.staj-burs']);

/** Sonucun içerik türü. Karar `review` ise belirsizdir; `accept` ise kind'a göre ilan/süreç. */
export function contentTypeOf(input: ContentTypeInput): ContentType {
  if (input.decision === 'review') return 'uncertain';
  if (input.decision === 'accept') {
    return input.kind === 'process' ? 'personnel_process_announcement' : 'personnel_recruitment';
  }
  // reject
  const rules = input.rules;
  if (rules.some((rule) => STUDENT_RULES.has(rule))) return 'student_admission';
  if (rules.some((rule) => EDUCATION_RULES.has(rule))) return 'education_program';
  if (rules.includes('ret-baslik.basin-duyurusu')) return 'news';
  // Kurala bağlanmayan veya basın/konferans/rapor kuralına giren redlerde başlık ipuçları belirler.
  const subtype = titleSubtype(input.normalizedTitle);
  if (subtype !== 'other') return subtype;
  // Başlık sessiz ama kaynağın kendi kategorisi "haber" diyorsa o etiket kullanılır.
  // Bu yalnızca ret ETİKETİDİR: karar zaten reject'tir, hiçbir kayıt bu yolla
  // ilana dönüşmez ve bildirim üretmez.
  if (input.normalizedSourceCategory && /\bhaber\w*\b/.test(input.normalizedSourceCategory)) return 'news';
  return 'other';
}
