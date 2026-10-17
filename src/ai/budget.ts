import type { Repos } from '../db/repos';
import type { Env } from '../config/env';

export const LLM_BUDGET_WINDOW_SECONDS = 24 * 3_600;
const USD_MICRO_UNITS = 1_000_000;

export type LlmBudgetBlockReason =
  | 'run-call-limit'
  | 'run-cost-limit'
  | 'daily-call-limit'
  | 'daily-cost-limit'
  | 'pricing-unavailable'
  | 'budget-storage-error';

export interface LlmBudgetPolicy {
  dailyCallLimit: number;
  maxCallsPerRun: number;
  dailyCostLimitUsd: number | null;
  runCostLimitUsd: number | null;
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
  /** Ek sayaç (ör. sınıflandırıcı), global sayaçla aynı atomik üst sınırı paylaşır. */
  additionalDailyCallBucket?: string;
}

export interface LlmBudgetReservation {
  allowed: boolean;
  reason?: LlmBudgetBlockReason;
  estimatedCostUsd: number | null;
  callsReserved: number;
  runEstimatedCostUsd: number | null;
}

function asMicroUsd(usd: number): number {
  return Math.ceil(usd * USD_MICRO_UNITS);
}

function toMicroUsdLimit(usd: number): number {
  return Math.floor(usd * USD_MICRO_UNITS);
}

/**
 * İstek maliyetinin kasıtlı olarak muhafazakâr üst tahmini.
 * UTF-8 JSON bayt sayısı prompt tokenları için üst vekil olarak alınır; 256 token
 * sabit ek pay istek/zarf yükünü kapsar, completion ise API'ye gönderilecek
 * maxOutputTokens ile sınırlandırılır. Fiyat operatör varsayımıdır, sağlayıcı
 * faturası değildir; bu nedenle UI/raporlar bu değeri "tahmin" diye adlandırmalı.
 */
export function estimateLlmRequestCostUsd(
  messages: readonly { role: string; content: string }[],
  maxOutputTokens: number,
  rates: Pick<LlmBudgetPolicy, 'inputUsdPerMtok' | 'outputUsdPerMtok'>,
): number | null {
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    rates.inputUsdPerMtok === null ||
    rates.outputUsdPerMtok === null ||
    rates.inputUsdPerMtok <= 0 ||
    rates.outputUsdPerMtok <= 0
  ) {
    return null;
  }
  const inputTokenUpperBound = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 256;
  return (
    rates.inputUsdPerMtok * inputTokenUpperBound + rates.outputUsdPerMtok * maxOutputTokens
  ) / 1_000_000;
}

/**
 * Bir process/worker çalışması için eşzamanlı güvenli bütçe ayırıcısı.
 * Günlük çağrı ve USD-mikro maliyet kovaları bütün worker'lar arasında depoda
 * atomik rezerve edilir. Depo/fiyat hatasında provider çağrısı yapılmaz.
 */
export class LlmBudget {
  private callsReserved = 0;
  private runCostReservedMicros = 0;

