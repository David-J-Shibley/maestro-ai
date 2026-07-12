import type { TierProbeStatus } from "../provider/probe.js";
import type {
  GuardrailResult,
  GuardrailsPolicy,
  ModelTier,
  RoutingPolicy,
  TaskAnalysis,
} from "../types.js";
import { capTier, isLocalTier, TIER_ORDER } from "../types.js";
import type { BudgetStatus } from "./budget.js";
import { tierMeetsTask } from "./tier-fit.js";

export type GuardrailKind = "budget" | "privacy" | "latency";
export type GuardrailAction = "allow" | "warn" | "cap" | "block";

export interface ApplyGuardrailsInput {
  tier: ModelTier;
  analysis: TaskAnalysis;
  policy?: RoutingPolicy | null;
  budget?: BudgetStatus | null;
  tierStatuses?: Map<ModelTier, TierProbeStatus>;
  userPrompt?: string;
}

export interface ApplyGuardrailsOutput {
  tier: ModelTier;
  results: GuardrailResult[];
}

const DEFAULT_WARN_REMAINING_USD = 0.1;
const DEFAULT_LATENCY_TARGET_MS = 8000;

export function applyGuardrails(input: ApplyGuardrailsInput): ApplyGuardrailsOutput {
  const results: GuardrailResult[] = [];
  let tier = input.tier;
  const guardrails = input.policy?.guardrails;

  tier = applyBudgetGuardrails(input, guardrails?.budget, results, tier);
  tier = applyPrivacyGuardrails(input, guardrails?.privacy, results, tier);
  tier = applyLatencyGuardrails(input, guardrails?.latency, results, tier);

  return { tier, results };
}

function applyBudgetGuardrails(
  input: ApplyGuardrailsInput,
  config: GuardrailsPolicy["budget"] | undefined,
  results: GuardrailResult[],
  tier: ModelTier
): ModelTier {
  if (config?.enabled === false) return tier;
  if (!input.budget) return tier;

  const warnAt = config?.warn_remaining_usd ?? DEFAULT_WARN_REMAINING_USD;
  const { remainingUsd, budgetUsd, spentUsd, capTier: budgetCap } = input.budget;

  if (remainingUsd <= 0) {
    const capped = capTier(tier, budgetCap);
    results.push({
      kind: "budget",
      action: "block",
      message: `Session budget exhausted ($${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)})`,
      detail: `Capped route at ${capped}`,
    });
    return capped;
  }

  if (remainingUsd <= warnAt) {
    results.push({
      kind: "budget",
      action: "warn",
      message: `Low session budget: $${remainingUsd.toFixed(4)} remaining of $${budgetUsd.toFixed(2)}`,
      detail: `Budget cap tier: ${budgetCap}`,
    });
  }

  const capped = capTier(tier, budgetCap);
  if (capped !== tier) {
    results.push({
      kind: "budget",
      action: "cap",
      message: `Budget guardrail capped ${tier} → ${capped}`,
      detail: `$${remainingUsd.toFixed(4)} remaining`,
    });
    return capped;
  }

  return tier;
}

function applyPrivacyGuardrails(
  input: ApplyGuardrailsInput,
  config: GuardrailsPolicy["privacy"] | undefined,
  results: GuardrailResult[],
  tier: ModelTier
): ModelTier {
  if (config?.enabled === false) return tier;
  const privacy = input.policy?.privacy;
  if (!privacy?.keywords?.length) return tier;

  const blob = [input.userPrompt ?? "", ...input.analysis.signals]
    .join(" ")
    .toLowerCase();
  const hit = privacy.keywords.find((kw) => blob.includes(kw.toLowerCase()));
  if (!hit) return tier;

  const blockCloud = config?.block_cloud !== false;
  const maxTier = privacy.max_tier;
  const wasCloud = !isLocalTier(tier);
  const capped = capTier(tier, maxTier);

  if (blockCloud && wasCloud) {
    const localCap = capTier(capped, "local_strong");
    results.push({
      kind: "privacy",
      action: "block",
      message: `Privacy guardrail: sensitive signal "${hit}" — cloud tiers blocked`,
      detail: `Capped at ${localCap}`,
    });
    return localCap;
  }

  if (capped !== tier) {
    results.push({
      kind: "privacy",
      action: "cap",
      message: privacy.reason ?? `Privacy keywords detected ("${hit}")`,
      detail: `Capped ${tier} → ${capped}`,
    });
    return capped;
  }

  results.push({
    kind: "privacy",
    action: "warn",
    message: `Privacy signal detected ("${hit}") — staying within ${maxTier}`,
  });
  return tier;
}

