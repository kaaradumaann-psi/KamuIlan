/**
 * `GET /api/sitemap.xml` — herkese açık vitrin için site haritası.
 *
 * Yalnızca `PUBLIC_LISTINGS_ENABLED=1` iken yanıt verir: giriş kapılı bir sitenin
 * adreslerini arama motorlarına bildirmek anlamsızdır ve kapalı ürünün içeriğini
 * duyurur. Yalnızca ONAYLI ilanlar listelenir (aynı süzgeç: `classification.decision
 * = accept`); üst sınır sitemap protokolünün tek dosya sınırının altındadır.
 */
import type { FastifyInstance } from 'fastify';
import { getEnv } from '../../config/env';
import type { Repos } from '../../db/repos';
import { ApiError } from '../errors';

const MAX_JOB_URLS = 5_000;
const STATIC_PATHS = ['/', '/ilanlar', '/kaynaklar'];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function registerSitemapRoutes(app: FastifyInstance, repos: Repos): void {
  app.get(
    '/api/sitemap.xml',
    { schema: { tags: ['seo'], summary: 'Site haritası (yalnızca herkese açık vitrin açıkken)' } },
    async (_request, reply) => {
      const env = getEnv();
      if (!env.PUBLIC_LISTINGS_ENABLED)
        throw ApiError.notFound('Site haritası yalnızca herkese açık vitrinde yayımlanır.');
      const base = env.APP_BASE_URL.replace(/\/+$/, '');
      const jobs = await repos.store.find(
        'jobs',
        { 'classification.decision': 'accept' },
        { sort: [['updatedAt', -1]], limit: MAX_JOB_URLS },
      );
      const entries = [
        ...STATIC_PATHS.map((path) => `  <url><loc>${escapeXml(`${base}${path}`)}</loc></url>`),
        ...jobs.map(
          (job) =>
            `  <url><loc>${escapeXml(`${base}/ilanlar/${encodeURIComponent(job.id)}`)}</loc><lastmod>${escapeXml(
              job.updatedAt.slice(0, 10),
            )}</lastmod></url>`,
        ),
      ];
      reply.header('content-type', 'application/xml; charset=utf-8');
      reply.header('cache-control', 'public, max-age=3600');
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
    },
  );
}
