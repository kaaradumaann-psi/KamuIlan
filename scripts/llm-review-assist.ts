/**
 * İnceleme kuyruğu LLM destek raporu (KURU ÇALIŞTIRMA — ana veritabanına YAZMAZ).
 *
 *   npm run llm:review-assist                     → açık 'classification' kayıtlarını değerlendirir
 *   npm run llm:review-assist -- --report r.json  → kayıt bazlı JSON rapor da yazar (yerel dosya)
 *   npm run llm:review-assist -- --limit 50       → en fazla 50 kayıt
 *
 * Ne yapar:
 *  - Yapılandırılmış veritabanındaki AÇIK inceleme kayıtlarını okur (salt okunur).
 *  - Her kaydı üretimdeki ile AYNI kapıdan geçirir (kanıt doğrulama, kota, bütçe).
 *  - Önerilen kararı raporlar: kabul (ilan), kabul (süreç), ret, incelemede kalsın.
 *
 * Ne YAPMAZ:
 *  - Ana veritabanındaki hiçbir kaydı değiştirmez (telemetri/önbellek geçici bir
 *    dosya deposuna yazılır). Kararları uygulamak yöneticiye aittir: panel →
 *    İnceleme sekmesi (kabul/red) veya LLM_CLASSIFIER_ENABLED=1 ile sonraki
 *    taramada kapının aynı içeriği kendisinin çözmesi.
 *
 * Gereklilik: LLM_CLASSIFIER_ENABLED=1 + LLM_BASE_URL/LLM_API_KEY/model (gerçek
 * API çağrısı yapılır; maliyet ve veri koşulları sağlayıcıya tabidir).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getEnv } from '../src/config/env';
import { effectiveDriver, describeDriver, initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { FileStore } from '../src/db/file-store';
import { createLogger } from '../src/lib/logger';
import type { ReviewQueueDoc } from '../src/db/schemas';
import { CLASSIFICATION_VERSION } from '../src/config/app';
import type { ClassificationResult } from '../src/domain';
import { createLlmClassificationGate, llmClassifierConfig } from '../src/ai/classifier';

function optionValue(flag: string): string | null | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

async function main(): Promise<void> {
  const reportOption = optionValue('--report');
  if (reportOption === null) throw new Error('--report için bir dosya yolu verin.');
  const limitOption = optionValue('--limit');
  const limit = limitOption && limitOption !== null ? Math.max(1, Number(limitOption) || 100) : 200;

  const env = getEnv();
  if (!llmClassifierConfig(env)) {
    console.error(
      'LLM kapısı yapılandırılmamış: LLM_CLASSIFIER_ENABLED=1 ve LLM_BASE_URL/LLM_API_KEY/LLM_CLASSIFIER_MODEL (veya LLM_MODEL) gerekli.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Ana veritabanı (salt okunur): ${describeDriver(effectiveDriver(env))}`);
  console.log('MOD: KURU ÇALIŞTIRMA — ana veritabanına hiçbir yazma yapılmaz.\n');

  const store = await initStore(undefined, { ensureIndexes: false });
  createRepos(store);
  const items: ReviewQueueDoc[] = await store.find(
    'reviewQueue',
    { status: 'open', kind: 'classification' },
    { limit, sort: [['createdAt', -1]] },
  );
  console.log(`Açık inceleme kaydı: ${items.length}${items.length >= limit ? ` (limit ${limit})` : ''}`);
  if (items.length === 0) {
    await closeStore();
    return;
  }

  // Kapı telemetrisi/önbelleği GEÇİCİ depoya yazılır; ana depo salt okunur kalır.
  const telemetryDir = mkdtempSync(join(tmpdir(), 'kamuilan-review-assist-'));
  const telemetryStore = new FileStore(telemetryDir);
  await telemetryStore.init();
  const gateRepos = createRepos(telemetryStore);
  const gate = createLlmClassificationGate({
    repos: gateRepos,
    env,
    logger: createLogger('review-assist', { level: 'warn' }),
  });

  const rows: unknown[] = [];
  const summary = { acceptJob: 0, acceptProcess: 0, reject: 0, keepReview: 0 };
  for (const item of items) {
    const payload = item.payload as {
      sourceItemId?: string;
      excerpt?: string;
      employmentType?: string;
      reasons?: string[];
      rules?: string[];
    };
    const base: ClassificationResult = {
      decision: 'review',
      kind: 'job',
      employmentType: 'belirsiz',
      confidence: item.confidence,
      reasons: Array.isArray(payload.reasons) ? payload.reasons : [item.reason],
      rules: Array.isArray(payload.rules) ? payload.rules : [],
      negativeSignals: [],
      version: CLASSIFICATION_VERSION,
    };
    const outcome = await gate.evaluate({
      title: item.title,
      body: typeof payload.excerpt === 'string' ? payload.excerpt : null,
      sourceCategory: null,
      sourceKey: item.sourceKey,
      url: item.url,
      base,
    });
    const next = outcome.classification;
    const recommendation =
      next.decision === 'accept' && next.kind === 'process'
        ? 'accept-process'
        : next.decision === 'accept'
          ? 'accept-job'
          : next.decision === 'reject'
            ? 'reject'
            : 'keep-review';
    summary[
      recommendation === 'accept-job'
        ? 'acceptJob'
        : recommendation === 'accept-process'
          ? 'acceptProcess'
          : recommendation === 'reject'
            ? 'reject'
            : 'keepReview'
    ] += 1;
    rows.push({
      id: item.id,
      title: item.title,
      url: item.url,
      sourceKey: item.sourceKey,
      createdAt: item.createdAt,
      baseReason: item.reason,
      recommendation,
      contentType: next.contentType ?? null,
      llm: outcome.opinion
        ? { verdict: outcome.opinion.verdict, summary: outcome.opinion.summary, reasons: outcome.opinion.reasons }
        : null,
      finalReasons: next.reasons.slice(-2),
    });
    console.log(
      `- [${recommendation}] ${item.title.slice(0, 80)} → ${next.contentType ?? 'uncertain'}${
        outcome.opinion?.summary ? ` · ${outcome.opinion.summary.slice(0, 90)}` : ''
      }`,
    );
  }

  const gateSummary = gate.summary();
  console.log(
    `\nÖZET: kabul(ilan) ${summary.acceptJob} · kabul(süreç) ${summary.acceptProcess} · ret ${summary.reject} · incelemede kalır ${summary.keepReview}`,
  );
  console.log(
    `LLM: ${gateSummary.calls} çağrı · ${gateSummary.cacheHits} önbellek · ${gateSummary.invalid} doğrulanamadı · ${gateSummary.errors} hata · ${gateSummary.blocked} bütçe/metin engeli`,
  );
  console.log(
    '\nBu rapor ÖNERİDİR. Uygulama: panel → İnceleme (kayıt bazlı karar) veya kapı açıkken sonraki tarama.',
  );

  if (reportOption) {
    const reportPath = resolve(reportOption);
    writeFileSync(
      reportPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'dry-run', summary, gate: gateSummary, records: rows }, null, 2),
      'utf8',
    );
    console.log(`Rapor yazıldı: ${reportPath}`);
  }

  await telemetryStore.close();
  rmSync(telemetryDir, { recursive: true, force: true });
  await closeStore();
}

await main();
