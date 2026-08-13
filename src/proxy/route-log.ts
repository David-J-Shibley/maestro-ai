import type { ModelTier } from "../types.js";
import { setStickyTier } from "./session-sticky.js";

export interface RouteLogEntry {
  at: string;
  ask?: string;
  tier?: string;
  model?: string;
  plain?: boolean;
  toolsOmitted?: number;
  latencyMs?: number;
  coerced?: boolean;
  plainRetry?: boolean;
  contextRetry?: boolean;
  outcome?: string;
}

const MAX = 30;
const buffer: RouteLogEntry[] = [];

export function pushRouteLog(entry: RouteLogEntry): void {
  buffer.push(entry);
  while (buffer.length > MAX) buffer.shift();
}

/** Record a completed proxy route for /status and session sticky. */
export function recordProxyRoute(opts: {
  sessionId?: string;
  ask?: string;
  tier: ModelTier | string;
  model: string;
  started: number;
  plain?: boolean;
  toolsOmitted?: number;
  coerced?: boolean;
  plainRetry?: boolean;
  contextRetry?: boolean;
  outcome?: string;
}): void {
  if (opts.sessionId) {
    setStickyTier(opts.sessionId, opts.tier as ModelTier);
  }
  pushRouteLog({
    at: new Date().toISOString(),
    ask: opts.ask?.slice(0, 80),
    tier: String(opts.tier),
    model: opts.model,
    plain: opts.plain,
    toolsOmitted: opts.toolsOmitted,
    latencyMs: Date.now() - opts.started,
    coerced: opts.coerced,
    plainRetry: opts.plainRetry,
    contextRetry: opts.contextRetry,
    outcome: opts.outcome ?? "ok",
  });
}

export function getRouteLog(): RouteLogEntry[] {
  return [...buffer];
}

export function clearRouteLog(): void {
  buffer.length = 0;
}
