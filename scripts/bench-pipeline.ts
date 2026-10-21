/**
 * Tarama hattı aşama süreleri (p50/p95): PDF metni, sınıflandırma, alan çıkarımı,
 * tekilleştirme kararı ve ilan API'si (dosya sürücüsü, süreç içi).
 *
 *   npx tsx scripts/bench-pipeline.ts <pdf-dizini> [--jobs=2000]
 *
 * Ağa çıkmaz; yalnızca verilen yerel PDF'leri okur. Ölçüm ortamı ve veri hacmi
 * çıktının ilk satırlarında yazar: bu bir YEREL ölçümdür, staging/üretim değildir.
 * Postgres liste performansı ayrıca: scripts/bench-postgres-list.ts.
 */
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractPdfText } from '../src/extraction/pdf';
import { classify } from '../src/classification/engine';
import { extract } from '../src/extraction/engine';
import { decideDedupe, type DedupeCandidateJob } from '../src/ingest/dedupe';
import { normalizeTr } from '../src/domain/text';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { systemClock } from '../src/lib/clock';
import { buildApp } from '../src/server/app';
import type { JobDoc } from '../src/db/schemas';

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `p50 ${at(0.5).toFixed(1)} ms · p95 ${at(0.95).toFixed(1)} ms · n=${sorted.length}`;
}

