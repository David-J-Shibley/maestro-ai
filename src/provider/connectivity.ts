/**
 * Detect offline / no-cloud conditions and force local-only routing.
 *
 * Offline when:
 * 1. Internet reachability check fails, or
 * 2. Probe shows hosted_oss + premium unavailable while a local tier is up
 */
import type { ModelTier, RouterConfig, RouterOverrides } from "../types.js";
import { capTier, isLocalTier } from "../types.js";
import type { ProbeAllResult } from "./probe.js";

const DEFAULT_CONNECTIVITY_TTL_MS = 30_000;
const DEFAULT_INTERNET_TIMEOUT_MS = 1_500;

/** Lightweight endpoints that return quickly when the public internet is up. */
const INTERNET_CHECK_URLS = [
  "https://connectivitycheck.gstatic.com/generate_204",
  "https://cloudflare.com/cdn-cgi/trace",
];

export type ConnectivitySource = "internet" | "probe" | "cached" | "disabled";

export interface ConnectivityStatus {
  online: boolean;
  /** Human-readable why online/offline */
  reason: string;
  source: ConnectivitySource;
  /** True when offlineLocalOnly will force local tiers */
  localOnlyForced: boolean;
}

type CacheEntry = {
  expiresAt: number;
  value: ConnectivityStatus;
};

let connectivityCache: CacheEntry | null = null;

/** Test / doctor: clear connectivity cache. */
export function clearConnectivityCache(): void {
  connectivityCache = null;
}

export function offlineLocalOnlyEnabled(config: RouterConfig): boolean {
  return config.routing.offlineLocalOnly !== false;
}

/**
 * Probe-based offline: cloud tiers down, at least one local tier up.
 * (LiteLLM can still answer /models while Featherless/Bedrock are dead —
 * this catches "cloud dead" when probe marks hosted+premium unavailable.)
 */
export function isOfflineFromProbe(
  unavailable: Set<ModelTier> | undefined,
  availableTiers?: Iterable<ModelTier>
): boolean {
  if (!unavailable?.size) return false;
  const cloudDown =
    unavailable.has("hosted_oss") && unavailable.has("premium");
  if (!cloudDown) return false;

  if (availableTiers) {
    for (const t of availableTiers) {
      if (isLocalTier(t) && !unavailable.has(t)) return true;
    }
    return false;
  }
  // No tier list — assume local might be up if cloud is down
  return !unavailable.has("local_fast") || !unavailable.has("local_strong");
}

export async function checkInternet(
  timeoutMs = DEFAULT_INTERNET_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<{ online: boolean; reason: string }> {
  for (const url of INTERNET_CHECK_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual",
      });
      // Any response (including 204 / 3xx) means the network path works.
      if (res.status >= 200 && res.status < 500) {
        return { online: true, reason: "internet reachable" };
      }
    } catch {
      /* try next URL */
    } finally {
      clearTimeout(timer);
    }
  }
  return { online: false, reason: "no internet" };
}

export async function resolveConnectivity(
  config: RouterConfig,
  probe?: ProbeAllResult | null,
  options?: {
    force?: boolean;
    fetchImpl?: typeof fetch;
    /** Skip live internet check (unit tests / probe-only). */
    skipInternetCheck?: boolean;
  }
): Promise<ConnectivityStatus> {
  const enabled = offlineLocalOnlyEnabled(config);
  const ttl =
    config.routing.probeCacheTtlMs === undefined
      ? DEFAULT_CONNECTIVITY_TTL_MS
      : Math.max(0, config.routing.probeCacheTtlMs);

  if (!options?.force && ttl > 0 && connectivityCache) {
    if (connectivityCache.expiresAt > Date.now()) {
      return {
        ...connectivityCache.value,
        source: "cached",
      };
    }
  }

  let online = true;
  let reason = "online";
  let source: ConnectivitySource = "internet";

  // Vitest sets VITEST — skip live internet / probe-offline so suite tests aren't
  // forced local when LiteLLM isn't running. Connectivity unit tests pass fetchImpl.
  const inVitestWithoutFetch = Boolean(process.env.VITEST) && !options?.fetchImpl;
  const skipNet =
    options?.skipInternetCheck === true || inVitestWithoutFetch;

  if (skipNet) {
    online = true;
    reason = "internet check skipped";
    source = "disabled";
  } else {
    const net = await checkInternet(
      DEFAULT_INTERNET_TIMEOUT_MS,
      options?.fetchImpl ?? fetch
    );
    online = net.online;
    reason = net.reason;
    source = "internet";
  }

  // Probe-based cloud-down detection (skip in vitest unless fetchImpl provided)
  if (online && probe && !inVitestWithoutFetch) {
    const available = (Object.keys(config.models) as ModelTier[]).filter(
      (t) => !probe.unavailable.has(t)
    );
    if (isOfflineFromProbe(probe.unavailable, available)) {
      online = false;
      reason = "cloud tiers unavailable (hosted_oss + premium)";
      source = "probe";
    }
  }

  const status: ConnectivityStatus = {
    online,
    reason,
    source,
    localOnlyForced: enabled && !online,
  };

  if (!options?.force && ttl > 0) {
    connectivityCache = {
      expiresAt: Date.now() + ttl,
      value: status,
    };
  }

  return status;
}

/**
 * When offline + offlineLocalOnly, force preferLocal and cap maxTier at local_strong.
 */
export function applyOfflineLocalOnlyOverrides(
  overrides: RouterOverrides,
  connectivity: ConnectivityStatus,
  config: RouterConfig
): { overrides: RouterOverrides; forced: boolean; note?: string } {
  if (!connectivity.localOnlyForced || !offlineLocalOnlyEnabled(config)) {
    return { overrides, forced: false };
  }

  const maxTier = capTier(
    overrides.session?.maxTier ?? "premium",
    "local_strong"
  );
  const note = `offline → local-only (${connectivity.reason})`;

  return {
    forced: true,
    note,
    overrides: {
      ...overrides,
      preferLocal: true,
      session: {
        ...overrides.session,
        maxTier,
      },
    },
  };
}
