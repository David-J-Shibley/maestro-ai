import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import { routeTask } from "../src/router/model-router.js";
import {
  applyModeToRuntime,
  canEscalateWithinMode,
  getModeProfile,
  resolveModeConstraints,
} from "../src/routing/modes.js";
import { computeTelemetryStats } from "../src/telemetry/stats.js";
import type { TelemetryRecord } from "../src/types.js";

const CONFIG_JSON = `{
  "models": {
    "local_fast": { "primary": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" } },
    "local_strong": { "primary": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1" } },
    "hosted_oss": { "primary": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1" } },
    "premium": { "primary": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1" } }
  },
  "routing": {
    "defaultTier": "local_strong",
    "defaultMode": "balanced",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`;

function config() {
  return loadConfigFromString(CONFIG_JSON);
}

describe("routing modes", () => {
  it("exposes all operator modes", () => {
    expect(getModeProfile("local-only").label).toBe("Local only");
    expect(getModeProfile("best-quality").description).toContain("quality");
  });

  it("local-only caps architecture tasks to local_strong", () => {
    const analysis = analyzeTask({
      userPrompt: "Design the architecture for a distributed task queue with trade-offs.",
    });
    const decision = routeTask({
      analysis,
      config: config(),
      overrides: { mode: "local-only" },
      userPrompt: "Design the architecture for a distributed task queue with trade-offs.",
    });

    expect(decision.tier).toBe("local_strong");
    expect(decision.mode).toBe("local-only");
    expect(decision.debug?.some((d) => d.includes("mode"))).toBe(true);
  });

  it("best-quality routes architecture to premium", () => {
    const analysis = analyzeTask({
      userPrompt: "Design the architecture for a distributed task queue with trade-offs.",
    });
    const decision = routeTask({
      analysis,
      config: config(),
      overrides: { mode: "best-quality" },
      userPrompt: "Design the architecture for a distributed task queue with trade-offs.",
    });

    expect(decision.tier).toBe("premium");
    expect(decision.mode).toBe("best-quality");
  });

  it("cheapest nudges summarization toward local_fast", () => {
    const analysis = analyzeTask({
      userPrompt: "Summarize this paragraph in two sentences.",
    });
    const decision = routeTask({
      analysis,
      config: config(),
      overrides: { mode: "cheapest" },
      userPrompt: "Summarize this paragraph in two sentences.",
    });

    expect(decision.tier).toBe("local_fast");
    expect(decision.mode).toBe("cheapest");
  });

  it("fastest sets maxRetriesPerTier to 0 in runtime", () => {
    const runtime = applyModeToRuntime("fastest", config());
    expect(runtime.routing.maxRetriesPerTier).toBe(0);
    expect(runtime.overrides.preferLocal).toBe(true);
  });

  it("blocks cloud escalation in local-only mode", () => {
    const constraints = resolveModeConstraints("local-only");
    expect(canEscalateWithinMode("hosted_oss", constraints)).toBe(false);
    expect(canEscalateWithinMode("local_strong", constraints)).toBe(true);
  });

  it("tracks mode success rates in telemetry stats", () => {
    const record = (overrides: Partial<TelemetryRecord>): TelemetryRecord => ({
      id: "x",
      timestamp: "2026-01-01",
      promptHash: "h",
      taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
      selectedTier: "local_fast",
      selectedModel: "fast",
      latencyMs: 100,
      success: true,
      routingReason: "ok",
      attempts: 1,
      ...overrides,
    });

    const stats = computeTelemetryStats([
      record({ id: "1", mode: "cheapest", success: true }),
      record({ id: "2", mode: "cheapest", success: false }),
      record({ id: "3", mode: "balanced", success: true }),
    ]);

    expect(stats.modeDistribution.cheapest).toBe(2);
    expect(stats.modeDistribution.balanced).toBe(1);
    expect(stats.modeSuccessRates.cheapest?.successRate).toBe(0.5);
    expect(stats.modeSuccessRates.balanced?.successRate).toBe(1);
  });
});
