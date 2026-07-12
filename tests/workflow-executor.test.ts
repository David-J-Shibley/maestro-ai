import { describe, expect, it } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { planWorkflow } from "../src/workflow/planner.js";
import { executeWorkflow } from "../src/workflow/executor.js";
import { formatExecutionReport } from "../src/workflow/report.js";
import { validateWorkflowOutput } from "../src/workflow/validation.js";
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

function mockResult(content: string, tier: import("../src/types.js").ModelTier = "local_strong"): RoutedLLMCallResult {
  return {
    response: { content, model: "mock", tier, latencyMs: 10 },
    analysis: analyzeTask({ userPrompt: content }),
    initialRouting: {
      tier,
      model: "mock",
      baseUrl: "http://l/v1",
      provider: "ollama",
      reason: "mock",
      fallbackTier: null,
    },
    routing: {
      tier,
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

describe("workflow executor", () => {
  it("executes critique-revise sequentially with dependency context", async () => {
    const outputs: string[] = [];
    const runner: StepRunner = async (ctx) => {
      outputs.push(ctx.step.id);
      if (ctx.step.id === "draft") return mockResult("draft text");
      if (ctx.step.id === "critique") {
        expect(ctx.messages[1]?.content).toContain("draft");
        return mockResult("critique notes");
      }
      if (ctx.step.id === "revise") {
        expect(ctx.messages[1]?.content).toContain("critique");
        return mockResult("final polished text");
      }
      return mockResult("ok");
    };

    const analysis = analyzeTask({ userPrompt: "Write a product memo" });
    const plan = planWorkflow(
      { messages: [{ role: "user", content: "Write a product memo" }], workflow: "critique" },
      analysis,
      CONFIG
    );

    const { steps, finalOutput } = await executeWorkflow(
      plan,
      { messages: [{ role: "user", content: "Write a product memo" }], workflow: "critique" },
      CONFIG,
      { stepRunner: runner }
    );

    expect(outputs).toEqual(["draft", "critique", "revise"]);
    expect(finalOutput).toBe("final polished text");
    expect(steps.every((s) => s.status === "passed")).toBe(true);
  });

  it("runs parallel workers before synthesis", async () => {
    const order: string[] = [];
    const runner: StepRunner = async (ctx) => {
      order.push(`start-${ctx.step.id}`);
      if (ctx.step.id.startsWith("worker")) {
        await new Promise((r) => setTimeout(r, 20));
      }
      order.push(`end-${ctx.step.id}`);
      return mockResult(`output-${ctx.step.id}`);
    };

    const analysis = analyzeTask({ userPrompt: "Compare option A and option B" });
    const plan = planWorkflow(
      { messages: [{ role: "user", content: "Compare option A and option B" }], workflow: "parallel-synthesis" },
      analysis,
      CONFIG
    );

    await executeWorkflow(
      plan,
      { messages: [{ role: "user", content: "Compare option A and option B" }], workflow: "parallel-synthesis" },
      CONFIG,
      { stepRunner: runner }
    );

    const synthStart = order.indexOf("start-synthesize");
    const w1Start = order.indexOf("start-worker-1");
    const w2Start = order.indexOf("start-worker-2");
    expect(order[0]).toBe("start-plan");
    expect(w1Start).toBeGreaterThan(0);
    expect(w2Start).toBeGreaterThan(0);
    expect(w1Start).toBeLessThan(synthStart);
    expect(w2Start).toBeLessThan(synthStart);
  });

  it("formats execution report with escalations", () => {
    const analysis = analyzeTask({ userPrompt: "Fix tests" });
    const plan = planWorkflow(
      { messages: [{ role: "user", content: "Fix tests" }], workflow: "implement-test-fix" },
      analysis,
      CONFIG
    );
    const steps = [
      {
        stepId: "implement",
        name: "Implementation",
        content: "code",
        status: "passed" as const,
        latencyMs: 100,
        estimatedCostUsd: 0.01,
        escalated: true,
        retries: 1,
        recommendedTier: "hosted_oss" as const,
        actualTier: "hosted_oss" as const,
        model: "hosted",
        evaluation: { pass: true, reason: "ok", retryRecommended: false, escalationRecommended: false, checks: [] },
      },
    ];
    const validation = validateWorkflowOutput(plan, { messages: [{ role: "user", content: "Fix tests" }] }, steps, "code");
    const report = formatExecutionReport(plan, steps, validation);
    expect(report.markdown).toContain("Maestro Execution Report");
    expect(report.markdown).toContain("Implementation");
    expect(report.escalations.length).toBeGreaterThan(0);
  });
});
