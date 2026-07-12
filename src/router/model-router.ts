import type {
  ModelTier,
  RoutingDecision,
  RouterConfig,
  RouterOverrides,
  TaskAnalysis,
  TaskHints,
} from "../types.js";
import { capTier, isLocalTier, nextTier, TIER_ORDER } from "../types.js";
import { resolveEndpointForTier } from "../config/tier-config.js";
import type { TierProbeStatus } from "../provider/probe.js";
import {
  applyBudgetToTier,
  resolveBudgetStatus,
  type BudgetStatus,
} from "../routing/budget.js";
import { applyRoutingPolicy } from "../config/policy.js";
import {
  applyModeToTier,
  getModeProfile,
  resolveActiveMode,
  resolveModeConstraints,
  type ModeConstraints,
} from "../routing/modes.js";
import { tierMeetsTask } from "../routing/tier-fit.js";
import { applyGuardrails } from "../routing/guardrails.js";
import {
  shouldApplyLearnedHint,
  suggestTierFromTelemetry,
} from "../routing/learned.js";

export interface RouteInput {
  analysis: TaskAnalysis;
  config: RouterConfig;
  overrides?: RouterOverrides;
  taskHints?: TaskHints;
  unavailableTiers?: Set<ModelTier>;
  tierStatuses?: Map<ModelTier, TierProbeStatus>;
  userPrompt?: string;
}

function pushDebug(debug: string[], line: string): void {
  debug.push(line);
}

export function routeTask(input: RouteInput): RoutingDecision {
  const { analysis, config, overrides, taskHints, unavailableTiers, tierStatuses } = input;
  const debug: string[] = [];
  const session = overrides?.session;
  const activeMode = resolveActiveMode(overrides, config);
  const modeConstraints = resolveModeConstraints(activeMode);
  const preferLocal =
    session?.alwaysPreferLocal ??
    overrides?.preferLocal ??
    modeConstraints.preferLocal ??
    config.routing.preferLocal;

  if (activeMode !== "balanced") {
    pushDebug(debug, `mode: ${getModeProfile(activeMode).description}`);
  }

  if (overrides?.premiumOnly) {
    pushDebug(debug, "override: premium-only");
    return buildDecision(
      "premium",
      config,
      analysis,
      debug,
      unavailableTiers,
      tierStatuses,
      undefined,
      null,
      activeMode,
      modeConstraints
    );
  }

  if (overrides?.modelTier) {
    pushDebug(debug, `override: tier=${overrides.modelTier}`);
    return buildDecision(
      overrides.modelTier,
      config,
      analysis,
      debug,
      unavailableTiers,
      tierStatuses,
      undefined,
      null,
      activeMode,
      modeConstraints
    );
  }

  if (taskHints?.quality === "best") {
    pushDebug(debug, "hint: quality=best");
    return buildDecision(
      "premium",
      config,
      analysis,
      debug,
      unavailableTiers,
      tierStatuses,
      "user hint: best quality",
      null,
      activeMode,
      modeConstraints
    );
  }

  let tier: ModelTier = config.routing.defaultTier;
  const reasons: string[] = [];

  if (shouldUsePremium(analysis)) {
    tier = "premium";
    reasons.push("hard/high-risk/tool-heavy/long-context/complex task");
  } else if (shouldUseHostedOss(analysis, preferLocal)) {
    tier = "hosted_oss";
    reasons.push("medium difficulty coding or multi-step reasoning");
  } else if (shouldUseLocalStrong(analysis)) {
    tier = "local_strong";
    reasons.push("summarization/rewriting/extraction/simple code");
  } else if (shouldUseLocalFast(analysis)) {
    tier = "local_fast";
    reasons.push("short simple low-risk task (incl. simple HTML/UI)");
  } else {
    tier = config.routing.defaultTier;
    reasons.push(`default tier: ${tier}`);
  }

  if (
    preferLocal &&
    !isLocalTier(tier) &&
    analysis.difficulty === "easy" &&
    analysis.riskLevel === "low"
  ) {
    tier = "local_strong";
    reasons.push("preferLocal bumped easy low-risk task to local_strong");
  }

  const policyApplied = applyRoutingPolicy(
    tier,
    analysis,
    config.policy,
    input.userPrompt
  );
  if (policyApplied.tier !== tier) {
    tier = policyApplied.tier;
  }
  for (const note of policyApplied.notes) {
    pushDebug(debug, `policy: ${note}`);
    reasons.push(note);
  }

  if (session?.maxTier) {
    const capped = capTier(tier, session.maxTier);
    if (capped !== tier) {
      pushDebug(debug, `session max_tier=${session.maxTier} capped ${tier} → ${capped}`);
      tier = capped;
    }
  }

  const modeAdjusted = applyModeToTier(tier, analysis, modeConstraints);
  tier = modeAdjusted.tier;
  for (const note of modeAdjusted.notes) {
    pushDebug(debug, `mode: ${note}`);
  }

  const budget = resolveBudgetStatus(session, config);
  if (budget) {
    if (!session?.sessionId) {
      pushDebug(debug, "budget: no session_id — using 'anonymous' for spend tracking");
    }
    tier = applyBudgetToTier(tier, budget, debug);
  }

  const guardrails = applyGuardrails({
    tier,
    analysis,
    policy: config.policy,
    budget,
    tierStatuses,
    userPrompt: input.userPrompt,
  });
  tier = guardrails.tier;
  for (const g of guardrails.results) {
    pushDebug(debug, `guardrail:${g.kind}:${g.action}: ${g.message}`);
  }

  if (config.routing.learnedRoutingHints && config.telemetry.enabled) {
    const suggestion = suggestTierFromTelemetry(
      config.telemetry.logPath,
      analysis.taskType,
      { minSamples: config.routing.learnedMinSamples ?? 5 }
    );
    if (
      suggestion &&
      shouldApplyLearnedHint(tier, suggestion, "medium") &&
      tierMeetsTask(analysis, suggestion.tier)
    ) {
      pushDebug(
        debug,
        `learned: telemetry suggests ${suggestion.tier} — ${suggestion.reason}`
      );
      tier = suggestion.tier;
    } else if (suggestion) {
      pushDebug(
        debug,
        `learned: hint available for ${analysis.taskType} → ${suggestion.tier} (${suggestion.confidence} confidence, not applied)`
      );
    }
  }

  for (const r of reasons) pushDebug(debug, `rule: ${r}`);

  return buildDecision(
    tier,
    config,
    analysis,
    debug,
    unavailableTiers,
    tierStatuses,
    reasons.join("; "),
    budget,
    activeMode,
    modeConstraints,
    guardrails.results
  );
}

