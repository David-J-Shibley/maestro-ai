import type { ModelTier, TaskAnalysis, WorkloadRole } from "../types.js";
import { capTier, floorTier } from "../types.js";

export const WORKLOAD_ROLES = [
  "orchestrator",
  "research",
  "coder",
  "formatter",
  "critic",
  "extractor",
] as const;

export function isWorkloadRole(value: string): value is WorkloadRole {
  return (WORKLOAD_ROLES as readonly string[]).includes(value);
}

/**
 * Apply explicit workload/role floors and caps.
 * Orchestration-style roles bias toward stable cloud tiers; formatter/extractor stay local-leaning.
 */
export function applyWorkloadRole(
  tier: ModelTier,
  workload: WorkloadRole | undefined,
  analysis: TaskAnalysis
): { tier: ModelTier; notes: string[] } {
  if (!workload) return { tier, notes: [] };

  switch (workload) {
    case "orchestrator": {
      const next = floorTier(tier, "hosted_oss");
      return {
        tier: next,
        notes:
          next !== tier
            ? [`workload:orchestrator floor → ${next}`]
            : [`workload:orchestrator (tier ${tier})`],
      };
    }
    case "research": {
      const next = floorTier(tier, "hosted_oss");
      return {
        tier: next,
        notes:
          next !== tier
            ? [`workload:research floor → ${next}`]
            : [`workload:research (tier ${tier})`],
      };
    }
    case "critic": {
      const next = floorTier(tier, "hosted_oss");
      return {
        tier: next,
        notes:
          next !== tier
            ? [`workload:critic floor → ${next}`]
            : [`workload:critic (tier ${tier})`],
      };
    }
    case "coder": {
      const floor: ModelTier =
        analysis.difficulty === "hard" ||
        analysis.riskLevel === "high" ||
        analysis.taskType === "architecture"
          ? "hosted_oss"
          : "local_strong";
      const next = floorTier(tier, floor);
      return {
        tier: next,
        notes:
          next !== tier
            ? [`workload:coder floor → ${next}`]
            : [`workload:coder (tier ${tier})`],
      };
    }
    case "formatter": {
      const next =
        analysis.riskLevel === "high"
          ? tier
          : capTier(tier, "local_strong");
      return {
        tier: next,
        notes:
          next !== tier
            ? [`workload:formatter cap → ${next}`]
            : [`workload:formatter (tier ${tier})`],
      };
    }
    case "extractor": {
      let next = floorTier(tier, "local_strong");
      if (analysis.riskLevel !== "high" && analysis.difficulty !== "hard") {
        next = capTier(next, "hosted_oss");
      }
      return {
        tier: next,
        notes:
          next !== tier
            ? [`workload:extractor → ${next}`]
            : [`workload:extractor (tier ${tier})`],
      };
    }
    default:
      return { tier, notes: [] };
  }
}
