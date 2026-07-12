import type {
  ModelTier,
  RouterConfig,
  RouterOverrides,
  RoutingConfig,
  SessionPolicy,
  TaskAnalysis,
} from "../types.js";
import { capTier, floorTier, TIER_ORDER } from "../types.js";
import { tierMeetsTask } from "./tier-fit.js";

export const ROUTING_MODES = [
  "balanced",
  "local-only",
  "cheapest",
  "fastest",
  "best-quality",
  "private",
] as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];

export const DEFAULT_ROUTING_MODE: RoutingMode = "balanced";

export interface ModeProfile {
  id: RoutingMode;
  label: string;
  description: string;
}

export const MODE_PROFILES: ModeProfile[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Default heuristics — cost-aware with escalation when validation fails",
  },
  {
    id: "local-only",
    label: "Local only",
    description: "Never route above local_strong — all inference stays on localhost",
  },
  {
    id: "cheapest",
    label: "Cheapest",
    description: "Minimize cost — prefer local tiers and nudge down when the task allows",
  },
  {
    id: "fastest",
    label: "Fastest",
    description: "Minimize latency — favor local_fast, skip same-tier retries",
  },
  {
    id: "best-quality",
    label: "Best quality",
    description: "Maximize output quality — allow premium, bias toward higher tiers",
  },
  {
    id: "private",
    label: "Private",
    description: "Strict privacy — localhost only, sensitive-content rules enforced",
  },
];

export interface ModeConstraints {
  mode: RoutingMode;
  maxTier?: ModelTier;
  minTier?: ModelTier;
  preferLocal?: boolean;
  premiumOnly?: boolean;
  enableEscalation?: boolean;
  maxRetriesPerTier?: number;
  /** Nudge tier selection toward the low or high end when rules allow. */
  tierPreference?: "lowest" | "highest" | "balanced";
  enforcePrivacyPolicy?: boolean;
  notes: string[];
}

export function isRoutingMode(value: string): value is RoutingMode {
  return (ROUTING_MODES as readonly string[]).includes(value);
}

export function resolveActiveMode(
  overrides?: RouterOverrides,
  config?: RouterConfig
): RoutingMode {
  return overrides?.mode ?? config?.routing.defaultMode ?? DEFAULT_ROUTING_MODE;
}

export function resolveModeConstraints(mode: RoutingMode): ModeConstraints {
  switch (mode) {
    case "balanced":
      return { mode, tierPreference: "balanced", notes: [] };

    case "local-only":
      return {
        mode,
        maxTier: "local_strong",
        preferLocal: true,
        tierPreference: "balanced",
        notes: [],
      };

    case "cheapest":
      return {
        mode,
        maxTier: "local_strong",
        preferLocal: true,
        tierPreference: "lowest",
        notes: [],
      };

    case "fastest":
      return {
        mode,
        preferLocal: true,
        tierPreference: "lowest",
        maxRetriesPerTier: 0,
        notes: [],
      };

    case "best-quality":
      return {
        mode,
        maxTier: "premium",
        minTier: "hosted_oss",
        preferLocal: false,
        tierPreference: "highest",
        notes: [],
      };

    case "private":
      return {
        mode,
        maxTier: "local_strong",
        preferLocal: true,
        enforcePrivacyPolicy: true,
        tierPreference: "lowest",
        notes: [],
      };

    default:
      return { mode: "balanced", tierPreference: "balanced", notes: [] };
  }
}

/** Merge mode constraints into overrides and routing config for a single call. */
export function applyModeToRuntime(
  mode: RoutingMode,
  config: RouterConfig,
  overrides: RouterOverrides = {}
): {
  mode: RoutingMode;
  constraints: ModeConstraints;
  overrides: RouterOverrides;
  routing: RoutingConfig;
} {
  const constraints = resolveModeConstraints(mode);
  const routing = { ...config.routing };
  const merged: RouterOverrides = { ...overrides, mode };

  if (constraints.preferLocal !== undefined) {
    merged.preferLocal = constraints.preferLocal;
  }
  if (constraints.premiumOnly) {
    merged.premiumOnly = true;
  }
  if (constraints.maxRetriesPerTier !== undefined) {
    routing.maxRetriesPerTier = constraints.maxRetriesPerTier;
  }
  if (constraints.enableEscalation !== undefined) {
    routing.enableEscalation = constraints.enableEscalation;
  }

  const session: SessionPolicy = { ...overrides.session };
  if (constraints.maxTier) {
    session.maxTier = session.maxTier
      ? capTier(constraints.maxTier, session.maxTier)
      : constraints.maxTier;
  }
  if (constraints.preferLocal) {
    session.alwaysPreferLocal = true;
  }
  merged.session = Object.keys(session).length ? session : overrides.session;

  return { mode, constraints, overrides: merged, routing };
}

