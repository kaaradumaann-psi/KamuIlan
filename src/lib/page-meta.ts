/**
 * Sayfa metaverisi (SEO + paylaşılan bağlantı önizlemesi) ve ilan yapılandırılmış verisi.
 *
 * SPA olduğu için başlık ve açıklama istemci tarafında güncellenir; arama motorları
 * JavaScript'i işleyerek bunları okur. `JobPosting` yalnızca ilanda GERÇEKTEN bulunan
 * alanlardan üretilir: değer yoksa alan hiç yazılmaz (tahmin/varsayılan yok).
 */
import { useEffect } from 'react';
import { APP_NAME } from '../site';
import type { PublicJobDetail } from '../types';

const DEFAULT_DESCRIPTION =
  'Resmî kaynaklardan toplanan kamu personel alım ilanları: kurum, il, kontenjan, son başvuru tarihi ve kaynak bağlantısı.';

function setMetaContent(
  selector: string,
  attribute: 'name' | 'property',
  key: string,
  content: string,
): void {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

export function usePageMeta(meta: { title: string | null; description?: string | null }): void {
  const { title, description } = meta;
  useEffect(() => {
    if (!title) return;
    const fullTitle = `${title} | ${APP_NAME}`;
    const text = (description ?? DEFAULT_DESCRIPTION).slice(0, 300);
    document.title = fullTitle;
    setMetaContent('meta[name="description"]', 'name', 'description', text);
    setMetaContent('meta[property="og:title"]', 'property', 'og:title', fullTitle);
    setMetaContent('meta[property="og:description"]', 'property', 'og:description', text);
  }, [title, description]);
}

/** schema.org `JobPosting`; zorunlu alanlardan biri yoksa `null` (eksik yapılandırılmış veri yayımlanmaz). */
export function jobPostingJsonLd(job: PublicJobDetail, pageUrl: string): Record<string, unknown> | null {
  if (job.kind !== 'job' || !job.publishedAt || !job.title || !job.institution) return null;
  const totalJobOpenings = job.quota;
  const validThrough =
    job.applicationEndAt ?? (job.applicationEndDate ? `${job.applicationEndDate}T23:59:59+03:00` : null);
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    datePosted: job.publishedAt.slice(0, 10),
    ...(validThrough ? { validThrough } : {}),
    hiringOrganization: { '@type': 'Organization', name: job.institution },
    ...(job.city
      ? {
          jobLocation: {
            '@type': 'Place',
            address: {
              '@type': 'PostalAddress',
              addressRegion: job.city,
              ...(job.district ? { addressLocality: job.district } : {}),
              addressCountry: 'TR',
            },
          },
        }
      : {}),
    ...(totalJobOpenings ? { totalJobOpenings } : {}),
    description: job.textExcerpt || job.title,
    url: pageUrl,
    directApply: false,
  };
}

/** `<script type="application/ld+json">` içeriği: `</script>` kaçışı (XSS) için `<` kodlanır. */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
