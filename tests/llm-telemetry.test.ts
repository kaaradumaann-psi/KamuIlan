/**
 * LLM ölçüm özeti (telemetri → panel/eval) ve maliyet tahmini davranışı.
 *
 * Kanıtlananlar:
 *  - Gecikme yüzdelikleri yalnızca GERÇEK API çağrılarından hesaplanır (önbellek
 *    isabetleri 0 ms ile ortalamayı düşürmez); hata yolunda da gecikme ölçülür.
 *  - Sağlayıcı fiyatı verilmemişse maliyet RaporLANMAZ (uydurma $ yok); verilmişse
 *    "TAHMİN" etiketi ve doğrulanmamışlık notu ile gelir.
 *  - Token kullanımı bildirmeyen sağlayıcıarda `reportedShare` bunu açıkça gösterir.
 *  - Sunucu üretimiyle arayüz sözleşmesi TIPTENSEL olarak aynı kalır (API yanıtı
 *    elle çift tanımlıdır; bu test sürüşmeyi CI'da kırar).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import type { LlmAnalysisDoc } from '../src/db/schemas';
import { createLogger } from '../src/lib/logger';
import { getEnv, resetEnvCache } from '../src/config/env';
import {
  computeLlmTelemetry,
  estimateLlmCostUsd,
  llmCostAssumptions,
  llmOverviewStats,
} from '../src/ai/classifier';
import type { AdminOverview } from '../src/types';

const LOGGER = createLogger('llm-telemetry-test', { level: 'silent' });

function row(overrides: Partial<LlmAnalysisDoc>): LlmAnalysisDoc {
  return {
    id: `lma-${Math.random().toString(36).slice(2, 10)}`,
    cacheKey: 'cache-key-000000000000',
    contentKey: 'content-key-00000000000',
    sourceKey: 'test-kaynak',
    url: 'https://ornek.test/ilan/1',
    model: 'test-model',
    promptVersion: 'kamuilan-sinif-v1',
    status: 'ok',
    cacheHit: false,
    verdict: 'ilan',
    contentType: 'personnel_recruitment',
    confidence: 0.7,
    employmentType: 'kadrolu',
    summary: null,
    evidence: null,
    latencyMs: 100,
    promptTokens: 1_000,
    completionTokens: 200,
    error: null,
    createdAt: '2026-10-15T09:00:00.000Z',
    ...overrides,
  } as LlmAnalysisDoc;
}

describe('computeLlmTelemetry', () => {
  const env = getEnv({ NODE_ENV: 'test' });

  it('yüzdeleri yalnızca API çağrılarından hesaplar; önbellek isabeti gecikmeyi şişirmez', () => {
    const stats = computeLlmTelemetry(
      [
        row({ latencyMs: 100 }),
        row({ latencyMs: 900 }),
        row({ latencyMs: 1_000 }),
        row({ latencyMs: 0, cacheHit: true }),
        row({ latencyMs: 0, cacheHit: true }),
      ],
      env,
    );
    expect(stats.analyses).toBe(5);
    expect(stats.apiCalls).toBe(3);
    expect(stats.cacheHits).toBe(2);
    expect(stats.cacheHitRate).toBeCloseTo(0.4);
    expect(stats.latency).toMatchObject({ count: 3, avgMs: 667, p50Ms: 900, p95Ms: 1_000, maxMs: 1_000 });
  });

  it('hata ve zaman aşımı çağrı başına hata oranına girer; boş kümede null kalır', () => {
    const stats = computeLlmTelemetry(
      [row({ status: 'ok' }), row({ status: 'error', latencyMs: 500 }), row({ status: 'timeout', latencyMs: 30_000 })],
      env,
    );
    expect(stats.error).toBe(1);
    expect(stats.timeout).toBe(1);
    expect(stats.errorRate).toBeCloseTo(2 / 3);
    // Zaman aşımının gecikmesi KAYDEDİLİR (0 değil): "hata bedava" değildir.
    expect(stats.latency.maxMs).toBe(30_000);
    expect(computeLlmTelemetry([], env).errorRate).toBeNull();
  });

  it('token kullanımı olmayan satırlar maliyet güvenini düşürür (reportedShare)', () => {
    const stats = computeLlmTelemetry(
      [row({ promptTokens: null, completionTokens: null }), row({ promptTokens: 500, completionTokens: 50 })],
      env,
    );
    expect(stats.tokens).toEqual({ prompt: 500, completion: 50, reportedShare: 0.5 });
  });

  it('sinceIso penceresi dışındaki kayıtları saymaz', () => {
    const stats = computeLlmTelemetry(
      [row({ createdAt: '2026-10-15T09:00:00.000Z' }), row({ createdAt: '2026-10-13T09:00:00.000Z' })],
      env,
      { sinceIso: '2026-10-15T00:00:00.000Z' },
    );
    expect(stats.analyses).toBe(1);
  });
});

describe('maliyet tahmini', () => {
  it('fiyatlandırma yapılandırılmamışsa rakam ÜRETİLMEZ ve neden açıkça yazılır', () => {
    const env = getEnv({ NODE_ENV: 'test', LLM_COST_USD_PER_MTOK_INPUT: '', LLM_COST_USD_PER_MTOK_OUTPUT: '' });
    expect(llmCostAssumptions(env).configured).toBe(false);
    const cost = estimateLlmCostUsd({ prompt: 1_000_000, completion: 1_000_000 }, llmCostAssumptions(env));
    expect(cost.usd).toBeNull();
    expect(cost.note).toMatch(/doğrulanmadı/);
  });

  it('yapılandırılan fiyat TAHMİN etiketiyle kullanılır (kesin fiyat iddiası yoktur)', () => {
    const env = getEnv({
      NODE_ENV: 'test',
      LLM_COST_USD_PER_MTOK_INPUT: '0.6',
      LLM_COST_USD_PER_MTOK_OUTPUT: '2.4',
    });
    const assumptions = llmCostAssumptions(env);
    expect(assumptions).toEqual({ inputUsdPerMtok: 0.6, outputUsdPerMtok: 2.4, configured: true });
    const cost = estimateLlmCostUsd({ prompt: 500_000, completion: 250_000 }, assumptions);
    expect(cost.usd).toBeCloseTo(0.3 + 0.6);
    expect(cost.note).toMatch(/TAHMİN/);
    expect(cost.note).toMatch(/canlı doğrulanmadı/);
  });

  it('geçersiz fiyat değeri sessizce yok sayılmaz; ortam doğrulaması patlar', () => {
    resetEnvCache();
    expect(() => getEnv({ NODE_ENV: 'test', LLM_COST_USD_PER_MTOK_INPUT: 'bedava' })).toThrow(/LLM_COST_USD_PER_MTOK/);
    expect(() => getEnv({ NODE_ENV: 'test', LLM_COST_USD_PER_MTOK_INPUT: '-1' })).toThrow(/LLM_COST_USD_PER_MTOK/);
    resetEnvCache();
  });
});

describe('yönetici paneli özeti ve arayüz sözleşmesi', () => {
  let dir: string;
  let store: FileStore;
  let repos: Repos;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kamuilan-llm-telemetry-'));
    store = new FileStore(dir);
    await store.init();
    repos = createRepos(store);
    await store.insertOne('llmAnalyses', row({ latencyMs: 420, promptTokens: 1_200, completionTokens: 180 }));
    await store.insertOne('llmAnalyses', row({ status: 'invalid', latencyMs: 210, promptTokens: null, completionTokens: null }));
  });

  afterAll(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('llmOverviewStats ölçüm alanlarını doldurur ve LOGGER kullanımı sessizdir', async () => {
    const env = getEnv({ NODE_ENV: 'test', LLM_CLASSIFIER_ENABLED: '0' });
    expect(LOGGER).toBeDefined();
    const stats = await llmOverviewStats(repos, env, new Date('2026-10-15T09:30:00+03:00'));
    expect(stats.enabled).toBe(false);
    expect(stats.totals).toMatchObject({ analyses: 2, ok: 1, invalid: 1 });
    expect(stats.last24h.latency.maxMs).toBe(420);
    expect(stats.last24h.cost.usd).toBeNull();
  });

  it('sunucu üretimi ile arayüz tipi uyuşuyor kalmalıdır (sözleşme sürüşmesi derlemeyi kırar)', () => {
    type ServerLast24h = Awaited<ReturnType<typeof llmOverviewStats>>['last24h'];
    type ClientLast24h = AdminOverview['llm']['last24h'];
    const assignable: ServerLast24h extends ClientLast24h ? true : false = true;
    expect(assignable).toBe(true);
  });
});
