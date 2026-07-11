import type { ModelEndpointConfig, ModelTier, RouterConfig } from "../types.js";

/** Raw tier entry: flat endpoint or primary/fallback pair. */
export type RawTierEntry =
  | ModelEndpointConfig
  | { primary: ModelEndpointConfig; fallback?: ModelEndpointConfig };

export interface TierModelConfig {
  primary: ModelEndpointConfig;
  fallback?: ModelEndpointConfig;
}

export function isTierWithFallback(
  entry: RawTierEntry
): entry is { primary: ModelEndpointConfig; fallback?: ModelEndpointConfig } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "primary" in entry &&
    typeof (entry as { primary: unknown }).primary === "object"
  );
}

export function normalizeTierEntry(entry: RawTierEntry): TierModelConfig {
  if (isTierWithFallback(entry)) {
    if (!entry.primary?.model || !entry.primary.baseUrl || !entry.primary.provider) {
      throw new Error("Tier primary endpoint is invalid");
    }
    return { primary: entry.primary, fallback: entry.fallback };
  }
  if (!entry.model || !entry.baseUrl || !entry.provider) {
    throw new Error("Tier endpoint is invalid");
  }
  return { primary: entry };
}

export function normalizeModels(
  raw: Record<string, RawTierEntry>
): Record<ModelTier, TierModelConfig> {
  const tiers = Object.keys(raw) as ModelTier[];
  const out = {} as Record<ModelTier, TierModelConfig>;
  for (const tier of tiers) {
    const entry = raw[tier];
    if (!entry) throw new Error(`Missing tier: ${tier}`);
    out[tier] = normalizeTierEntry(entry);
  }
  return out;
}

export function getPrimaryEndpoint(
  config: RouterConfig,
  tier: ModelTier
): ModelEndpointConfig {
  return config.models[tier].primary;
}

export function listEndpointsForTier(
  config: RouterConfig,
  tier: ModelTier
): ModelEndpointConfig[] {
  const tc = config.models[tier];
  return tc.fallback ? [tc.primary, tc.fallback] : [tc.primary];
}

export interface ResolvedEndpoint {
  tier: ModelTier;
  endpoint: ModelEndpointConfig;
  source: "primary" | "tier_fallback";
  fallbackReason?: string;
}

export function resolveEndpointForTier(
  config: RouterConfig,
  tier: ModelTier,
  primaryAvailable: boolean,
  fallbackAvailable?: boolean
): ResolvedEndpoint | null {
  const tc = config.models[tier];
  if (primaryAvailable) {
    return { tier, endpoint: tc.primary, source: "primary" };
  }
  if (tc.fallback && fallbackAvailable !== false) {
    return {
      tier,
      endpoint: tc.fallback,
      source: "tier_fallback",
      fallbackReason: `${tier} primary (${tc.primary.provider}/${tc.primary.model}) unavailable; using tier fallback (${tc.fallback.provider}/${tc.fallback.model})`,
    };
  }
  return null;
}