function shouldUsePremium(analysis: TaskAnalysis): boolean {
  return (
    analysis.difficulty === "hard" ||
    analysis.riskLevel === "high" ||
    (analysis.requiresToolUse && analysis.requiresCodeReasoning) ||
    analysis.requiresLongContext ||
    analysis.taskType === "architecture" ||
    analysis.taskType === "multi_step"
  );
}

function shouldUseHostedOss(analysis: TaskAnalysis, preferLocal: boolean): boolean {
  if (preferLocal && analysis.difficulty === "easy") return false;

  return (
    analysis.difficulty === "medium" ||
    analysis.taskType === "debugging" ||
    analysis.taskType === "refactoring" ||
    (analysis.requiresCodeReasoning && analysis.requiresToolUse)
  );
}

function shouldUseLocalStrong(analysis: TaskAnalysis): boolean {
  return (
    ["summarization", "rewriting", "extraction", "classification"].includes(
      analysis.taskType
    ) ||
    (analysis.taskType === "code_edit" &&
      analysis.difficulty !== "hard" &&
      analysis.requiresCodeReasoning)
  );
}

function shouldUseLocalFast(analysis: TaskAnalysis): boolean {
  return (
    analysis.difficulty === "easy" &&
    analysis.riskLevel === "low" &&
    !analysis.requiresToolUse &&
    !analysis.requiresStructuredOutput &&
    (["formatting", "classification", "simple_answer"].includes(analysis.taskType) ||
      (analysis.taskType === "code_edit" && !analysis.requiresCodeReasoning))
  );
}

