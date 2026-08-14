import type { ModelEndpointConfig, ModelTier, RouterConfig } from "../types.js";
import { isModelInCatalog } from "../provider/model-catalog.js";
import { listEndpointsForTier } from "./tier-config.js";
import { TIER_ORDER } from "../types.js";

export interface ResolvedModelOverride {
  tier: ModelTier;
  endpoint: ModelEndpointConfig;
  /** Matched a configured endpoint vs swapped model on a gateway. */
  source: "config" | "gateway_swap";
}

/**
 * Resolve a direct model id to a tier + endpoint. Searches configured tiers first;
 * if not found, uses the preferred tier's gateway with the model id swapped in.
 */
export function resolveModelOverride(
  modelId: string,
  config: RouterConfig,
  preferTier?: ModelTier
): ResolvedModelOverride | null {
  const want = modelId.trim();
  if (!want) return null;

  for (const tier of TIER_ORDER) {
    for (const ep of listEndpointsForTier(config, tier)) {
      if (endpointModelMatches(want, ep.model)) {
        return { tier, endpoint: ep, source: "config" };
      }
    }
  }

  const tier = preferTier ?? config.routing.defaultTier;
  const base = config.models[tier]?.primary;
  if (!base?.baseUrl || !base.provider) return null;

  return {
    tier,
    endpoint: {
      ...base,
      model: want,
    },
    source: "gateway_swap",
  };
}

function endpointModelMatches(requested: string, configured: string): boolean {
  return isModelInCatalog(requested, [configured]);
}