function applyLatencyGuardrails(
  input: ApplyGuardrailsInput,
  config: GuardrailsPolicy["latency"] | undefined,
  results: GuardrailResult[],
  tier: ModelTier
): ModelTier {
  if (config?.enabled === false) return tier;

  const targetMs =
    config?.target_ms ??
    input.policy?.latency_target_ms ??
    DEFAULT_LATENCY_TARGET_MS;
  if (!targetMs || targetMs <= 0) return tier;
  if (!input.tierStatuses?.size) return tier;

  const currentLatency = effectiveTierLatency(input.tierStatuses, tier);
  if (currentLatency === undefined) return tier;

  if (currentLatency <= targetMs) {
    return tier;
  }

  if (config?.prefer_faster_tier === false) {
    results.push({
      kind: "latency",
      action: "warn",
      message: `Probe latency ${currentLatency}ms exceeds target ${targetMs}ms`,
      detail: `Keeping ${tier} (prefer_faster_tier disabled)`,
    });
    return tier;
  }

  const faster = findFasterViableTier(
    tier,
    input.analysis,
    input.tierStatuses,
    targetMs
  );

  if (faster && faster.tier !== tier) {
    results.push({
      kind: "latency",
      action: "cap",
      message: `Latency guardrail: ${tier} (${currentLatency}ms) → ${faster.tier} (${faster.latencyMs}ms)`,
      detail: `Target ${targetMs}ms`,
    });
    return faster.tier;
  }

  results.push({
    kind: "latency",
    action: "warn",
    message: `Probe latency ${currentLatency}ms exceeds target ${targetMs}ms`,
    detail: "No faster viable tier available",
  });
  return tier;
}

function effectiveTierLatency(
  statuses: Map<ModelTier, TierProbeStatus>,
  tier: ModelTier
): number | undefined {
  const status = statuses.get(tier);
  if (!status?.available) return undefined;

  const source = status.effective?.source ?? "primary";
  if (source === "tier_fallback" && status.fallback?.available) {
    return status.fallback.latencyMs;
  }
  return status.primary.latencyMs;
}

function findFasterViableTier(
  currentTier: ModelTier,
  analysis: TaskAnalysis,
  statuses: Map<ModelTier, TierProbeStatus>,
  targetMs: number
): { tier: ModelTier; latencyMs: number } | null {
  const candidates: Array<{ tier: ModelTier; latencyMs: number }> = [];

  for (const tier of TIER_ORDER) {
    if (!tierMeetsTask(analysis, tier)) continue;
    const status = statuses.get(tier);
    if (!status?.available) continue;
    const latency = effectiveTierLatency(statuses, tier);
    if (latency === undefined || latency > targetMs) continue;
    candidates.push({ tier, latencyMs: latency });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.latencyMs - b.latencyMs);
  return candidates[0] ?? null;
}

export function formatGuardrailsMarkdown(
  guardrails?: GuardrailResult[]
): string | null {
  if (!guardrails?.length) return null;

  const lines = ["", "**Guardrails**"];
  for (const g of guardrails) {
    const icon =
      g.action === "block" ? "⛔" : g.action === "warn" ? "⚠️" : "🛡️";
    lines.push(`- ${icon} **${g.kind}**: ${g.message}`);
    if (g.detail) lines.push(`  - ${g.detail}`);
  }
  return lines.join("\n");
}
