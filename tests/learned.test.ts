import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  learnedRoutingAvailable,
  shouldApplyLearnedHint,
  suggestTierFromTelemetry,
} from "../src/routing/learned.js";
import type { TaskAnalysis, TelemetryRecord } from "../src/types.js";

const tmpDirs: string[] = [];

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

function writeTelemetry(records: TelemetryRecord[]): string {
  const dir = join(tmpdir(), `maestro-learned-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  const path = join(dir, "telemetry.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function summarizationRecords(): TelemetryRecord[] {
  const records: TelemetryRecord[] = [];
  for (let i = 0; i < 6; i++) {
    records.push({
      id: `lf-${i}`,
      timestamp: "2026-01-01",
      promptHash: "h",
      taskAnalysis: analysis("summarization"),
      selectedTier: "local_fast",
      selectedModel: "llama",
      latencyMs: 50,
      success: false,
      routingReason: "ok",
      attempts: 1,
    });
  }
  for (let i = 0; i < 10; i++) {
    records.push({
      id: `ls-${i}`,
      timestamp: "2026-01-01",
      promptHash: "h",
      taskAnalysis: analysis("summarization"),
      selectedTier: "local_strong",
      selectedModel: "glm",
      latencyMs: 100,
      success: true,
      routingReason: "ok",
      attempts: 1,
    });
  }
  for (let i = 0; i < 8; i++) {
    records.push({
      id: `ex-${i}`,
      timestamp: "2026-01-01",
      promptHash: "h",
      taskAnalysis: analysis("extraction"),
      selectedTier: "local_fast",
      selectedModel: "llama",
      latencyMs: 80,
      success: true,
      routingReason: "ok",
      attempts: 1,
    });
  }
  for (let i = 0; i < 8; i++) {
    records.push({
      id: `ce-${i}`,
      timestamp: "2026-01-01",
      promptHash: "h",
      taskAnalysis: analysis("code_edit"),
      selectedTier: "hosted_oss",
      selectedModel: "qwen",
      latencyMs: 200,
      success: true,
      routingReason: "ok",
      attempts: 1,
    });
  }
  return records;
}

describe("learned routing prep", () => {
  it("suggests tier from telemetry for a task type", () => {
    const logPath = writeTelemetry(summarizationRecords());
    const suggestion = suggestTierFromTelemetry(logPath, "summarization", {
      minSamples: 5,
    });
    expect(suggestion?.tier).toBe("local_strong");
    expect(suggestion?.sampleSize).toBe(10);
    expect(suggestion?.confidence).toBe("medium");
  });

  it("reports readiness when enough records and recommendations exist", () => {
    const logPath = writeTelemetry(summarizationRecords());
    expect(
      learnedRoutingAvailable(logPath, { minSamples: 5, minRecordsForReadiness: 25 })
    ).toBe(true);
  });

  it("applies hint when confidence and success rate are sufficient", () => {
    const logPath = writeTelemetry(summarizationRecords());
    const suggestion = suggestTierFromTelemetry(logPath, "summarization", {
      minSamples: 5,
    });
    expect(suggestion).toBeTruthy();
    expect(shouldApplyLearnedHint("local_fast", suggestion!, "medium")).toBe(true);
    expect(shouldApplyLearnedHint("local_fast", suggestion!, "high")).toBe(false);
  });
});
