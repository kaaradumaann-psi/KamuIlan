import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmBudget, type LlmBudgetPolicy } from '../src/ai/budget';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const MESSAGES = [{ role: 'user', content: 'İlan başvuru metni '.repeat(8) }];

function policy(overrides: Partial<LlmBudgetPolicy> = {}): LlmBudgetPolicy {
  return {
    dailyCallLimit: 10,
    maxCallsPerRun: 10,
    dailyCostLimitUsd: null,
    runCostLimitUsd: null,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
    ...overrides,
  };
}

async function makeRepos() {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-ai-budget-')));
  await store.init();
  return { repos: createRepos(store, fixedClock(NOW)), store };
}

describe('LLM bütçe rezervasyonu', () => {
  it('farklı worker bütçeleri ortak günlük çağrı tavanını atomik paylaşır', async () => {
    const { repos, store } = await makeRepos();
    const workers = Array.from({ length: 24 }, () => new LlmBudget(repos, policy({ dailyCallLimit: 3 })));
    const results = await Promise.all(workers.map((budget) => budget.reserve(MESSAGES, 100)));

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(await repos.rateLimits.peek('llm-global-daily', 24 * 3_600)).toBe(3);
    await store.close();
  });

  it('aynı koşudaki eşzamanlı kayıtlar koşu başı çağrı sınırını aşmaz', async () => {
    const { repos, store } = await makeRepos();
    const budget = new LlmBudget(repos, policy({ maxCallsPerRun: 2 }));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => budget.reserve(MESSAGES, 100)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(budget.summary().callsReserved).toBe(2);
    await store.close();
  });

  it('muhafazakâr USD rezervasyonu ortak günlük tavanı aşmaz', async () => {
    const { repos, store } = await makeRepos();
    const workers = Array.from(
      { length: 12 },
      () =>
        new LlmBudget(
          repos,
          policy({
            dailyCostLimitUsd: 0.0001,
            inputUsdPerMtok: 0.1,
            outputUsdPerMtok: 0.1,
          }),
        ),
    );
    const results = await Promise.all(workers.map((budget) => budget.reserve(MESSAGES, 100)));

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    const reservedMicros = await repos.rateLimits.peek('llm-global-daily-cost-usd-micros', 24 * 3_600);
    expect(reservedMicros).toBeGreaterThan(0);
    expect(reservedMicros).toBeLessThanOrEqual(100);
    await store.close();
  });

  it('USD tavanı varken fiyat varsayımı yoksa sağlayıcı bütçesi kapalı kalır', async () => {
    const { repos, store } = await makeRepos();
    const budget = new LlmBudget(repos, policy({ dailyCostLimitUsd: 1 }));

    const result = await budget.reserve(MESSAGES, 100);

    expect(result).toMatchObject({ allowed: false, reason: 'pricing-unavailable' });
    expect(await repos.rateLimits.peek('llm-global-daily', 24 * 3_600)).toBe(0);
    await store.close();
  });

  it('bütçe deposu hatasında sağlayıcıya gitmek yerine engeller', async () => {
    const failingRepos = {
      rateLimits: {
        reserve: async () => {
          throw new Error('postgres://private-user:private-password@secret-host/database');
        },
      },
    } as unknown as ConstructorParameters<typeof LlmBudget>[0];
    const budget = new LlmBudget(failingRepos, policy());

    const result = await budget.reserve(MESSAGES, 100);

    expect(result).toMatchObject({ allowed: false, reason: 'budget-storage-error' });
    expect(JSON.stringify(result)).not.toContain('private-password');
  });
});
