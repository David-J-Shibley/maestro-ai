import type { ModelTier } from "../types.js";
import { TIER_ORDER } from "../types.js";
import type { TierProbeStatus } from "../provider/probe.js";

export interface ProbeSummaryInput {
  unavailable?: Set<ModelTier> | ModelTier[];
  tiers?: TierProbeStatus[];
}

/** One-line probe summary for CLI --debug (full JSON available via --json). */
export function formatProbeSummary(probe: ProbeSummaryInput): string {
  const unavailable = normalizeUnavailable(probe.unavailable);
  const tierRows = buildTierRows(probe.tiers);

  if (tierRows.length === 0) {
    const up = TIER_ORDER.length - unavailable.size;
    return `Probe: ${up}/${TIER_ORDER.length} tiers up`;
  }

  const parts = tierRows.map((row) => {
    const mark = row.available ? "✓" : "✗";
    const latency =
      row.latencyMs !== undefined ? `${row.latencyMs}ms` : "n/a";
    const slot = row.slot !== "primary" ? ` ${row.slot}` : "";
    return `${row.tier}${slot} ${latency}${mark}`;
  });

  const fastest = tierRows
    .filter((r) => r.available && r.latencyMs !== undefined)
    .sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))[0];

  let summary = `Probe: ${parts.join(" | ")}`;
  if (fastest) {
    summary += ` | fastest: ${fastest.tier} (${fastest.latencyMs}ms)`;
  }
  return summary;
}

function normalizeUnavailable(
  unavailable?: Set<ModelTier> | ModelTier[]
): Set<ModelTier> {
  if (!unavailable) return new Set();
  if (unavailable instanceof Set) return unavailable;
  return new Set(unavailable);
}

function buildTierRows(
  tiers?: TierProbeStatus[]
): Array<{
  tier: ModelTier;
  slot: "primary" | "fallback";
  available: boolean;
  latencyMs?: number;
}> {
  if (!tiers?.length) return [];

  const rows: Array<{
    tier: ModelTier;
    slot: "primary" | "fallback";
    available: boolean;
    latencyMs?: number;
  }> = [];

  for (const status of tiers) {
    rows.push({
      tier: status.tier,
      slot: "primary",
      available: status.primary.available,
      latencyMs: status.primary.latencyMs,
    });
    if (status.fallback) {
      rows.push({
        tier: status.tier,
        slot: "fallback",
        available: status.fallback.available,
        latencyMs: status.fallback.latencyMs,
      });
    }
  }

  return rows.sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
  );
}
