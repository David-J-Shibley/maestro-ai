import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelTier,
  PrivacyPolicyRule,
  RoutingPolicy,
  SensitiveCodePolicy,
  TaskAnalysis,
} from "../types.js";
import { capTier } from "../types.js";

export type { PrivacyPolicyRule, RoutingPolicy, SensitiveCodePolicy };

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PolicyApplication {
  tier: ModelTier;
  notes: string[];
}

export function defaultPolicyPath(): string {
  return join(__dirname, "..", "..", "config", "default.policy.json");
}

export function userPolicyPath(): string {
  return join(homedir(), ".maestro-ai", "policy.json");
}

export function resolvePolicyPath(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.MAESTRO_POLICY,
    userPolicyPath(),
    defaultPolicyPath(),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    const path = resolve(c);
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadPolicyFromString(json: string): RoutingPolicy {
  return JSON.parse(json) as RoutingPolicy;
}

export function loadPolicy(policyPath?: string): RoutingPolicy | null {
  const resolved = resolvePolicyPath(policyPath);
  if (!resolved) return null;
  return loadPolicyFromString(readFileSync(resolved, "utf8"));
}

export function applyRoutingPolicy(
  tier: ModelTier,
  analysis: TaskAnalysis,
  policy: RoutingPolicy | null | undefined,
  promptText?: string
): PolicyApplication {
  const notes: string[] = [];
  if (!policy) return { tier, notes };

  let result = tier;

  const taskOverride = policy.task_type_tiers?.[analysis.taskType];
  if (taskOverride && taskOverride !== result) {
    notes.push(`task type "${analysis.taskType}" → ${taskOverride}`);
    result = taskOverride;
  }

  if (policy.privacy?.keywords?.length) {
    const blob = [promptText ?? "", ...analysis.signals].join(" ").toLowerCase();
    const hit = policy.privacy.keywords.some((kw) => blob.includes(kw.toLowerCase()));
    if (hit) {
      const capped = capTier(result, policy.privacy.max_tier);
      if (capped !== result) {
        notes.push(policy.privacy.reason ?? `privacy keywords → max ${policy.privacy.max_tier}`);
        result = capped;
      }
    }
  }

  if (
    policy.sensitive_code_local_only?.enabled &&
    analysis.requiresCodeReasoning &&
    analysis.riskLevel === "high"
  ) {
    const capped = capTier(result, policy.sensitive_code_local_only.max_tier);
    if (capped !== result) {
      notes.push(
        policy.sensitive_code_local_only.reason ??
          "high-risk code stays on local tiers"
      );
      result = capped;
    }
  }

  return { tier: result, notes };
}
