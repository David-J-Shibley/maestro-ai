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
  const out: ModelEndpointConfig[] = [];
  const seen = new Set<string>();
  const add = (ep: ModelEndpointConfig | undefined) => {
    if (!ep) return;
    const key = `${ep.provider}|${ep.baseUrl}|${ep.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ep);
  };
  add(tc.primary);
  add(tc.fallback);
  if (tier === "premium") {
    for (const ep of config.premiumPool ?? []) add(ep);
  }
  return out;
}

export interface ResolvedEndpoint {
  tier: ModelTier;
  endpoint: ModelEndpointConfig;
  source: "primary" | "tier_fallback" | "premium_pool";
  fallbackReason?: string;
}

/**
 * Pick the first available endpoint for a tier.
 * `availability[i]` aligns with `listEndpointsForTier(config, tier)`.
 */
export function resolveEndpointForTier(
  config: RouterConfig,
  tier: ModelTier,
  primaryAvailable: boolean,
  fallbackAvailable?: boolean,
  poolAvailable?: boolean[]
): ResolvedEndpoint | null {
  const tc = config.models[tier];
  const endpoints = listEndpointsForTier(config, tier);

  const flags: boolean[] = endpoints.map((ep, i) => {
    if (i === 0) return primaryAvailable;
    if (i === 1 && tc.fallback && ep === tc.fallback) {
      return fallbackAvailable !== false;
    }
    // premium pool slots
    const pool = config.premiumPool ?? [];
    const poolIdx = pool.findIndex(
      (p) =>
        p.provider === ep.provider && p.baseUrl === ep.baseUrl && p.model === ep.model
    );
    if (poolIdx >= 0) {
      if (!poolAvailable || poolAvailable.length === 0) return true;
      return poolAvailable[poolIdx] === true;
    }
    // Extra fallback-like entry without explicit flag
    return fallbackAvailable !== false;
  });

  for (let i = 0; i < endpoints.length; i++) {
    if (!flags[i]) continue;
    const ep = endpoints[i]!;
    let source: ResolvedEndpoint["source"] = "primary";
    let fallbackReason: string | undefined;
    if (i === 0) {
      source = "primary";
    } else if (tc.fallback && ep.model === tc.fallback.model && ep.baseUrl === tc.fallback.baseUrl) {
      source = "tier_fallback";
      fallbackReason = `${tier} primary (${tc.primary.provider}/${tc.primary.model}) unavailable; using tier fallback (${ep.provider}/${ep.model})`;
    } else {
      source = "premium_pool";
      fallbackReason = `premium primary unavailable; using premium pool (${ep.provider}/${ep.model})`;
    }
    return { tier, endpoint: ep, source, fallbackReason };
  }
  return null;
}
