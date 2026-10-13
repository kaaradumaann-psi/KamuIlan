/**
 * Kaynak uçları (herkese açık okuma).
 *
 * Şeffaflık ilkesi: hangi kaynağın ne zaman tarandığı, kaç ilan ürettiği ve
 * nerede aksadığı açıkça gösterilir. "Tüm ilanlar toplanıyor" iddiası yoktur;
 * kapsam raporu planlanan kaynakları ve bilinen boşlukları da listeler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repos } from '../../db/repos';
import { ApiError } from '../errors';
import { toCoverageEntry, toPublicSource, toRunSummary, toSourceStatus } from '../serializers';

export function registerSourceRoutes(app: FastifyInstance, repos: Repos): void {
  app.get('/api/sources', { schema: { tags: ['sources'], summary: 'Aktif kaynaklar ve sağlık durumu' } }, async () => {
    const coverage = await repos.sources.coverage();
    return {
      sources: coverage.sources.map(toCoverageEntry),
      planned: coverage.planned.map((entry) => ({
        id: entry.id,
        name: entry.name,
        institution: entry.institution,
        candidateUrl: entry.candidateUrl,
        indirectCoverage: entry.indirectCoverage,
        note: entry.note,
      })),
      summary: coverage.summary,
      disclaimer:
        'Liste eksiksiz değildir: bazı kurumlar ilanını yalnızca kendi sayfasında duyurur. Burada etkin tanımlı kaynakları, son tarama sonuçlarını ve henüz planlanan kurumları açıkça gösteririz.',
      generatedAt: repos.clock.now().toISOString(),
    };
  });

  app.get('/api/sources/:key/status', { schema: { tags: ['sources'], summary: 'Tek kaynağın ayrıntılı durumu' } }, async (request) => {
    const params = z.object({ key: z.string().min(2).max(80) }).parse(request.params);
    const source = await repos.sources.getByKey(params.key);
    if (!source) throw ApiError.notFound('Kaynak bulunamadı.');
    const [lastRun, runs, jobCount] = await Promise.all([
      repos.runs.lastRun(source.key),
      repos.runs.list({ sourceKey: source.key }, 20),
      repos.store.count('jobSources', { sourceKey: source.key }),
    ]);
    return {
      source: toPublicSource(source),
      status: toSourceStatus(source, lastRun),
      jobCount,
      lastRun: lastRun ? toRunSummary(lastRun) : null,
      recentRuns: runs.map(toRunSummary),
      inspectedAt: repos.clock.now().toISOString(),
    };
  });
}
