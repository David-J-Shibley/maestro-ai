import { describe, expect, it } from "vitest";
import { buildDecisionExplanation } from "../src/routing/explanation.js";
import { applyRoutingPolicy, loadPolicyFromString } from "../src/config/policy.js";
import { routeTask } from "../src/router/model-router.js";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import type { RoutingDecision, TaskAnalysis } from "../src/types.js";

const BASE_ROUTING: RoutingDecision = {
  tier: "hosted_oss",
  model: "qwen3-coder-next",
  baseUrl: "http://localhost:4000/v1",
  provider: "litellm",
  reason: "medium coding",
  fallbackTier: "premium",
  debug: [
    "rule: medium difficulty coding or multi-step reasoning",
    "policy: task type \"code_edit\" → hosted_oss",
  ],
};

const BASE_ANALYSIS: TaskAnalysis = {
  taskType: "code_edit",
  difficulty: "medium",
  riskLevel: "low",
  requiresToolUse: false,
  requiresCodeReasoning: true,
  requiresLongContext: false,
  requiresStructuredOutput: false,
  confidence: 0.8,
  signals: ["taskType=code_edit", "code_reasoning"],
};

describe("buildDecisionExplanation", () => {
  it("produces markdown and why bullets", () => {
    const explanation = buildDecisionExplanation({
      routing: BASE_ROUTING,
      analysis: BASE_ANALYSIS,
      contextTokens: 5200,
      historical: {
        sampleSize: 42,
        successRate: 0.93,
        taskType: "code_edit",
        tier: "hosted_oss",
      },
      fallbackModel: "claude-sonnet-4-6",
    });

    expect(explanation.summary).toContain("qwen3-coder-next");
    expect(explanation.why.length).toBeGreaterThan(2);
    expect(explanation.markdown).toContain("🎼 Maestro Decision");
    expect(explanation.markdown).toContain("5,200");
    expect(explanation.markdown).toContain("93%");
    expect(explanation.markdown).toContain("42 similar tasks");
    expect(explanation.fallback?.tier).toBe("premium");
  });

  it("includes budget note when present", () => {
    const explanation = buildDecisionExplanation({
      routing: {
        ...BASE_ROUTING,
        budget: {
          session_id: "s1",
          budget_usd: 0.5,
          spent_usd: 0.12,
          remaining_usd: 0.38,
          cap_tier: "hosted_oss",
        },
      },
      analysis: BASE_ANALYSIS,
    });

    expect(explanation.budget_note).toContain("0.38");
    expect(explanation.markdown).toContain("Budget");
  });
});

describe("routing policy", () => {
  const POLICY = loadPolicyFromString(`{
    "task_type_tiers": { "architecture": "premium", "summarization": "local_strong" },
    "privacy": {
      "keywords": ["api_key", "password"],
      "max_tier": "local_strong",
      "reason": "Sensitive content stays local"
    },
    "sensitive_code_local_only": {
      "enabled": true,
      "max_tier": "local_strong",
      "reason": "High-risk code local only"
    }
  }`);

  it("overrides tier by task type", () => {
    const analysis = analyzeTask({ userPrompt: "Summarize this document." });
    const result = applyRoutingPolicy("local_fast", analysis, POLICY);
    expect(result.tier).toBe("local_strong");
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("caps tier on privacy keywords in prompt", () => {
    const analysis = analyzeTask({
      userPrompt: "Refactor the auth module that uses api_key from .env",
    });
    const result = applyRoutingPolicy("premium", analysis, POLICY, "api_key in prompt");
    expect(result.tier).not.toBe("premium");
    expect(result.tier).toBe("local_strong");
  });

  it("integrates policy in routeTask", () => {
    const config = loadConfigFromString(`{
      "models": {
        "local_fast": { "primary": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" } },
        "local_strong": { "primary": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1" } },
        "hosted_oss": { "primary": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1" } },
        "premium": { "primary": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1" } }
      },
      "routing": { "defaultTier": "local_strong", "maxRetriesPerTier": 1, "enableEscalation": true, "preferLocal": true, "longContextTokenThreshold": 32000, "probeAvailability": false },
      "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
    }`);
    config.policy = POLICY;

    const analysis = analyzeTask({
      userPrompt: "Refactor auth; api_key is in .env",
    });
    const decision = routeTask({
      analysis,
      config,
      userPrompt: "Refactor auth; api_key is in .env",
    });

    expect(decision.tier).toBe("local_strong");
    expect(decision.debug?.some((d) => d.includes("policy"))).toBe(true);
  });
});
