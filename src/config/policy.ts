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

/** Common credential / secret shapes — used when privacy.detect_secrets is enabled (default). */
export const SECRET_PATTERNS: RegExp[] = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS access key id
  /\bsk-(?:live|test|proj)-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:postgres|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@/i,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/,
];

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

  if (policy.privacy?.keywords?.length || policy.privacy?.detect_secrets !== false) {
    const blob = [promptText ?? "", ...analysis.signals].join(" ");
    const blobLower = blob.toLowerCase();
    const keywordHit = (policy.privacy?.keywords ?? []).some((kw) =>
      blobLower.includes(kw.toLowerCase())
    );
    const secretHit =
      policy.privacy?.detect_secrets !== false && SECRET_PATTERNS.some((re) => re.test(blob));
    if (keywordHit || secretHit) {
      const maxTier = policy.privacy?.max_tier ?? "local_strong";
      const capped = capTier(result, maxTier);
      if (capped !== result) {
        notes.push(
          policy.privacy?.reason ??
            (secretHit
              ? `secret/credential pattern → max ${maxTier}`
              : `privacy keywords → max ${maxTier}`)
        );
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
