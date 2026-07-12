import { describe, expect, it } from "vitest";
import { computeTelemetryStats } from "../src/telemetry/stats.js";
import type { TelemetryRecord } from "../src/types.js";

function record(overrides: Partial<TelemetryRecord>): TelemetryRecord {
  return {
    id: "x",
    timestamp: "2026-01-01",
    promptHash: "h",
    taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
    selectedTier: "local_strong",
    selectedModel: "glm",
    latencyMs: 100,
    success: true,
    routingReason: "ok",
    attempts: 1,
    ...overrides,
  };
}

describe("telemetry stats", () => {
  it("computes tier distribution from the tier that actually served", () => {
    const stats = computeTelemetryStats([
      record({ id: "1", selectedTier: "local_fast", selectedModel: "llama" }),
      record({ id: "2", selectedTier: "premium", selectedModel: "sonnet" }),
    ]);
    expect(stats.total).toBe(2);
    expect(stats.tierDistribution.local_fast).toBe(1);
    expect(stats.tierDistribution.premium).toBe(1);
  });

  it("does NOT count a configured fallback as an escalation", () => {
    // local_strong call with hosted_oss configured as fallback, but the call
    // succeeded on the primary (escalated: false). This is the regression that
    // previously inflated escalationRate and mis-attributed the call to hosted_oss.
    const stats = computeTelemetryStats([
      record({
        selectedTier: "local_strong",
        selectedModel: "glm",
        fallbackTier: "hosted_oss",
        escalated: false,
        success: true,
      }),
    ]);
    expect(stats.escalationRate).toBe(0);
    expect(stats.tierDistribution.local_strong).toBe(1);
    expect(stats.tierDistribution.hosted_oss).toBeUndefined();
    expect(stats.modelDistribution.glm).toBe(1);
  });

  it("counts an actual escalation under the fallback tier/model", () => {
    // local_strong selected, but escalated to hosted_oss which actually served.
    const stats = computeTelemetryStats([
      record({
        selectedTier: "local_strong",
        selectedModel: "glm",
        fallbackTier: "hosted_oss",
        fallbackModel: "qwen3-coder-next",
        escalated: true,
        success: true,
      }),
    ]);
    expect(stats.escalationRate).toBe(1);
    expect(stats.tierDistribution.local_strong).toBeUndefined();
    expect(stats.tierDistribution.hosted_oss).toBe(1);
    expect(stats.modelDistribution.glm).toBeUndefined();
    expect(stats.modelDistribution["qwen3-coder-next"]).toBe(1);
  });

  it("computes success rate and cost", () => {
    const stats = computeTelemetryStats([
      record({ id: "1", success: true, estimatedCostUsd: 0.1 }),
      record({ id: "2", success: false, estimatedCostUsd: 0.2 }),
    ]);
    expect(stats.successRate).toBe(0.5);
    expect(stats.totalEstimatedCostUsd).toBeCloseTo(0.3);
    expect(stats.recentFailures).toHaveLength(1);
  });
});