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

export type ProbeAllResult = {
  unavailable: Set<ModelTier>;
  results: ProbeResult[];
  tiers: TierProbeStatus[];
};

const DEFAULT_PROBE_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: ProbeAllResult;
};

const probeCache = new Map<string, CacheEntry>();

function cacheKey(config: RouterConfig): string {
  const models = Object.entries(config.models)
    .map(([tier, tc]) => {
      const p = tc.primary;
      const f = tc.fallback;
      return `${tier}:${p.provider}:${p.model}:${p.baseUrl}:${f?.provider ?? ""}:${f?.model ?? ""}:${f?.baseUrl ?? ""}`;
    })
    .sort()
    .join("|");
  return models;
}

/** Clear in-memory probe cache (tests / doctor force-refresh). */
export function clearProbeCache(): void {
  probeCache.clear();
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

async function probeAllTiersUncached(config: RouterConfig): Promise<ProbeAllResult> {
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

/**
 * Probe all tiers. Results are cached for `routing.probeCacheTtlMs` (default 30s)
 * so frequent subtasks don't re-hit every endpoint.
 */
export async function probeAllTiers(
  config: RouterConfig,
  options?: { force?: boolean }
): Promise<ProbeAllResult> {
  const ttl =
    config.routing.probeCacheTtlMs === undefined
      ? DEFAULT_PROBE_CACHE_TTL_MS
      : Math.max(0, config.routing.probeCacheTtlMs);

  if (!options?.force && ttl > 0) {
    const key = cacheKey(config);
    const hit = probeCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return {
        unavailable: new Set(hit.value.unavailable),
        results: hit.value.results,
        tiers: hit.value.tiers,
      };
    }
  }

  const value = await probeAllTiersUncached(config);

  if (!options?.force && ttl > 0) {
    probeCache.set(cacheKey(config), {
      expiresAt: Date.now() + ttl,
      value: {
        unavailable: new Set(value.unavailable),
        results: value.results,
        tiers: value.tiers,
      },
    });
  }

  return value;
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