async function time<T>(samples: number[], run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  const result = await run();
  samples.push(performance.now() - started);
  return result;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error('Kullanım: npx tsx scripts/bench-pipeline.ts <pdf-dizini> [--jobs=2000]');
  const jobCount = Number(/--jobs=(\d+)/.exec(process.argv.join(' '))?.[1] ?? 2000);
  const files = readdirSync(dir).filter((name) => name.endsWith('.pdf'));
  console.log(`ortam: yerel, Node ${process.version}, ${cpus()[0]?.model ?? 'cpu'} — staging/üretim DEĞİL`);
  console.log(`veri: ${files.length} PDF (${dir}), ${jobCount} sentetik ilan (API ölçümü)`);

  const pdfTimes: number[] = [];
  const classifyTimes: number[] = [];
  const extractTimes: number[] = [];
  const dedupeTimes: number[] = [];
  const texts: string[] = [];
  for (const file of files) {
    const pdf = await time(pdfTimes, () => extractPdfText(new Uint8Array(readFileSync(join(dir, file)))));
    texts.push(pdf.text);
  }
  const candidates: DedupeCandidateJob[] = Array.from({ length: 400 }, (_, index) => ({
    id: `job_${index}`,
    title: `Kurum ${index} personel alım ilanı`,
    titleNormalized: normalizeTr(`Kurum ${index} personel alım ilanı`),
    institution: `Kurum ${index % 50}`,
    institutionNormalized: normalizeTr(`Kurum ${index % 50}`),
    normalizedUrl: `https://ornek.test/${index}`,
    originalRefNo: null,
    applicationEndDate: '2026-11-30',
    textExcerpt: 'Kurumumuza sözleşmeli personel alınacaktır. '.repeat(20),
    sourceKeys: ['resmigazete'],
  }));
  for (const text of texts) {
    const title = text.split('\n').slice(0, 2).join(' ');
    for (let round = 0; round < 5; round += 1) {
      await time(classifyTimes, () => classify({ title, body: text }));
      await time(extractTimes, () =>
        extract({ title, body: text, listing: {}, links: [], attachments: [], bodySource: 'document' } as never),
      );
      await time(dedupeTimes, () =>
        decideDedupe(
          {
            sourceKey: 'bench',
            sourceItemId: 'x',
            title,
            institution: title.split(':')[0] ?? null,
            normalizedUrl: 'https://ornek.test/yeni',
            referenceNo: null,
            applicationEndDate: null,
            textExcerpt: text.slice(0, 2_500),
          },
          candidates,
        ),
      );
    }
  }
  console.log(`PDF metni        : ${stats(pdfTimes)}`);
  console.log(`sınıflandırma    : ${stats(classifyTimes)}`);
  console.log(`alan çıkarımı    : ${stats(extractTimes)}`);
  console.log(`tekilleştirme    : ${stats(dedupeTimes)} (400 aday)`);

  // API: dosya sürücüsü + süreç içi Fastify (ağ yok).
  const dataDir = mkdtempSync(join(tmpdir(), 'kamuilan-bench-'));
  process.env.DATA_DIR = dataDir;
  const store = new FileStore(dataDir);
  await store.init();
  const repos = createRepos(store, systemClock);
  const now = new Date().toISOString();
  const jobs = Array.from({ length: jobCount }, (_, index) => ({
    id: `job_bench_${String(index).padStart(6, '0')}`,
    title: `Kurum ${index % 300} Sözleşmeli Personel Alım İlanı`,
    titleNormalized: `kurum ${index % 300} sozlesmeli personel alim ilani`,
    institution: `Kurum ${index % 300}`,
    institutionNormalized: `kurum ${index % 300}`,
    unit: null,
    employmentType: 'sozlesmeli',
    status: index % 3 === 0 ? 'closed' : 'active',
    statusReason: '',
    city: ['Ankara', 'İstanbul', 'Bursa'][index % 3] ?? null,
    cityNormalized: ['ankara', 'istanbul', 'bursa'][index % 3] ?? '',
    district: null,
    quota: 1 + (index % 20),
    applicationStartAt: null,
    applicationEndAt: null,
    applicationEndDate: `2026-${String(10 + (index % 3)).padStart(2, '0')}-15`,
    publishedAt: '2026-10-01',
    detailUrl: `https://ornek.test/ilan/${index}`,
    normalizedUrl: `https://ornek.test/ilan/${index}`,
    applicationUrl: null,
    applicationMethod: null,
    attachments: [],
    requirements: { educationLevels: ['lisans'], departments: [], kpssScoreTypes: ['P3'], kpssMinScore: null, kpssYear: null, qualificationCodes: [], minAge: null, maxAge: null, certificates: [], minExperienceYears: null, foreignLanguages: [], specialConditions: [] },
    titles: [],
    openings: [],
    textExcerpt: 'Kurumumuza sözleşmeli personel alınacaktır.',
    textNormalized: 'kurumumuza sozlesmeli personel alinacaktir',
    originalRefNo: null,
    sourceKeys: ['resmigazete'],
    primarySourceKey: 'resmigazete',
    classification: { decision: 'accept', kind: 'job', employmentType: 'sozlesmeli', confidence: 0.9, reasons: [], rules: [], negativeSignals: [], version: 'bench', classifiedAt: now },
    extractionConfidence: 0.6,
    fieldSources: {},
    evidence: {},
    uncertainties: [],
    provenance: 'scraped',
    lastVerifiedAt: now,
    contentHash: 'a'.repeat(64),
    dedupeKey: `bench-${index}`,
    version: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: new Date(Date.parse('2026-10-01T00:00:00Z') + index * 60_000).toISOString(),
    updatedAt: now,
  })) as unknown as JobDoc[];
  await store.insertMany('jobs', jobs);
  const { createLogger } = await import('../src/lib/logger');
  const app = await buildApp({ repos, disableRateLimit: true, logger: createLogger('bench', { level: 'silent' }) });
  const endpoints: [string, string][] = [
    ['ilan listesi (sayfa 1)', '/api/jobs?page=1'],
    ['filtreli arama', '/api/jobs?city=Ankara&status=active&q=personel'],
    ['ilan detayı', `/api/jobs/${jobs[10]?.id ?? ''}`],
    ['ana sayfa özeti', '/api/jobs/stats'],
  ];
  for (const [label, url] of endpoints) {
    const samples: number[] = [];
    for (let run = 0; run < 15; run += 1) {
      const response = await time(samples, () => app.inject({ method: 'GET', url }));
      if (response.statusCode !== 200) throw new Error(`${url} → ${response.statusCode}`);
    }
    console.log(`API ${label.padEnd(22)}: ${stats(samples)} (dosya sürücüsü, ${jobCount} ilan)`);
  }
  await app.close();
  await store.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
