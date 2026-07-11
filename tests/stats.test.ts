import { describe, expect, it } from "vitest";
import { computeTelemetryStats } from "../src/telemetry/stats.js";
import type { TelemetryRecord } from "../src/types.js";

describe("telemetry stats", () => {
  it("computes tier distribution", () => {
    const records: TelemetryRecord[] = [
      {
        id: "1",
        timestamp: "2026-01-01",
        promptHash: "a",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "local_fast",
        selectedModel: "llama",
        latencyMs: 100,
        success: true,
        routingReason: "ok",
        attempts: 1,
      },
      {
        id: "2",
        timestamp: "2026-01-02",
        promptHash: "b",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "premium",
        selectedModel: "sonnet",
        fallbackTier: "hosted_oss",
        latencyMs: 200,
        estimatedCostUsd: 0.01,
        success: false,
        routingReason: "fail",
        attempts: 2,
      },
    ];

    const stats = computeTelemetryStats(records);
    expect(stats.total).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(stats.tierDistribution.local_fast).toBe(1);
    expect(stats.escalationRate).toBeGreaterThan(0);
  });
});
