import { describe, expect, it } from "vitest";
import { executionLevels, shouldSkipStep } from "../src/workflow/dag.js";
import { buildParallelSynthesisSteps } from "../src/workflow/patterns.js";

describe("workflow DAG", () => {
  it("orders steps by dependencies", () => {
    const steps = buildParallelSynthesisSteps(2);
    const levels = executionLevels(steps);
    expect(levels[0]?.map((s) => s.id)).toEqual(["plan"]);
    expect(levels[1]?.map((s) => s.id).sort()).toEqual(["worker-1", "worker-2"]);
    expect(levels[2]?.map((s) => s.id)).toEqual(["synthesize"]);
  });

  it("skips fix step when validation passed", () => {
    const results = new Map([
      ["validate", { status: "passed" }],
    ]);
    expect(
      shouldSkipStep(
        {
          id: "fix",
          name: "Fix",
          purpose: "",
          dependsOn: ["validate"],
          expectedOutput: "",
          taskType: "code_edit",
          riskLevel: "medium",
          recommendedTier: "hosted_oss",
          parallelizable: false,
          kind: "llm",
          validation: {},
          runOnFailure: true,
          optional: true,
        },
        results
      )
    ).toBe(true);
  });

  it("runs fix step when validation failed", () => {
    const results = new Map([
      ["validate", { status: "failed" }],
    ]);
    expect(
      shouldSkipStep(
        {
          id: "fix",
          name: "Fix",
          purpose: "",
          dependsOn: ["validate"],
          expectedOutput: "",
          taskType: "code_edit",
          riskLevel: "medium",
          recommendedTier: "hosted_oss",
          parallelizable: false,
          kind: "llm",
          validation: {},
          runOnFailure: true,
          optional: true,
        },
        results
      )
    ).toBe(false);
  });

  it("skips downstream steps when dependency failed", () => {
    const results = new Map([
      ["execute", { status: "failed" }],
    ]);
    expect(
      shouldSkipStep(
        {
          id: "validate",
          name: "Validate",
          purpose: "",
          dependsOn: ["execute"],
          expectedOutput: "",
          taskType: "classification",
          riskLevel: "low",
          recommendedTier: "local_strong",
          parallelizable: false,
          kind: "llm",
          validation: {},
        },
        results
      )
    ).toBe(true);
  });
});
