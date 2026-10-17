/**
 * İnceleme kuyruğu LLM destek raporu (KURU ÇALIŞTIRMA — ana veritabanına YAZMAZ).
 *
 *   npm run llm:review-assist -- --live --allow-provider-data --max-records 20 --max-calls 5 --max-output-tokens 128 --max-cost-usd 0.02
 *   npm run llm:review-assist -- --live --allow-provider-data --max-records 20 --max-calls 5 --max-output-tokens 128 --max-cost-usd 0.02 --report r.json
 *
 * Live provider use is opt-in and requires bounded records, attempts, output tokens,
 * an operator USD ceiling, and explicit confirmation that excerpts may be shared.
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
import { createHash } from 'node:crypto';
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
import { computeLlmTelemetry, createLlmClassificationGate, llmClassifierConfig } from '../src/ai/classifier';

function optionValue(flag: string): string | null | undefined {
  const indexes = process.argv.flatMap((argument, index) => (argument === flag ? [index] : []));
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1) return null;
  const value = process.argv[indexes[0]! + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function boundedIntegerOption(flag: string, min: number, max: number): number | null {
  const raw = optionValue(flag);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function boundedUsdOption(flag: string): number | null {
  const raw = optionValue(flag);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 10 ? value : null;
}

function scrubProviderText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
    .replace(/\b[1-9]\d{10}\b/g, '[TCKN-LIKE REDACTED]')
    .replace(/\b(?:\+90|0090|0)?[\s().-]*\(?5\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/g, '[PHONE REDACTED]')
    .replace(/([?&](?:token|access_token|api[_-]?key|apikey|session(?:id)?|sid|csrf|nonce|auth|password|secret)=)[^&\s"'<>#]+/gi, '$1[REDACTED]')
    .replace(/(authorization|x-goog-api-key|api[_-]?key|apikey|access_token|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    // A query may contain a search term or personal data even when its key name
    // does not look sensitive; the persisted/report URL is intentionally origin+path only.
    url.search = '';
    return url.toString();
  } catch {
    return '[INVALID-URL]';
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function main(): Promise<void> {
  const reportOption = optionValue('--report');
  if (reportOption === null) throw new Error('--report için bir dosya yolu verin.');
  const maxRecords = boundedIntegerOption('--max-records', 1, 50);
  const maxCalls = boundedIntegerOption('--max-calls', 1, 20);
  const maxOutputTokens = boundedIntegerOption('--max-output-tokens', 1, 900);
  const maxCostUsd = boundedUsdOption('--max-cost-usd');
  const live = process.argv.includes('--live');
  if (
    !live ||
    !process.argv.includes('--allow-provider-data') ||
    maxRecords === null ||
    maxCalls === null ||
    maxOutputTokens === null ||
    maxCostUsd === null
  ) {
    console.error('LLM review assist için --live --allow-provider-data --max-records 1..50 --max-calls 1..20 --max-output-tokens 1..900 --max-cost-usd pozitif ve en fazla 10 zorunludur. Provider/DB çağrısı yapılmadı.');
    process.exitCode = 2;
    return;
  }

  const env = getEnv();
  if (env.NODE_ENV === 'test') {
    console.error('NODE_ENV=test iken LLM review assist reddedildi.');
    process.exitCode = 2;
    return;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.error('TLS doğrulaması kapalı; LLM review assist reddedildi.');
    process.exitCode = 2;
    return;
  }
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
    { limit: maxRecords, sort: [['createdAt', -1]] },
  );
  console.log(`Açık inceleme kaydı: ${items.length}${items.length >= maxRecords ? ` (limit ${maxRecords})` : ''}`);
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
    maxCallsPerRun: maxCalls,
    maxOutputTokens,
    runCostLimitUsd: maxCostUsd,
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
      reasons: (Array.isArray(payload.reasons) ? payload.reasons : [item.reason]).map(scrubProviderText),
      rules: (Array.isArray(payload.rules) ? payload.rules : []).map(scrubProviderText),
      negativeSignals: [],
      version: CLASSIFICATION_VERSION,
    };
    const safeTitle = scrubProviderText(item.title);
    const safeExcerpt = typeof payload.excerpt === 'string' ? scrubProviderText(payload.excerpt) : null;
    const outcome = await gate.evaluate({
      title: safeTitle,
      body: safeExcerpt,
      sourceCategory: null,
      sourceKey: item.sourceKey,
      url: safeUrl(item.url),
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
      idHash: hashText(item.id),
      titleHash: hashText(item.title),
      urlHash: hashText(item.url),
      sourceKey: item.sourceKey,
      createdAt: item.createdAt,
      baseReasonHash: hashText(item.reason),
      recommendation,
      contentType: next.contentType ?? null,
      llm: outcome.opinion
        ? {
            verdict: outcome.opinion.verdict,
            summaryHash: hashText(scrubProviderText(outcome.opinion.summary ?? '')),
            reasonHashes: outcome.opinion.reasons.map((reason) => hashText(scrubProviderText(reason))),
          }
        : null,
      finalReasonHashes: next.reasons.slice(-2).map((reason) => hashText(scrubProviderText(reason))),
    });
    console.log(
      `- [${recommendation}] record#${hashText(item.id)} · title#${hashText(item.title)} → ${next.contentType ?? 'uncertain'}`,
    );
  }

  const gateSummary = gate.summary();
  const telemetryRows = await gateRepos.store.find('llmAnalyses', {}, { limit: 5_000, sort: [['createdAt', -1]] });
  const telemetry = computeLlmTelemetry(telemetryRows, env);
  console.log(
    `\nÖZET: kabul(ilan) ${summary.acceptJob} · kabul(süreç) ${summary.acceptProcess} · ret ${summary.reject} · incelemede kalır ${summary.keepReview}`,
  );
  console.log(
    `LLM: ${gateSummary.calls} çağrı · ${gateSummary.cacheHits} önbellek · ${gateSummary.invalid} doğrulanamadı · ${gateSummary.errors} hata · ${gateSummary.blocked} bütçe/metin engeli`,
  );
  console.log(
    `Operatör tavanı: ${maxRecords} kayıt · ${maxCalls} provider çağrısı · ${maxOutputTokens} çıktı tokenı · $${maxCostUsd.toFixed(6)}; ` +
      `koşum tahmini maliyet: ${telemetry.cost.usd === null ? 'NOT REPORTED' : `~$${telemetry.cost.usd.toFixed(6)}`} ` +
      `(sağlayıcı faturası değildir).`,
  );
  console.log(
    '\nBu rapor ÖNERİDİR. Uygulama: panel → İnceleme (kayıt bazlı karar) veya kapı açıkken sonraki tarama.',
  );

  if (reportOption) {
    const reportPath = resolve(reportOption);
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: 'dry-run',
          operatorBudget: { maxRecords, maxCalls, maxOutputTokens, maxEstimatedCostUsd: maxCostUsd },
          mainDatabase: 'READ ONLY; schema creation disabled',
          summary,
          gate: gateSummary,
          llmTelemetry: telemetry,
          records: rows,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    console.log(`Rapor yazıldı: ${reportPath}`);
  }

  await telemetryStore.close();
  rmSync(telemetryDir, { recursive: true, force: true });
  await closeStore();
}

await main();
