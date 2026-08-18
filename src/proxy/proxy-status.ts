import type { ModelTier, RouterConfig, RoutingMode } from "../types.js";
import { TIER_ORDER } from "../types.js";
import { detectLitellmProcess, guessLitellmConfigPaths } from "../doctor/litellm-process.js";
import { fetchModelCatalog } from "../provider/model-catalog.js";
import { probeAllTiers } from "../provider/probe.js";
import { resolveConnectivity } from "../provider/connectivity.js";
import { getRouteLog } from "./route-log.js";
import type { HarnessProfile } from "./harness-profile.js";

export interface ProxyStatusTier {
  tier: ModelTier;
  available: boolean;
  configuredModel: string;
  effectiveModel: string;
  provider: string;
  baseUrl: string;
  endpointSource?: "primary" | "tier_fallback" | "premium_pool";
  fallbackReason?: string;
  latencyMs?: number;
  primaryError?: string;
  modelRegistered?: boolean;
}

export interface ProxyLitellmStatus {
  /** GET /v1/models succeeded on the LiteLLM gateway (no model-id check). */
  gatewayUp: boolean;
  /** At least one litellm tier primary passed full probe (catalog + configured model id). */
  reachable: boolean;
  baseUrl: string | null;
  processRunning: boolean;
  processDetail: string;
  configPath: string | null;
  knownConfigPaths: string[];
  catalogError?: string;
  catalogSample?: string[];
}

export async function buildProxyStatusPayload(opts: {
  config: RouterConfig;
  options: {
    mode?: RoutingMode;
    maxTier?: ModelTier;
    modelTier?: ModelTier;
    model?: string;
    alwaysPreferLocal?: boolean;
    sessionId?: string;
  };
  host: string;
  port: number;
  profile: HarnessProfile;
  ephemeralSessionId: string;
  version: string;
}): Promise<Record<string, unknown>> {
  const { config, options, host, port, profile, ephemeralSessionId, version } = opts;
  const probe = await probeAllTiers(config, { force: true });
  const connectivity = await resolveConnectivity(config, probe);

  const litellmEndpoint =
    config.models.hosted_oss?.primary.provider === "litellm"
      ? config.models.hosted_oss.primary
      : config.models.local_strong?.primary.provider === "litellm"
        ? config.models.local_strong.primary
        : undefined;

  const process = detectLitellmProcess();
  const knownConfigPaths = guessLitellmConfigPaths();
  const configPath = process.configPath ?? knownConfigPaths[0] ?? null;

  const catalog = litellmEndpoint
    ? await fetchModelCatalog(litellmEndpoint, 5000, { force: true })
    : null;

  const litellm: ProxyLitellmStatus = {
    gatewayUp: catalog?.ok ?? false,
    reachable: probe.tiers.some(
      (t) => t.primary.provider === "litellm" && t.primary.available
    ),
    baseUrl: litellmEndpoint?.baseUrl ?? null,
    processRunning: process.running,
    processDetail: process.detail,
    configPath,
    knownConfigPaths,
    ...(catalog && !catalog.ok && catalog.error ? { catalogError: catalog.error } : {}),
    ...(catalog?.ok && catalog.ids.length
      ? { catalogSample: catalog.ids.slice(0, 8) }
      : {}),
  };

  const tiers: ProxyStatusTier[] = TIER_ORDER.filter((tier) => config.models[tier]).map(
    (tier) => {
      const status = probe.tiers.find((t) => t.tier === tier);
      const configured = config.models[tier]!.primary;
      const effective = status?.effective?.endpoint ?? configured;
      return {
        tier,
        available: status?.available ?? false,
        configuredModel: configured.model,
        effectiveModel: effective.model,
        provider: effective.provider,
        baseUrl: effective.baseUrl,
        endpointSource: status?.effective?.source,
        fallbackReason: status?.effective?.fallbackReason,
        latencyMs: status?.primary.latencyMs,
        primaryError: status?.primary.error,
        modelRegistered: status?.primary.modelRegistered,
      };
    }
  );

  return {
    ok: true,
    service: "maestro-proxy",
    version,
    host,
    port,
    profile: profile.name,
    mode: options.mode ?? null,
    maxTier: options.maxTier ?? null,
    modelTier: options.modelTier ?? null,
    model: options.model ?? null,
    preferLocal: Boolean(options.alwaysPreferLocal || profile.stickyLocalBias),
    sessionId: options.sessionId ?? ephemeralSessionId,
    connectivity: {
      online: connectivity.online,
      reason: connectivity.reason,
      source: connectivity.source,
      localOnlyForced: connectivity.localOnlyForced,
    },
    litellm,
    tiers,
    recentRoutes: getRouteLog(),
  };
}
