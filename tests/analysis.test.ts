import { describe, expect, it } from "vitest";
import {
  computeRoutingInsights,
  formatInsightsReport,
} from "../src/telemetry/analysis.js";
import type { TaskAnalysis, TelemetryRecord } from "../src/types.js";

function analysis(taskType: TaskAnalysis["taskType"]): TaskAnalysis {
  return {
    taskType,
    difficulty: "easy",
    riskLevel: "low",
    requiresToolUse: false,
    requiresCodeReasoning: false,
    requiresLongContext: false,
    requiresStructuredOutput: false,
    confidence: 0.9,
    signals: [],
  };
}

function record(overrides: Partial<TelemetryRecord> & { id: string }): TelemetryRecord {
  return {
    timestamp: "2026-01-01",
    promptHash: "h",
    taskAnalysis: analysis("summarization"),
    selectedTier: "local_strong",
    selectedModel: "glm",
    latencyMs: 100,
    success: true,
    routingReason: "ok",
    attempts: 1,
    ...overrides,
  };
}

describe("telemetry analysis", () => {
  it("recommends tier with highest success rate per task type", () => {
    const records: TelemetryRecord[] = [];
    for (let i = 0; i < 6; i++) {
      records.push(
        record({
          id: `lf-${i}`,
          taskAnalysis: analysis("summarization"),
          selectedTier: "local_fast",
          selectedModel: "llama",
          success: i < 2,
        })
      );
    }
    for (let i = 0; i < 6; i++) {
      records.push(
        record({
          id: `ls-${i}`,
          taskAnalysis: analysis("summarization"),
          selectedTier: "local_strong",
          selectedModel: "glm",
          success: true,
        })
      );
    }

    const insights = computeRoutingInsights(records, { minSamples: 5 });
    const rec = insights.recommendations.find((r) => r.taskType === "summarization");
    expect(rec?.recommendedTier).toBe("local_strong");
    expect(rec?.sampleSize).toBe(6);
    expect(rec?.successRate).toBe(1);
  });

  it("generates mode comparison findings", () => {
    const records: TelemetryRecord[] = [];
    for (let i = 0; i < 6; i++) {
      records.push(
        record({
          id: `b-${i}`,
          mode: "balanced",
          success: true,
        })
      );
    }
    for (let i = 0; i < 6; i++) {
      records.push(
        record({
          id: `c-${i}`,
          mode: "cheapest",
          success: i < 2,
        })
      );
    }

    const insights = computeRoutingInsights(records, { minSamples: 5 });
    const cheapest = insights.modeComparisons.find((m) => m.mode === "cheapest");
    expect(cheapest?.count).toBe(6);
    expect(insights.findings.some((f) => f.includes("cheapest"))).toBe(true);
  });

  it("formats a human-readable report", () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      record({
        id: `r-${i}`,
        taskAnalysis: analysis("extraction"),
        selectedTier: i % 2 === 0 ? "local_fast" : "local_strong",
        success: i % 3 !== 0,
      })
    );
    const insights = computeRoutingInsights(records);
    const report = formatInsightsReport(insights);
    expect(report).toContain("Telemetry Routing Analysis");
    expect(report).toContain("Records analyzed: 30");
  });
});