export function applyModeToTier(
  tier: ModelTier,
  analysis: TaskAnalysis,
  constraints: ModeConstraints
): { tier: ModelTier; notes: string[] } {
  const notes: string[] = [];
  let adjusted = tier;

  if (constraints.maxTier) {
    const capped = capTier(adjusted, constraints.maxTier);
    if (capped !== adjusted) {
      notes.push(`Capped ${adjusted} → ${capped} (${constraints.mode} max tier)`);
      adjusted = capped;
    }
  }

  if (constraints.minTier && requiresHigherTier(analysis, constraints.minTier)) {
    const floored = floorTier(adjusted, constraints.minTier);
    if (floored !== adjusted) {
      notes.push(`Raised ${adjusted} → ${floored} for task requirements`);
      adjusted = floored;
    }
  }

  if (constraints.tierPreference === "lowest") {
    const lowered = nudgeTierDown(adjusted, analysis, constraints.maxTier);
    if (lowered !== adjusted) {
      notes.push(`Nudged ${adjusted} → ${lowered} (lowest viable tier)`);
      adjusted = lowered;
    }
  } else if (constraints.tierPreference === "highest") {
    const raised = nudgeTierUp(adjusted, analysis, constraints.maxTier);
    if (raised !== adjusted) {
      notes.push(`Nudged ${adjusted} → ${raised} (highest allowed tier)`);
      adjusted = raised;
    }
  }

  return { tier: adjusted, notes };
}

export function canEscalateWithinMode(
  nextTier: ModelTier,
  constraints: ModeConstraints
): boolean {
  if (!constraints.maxTier) return true;
  const nextIdx = TIER_ORDER.indexOf(nextTier);
  const maxIdx = TIER_ORDER.indexOf(constraints.maxTier);
  return nextIdx >= 0 && maxIdx >= 0 && nextIdx <= maxIdx;
}

function requiresHigherTier(analysis: TaskAnalysis, minTier: ModelTier): boolean {
  if (minTier !== "hosted_oss" && minTier !== "premium") return false;
  return (
    analysis.requiresCodeReasoning &&
    ["code_edit", "debugging", "refactoring", "multi_step", "tool_use"].includes(
      analysis.taskType
    )
  );
}

function nudgeTierDown(
  tier: ModelTier,
  analysis: TaskAnalysis,
  maxTier?: ModelTier
): ModelTier {
  const idx = TIER_ORDER.indexOf(tier);
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = TIER_ORDER[i];
    if (!candidate) continue;
    if (maxTier && TIER_ORDER.indexOf(candidate) > TIER_ORDER.indexOf(maxTier)) continue;
    if (tierMeetsTask(analysis, candidate)) return candidate;
  }
  return tier;
}

function nudgeTierUp(
  tier: ModelTier,
  analysis: TaskAnalysis,
  maxTier?: ModelTier
): ModelTier {
  const ceiling = maxTier ?? "premium";
  const idx = TIER_ORDER.indexOf(tier);
  const maxIdx = TIER_ORDER.indexOf(ceiling);
  for (let i = idx + 1; i <= maxIdx; i++) {
    const candidate = TIER_ORDER[i];
    if (!candidate) continue;
    if (tierMeetsTask(analysis, candidate)) return candidate;
  }
  return tier;
}

export function getModeProfile(mode: RoutingMode): ModeProfile {
  return MODE_PROFILES.find((p) => p.id === mode) ?? MODE_PROFILES[0]!;
}
