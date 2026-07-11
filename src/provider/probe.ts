import { listEndpointsForTier, resolveEndpointForTier } from "../config/tier-config.js";
import type { ModelEndpointConfig, ModelTier, RouterConfig } from "../types.js";

export interface ProbeResult {
  tier: ModelTier;
  slot: "primary" | "fallback";
  available: boolean;
  latencyMs?: number;
  error?: string;
  model: string;
  provider: string;
}

export type ProbeSnapshot = ProbeResult;

export interface TierProbeStatus {
  tier: ModelTier;
  available: boolean;
  primary: ProbeResult;
  fallback?: ProbeResult;
  effective?: ReturnType<typeof resolveEndpointForTier>;
}

export async function probeEndpoint(
  endpoint: ModelEndpointConfig,
  timeoutMs = 3000
): Promise<{ available: boolean; latencyMs?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const url = endpoint.baseUrl.replace(/\/$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }

    const response = await fetch(`${url}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    return {
      available: response.ok,
      latencyMs: Date.now() - start,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      available: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTier(
  config: RouterConfig,
  tier: ModelTier
): Promise<TierProbeStatus> {
  const endpoints = listEndpointsForTier(config, tier);
  const primaryEp = endpoints[0]!;
  const primaryProbe = await probeEndpoint(primaryEp);
  const primary: ProbeResult = {
    tier,
    slot: "primary",
    ...primaryProbe,
    model: primaryEp.model,
    provider: primaryEp.provider,
  };

  let fallback: ProbeResult | undefined;
  if (endpoints[1]) {
    const fbProbe = await probeEndpoint(endpoints[1]);
    fallback = {
      tier,
      slot: "fallback",
      ...fbProbe,
      model: endpoints[1].model,
      provider: endpoints[1].provider,
    };
  }

  const effective = resolveEndpointForTier(
    config,
    tier,
    primary.available,
    fallback?.available
  );

  return {
    tier,
    available: Boolean(effective),
    primary,
    fallback,
    effective: effective ?? undefined,
  };
}

export async function probeAllTiers(
  config: RouterConfig
): Promise<{ unavailable: Set<ModelTier>; results: ProbeResult[]; tiers: TierProbeStatus[] }> {
  const unavailable = new Set<ModelTier>();
  const results: ProbeResult[] = [];
  const tiers: TierProbeStatus[] = [];

  const entries = Object.keys(config.models) as ModelTier[];

  await Promise.all(
    entries.map(async (tier) => {
      const status = await probeTier(config, tier);
      tiers.push(status);
      results.push(status.primary);
      if (status.fallback) results.push(status.fallback);
      if (!status.available) unavailable.add(tier);
    })
  );

  return { unavailable, results, tiers };
}

export function getResolvedEndpoint(
  config: RouterConfig,
  tier: ModelTier,
  tierStatus?: TierProbeStatus
) {
  if (tierStatus) {
    return tierStatus.effective ?? null;
  }
  const tc = config.models[tier];
  return resolveEndpointForTier(config, tier, true, Boolean(tc.fallback));
}
