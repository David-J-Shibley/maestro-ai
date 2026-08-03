import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionSpend } from "../src/telemetry/stats.js";
import { readFileSync } from "node:fs";
import { recordStructuredFeedback, recordUserFeedback } from "../src/telemetry/logger.js";
import { handleStatsTool, handleFeedbackTool } from "../src/mcp/tools.js";
import type { RouterConfig, TelemetryRecord } from "../src/types.js";

function tempConfig(logPath: string): RouterConfig {
  return {
    models: {} as RouterConfig["models"],
    routing: {
      defaultTier: "local_fast",
      maxRetriesPerTier: 1,
      enableEscalation: true,
      preferLocal: true,
      longContextTokenThreshold: 32000,
      probeAvailability: false,
    },
    telemetry: { enabled: true, logPath },
  };
}

describe("session spend + feedback", () => {
  it("sums spend by session id", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    const logPath = join(dir, "telemetry.jsonl");
    const records: TelemetryRecord[] = [
      {
        id: "1",
        timestamp: "2026-01-01",
        promptHash: "a",
        sessionId: "chat-1",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "premium",
        selectedModel: "sonnet",
        estimatedCostUsd: 0.05,
        latencyMs: 100,
        success: true,
        routingReason: "ok",
        attempts: 1,
      },
      {
        id: "2",
        timestamp: "2026-01-02",
        promptHash: "b",
        sessionId: "chat-2",
        taskAnalysis: {} as TelemetryRecord["taskAnalysis"],
        selectedTier: "local_fast",
        selectedModel: "llama",
        estimatedCostUsd: 0,
        latencyMs: 50,
        success: true,
        routingReason: "ok",
        attempts: 1,
      },
    ];
    writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    expect(getSessionSpend(logPath, "chat-1")).toBeCloseTo(0.05);
    expect(getSessionSpend(logPath, "chat-2")).toBe(0);
  });

  it("records feedback and patches telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    const logPath = join(dir, "telemetry.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        id: "tid-1",
        timestamp: "2026-01-01",
        promptHash: "a",
        taskAnalysis: {},
        selectedTier: "local_fast",
        selectedModel: "llama",
        latencyMs: 10,
        success: true,
        routingReason: "ok",
        attempts: 1,
      }) + "\n"
    );

    const config = tempConfig(logPath);
    const feedbackId = recordUserFeedback(config, "tid-1", "bad: wrong format");
    expect(feedbackId).toBeTruthy();

    const spend = getSessionSpend(logPath, "x");
    expect(spend).toBe(0);
  });

  it("records structured rating and accepted, patching telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    const logPath = join(dir, "telemetry.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        id: "tid-2",
        timestamp: "2026-01-01",
        promptHash: "a",
        taskAnalysis: {},
        selectedTier: "local_fast",
        selectedModel: "llama",
        latencyMs: 10,
        success: true,
        routingReason: "ok",
        attempts: 1,
      }) + "\n"
    );

    const config = tempConfig(logPath);
    recordStructuredFeedback(config, {
      telemetryId: "tid-2",
      rating: 4,
      accepted: true,
      feedback: "solid",
    });

    const patched = JSON.parse(readFileSync(logPath, "utf8").trim()) as TelemetryRecord;
    expect(patched.userRating).toBe(4);
    expect(patched.userAccepted).toBe(true);
    expect(patched.userFeedback).toBe("solid");
  });
});

describe("feedback MCP tool", () => {
  it("accepts rating and accepted without a note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    const logPath = join(dir, "telemetry.jsonl");
    writeFileSync(logPath, "");
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          local_fast: { primary: { provider: "ollama", model: "llama", baseUrl: "http://x" } },
          local_strong: { primary: { provider: "ollama", model: "qwen", baseUrl: "http://x" } },
          hosted_oss: { primary: { provider: "litellm", model: "q", baseUrl: "http://x" } },
          premium: { primary: { provider: "litellm", model: "s", baseUrl: "http://x" } },
        },
        routing: {
          defaultTier: "local_fast",
          maxRetriesPerTier: 1,
          enableEscalation: true,
          preferLocal: true,
          longContextTokenThreshold: 32000,
          probeAvailability: false,
        },
        telemetry: { enabled: true, logPath },
      })
    );

    const result = await handleFeedbackTool({
      telemetry_id: "tid-x",
      rating: 5,
      accepted: true,
      config_path: configPath,
    });
    expect(result.ok).toBe(true);
    expect(result.rating).toBe(5);
    expect(result.accepted).toBe(true);
  });
});

describe("stats MCP tool", () => {
  it("returns telemetry summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    const logPath = join(dir, "telemetry.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        id: "1",
        timestamp: "2026-01-01",
        promptHash: "a",
        taskAnalysis: {},
        selectedTier: "local_fast",
        selectedModel: "llama",
        latencyMs: 100,
        success: true,
        routingReason: "ok",
        attempts: 1,
      }) + "\n"
    );

    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          local_fast: { primary: { provider: "ollama", model: "llama", baseUrl: "http://x" } },
          local_strong: { primary: { provider: "ollama", model: "qwen", baseUrl: "http://x" } },
          hosted_oss: { primary: { provider: "litellm", model: "q", baseUrl: "http://x" } },
          premium: { primary: { provider: "litellm", model: "s", baseUrl: "http://x" } },
        },
        routing: {
          defaultTier: "local_fast",
          maxRetriesPerTier: 1,
          enableEscalation: true,
          preferLocal: true,
          longContextTokenThreshold: 32000,
          probeAvailability: false,
        },
        telemetry: { enabled: true, logPath },
      })
    );

    const result = await handleStatsTool({ last: 10, config_path: configPath });
    expect(result.stats.total).toBe(1);
    expect(result.report).toContain("Success");
  });
});
