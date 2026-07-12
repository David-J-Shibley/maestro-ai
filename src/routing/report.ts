import type { ModelTier, RoutingDecision, RouterConfig, TaskAnalysis } from "../types.js";
import type { ProbeSnapshot } from "../provider/probe.js";
import { getPrimaryEndpoint } from "../config/tier-config.js";
import { buildDecisionExplanation, type DecisionExplanation } from "./explanation.js";
import { buildValidationOutcome } from "./outcome.js";
import { getHistoricalSuccessRate } from "../telemetry/stats.js";
import type { EvaluationResult, RoutedAttempt } from "../types.js";

export interface CallOutcome {
  escalated: boolean;
  attempts: RoutedAttempt[];
  evaluation: EvaluationResult;
  initialRouting: RoutingDecision;
  maxRetriesPerTier: number;
}

export interface RoutingReport {
  tier: ModelTier;
  model: string;
  provider: string;
  base_url: string;
  reason: string;
  requested_tier?: ModelTier;
  fallback_tier: ModelTier | null;
  fallback_reason?: string;
  endpoint_source?: "primary" | "tier_fallback";
  budget?: RoutingDecision["budget"];
  analysis: TaskAnalysis;
  debug: string[];
  probe: {
    unavailable_tiers: ModelTier[];
    results: ProbeSnapshot[];
  } | null;
  explanation: DecisionExplanation;
  mode?: import("../types.js").RoutingMode;
  guardrails?: RoutingDecision["guardrails"];
}

export function buildRoutingReport(input: {
  routing: RoutingDecision;
  analysis: TaskAnalysis;
  probe?: { unavailable: Set<ModelTier>; results: ProbeSnapshot[] };
  contextTokens?: number;
  config?: RouterConfig;
  callOutcome?: CallOutcome;
}): RoutingReport {
  const { routing, analysis, probe, contextTokens, config, callOutcome } = input;

  const explanationRouting = callOutcome?.initialRouting ?? routing;

  const historical =
    config?.telemetry?.enabled
      ? getHistoricalSuccessRate(
          config.telemetry.logPath,
          analysis.taskType,
          explanationRouting.tier
        )
      : null;

  let fallbackModel: string | undefined;
  if (explanationRouting.fallbackTier && config) {
    try {
      fallbackModel = getPrimaryEndpoint(config, explanationRouting.fallbackTier).model;
    } catch {
      fallbackModel = undefined;
    }
  }

  const outcome = callOutcome
    ? buildValidationOutcome({
        initialRouting: callOutcome.initialRouting,
        finalRouting: routing,
        attempts: callOutcome.attempts,
        evaluation: callOutcome.evaluation,
        escalated: callOutcome.escalated,
        maxRetriesPerTier: callOutcome.maxRetriesPerTier,
      })
    : undefined;

  const explanation = buildDecisionExplanation({
    routing: explanationRouting,
    analysis,
    contextTokens,
    historical,
    fallbackModel,
    outcome,
  });

  return {
    tier: routing.tier,
    model: routing.model,
    provider: routing.provider,
    base_url: routing.baseUrl,
    reason: routing.reason,
    requested_tier: routing.requestedTier,
    fallback_tier: routing.fallbackTier,
    fallback_reason: routing.fallbackReason,
    endpoint_source: routing.endpointSource,
    budget: routing.budget,
    analysis,
    debug: routing.debug ?? [],
    probe: probe
      ? {
          unavailable_tiers: Array.from(probe.unavailable),
          results: probe.results,
        }
      : null,
    explanation,
    mode: routing.mode,
    guardrails: routing.guardrails,
  };
}

export function enrichAskResponse(
  base: Record<string, unknown>,
  report: RoutingReport
): Record<string, unknown> {
  return {
    ...base,
    routing: report,
    explanation: report.explanation,
  };
}
