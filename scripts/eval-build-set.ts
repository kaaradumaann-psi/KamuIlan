/**
 * Gerçek veri etiketleme sayfası: `npm run eval:build-set`
 *
 * Ne yapar (SALT OKUNUR — veritabanına yazmaz):
 *   1. Yapılandırılmış depodaki ilan kayıtlarını okur (dosya / Supabase Postgres).
 *   2. Etiketleme sayfası üretir: her kayıt için resmî bağlantı, saklanan kısa alıntı,
 *      deterministik motorun ve LLM'nin TAHMİNİ (`machineSuggestion`, altın etiket değil)
 *      ve boş `expectedContentType`.
 *   3. İnsan etiketleri doldurur, sonra aynı betikle içe aktarılır.
 *
 * Komutlar:
 *   npm run eval:build-set                                  # sayfa üret → data/eval-worksheet.json
 *   npm run eval:build-set -- --filter review               # yalnızca belirsiz kayıtlar
 *   npm run eval:build-set -- --source resmigazete-cestili-ilanlar --limit 40
 *   npm run eval:build-set -- --import data/eval-worksheet.json            # doğrula + raporu yaz
 *   npm run eval:build-set -- --import data/eval-worksheet.json --apply    # kümeye birleştir
 *
 * Neden `--apply` ayrı: insan doğrulaması olmayan hiçbir kayıt kümeye giremez; betik
 * bunu red listesiyle gösterir. Küme dosyasına yazma YALNIZCA `--apply` ile olur.
 *
 * Kapsam hedefi 150–200 gerçek, insan doğrulamalı kayıttır (sınıf bazlı hedefler:
 * `src/classification/eval-set.ts` COVERAGE_TARGETS). Bu sayı üretilmiş gibi
 * gösterilmez; rapor her seferinde "şu an kaç gerçek kayıt var"ı yazar.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { closeStore, describeDriver, effectiveDriver, initStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import type { JobDoc, JobSourceDoc } from '../src/db/schemas';
import {
  COVERAGE_TARGET_TOTAL,
  buildLabelingWorksheet,
  importLabeledWorksheet,
  mergeLabeledSets,
  type LabeledSetRecord,
  type WorksheetJobRecord,
} from '../src/classification/eval-set';

function optionValue(flag: string): string | null | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function writeOut(path: string, contents: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), contents, 'utf8');
}

async function buildWorksheet(): Promise<void> {
  const filterOption = optionValue('--filter');
  const sourceOption = optionValue('--source');
  const limitRaw = optionValue('--limit');
  if (filterOption === null || limitRaw === null) {
    throw new Error('--filter ve --limit için bir değer verin (review|accepted|rejected|all, sayı).');
  }
  const filter = filterOption ?? 'all';
  const limit = limitRaw === null ? 60 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit 1–500 arasında olmalıdır.');
  const outPath = optionValue('--out') ?? 'data/eval-worksheet.json';

  const env = (await import('../src/config/env')).getEnv();
  const driver = effectiveDriver(env);
  const store = await initStore();
  const repos = createRepos(store);
  console.log(`Veritabanı: ${describeDriver(driver)} · MOD: KURU (salt okunur, hiçbir şey yazılmıyor)`);

  const jobs = (await repos.store.find('jobs', {}, { limit: 5_000, sort: [['lastSeenAt', -1]] })) as JobDoc[];
  const filtered = jobs.filter((job) => {
    if (sourceOption && job.primarySourceKey !== sourceOption) return false;
    if (filter === 'review') return job.classification.decision === 'review';
    if (filter === 'accepted') return job.classification.decision === 'accept';
    if (filter === 'rejected') return job.classification.decision === 'reject';
    if (filter === 'all') return true;
    throw new Error(`Bilinmeyen --filter değeri: ${filter}`);
  });
  // Sınıf/kip kırılımını korumak için katmanlı örnek: aynı içerik türünün
  // 20 kaydıyla küme doldurup "gerçek kapsam" izlenimi verme.
  const buckets = new Map<string, JobDoc[]>();
  for (const job of filtered) {
    const key = `${job.classification.contentType ?? 'uncertain'}|${job.classification.kind}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(job);
    buckets.set(key, bucket);
  }
  const picked: JobDoc[] = [];
  const queues = [...buckets.values()];
  while (picked.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < limit) picked.push(next);
    }
  }

  const sourceLinks = await repos.store.find('jobSources', {}, { limit: 10_000 });
  const linkByJobId = new Map<string, JobSourceDoc>();
  for (const link of sourceLinks as JobSourceDoc[]) {
    if (!linkByJobId.has(link.jobId)) linkByJobId.set(link.jobId, link);
  }
  const records: WorksheetJobRecord[] = picked.map((job) => {
    const link = linkByJobId.get(job.id);
    return {
      id: job.id,
      title: job.title,
      institution: job.institution,
      detailUrl: job.detailUrl,
      applicationUrl: job.applicationUrl,
      city: job.city,
      quota: job.quota,
      publishedAt: job.publishedAt,
      applicationStartAt: job.applicationStartAt,
      applicationEndAt: job.applicationEndAt,
      textExcerpt: job.textExcerpt,
      evidence: job.evidence,
      provenance: job.provenance,
      primarySourceKey: job.primarySourceKey,
      sourceCategory: link?.sourceCategory ?? null,
      capturedTextStatus: link?.capturedTextStatus ?? 'unavailable',
      classification: {
        decision: job.classification.decision,
        kind: job.classification.kind,
        contentType: job.classification.contentType,
        confidence: job.classification.confidence,
        reasons: job.classification.reasons,
        ...(job.classification.llm
          ? {
              llm: {
                model: job.classification.llm.model,
                verdict: job.classification.llm.verdict,
                evidenceVerified: job.classification.llm.evidenceVerified,
                cacheHit: job.classification.llm.cacheHit,
              },
            }
          : {}),
      },
      uncertainties: job.uncertainties,
    };
  });

  const worksheet = buildLabelingWorksheet(records, repos.clock.now());
  writeOut(outPath, JSON.stringify(worksheet, null, 2));
  const real = worksheet.records.filter((record) => record.origin === 'real').length;
  console.log(
    `Etiketleme sayfası: ${resolve(outPath)}\n` +
      `  kayıt ${worksheet.records.length} · gerçek kaynaklı ${real} · örnek/demo ${worksheet.records.length - real}\n` +
      `  sınıf/küp sayısı: ${buckets.size} · katmanlı seçim yapıldı (her küpten sırayla)\n` +
      `  hedef: ${COVERAGE_TARGET_TOTAL} insan doğrulamalı gerçek kayıt (sınıf bazlı hedefler eval-set.ts içinde)`,
  );
  console.log(
    '\nSonraki adım: kayıtları RESMÎ kaynak bağlantılarından okuyup expectedContentType/' +
      'expectedFields + labeledBy/labeledAt doldurun, sonra:\n' +
      `  npm run eval:build-set -- --import ${outPath}            # doğrula (yazmaz)\n` +
      `  npm run eval:build-set -- --import ${outPath} --apply   # kümeye birleştir`,
  );
  if (real === 0) {
    console.log('\nUYARI: depoda gerçek kaynaklı kayıt yok. Canlı tarama yapılmadan bu sayfa doldurulamaz.');
  }
  await closeStore();
}

function importWorksheet(): void {
  const importPath = optionValue('--import');
  if (!importPath) throw new Error('--import için dosya yolu verin.');
  const absolute = resolve(importPath);
  if (!existsSync(absolute)) throw new Error(`Dosya bulunamadı: ${absolute}`);
  const worksheet = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  const { records, report } = importLabeledWorksheet(worksheet);
  const setPath = optionValue('--set') ?? 'tests/fixtures/eval/labeled-set.json';
  const apply = process.argv.includes('--apply');

  console.log(
    `İçe aktarma özeti\n  kabul: ${report.accepted.length} · ret: ${report.rejected.length}\n` +
      `  gerçek: ${report.realCount} · sentetik/başlık: ${report.syntheticCount}\n` +
      `  beklenen alanlı (alan doğruluğu ölçülebilir): ${report.withExpectedFields}`,
  );
  if (report.coverage.length > 0) {
    console.log(`  kapsam: ${report.coverage.map((entry) => `${entry.contentType}=${entry.count}`).join(', ')}`);
  }
  if (report.gaps.length > 0) {
    console.log(`  EKSİK KATEGORİLER (hedefin altında): ${report.gaps.join(', ')}`);
  }
  for (const rejection of report.rejected.slice(0, 20)) {
    console.log(`  RED ${rejection.id}: ${rejection.reason}`);
  }
  if (report.rejected.length > 20) console.log(`  …ve ${report.rejected.length - 20} kayıt daha reddedildi.`);
  if (records.length === 0) {
    console.log('\nHiçbir kayıt kabul edilmedi; küme dosyasına dokunulmadı.');
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log('\nKURU ÇALIŞTIRMA: küme dosyası yazılmadı. Yazmak için --apply ekleyin.');
    return;
  }
  const absoluteSet = resolve(setPath);
  const existing = existsSync(absoluteSet)
    ? ({ records: (JSON.parse(readFileSync(absoluteSet, 'utf8')) as { records: LabeledSetRecord[] }).records } as const)
    : null;
  const merged = mergeLabeledSets(existing, records, new Date());
  writeOut(absoluteSet, JSON.stringify(merged.document, null, 2) + '\n');
  console.log(
    `\nKüme güncellendi: ${absoluteSet}\n  yeni ${merged.added} · güncellenen ${merged.updated} · ` +
      `toplam ${merged.document.records.length} kayıt`,
  );
  console.log('Doğrulama: npm run eval:classification (gerçek/sentetik sayıları ayrı raporlanır).');
}

if (process.argv.includes('--import')) importWorksheet();
else await buildWorksheet();
