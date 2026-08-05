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

export interface StickyPreferenceOpts {
  requiresToolUse: boolean;
  difficulty: string;
  riskLevel: string;
  taskType?: string;
  /**
   * When true (default), avoid soft cloud→cloud downgrades within a session
   * so provider prefix caches stay warm.
   */
  cacheAwareSticky?: boolean;
}

/**
 * Prefer sticky local for easy / tools-omittable turns.
 * Optionally keep the last cloud tier when the new route would only soft-downgrade
 * between hosted_oss and premium (cache-aware stickiness).
 */
export function applyStickyTierPreference(
  tier: ModelTier,
  sticky: ModelTier | undefined,
  opts: StickyPreferenceOpts
): { tier: ModelTier; applied: boolean; kind?: "local" | "cache" } {
  if (!sticky) return { tier, applied: false };

  // Local sticky — pin easy / low-risk / tools-omittable turns to last local tier.
  if (
    isLocalTier(sticky) &&
    !opts.requiresToolUse &&
    opts.difficulty === "easy" &&
    opts.riskLevel === "low"
  ) {
    return { tier: sticky, applied: sticky !== tier, kind: "local" };
  }

  const cacheAware = opts.cacheAwareSticky !== false;
  if (!cacheAware || isLocalTier(sticky)) {
    return { tier, applied: false };
  }

  // Cloud sticky (cache-aware): upgrades always win; leave for intentional local;
  // soft cloud→cloud downgrades stay on sticky to preserve prefix cache.
  const stickyIdx = tierIndex(sticky);
  const proposedIdx = tierIndex(tier);
  if (proposedIdx < 0 || stickyIdx < 0) return { tier, applied: false };
  if (proposedIdx >= stickyIdx) return { tier, applied: false };

  // Allow leaving cloud for local (cost / privacy / offline) — no shared cache anyway.
  if (isLocalTier(tier)) {
    return { tier, applied: false };
  }

  // Soft cloud→cloud downgrade (e.g. premium → hosted_oss): keep sticky.
  return { tier: sticky, applied: sticky !== tier, kind: "cache" };
}

function tierIndex(tier: ModelTier): number {
  const order: ModelTier[] = ["local_fast", "local_strong", "hosted_oss", "premium"];
  return order.indexOf(tier);
}

export function clearStickyStore(): void {
  store.clear();
}
