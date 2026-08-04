import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import { planWorkflow } from "../src/workflow/planner.js";
import { executeWorkflow } from "../src/workflow/executor.js";
import { formatProgressLine } from "../src/workflow/progress.js";
import type { WorkflowProgressEvent } from "../src/workflow/progress.js";
import type { RoutedLLMCallResult } from "../src/types.js";
import type { StepRunner } from "../src/workflow/types.js";

const CONFIG = loadConfigFromString(`{
  "models": {
    "local_fast": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" },
    "local_strong": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1" },
    "hosted_oss": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1" },
    "premium": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1" }
  },
  "routing": {
    "defaultTier": "local_strong",
    "maxRetriesPerTier": 0,
    "enableEscalation": false,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`);

function mockResult(content: string): RoutedLLMCallResult {
  return {
    response: { content, model: "mock", tier: "local_strong", latencyMs: 12 },
    analysis: analyzeTask({ userPrompt: content }),
    initialRouting: {
      tier: "local_strong",
      model: "mock",
      baseUrl: "http://l/v1",
      provider: "ollama",
      reason: "mock",
      fallbackTier: null,
    },
    routing: {
      tier: "local_strong",
      model: "mock",
      baseUrl: "http://l/v1",
      provider: "ollama",
      reason: "mock",
      fallbackTier: null,
    },
    evaluation: {
      pass: true,
      reason: "ok",
      retryRecommended: false,
      escalationRecommended: false,
      checks: [],
    },
    telemetryId: "mock",
    escalated: false,
    attempts: [],
  };
}

describe("workflow progress", () => {
  it("emits started/finished events in order for critique-revise", async () => {
    const events: WorkflowProgressEvent[] = [];
    const runner: StepRunner = async (ctx) => mockResult(`out-${ctx.step.id}`);

    const analysis = analyzeTask({ userPrompt: "Write a product memo" });
    const plan = planWorkflow(
      { messages: [{ role: "user", content: "Write a product memo" }], workflow: "critique" },
      analysis,
      CONFIG
    );

    await executeWorkflow(
      plan,
      { messages: [{ role: "user", content: "Write a product memo" }], workflow: "critique" },
      CONFIG,
      {
        stepRunner: runner,
        onProgress: (e) => events.push(e),
      }
    );

    expect(events[0]?.type).toBe("workflow_started");
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "step_started").length).toBe(3);
    expect(types.filter((t) => t === "step_finished").length).toBe(3);

    // Each started is followed by finished for that step before next sequential step
    const draftStart = events.findIndex(
      (e) => e.type === "step_started" && e.stepId === "draft"
    );
    const draftFinish = events.findIndex(
      (e) => e.type === "step_finished" && e.stepId === "draft"
    );
    const critiqueStart = events.findIndex(
      (e) => e.type === "step_started" && e.stepId === "critique"
    );
    expect(draftStart).toBeGreaterThanOrEqual(0);
    expect(draftFinish).toBeGreaterThan(draftStart);
    expect(critiqueStart).toBeGreaterThan(draftFinish);
  });

  it("formats human progress lines", () => {
    const line = formatProgressLine({
      type: "step_finished",
      stepId: "implement",
      name: "Implementation",
      status: "passed",
      latencyMs: 1200,
      index: 2,
      total: 6,
      actualTier: "hosted_oss",
      model: "qwen",
      escalated: true,
      retries: 1,
    });
    expect(line).toContain("2/6");
    expect(line).toContain("Implementation");
    expect(line).toContain("passed");
    expect(line).toContain("escalated");
  });
});
