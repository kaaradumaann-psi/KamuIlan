import type { RawAnnouncement } from '../domain';
import { collapseWhitespace, stripUiChrome } from '../domain/text';

/**
 * Tüm adaptörlerden gelen ham ilanı ortak biçimde temizler: sayfa kabuğu ifadeleri
 * başlıktan, kurum adından ve gövdeden çıkarılır. Boş kalan başlık ham haliyle
 * korunur (ilan kaybolmasın diye); asıl karar sınıflandırıcıda verilir.
 */
export function sanitizeRawAnnouncement(raw: RawAnnouncement): RawAnnouncement {
  const title = stripUiChrome(raw.title) || collapseWhitespace(raw.title);
  const institution = raw.institution ? stripUiChrome(raw.institution) || undefined : undefined;
  const bodyText = raw.bodyText ? stripUiChrome(raw.bodyText) : raw.bodyText;
  const rawExcerpt = raw.rawExcerpt ? stripUiChrome(raw.rawExcerpt) : raw.rawExcerpt;
  return { ...raw, title, institution, bodyText, rawExcerpt };
}
