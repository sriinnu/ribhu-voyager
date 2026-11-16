import type { Usage } from "./types.js";

/**
 * Per-model pricing in micros per 1k tokens. A provider/model entry comes from
 * `RIBBHU_MODEL_PRICING`; `RIBBHU_COST_MICROS_PER_1K_TOKENS` is the fallback
 * rate applied to both input and output.
 */
export type ModelPricing = {
  inputMicrosPer1k: number;
  outputMicrosPer1k: number;
};

/** Default per-run token budget used when one is not configured. */
export const DEFAULT_RUN_TOKEN_BUDGET = 200_000;

export type RunBudget = {
  /** Max tokens (input+output) one run may consume; 0 disables the cap. */
  tokenBudget: number;
  /** Max cost in micros one run may spend; 0 disables the cap. */
  costBudgetMicros: number;
};

export type ReservationRequest = {
  tokens: number;
  costMicros: number;
};

export function costMicrosForUsage(
  usage: Usage,
  pricing: ModelPricing | undefined,
): number {
  if (!pricing) return 0;
  const value =
    (usage.input * pricing.inputMicrosPer1k) / 1000 +
    (usage.output * pricing.outputMicrosPer1k) / 1000;
  return Math.max(0, Math.round(value));
}

/** Resolve a pricing entry for `provider/model`, falling back to a flat rate. */
export function resolveModelPricing(
  pricing: Record<string, ModelPricing> | undefined,
  provider: string,
  model: string,
  fallbackMicrosPer1k: number | undefined,
): ModelPricing | undefined {
  const exact = pricing?.[`${provider}/${model}`];
  if (exact) return exact;
  const fallback = fallbackMicrosPer1k ?? 0;
  if (fallback <= 0) return undefined;
  return { inputMicrosPer1k: fallback, outputMicrosPer1k: fallback };
}

/**
 * What a run reserves against the tenant quota before it starts. The engine
 * checks the budget before every turn; the reservation keeps other submissions
 * from admitting against the same headroom.
 */
export function reservationForRun(
  budget: RunBudget,
  pricing: ModelPricing | undefined,
): ReservationRequest {
  const tokens = budget.tokenBudget > 0 ? budget.tokenBudget : 0;
  const estimated = costMicrosForUsage(
    {
      input: Math.floor(tokens / 2),
      output: tokens - Math.floor(tokens / 2),
      totalTokens: tokens,
    },
    pricing,
  );
  const costMicros =
    budget.costBudgetMicros > 0
      ? budget.costBudgetMicros
      : estimated > 0
        ? estimated
        : 0;
  return { tokens, costMicros };
}
