import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  estimatePremiumCostUsd,
  sumAttemptCosts,
} from "../src/telemetry/logger.js";
import { computeTelemetryStats } from "../src/telemetry/stats.js";
import type { TelemetryRecord } from "../src/types.js";

describe("cost truth helpers", () => {
  it("sums attempt costs across retries", () => {
    const sum = sumAttemptCosts([
      {
        tier: "local_strong",
        usage: { promptTokens: 1_000_000, completionTokens: 0 },
        estimatedCostUsd: 0,
      },
      {
        tier: "hosted_oss",
        usage: { promptTokens: 1_000_000, completionTokens: 0 },
      },
      {
        tier: "premium",
        usage: { promptTokens: 1_000_000, completionTokens: 0 },
      },
    ]);
    // local 0 + hosted 0.5 + premium 3
    expect(sum).toBeCloseTo(3.5);
  });

  it("estimates premium counterfactual", () => {
    expect(
      estimatePremiumCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000 })
    ).toBeCloseTo(18);
    expect(estimateCostUsd("local_fast", { promptTokens: 1000, completionTokens: 1000 })).toBe(0);
  });

  it("reports savings vs always-premium in stats", () => {
    const records: TelemetryRecord[] = [
      {
        id: "1",
        timestamp: "2026-01-01",
        promptHash: "h",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "local_strong",
        selectedModel: "glm",
        latencyMs: 10,
        success: true,
        routingReason: "ok",
        attempts: 1,
        tokenUsage: { promptTokens: 1_000_000, completionTokens: 0 },
        estimatedCostUsd: 0,
        totalEstimatedCostUsd: 0,
        userAccepted: true,
        userRating: 5,
      },
      {
        id: "2",
        timestamp: "2026-01-01",
        promptHash: "h2",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "premium",
        selectedModel: "sonnet",
        latencyMs: 10,
        success: true,
        routingReason: "ok",
        attempts: 1,
        tokenUsage: { promptTokens: 1_000_000, completionTokens: 0 },
        estimatedCostUsd: 3,
        totalEstimatedCostUsd: 3,
        userAccepted: false,
        userRating: 2,
      },
    ];

    const stats = computeTelemetryStats(records);
    expect(stats.totalEstimatedCostUsd).toBeCloseTo(3);
    expect(stats.estimatedPremiumCostUsd).toBeCloseTo(6);
    expect(stats.estimatedSavingsUsd).toBeCloseTo(3);
    expect(stats.savingsRate).toBeCloseTo(0.5);
    expect(stats.acceptanceRate).toBeCloseTo(0.5);
    expect(stats.avgUserRating).toBeCloseTo(3.5);
  });

  it("prefers totalEstimatedCostUsd for spend", () => {
    const stats = computeTelemetryStats([
      {
        id: "1",
        timestamp: "2026-01-01",
        promptHash: "h",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "hosted_oss",
        selectedModel: "q",
        latencyMs: 10,
        success: true,
        routingReason: "ok",
        attempts: 2,
        estimatedCostUsd: 0.5,
        totalEstimatedCostUsd: 1.0,
      },
    ]);
    expect(stats.totalEstimatedCostUsd).toBeCloseTo(1.0);
  });
});
