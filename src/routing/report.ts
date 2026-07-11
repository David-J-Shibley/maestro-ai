import type { ModelTier, RoutingDecision, TaskAnalysis } from "../types.js";
import type { ProbeSnapshot } from "../provider/probe.js";

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
}

export function buildRoutingReport(input: {
  routing: RoutingDecision;
  analysis: TaskAnalysis;
  probe?: { unavailable: Set<ModelTier>; results: ProbeSnapshot[] };
}): RoutingReport {
  const { routing, analysis, probe } = input;

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
  };
}

export function enrichAskResponse(
  base: Record<string, unknown>,
  report: RoutingReport
): Record<string, unknown> {
  return {
    ...base,
    routing: report,
  };
}
