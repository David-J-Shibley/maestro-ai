import { describe, expect, it, beforeEach } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { routeTask } from "../src/router/model-router.js";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import {
  applyStickyTierPreference,
  clearStickyStore,
  getStickyTier,
  setStickyTier,
} from "../src/proxy/session-sticky.js";
import { applyWorkloadRole, isWorkloadRole } from "../src/routing/workload.js";
import type { RouterConfig, TaskAnalysis } from "../src/types.js";

const BASE_CONFIG = `{
  "models": {
    "local_fast": { "provider": "ollama", "model": "llama3.2:latest", "baseUrl": "http://localhost:11434/v1" },
    "local_strong": { "provider": "litellm", "model": "glm", "baseUrl": "http://localhost:4000/v1", "apiKey": "test" },
    "hosted_oss": { "provider": "litellm", "model": "qwen3-coder-next", "baseUrl": "http://localhost:4000/v1", "apiKey": "test" },
    "premium": { "provider": "litellm", "model": "bedrock/global.anthropic.claude-sonnet-4-6", "baseUrl": "http://localhost:4000/v1", "apiKey": "test" }
  },
  "routing": {
    "defaultTier": "local_strong",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/test-telemetry.jsonl" }
}`;

function config(extra?: Partial<RouterConfig["routing"]>): RouterConfig {
  const c = loadConfigFromString(BASE_CONFIG);
  if (extra) c.routing = { ...c.routing, ...extra };
  return c;
}

function baseAnalysis(over: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    taskType: "code_edit",
    difficulty: "medium",
    riskLevel: "low",
    requiresToolUse: false,
    toolNeedScore: 0.2,
    requiresCodeReasoning: true,
    requiresLongContext: false,
    requiresStructuredOutput: false,
    confidence: 0.8,
    signals: [],
    ...over,
  };
}

describe("workload roles", () => {
  it("recognizes workload roles", () => {
    expect(isWorkloadRole("orchestrator")).toBe(true);
    expect(isWorkloadRole("nope")).toBe(false);
  });

  it("floors orchestrator to hosted_oss", () => {
    const r = applyWorkloadRole("local_fast", "orchestrator", baseAnalysis());
    expect(r.tier).toBe("hosted_oss");
  });

  it("caps formatter at local_strong", () => {
    const r = applyWorkloadRole("premium", "formatter", baseAnalysis({ difficulty: "easy" }));
    expect(r.tier).toBe("local_strong");
  });

  it("routes with workload=orchestrator via routeTask", () => {
    const analysis = analyzeTask({
      userPrompt: "Rewrite this paragraph more clearly.",
      taskHints: { workload: "orchestrator" },
    });
    const decision = routeTask({
      analysis,
      config: config(),
      taskHints: { workload: "orchestrator" },
    });
    expect(["hosted_oss", "premium"]).toContain(decision.tier);
    expect(decision.reason).toMatch(/workload:orchestrator/);
  });

  it("routes with workload=formatter toward local", () => {
    const analysis = analyzeTask({
      userPrompt: "Format this list as markdown bullets.",
      taskHints: { workload: "formatter" },
    });
    const decision = routeTask({
      analysis,
      config: config(),
      taskHints: { workload: "formatter" },
    });
    expect(["local_fast", "local_strong"]).toContain(decision.tier);
  });
});

describe("cache-aware sticky", () => {
  beforeEach(() => clearStickyStore());

  it("keeps premium sticky on soft hosted_oss downgrade", () => {
    const r = applyStickyTierPreference("hosted_oss", "premium", {
      requiresToolUse: false,
      difficulty: "medium",
      riskLevel: "low",
      cacheAwareSticky: true,
    });
    expect(r.applied).toBe(true);
    expect(r.kind).toBe("cache");
    expect(r.tier).toBe("premium");
  });

  it("allows leaving cloud sticky for easy local", () => {
    const r = applyStickyTierPreference("local_strong", "premium", {
      requiresToolUse: false,
      difficulty: "easy",
      riskLevel: "low",
      cacheAwareSticky: true,
    });
    expect(r.applied).toBe(false);
    expect(r.tier).toBe("local_strong");
  });

  it("allows upgrades above sticky", () => {
    const r = applyStickyTierPreference("premium", "hosted_oss", {
      requiresToolUse: false,
      difficulty: "hard",
      riskLevel: "high",
      cacheAwareSticky: true,
    });
    expect(r.applied).toBe(false);
    expect(r.tier).toBe("premium");
  });

  it("disables cache-aware when config says false", () => {
    const r = applyStickyTierPreference("hosted_oss", "premium", {
      requiresToolUse: false,
      difficulty: "medium",
      riskLevel: "low",
      cacheAwareSticky: false,
    });
    expect(r.applied).toBe(false);
    expect(r.tier).toBe("hosted_oss");
  });

  it("still prefers local sticky for easy turns", () => {
    setStickyTier("s-cache", "local_strong");
    expect(getStickyTier("s-cache")).toBe("local_strong");
    const r = applyStickyTierPreference("hosted_oss", "local_strong", {
      requiresToolUse: false,
      difficulty: "easy",
      riskLevel: "low",
    });
    expect(r.applied).toBe(true);
    expect(r.kind).toBe("local");
    expect(r.tier).toBe("local_strong");
  });

  it("routeTask applies cache-aware sticky from session", () => {
    const analysis = analyzeTask({
      userPrompt: "Refactor this medium module and add types.",
    });
    // Without sticky, medium coding often lands on hosted_oss.
    const baseline = routeTask({ analysis, config: config() });
    expect(baseline.tier).not.toBe("premium");

    const sticky = routeTask({
      analysis,
      config: config(),
      overrides: { session: { sessionId: "s1", stickyTier: "premium" } },
    });
    expect(sticky.tier).toBe("premium");
    expect(sticky.debug?.some((d) => d.includes("sticky"))).toBe(true);
  });

  it("routeTask skips cache sticky when disabled", () => {
    const analysis = analyzeTask({
      userPrompt: "Refactor this medium module and add types.",
    });
    const decision = routeTask({
      analysis,
      config: config({ cacheAwareSticky: false }),
      overrides: { session: { sessionId: "s1", stickyTier: "premium" } },
    });
    expect(decision.tier).not.toBe("premium");
  });
});