function canFallbackToLocalFast(analysis: TaskAnalysis): boolean {
  return (
    analysis.difficulty !== "hard" &&
    analysis.riskLevel !== "high" &&
    analysis.taskType !== "architecture" &&
    !analysis.requiresLongContext &&
    !(analysis.requiresToolUse && analysis.requiresCodeReasoning)
  );
}

function resolveAvailableTier(
  requested: ModelTier,
  analysis: TaskAnalysis,
  unavailable: Set<ModelTier> | undefined,
  preferLocal: boolean,
  debug: string[]
): { tier: ModelTier; availabilityReason?: string } {
  const status = unavailable;
  if (!status?.size || !status.has(requested)) {
    return { tier: requested };
  }

  pushDebug(debug, `tier ${requested} fully unavailable`);

  const allowLocalFallback =
    requested !== "premium" &&
    !shouldUsePremium(analysis) &&
    canFallbackToLocalFast(analysis);

  if (preferLocal && allowLocalFallback && !status.has("local_fast")) {
    pushDebug(debug, "preferLocal: falling back to local_fast (Ollama)");
    return {
      tier: "local_fast",
      availabilityReason: `${requested} unavailable; fell back to local_fast (Ollama)`,
    };
  }

  if (shouldUsePremium(analysis) || requested === "premium") {
    if (!status.has("premium")) return { tier: "premium" };
    if (!status.has("hosted_oss")) {
      pushDebug(debug, "premium unavailable; using hosted_oss");
      return {
        tier: "hosted_oss",
        availabilityReason: "premium unavailable; using hosted_oss",
      };
    }
    pushDebug(debug, "premium unavailable; keeping premium as intended tier");
    return { tier: "premium" };
  }

  for (const candidate of TIER_ORDER) {
    if (TIER_ORDER.indexOf(candidate) > TIER_ORDER.indexOf(requested) && !status.has(candidate)) {
      pushDebug(debug, `escalated to ${candidate} due to availability`);
      return {
        tier: candidate,
        availabilityReason: `${requested} unavailable; escalated to ${candidate}`,
      };
    }
  }

  if (allowLocalFallback && !status.has("local_fast")) {
    pushDebug(debug, "last resort: local_fast (Ollama)");
    return {
      tier: "local_fast",
      availabilityReason: `${requested} unavailable; last resort local_fast`,
    };
  }

  return { tier: requested };
}

function buildDecision(
  requestedTier: ModelTier,
  config: RouterConfig,
  analysis: TaskAnalysis,
  debug: string[],
  unavailableTiers?: Set<ModelTier>,
  tierStatuses?: Map<ModelTier, TierProbeStatus>,
  reason?: string,
  budget?: BudgetStatus | null,
  mode?: import("../types.js").RoutingMode,
  modeConstraints?: ModeConstraints,
  guardrails?: import("../types.js").GuardrailResult[]
): RoutingDecision {
  const { tier, availabilityReason } = resolveAvailableTier(
    requestedTier,
    analysis,
    unavailableTiers,
    config.routing.preferLocal,
    debug
  );

  const status = tierStatuses?.get(tier);
  const resolved =
    status?.effective ??
    resolveEndpointForTier(
      config,
      tier,
      true,
      Boolean(config.models[tier].fallback)
    );

  const endpoint = resolved?.endpoint ?? config.models[tier].primary;
  const fallbackTier = nextTier(tier);

  const fallbackReason =
    resolved?.fallbackReason ??
    (availabilityReason && tier !== requestedTier ? availabilityReason : undefined);

  return {
    tier,
    requestedTier,
    model: endpoint.model,
    baseUrl: endpoint.baseUrl,
    provider: endpoint.provider,
    reason:
      reason ??
      `Selected ${tier} for ${analysis.taskType} (${analysis.difficulty}, ${analysis.riskLevel} risk)`,
    fallbackTier,
    fallbackReason,
    endpointSource: resolved?.source,
    debug,
    mode,
    guardrails: guardrails?.length ? guardrails : undefined,
    budget: budget
      ? {
          session_id: budget.sessionId,
          budget_usd: budget.budgetUsd,
          spent_usd: budget.spentUsd,
          remaining_usd: budget.remainingUsd,
          cap_tier: budget.capTier,
        }
      : undefined,
  };
}
