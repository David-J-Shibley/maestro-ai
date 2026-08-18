import type { ModelEndpointConfig, ModelTier, RouterConfig } from "../types.js";
import { listEndpointsForTier } from "../config/tier-config.js";
import { TIER_ORDER } from "../types.js";

export interface ModelCatalogResult {
  ok: boolean;
  ids: string[];
  latencyMs?: number;
  error?: string;
}

export interface EndpointModelValidation {
  endpoint: ModelEndpointConfig;
  label: string;
  reachable: boolean;
  modelRegistered: boolean;
  latencyMs?: number;
  error?: string;
  /** Small sample of catalog ids for error messages. */
  catalogSample?: string[];
}

/** Whether a configured model id matches a gateway catalog entry. */
export function isModelInCatalog(model: string, catalogIds: string[]): boolean {
  const want = model.trim();
  if (!want || catalogIds.length === 0) return false;
  for (const listed of catalogIds) {
    if (modelsMatch(want, listed)) return true;
  }
  return false;
}

function modelsMatch(configured: string, listed: string): boolean {
  if (configured === listed) return true;
  if (configured.toLowerCase() === listed.toLowerCase()) return true;
  // Ollama tags: config "qwen3:8b" matches "qwen3:8b" or "qwen3:8b-suffix"
  if (listed.startsWith(`${configured}:`)) return true;
  if (configured.startsWith(`${listed}:`)) return true;
  if (listed.startsWith(`${configured}-`) || listed.startsWith(`${configured}.`)) {
    return true;
  }
  return false;
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const row of data) {
    if (row && typeof row === "object") {
      const id = (row as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

function catalogCacheKey(endpoint: ModelEndpointConfig): string {
  return `${endpoint.baseUrl}|${endpoint.apiKey ?? ""}`;
}

type CatalogCacheEntry = {
  expiresAt: number;
  value: ModelCatalogResult;
};

const catalogCache = new Map<string, CatalogCacheEntry>();
const CATALOG_SUCCESS_TTL_MS = 30_000;
/** Short TTL so a cold-start blip does not poison long-running proxy /status. */
const CATALOG_FAILURE_TTL_MS = 5_000;

function catalogCacheTtlMs(result: ModelCatalogResult): number {
  return result.ok ? CATALOG_SUCCESS_TTL_MS : CATALOG_FAILURE_TTL_MS;
}

/** Clear catalog cache (tests). */
export function clearModelCatalogCache(): void {
  catalogCache.clear();
}

/** Fetch model ids from an OpenAI-compatible GET /v1/models (or /models). */
export async function fetchModelCatalog(
  endpoint: ModelEndpointConfig,
  timeoutMs = 5000,
  options?: { force?: boolean }
): Promise<ModelCatalogResult> {
  const key = catalogCacheKey(endpoint);
  if (!options?.force) {
    const hit = catalogCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

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

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const result: ModelCatalogResult = {
        ok: false,
        ids: [],
        latencyMs,
        error: `HTTP ${response.status}`,
      };
      catalogCache.set(key, {
        expiresAt: Date.now() + catalogCacheTtlMs(result),
        value: result,
      });
      return result;
    }

    const json = (await response.json()) as unknown;
    const ids = parseModelIds(json);
    const result: ModelCatalogResult = { ok: true, ids, latencyMs };
    catalogCache.set(key, {
      expiresAt: Date.now() + catalogCacheTtlMs(result),
      value: result,
    });
    return result;
  } catch (err) {
    const result: ModelCatalogResult = {
      ok: false,
      ids: [],
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
    catalogCache.set(key, {
      expiresAt: Date.now() + catalogCacheTtlMs(result),
      value: result,
    });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function endpointLabel(tier: ModelTier, slot: "primary" | "fallback" | "pool", index: number): string {
  if (slot === "primary") return `${tier} primary`;
  if (slot === "fallback") return `${tier} fallback`;
  return `${tier} pool[${index}]`;
}

function slotForEndpoint(
  config: RouterConfig,
  tier: ModelTier,
  ep: ModelEndpointConfig,
  index: number
): "primary" | "fallback" | "pool" {
  const tc = config.models[tier];
  if (index === 0) return "primary";
  if (tc.fallback && ep.model === tc.fallback.model && ep.baseUrl === tc.fallback.baseUrl) {
    return "fallback";
  }
  return "pool";
}

/** Validate one endpoint: reachable and configured model is in the gateway catalog. */
export async function validateEndpointModel(
  endpoint: ModelEndpointConfig,
  timeoutMs = 5000
): Promise<EndpointModelValidation> {
  const catalog = await fetchModelCatalog(endpoint, timeoutMs);
  const base = {
    endpoint,
    label: `${endpoint.provider}/${endpoint.model}`,
    latencyMs: catalog.latencyMs,
    catalogSample: catalog.ids.slice(0, 8),
  };

  if (!catalog.ok) {
    return {
      ...base,
      reachable: false,
      modelRegistered: false,
      error: catalog.error ?? "catalog fetch failed",
    };
  }

  const registered = isModelInCatalog(endpoint.model, catalog.ids);
  if (!registered) {
    const sample =
      catalog.ids.length > 0
        ? catalog.ids.slice(0, 6).join(", ")
        : "(empty catalog)";
    return {
      ...base,
      reachable: true,
      modelRegistered: false,
      error: `model "${endpoint.model}" not in gateway catalog (saw: ${sample})`,
    };
  }

  return {
    ...base,
    reachable: true,
    modelRegistered: true,
  };
}

/** Validate every unique endpoint in config (for doctor / proxy startup). */
export async function validateConfiguredModels(
  config: RouterConfig,
  timeoutMs = 5000
): Promise<EndpointModelValidation[]> {
  const out: EndpointModelValidation[] = [];
  const seen = new Set<string>();

  for (const tier of TIER_ORDER) {
    const endpoints = listEndpointsForTier(config, tier);
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i]!;
      const key = `${ep.provider}|${ep.baseUrl}|${ep.model}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const slot = slotForEndpoint(config, tier, ep, i);
      const validation = await validateEndpointModel(ep, timeoutMs);
      out.push({ ...validation, label: endpointLabel(tier, slot, i) });
    }
  }

  return out;
}

export function formatValidationIssue(v: EndpointModelValidation): string {
  if (!v.reachable) {
    return `${v.label}: ${v.endpoint.provider}/${v.endpoint.model} unreachable (${v.error})`;
  }
  if (!v.modelRegistered) {
    return `${v.label}: ${v.error}`;
  }
  return "";
}
