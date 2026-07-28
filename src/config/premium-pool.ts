import type { ModelEndpointConfig, RouterConfig } from "../types.js";

/** True when an upstream error should rotate within the premium pool. */
export function isPremiumPoolRotationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (/expired|unauthorized|forbidden|invalid.?token|security token|sso|credential/i.test(msg)) {
    return true;
  }
  if (/\b(401|403|500|502|503|504)\b/.test(msg)) return true;
  if (/status\s*code\s*[45]\d\d/i.test(lower)) return true;
  return false;
}

/**
 * Endpoints to try for the premium tier: primary, tier fallback, then premiumPool.
 */
export function listPremiumEndpoints(config: RouterConfig): ModelEndpointConfig[] {
  const out: ModelEndpointConfig[] = [];
  const seen = new Set<string>();
  const add = (ep: ModelEndpointConfig | undefined) => {
    if (!ep) return;
    const key = `${ep.provider}|${ep.baseUrl}|${ep.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ep);
  };

  add(config.models.premium?.primary);
  add(config.models.premium?.fallback);
  for (const ep of config.premiumPool ?? []) add(ep);
  return out;
}

let poolCursor = 0;

/** Round-robin start index into the premium endpoint list. */
export function nextPremiumPoolIndex(length: number): number {
  if (length <= 0) return 0;
  const idx = poolCursor % length;
  poolCursor = (poolCursor + 1) % length;
  return idx;
}

export function resetPremiumPoolCursor(): void {
  poolCursor = 0;
}

export function orderPremiumEndpoints(
  endpoints: ModelEndpointConfig[],
  preferIndex?: number
): ModelEndpointConfig[] {
  if (endpoints.length <= 1) return endpoints;
  const start =
    preferIndex != null && preferIndex >= 0
      ? preferIndex % endpoints.length
      : nextPremiumPoolIndex(endpoints.length);
  return [...endpoints.slice(start), ...endpoints.slice(0, start)];
}