  constructor(
    private readonly repos: Pick<Repos, 'rateLimits'>,
    private readonly policy: LlmBudgetPolicy,
  ) {
    if (!Number.isSafeInteger(policy.dailyCallLimit) || policy.dailyCallLimit < 1) {
      throw new Error('LLM günlük çağrı sınırı pozitif tamsayı olmalıdır.');
    }
    if (!Number.isSafeInteger(policy.maxCallsPerRun) || policy.maxCallsPerRun < 0) {
      throw new Error('LLM koşu çağrı sınırı negatif olmayan tamsayı olmalıdır.');
    }
    for (const [name, value] of [
      ['LLM_DAILY_COST_LIMIT_USD', policy.dailyCostLimitUsd],
      ['LLM_RUN_COST_LIMIT_USD', policy.runCostLimitUsd],
    ] as const) {
      if (value !== null && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`${name} pozitif, sonlu USD değeri olmalıdır.`);
      }
    }
  }

  async reserve(
    messages: readonly { role: string; content: string }[],
    maxOutputTokens: number,
  ): Promise<LlmBudgetReservation> {
    const hardCostLimitEnabled =
      this.policy.dailyCostLimitUsd !== null || this.policy.runCostLimitUsd !== null;
    const estimatedCostUsd = estimateLlmRequestCostUsd(messages, maxOutputTokens, this.policy);
    if (hardCostLimitEnabled && estimatedCostUsd === null) {
      return this.blocked('pricing-unavailable', null);
    }
    if (this.callsReserved >= this.policy.maxCallsPerRun) {
      return this.blocked('run-call-limit', estimatedCostUsd);
    }

    const costMicros = estimatedCostUsd === null ? 0 : Math.max(1, asMicroUsd(estimatedCostUsd));
    if (
      this.policy.runCostLimitUsd !== null &&
      this.runCostReservedMicros + costMicros > toMicroUsdLimit(this.policy.runCostLimitUsd)
    ) {
      return this.blocked('run-cost-limit', estimatedCostUsd);
    }

    // Yerel limitleri await öncesinde ayır: Promise.all ile gelen kayıtlar aynı
    // koşu içinde maxCallsPerRun / runCostLimitUsd değerini aşamaz.
    this.callsReserved += 1;
    this.runCostReservedMicros += costMicros;
    const releaseLocal = (): void => {
      this.callsReserved = Math.max(0, this.callsReserved - 1);
      this.runCostReservedMicros = Math.max(0, this.runCostReservedMicros - costMicros);
    };

    try {
      const globalCalls = await this.repos.rateLimits.reserve(
        'llm-global-daily',
        LLM_BUDGET_WINDOW_SECONDS,
        1,
        this.policy.dailyCallLimit,
      );
      if (!globalCalls.allowed) {
        releaseLocal();
        return this.blocked('daily-call-limit', estimatedCostUsd);
      }

      if (this.policy.additionalDailyCallBucket) {
        const scopedCalls = await this.repos.rateLimits.reserve(
          this.policy.additionalDailyCallBucket,
          LLM_BUDGET_WINDOW_SECONDS,
          1,
          this.policy.dailyCallLimit,
        );
        if (!scopedCalls.allowed) {
          releaseLocal();
          return this.blocked('daily-call-limit', estimatedCostUsd);
        }
      }

      if (this.policy.dailyCostLimitUsd !== null) {
        const costLimitMicros = toMicroUsdLimit(this.policy.dailyCostLimitUsd);
        const dailyCost = await this.repos.rateLimits.reserve(
          'llm-global-daily-cost-usd-micros',
          LLM_BUDGET_WINDOW_SECONDS,
          costMicros,
          costLimitMicros,
        );
        if (!dailyCost.allowed) {
          releaseLocal();
          return this.blocked('daily-cost-limit', estimatedCostUsd);
        }
      }

      return {
        allowed: true,
        estimatedCostUsd,
        callsReserved: this.callsReserved,
        runEstimatedCostUsd: this.runCostReservedMicros / USD_MICRO_UNITS,
      };
    } catch {
      // Storage details may contain host/credential information; do not echo them.
      releaseLocal();
      return this.blocked('budget-storage-error', estimatedCostUsd);
    }
  }

  summary(): { callsReserved: number; runEstimatedCostUsd: number | null } {
    const costConfigured = this.policy.inputUsdPerMtok !== null && this.policy.outputUsdPerMtok !== null;
    return {
      callsReserved: this.callsReserved,
      runEstimatedCostUsd: costConfigured ? this.runCostReservedMicros / USD_MICRO_UNITS : null,
    };
  }

  private blocked(reason: LlmBudgetBlockReason, estimatedCostUsd: number | null): LlmBudgetReservation {
    const costConfigured = this.policy.inputUsdPerMtok !== null && this.policy.outputUsdPerMtok !== null;
    return {
      allowed: false,
      reason,
      estimatedCostUsd,
      callsReserved: this.callsReserved,
      runEstimatedCostUsd: costConfigured ? this.runCostReservedMicros / USD_MICRO_UNITS : null,
    };
  }
}

export function createLlmBudgetFromEnv(
  repos: Pick<Repos, 'rateLimits'>,
  env: Env,
  overrides: {
    maxCallsPerRun?: number;
    runCostLimitUsd?: number | null;
    dailyCostLimitUsd?: number | null;
    additionalDailyCallBucket?: string;
  } = {},
): LlmBudget {
  return new LlmBudget(repos, {
    dailyCallLimit: env.LLM_DAILY_CALL_LIMIT,
    maxCallsPerRun: overrides.maxCallsPerRun ?? env.LLM_MAX_CALLS_PER_RUN,
    dailyCostLimitUsd:
      overrides.dailyCostLimitUsd === undefined ? env.LLM_DAILY_COST_LIMIT_USD : overrides.dailyCostLimitUsd,
    runCostLimitUsd:
      overrides.runCostLimitUsd === undefined ? env.LLM_RUN_COST_LIMIT_USD : overrides.runCostLimitUsd,
    inputUsdPerMtok: env.LLM_COST_USD_PER_MTOK_INPUT,
    outputUsdPerMtok: env.LLM_COST_USD_PER_MTOK_OUTPUT,
    ...(overrides.additionalDailyCallBucket
      ? { additionalDailyCallBucket: overrides.additionalDailyCallBucket }
      : {}),
  });
}
