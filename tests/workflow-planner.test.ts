import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import { planWorkflow, selectWorkflowPattern } from "../src/workflow/planner.js";
import { resolveModeConstraints } from "../src/routing/modes.js";
import type { RunWorkflowInput } from "../src/workflow/types.js";

const CONFIG = loadConfigFromString(`{
  "models": {
    "local_fast": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" },
    "local_strong": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1" },
    "hosted_oss": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1" },
    "premium": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1" }
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
}`);

function input(messages: string, workflow?: RunWorkflowInput["workflow"]): RunWorkflowInput {
  return {
    messages: [{ role: "user", content: messages }],
    workflow,
  };
}

describe("workflow planner", () => {
  it("selects single-shot for easy low-risk tasks", () => {
    const analysis = analyzeTask({ userPrompt: "Format this list as bullets" });
    const { pattern, why } = selectWorkflowPattern(
      analysis,
      input("Format this list as bullets"),
      resolveModeConstraints("balanced"),
      "balanced"
    );
    expect(pattern).toBe("single-shot");
    expect(why).toContain("decomposition");
  });

  it("selects single-shot for simple HTML demos without test hooks", () => {
    const analysis = analyzeTask({ userPrompt: "make me a simple HTML landing page" });
    const { pattern, why } = selectWorkflowPattern(
      analysis,
      input("make me a simple HTML landing page"),
      resolveModeConstraints("balanced"),
      "balanced"
    );
    expect(pattern).toBe("single-shot");
    expect(why).toMatch(/single routed call|decomposition/i);
  });

  it("selects implement-test-fix for coding tasks", () => {
    const analysis = analyzeTask({ userPrompt: "Fix the failing auth middleware tests" });
    const { pattern } = selectWorkflowPattern(
      analysis,
      input("Fix the failing auth middleware tests"),
      resolveModeConstraints("balanced"),
      "balanced"
    );
    expect(pattern).toBe("implement-test-fix");
  });

  it("selects critique-revise for writing with best quality", () => {
    const analysis = analyzeTask({
      userPrompt: "Draft an RFC for the new caching layer",
      taskHints: { quality: "best" },
    });
    const { pattern } = selectWorkflowPattern(
      analysis,
      {
        ...input("Draft an RFC for the new caching layer"),
        taskHints: { quality: "best" },
      },
      resolveModeConstraints("best-quality"),
      "best-quality"
    );
    expect(pattern).toBe("critique-revise");
  });

  it("selects parallel-synthesis for comparison tasks", () => {
    const analysis = analyzeTask({ userPrompt: "Compare React vs Vue for our dashboard" });
    const { pattern } = selectWorkflowPattern(
      analysis,
      input("Compare React vs Vue for our dashboard"),
      resolveModeConstraints("balanced"),
      "balanced"
    );
    expect(pattern).toBe("parallel-synthesis");
  });

  it("selects extract-normalize-validate for structured extraction", () => {
    const analysis = analyzeTask({
      userPrompt: "Extract invoice fields from this document",
      responseSchema: { type: "object" },
    });
    const plan = planWorkflow(
      {
        messages: [{ role: "user", content: "Extract invoice fields" }],
        responseSchema: { type: "object" },
        workflow: "auto",
      },
      analysis,
      CONFIG
    );
    expect(plan.pattern).toBe("extract-normalize-validate");
    expect(plan.steps.map((s) => s.id)).toEqual(["extract", "normalize", "validate"]);
  });

  it("honors explicit workflow alias", () => {
    const analysis = analyzeTask({ userPrompt: "hello" });
    const plan = planWorkflow(
      { ...input("hello"), workflow: "critique" },
      analysis,
      CONFIG
    );
    expect(plan.pattern).toBe("critique-revise");
  });

  it("caps step tiers under local-only mode", () => {
    const analysis = analyzeTask({ userPrompt: "Design system architecture for payments" });
    const plan = planWorkflow(
      { ...input("Design system architecture"), overrides: { mode: "local-only" } },
      analysis,
      CONFIG
    );
    for (const step of plan.steps) {
      expect(["local_fast", "local_strong"]).toContain(step.recommendedTier);
    }
    expect(plan.constraints.some((c) => c.includes("local-only"))).toBe(true);
  });

  it("uses single-shot under fastest mode for non-hard tasks", () => {
    const analysis = analyzeTask({ userPrompt: "Summarize this paragraph" });
    const { pattern } = selectWorkflowPattern(
      analysis,
      input("Summarize this paragraph"),
      resolveModeConstraints("fastest"),
      "fastest"
    );
    expect(pattern).toBe("single-shot");
  });
});
