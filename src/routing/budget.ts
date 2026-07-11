import { getSessionSpend } from "../telemetry/stats.js";
import type { ModelTier, RouterConfig, SessionPolicy } from "../types.js";
import { capTier, TIER_ORDER } from "../types.js";

/** Tier ceiling based on remaining session budget (USD). */
export function tierCapForBudget(remainingUsd: number): ModelTier {
  if (remainingUsd <= 0) return "local_fast";
  if (remainingUsd < 0.05) return "local_strong";
  if (remainingUsd < 0.15) return "hosted_oss";
  return "premium";
}

export interface BudgetStatus {
  sessionId: string;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  capTier: ModelTier;
  enforced: boolean;
}

export function resolveBudgetStatus(
  session: SessionPolicy | undefined,
  config: RouterConfig
): BudgetStatus | null {
  if (session?.budgetUsd === undefined) return null;

  const sessionId = session.sessionId ?? "anonymous";
  const spentUsd = getSessionSpend(config.telemetry.logPath, sessionId);
  const remainingUsd = Math.max(0, session.budgetUsd - spentUsd);

  return {
    sessionId,
    budgetUsd: session.budgetUsd,
    spentUsd,
    remainingUsd,
    capTier: tierCapForBudget(remainingUsd),
    enforced: true,
  };
}

export function applyBudgetToTier(
  tier: ModelTier,
  budget: BudgetStatus | null,
  debug: string[]
): ModelTier {
  if (!budget) return tier;

  const capped = capTier(tier, budget.capTier);
  if (capped !== tier) {
    debug.push(
      `budget: $${budget.remainingUsd.toFixed(4)} remaining (spent $${budget.spentUsd.toFixed(4)} of $${budget.budgetUsd}) → cap ${tier} → ${capped}`
    );
  }
  return capped;
}

export function canEscalateWithinBudget(
  targetTier: ModelTier,
  budget: BudgetStatus | null
): boolean {
  if (!budget) return true;
  const ti = TIER_ORDER.indexOf(targetTier);
  const ci = TIER_ORDER.indexOf(budget.capTier);
  return ti <= ci;
}
