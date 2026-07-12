import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { applyGuardrails } from "../src/routing/guardrails.js";
import { buildDecisionExplanation } from "../src/routing/explanation.js";
import { routeTask } from "../src/router/model-router.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import { loadPolicyFromString } from "../src/config/policy.js";
import type { ModelTier, RouterConfig } from "../src/types.js";
import type { TierProbeStatus } from "../src/provider/probe.js";

const CONFIG_JSON = `{
  "models": {
    "local_fast": { "primary": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" } },
    "local_strong": { "primary": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1" } },
    "hosted_oss": { "primary": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1" } },
    "premium": { "primary": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1" } }
  },
  "routing": {
    "defaultTier": "local_strong",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`;

const POLICY = loadPolicyFromString(`{
  "privacy": {
    "keywords": ["api_key"],
    "max_tier": "local_strong",
    "reason": "Sensitive content stays local"
  },
  "guardrails": {
    "budget": { "enabled": true, "warn_remaining_usd": 0.10 },
    "privacy": { "enabled": true, "block_cloud": true },
    "latency": { "enabled": true, "target_ms": 8000, "prefer_faster_tier": true }
  }
}`);

function config(): RouterConfig {
  const c = loadConfigFromString(CONFIG_JSON);
  c.policy = POLICY;
  return c;
}

function probeMap(latencies: Partial<Record<ModelTier, number>>): Map<ModelTier, TierProbeStatus> {
  const map = new Map<ModelTier, TierProbeStatus>();
  for (const [tier, latencyMs] of Object.entries(latencies) as [ModelTier, number][]) {
    map.set(tier, {
      tier,
      available: true,
      primary: {
        tier,
        slot: "primary",
        available: true,
        latencyMs,
        model: tier,
        provider: "ollama",
      },
    });
  }
  return map;
}

describe("applyGuardrails", () => {
  it("warns on low session budget", () => {
    const analysis = analyzeTask({ userPrompt: "Summarize this." });
    const result = applyGuardrails({
      tier: "hosted_oss",
      analysis,
      policy: POLICY,
      budget: {
        sessionId: "s1",
        budgetUsd: 0.5,
        spentUsd: 0.45,
        remainingUsd: 0.05,
        capTier: "hosted_oss",
        enforced: true,
      },
    });

    expect(result.results.some((r) => r.kind === "budget" && r.action === "warn")).toBe(
      true
    );
  });

  it("blocks cloud on privacy keyword match", () => {
    const analysis = analyzeTask({
      userPrompt: "Refactor module that reads api_key from env",
    });
    const result = applyGuardrails({
      tier: "premium",
      analysis,
      policy: POLICY,
      userPrompt: "Refactor module that reads api_key from env",
    });

    expect(result.tier).toBe("local_strong");
    expect(result.results.some((r) => r.kind === "privacy" && r.action === "block")).toBe(
      true
    );
  });

  it("prefers faster tier when latency exceeds target", () => {
    const analysis = analyzeTask({
      userPrompt: "Summarize this paragraph in two sentences.",
    });
    const result = applyGuardrails({
      tier: "local_strong",
      analysis,
      policy: POLICY,
      tierStatuses: probeMap({
        local_fast: 40,
        local_strong: 12000,
        hosted_oss: 50,
        premium: 60,
      }),
    });

    expect(result.tier).toBe("local_fast");
    expect(result.results.some((r) => r.kind === "latency" && r.action === "cap")).toBe(
      true
    );
  });
});

describe("guardrails in routing report", () => {
  it("includes guardrails in explanation markdown", () => {
    const analysis = analyzeTask({
      userPrompt: "Summarize with api_key in the prompt",
    });
    const decision = routeTask({
      analysis,
      config: config(),
      userPrompt: "Summarize with api_key in the prompt",
      tierStatuses: probeMap({ local_fast: 30, local_strong: 40, hosted_oss: 50, premium: 60 }),
    });

    const explanation = buildDecisionExplanation({ routing: decision, analysis });
    expect(decision.guardrails?.length).toBeGreaterThan(0);
    expect(explanation.markdown).toContain("**Guardrails**");
  });
});
