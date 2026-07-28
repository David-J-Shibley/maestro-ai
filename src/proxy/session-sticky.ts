import type { ModelTier } from "../types.js";
import { isLocalTier } from "../types.js";

const STICKY_TTL_MS = 30 * 60 * 1000;

export interface StickyEntry {
  lastTier: ModelTier;
  lastAt: number;
}

const store = new Map<string, StickyEntry>();

export function getStickyTier(sessionId: string | undefined): ModelTier | undefined {
  if (!sessionId) return undefined;
  const entry = store.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.lastAt > STICKY_TTL_MS) {
    store.delete(sessionId);
    return undefined;
  }
  return entry.lastTier;
}

export function setStickyTier(sessionId: string | undefined, tier: ModelTier): void {
  if (!sessionId) return;
  store.set(sessionId, { lastTier: tier, lastAt: Date.now() });
}

/** Prefer sticky local tier for easy / tools-omittable turns. */
export function applyStickyTierPreference(
  tier: ModelTier,
  sticky: ModelTier | undefined,
  opts: { requiresToolUse: boolean; difficulty: string; riskLevel: string }
): { tier: ModelTier; applied: boolean } {
  if (!sticky) return { tier, applied: false };
  if (opts.requiresToolUse) return { tier, applied: false };
  if (opts.difficulty !== "easy" || opts.riskLevel !== "low") {
    return { tier, applied: false };
  }
  // Only stick to local tiers — don't pin on premium from a prior hard turn.
  if (!isLocalTier(sticky)) return { tier, applied: false };
  return { tier: sticky, applied: sticky !== tier };
}

export function clearStickyStore(): void {
  store.clear();
}
