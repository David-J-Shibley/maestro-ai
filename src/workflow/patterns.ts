import type { ModelTier, RiskLevel, TaskType } from "../types.js";
import type { WorkflowPatternId, WorkflowStepPlan } from "./types.js";

export const PATTERN_LABELS: Record<WorkflowPatternId, string> = {
  "single-shot": "Simple single-shot",
  "plan-execute-validate": "Plan → Execute → Validate",
  "parallel-synthesis": "Plan → Parallel Workers → Synthesize",
  "critique-revise": "Draft → Critique → Revise",
  "implement-test-fix": "Implement → Test → Fix",
  "extract-normalize-validate": "Extract → Normalize → Validate",
};

function step(
  partial: Omit<WorkflowStepPlan, "parallelizable" | "validation"> &
    Partial<Pick<WorkflowStepPlan, "parallelizable" | "validation">>
): WorkflowStepPlan {
  return {
    parallelizable: false,
    validation: {},
    ...partial,
  };
}

export function buildSingleShotSteps(
  taskType: TaskType,
  risk: RiskLevel,
  tier: ModelTier
): WorkflowStepPlan[] {
  return [
    step({
      id: "execute",
      name: "Execute",
      purpose: "Handle the request in a single routed call",
      dependsOn: [],
      expectedOutput: "Final answer for the user goal",
      taskType,
      riskLevel: risk,
      recommendedTier: tier,
      kind: "llm",
      validation: { requireNoPlaceholders: true },
    }),
  ];
}

export function buildPlanExecuteValidateSteps(
  taskType: TaskType,
  risk: RiskLevel
): WorkflowStepPlan[] {
  return [
    step({
      id: "plan",
      name: "Planner",
      purpose: "Break down the objective and outline an execution approach",
      dependsOn: [],
      expectedOutput: "Structured plan with steps and acceptance criteria",
      taskType: taskType === "architecture" ? "architecture" : "multi_step",
      riskLevel: risk,
      recommendedTier: risk === "high" ? "premium" : "hosted_oss",
      kind: "llm",
    }),
    step({
      id: "execute",
      name: "Implementation",
      purpose: "Produce the primary deliverable from the plan",
      dependsOn: ["plan"],
      expectedOutput: "Implementation output matching the plan",
      taskType,
      riskLevel: risk,
      recommendedTier: "hosted_oss",
      kind: "llm",
      validation: { requireNoPlaceholders: true },
    }),
    step({
      id: "validate",
      name: "Validation",
      purpose: "Verify the deliverable meets requirements",
      dependsOn: ["execute"],
      expectedOutput: "Validation verdict and any required fixes",
      taskType: "classification",
      riskLevel: "low",
      recommendedTier: "local_strong",
      kind: "llm",
    }),
    step({
      id: "review",
      name: "Final review",
      purpose: "Security and quality review for sensitive deliverables",
      dependsOn: ["validate"],
      expectedOutput: "Approved final output",
      taskType: taskType,
      riskLevel: risk,
      recommendedTier: risk === "high" ? "premium" : "hosted_oss",
      kind: "synthesis",
      optional: true,
      runOnFailure: false,
    }),
  ];
}

export function buildParallelSynthesisSteps(workerCount: number): WorkflowStepPlan[] {
  const workers: WorkflowStepPlan[] = Array.from({ length: workerCount }, (_, i) =>
    step({
      id: `worker-${i + 1}`,
      name: `Worker ${i + 1}`,
      purpose: `Explore angle ${i + 1} from the plan`,
      dependsOn: ["plan"],
      expectedOutput: `Findings for perspective ${i + 1}`,
      taskType: "summarization",
      riskLevel: "low",
      recommendedTier: "local_strong",
      parallelizable: true,
      kind: "llm",
    })
  );

  return [
    step({
      id: "plan",
      name: "Planner",
      purpose: "Define comparison angles and research questions",
      dependsOn: [],
      expectedOutput: "Research plan with worker assignments",
      taskType: "multi_step",
      riskLevel: "medium",
      recommendedTier: "hosted_oss",
      kind: "llm",
    }),
    ...workers,
    step({
      id: "synthesize",
      name: "Synthesize",
      purpose: "Merge worker outputs into a coherent final answer",
      dependsOn: workers.map((w) => w.id),
      expectedOutput: "Unified comparison or analysis",
      taskType: "summarization",
      riskLevel: "medium",
      recommendedTier: "hosted_oss",
      kind: "synthesis",
    }),
  ];
}

export function buildCritiqueReviseSteps(
  taskType: TaskType,
  risk: RiskLevel
): WorkflowStepPlan[] {
  return [
    step({
      id: "draft",
      name: "Draft",
      purpose: "Produce an initial draft",
      dependsOn: [],
      expectedOutput: "First draft of the requested content",
      taskType,
      riskLevel: risk,
      recommendedTier: "local_strong",
      kind: "llm",
    }),
    step({
      id: "critique",
      name: "Critique",
      purpose: "Review draft for clarity, tone, and completeness",
      dependsOn: ["draft"],
      expectedOutput: "Structured critique with improvement notes",
      taskType: "classification",
      riskLevel: "low",
      recommendedTier: "hosted_oss",
      kind: "llm",
    }),
    step({
      id: "revise",
      name: "Revise",
      purpose: "Apply critique and produce polished final output",
      dependsOn: ["critique"],
      expectedOutput: "Revised final content",
      taskType,
      riskLevel: risk,
      recommendedTier: "hosted_oss",
      kind: "synthesis",
      validation: { requireNoPlaceholders: true },
    }),
  ];
}

export function buildImplementTestFixSteps(
  taskType: TaskType,
  risk: RiskLevel
): WorkflowStepPlan[] {
  return [
    step({
      id: "plan",
      name: "Planner",
      purpose: "Outline implementation approach and test strategy",
      dependsOn: [],
      expectedOutput: "Implementation plan with test approach",
      taskType: "multi_step",
      riskLevel: risk,
      recommendedTier: risk === "high" ? "premium" : "hosted_oss",
      kind: "llm",
    }),
    step({
      id: "implement",
      name: "Implementation",
      purpose: "Write or modify code for the objective",
      dependsOn: ["plan"],
      expectedOutput: "Code changes implementing the feature or fix",
      taskType,
      riskLevel: risk,
      recommendedTier: "hosted_oss",
      kind: "llm",
      validation: { requireNoPlaceholders: true },
    }),
    step({
      id: "test-gen",
      name: "Test generation",
      purpose: "Generate or update tests for the implementation",
      dependsOn: ["implement"],
      expectedOutput: "Tests covering the implementation",
      taskType: "code_edit",
      riskLevel: "medium",
      recommendedTier: "local_strong",
      kind: "llm",
    }),
    step({
      id: "validate",
      name: "Build/test validation",
      purpose: "Run tests and build to verify the implementation",
      dependsOn: ["test-gen"],
      expectedOutput: "Pass/fail verdict from test and build execution",
      taskType: "tool_use",
      riskLevel: "medium",
      recommendedTier: "local_fast",
      kind: "tool",
      validation: { runTests: true, runBuild: true },
    }),
    step({
      id: "fix",
      name: "Fix pass",
      purpose: "Repair failing tests or build issues",
      dependsOn: ["validate"],
      expectedOutput: "Corrected implementation",
      taskType,
      riskLevel: risk,
      recommendedTier: "hosted_oss",
      kind: "llm",
      runOnFailure: true,
      optional: true,
    }),
    step({
      id: "review",
      name: "Final review",
      purpose: "Review final code for correctness and security",
      dependsOn: ["fix", "validate"],
      expectedOutput: "Approved final implementation",
      taskType,
      riskLevel: risk,
      recommendedTier: risk === "high" ? "premium" : "hosted_oss",
      kind: "synthesis",
    }),
  ];
}

export function buildExtractNormalizeValidateSteps(risk: RiskLevel): WorkflowStepPlan[] {
  return [
    step({
      id: "extract",
      name: "Extract",
      purpose: "Extract raw structured data from source content",
      dependsOn: [],
      expectedOutput: "Raw extracted fields",
      taskType: "extraction",
      riskLevel: risk,
      recommendedTier: "local_strong",
      kind: "llm",
    }),
    step({
      id: "normalize",
      name: "Normalize",
      purpose: "Normalize extracted data to the target schema",
      dependsOn: ["extract"],
      expectedOutput: "Schema-aligned JSON object",
      taskType: "extraction",
      riskLevel: "low",
      recommendedTier: "local_strong",
      kind: "llm",
      validation: { requireSchema: true },
    }),
    step({
      id: "validate",
      name: "Validate",
      purpose: "Validate normalized output against requirements",
      dependsOn: ["normalize"],
      expectedOutput: "Validated final JSON",
      taskType: "classification",
      riskLevel: "low",
      recommendedTier: "local_fast",
      kind: "llm",
      validation: { requireSchema: true, requireNoPlaceholders: true },
    }),
  ];
}

export function patternSteps(
  pattern: WorkflowPatternId,
  ctx: {
    taskType: TaskType;
    risk: RiskLevel;
    defaultTier: ModelTier;
    workerCount?: number;
  }
): WorkflowStepPlan[] {
  switch (pattern) {
    case "single-shot":
      return buildSingleShotSteps(ctx.taskType, ctx.risk, ctx.defaultTier);
    case "plan-execute-validate":
      return buildPlanExecuteValidateSteps(ctx.taskType, ctx.risk);
    case "parallel-synthesis":
      return buildParallelSynthesisSteps(ctx.workerCount ?? 2);
    case "critique-revise":
      return buildCritiqueReviseSteps(ctx.taskType, ctx.risk);
    case "implement-test-fix":
      return buildImplementTestFixSteps(ctx.taskType, ctx.risk);
    case "extract-normalize-validate":
      return buildExtractNormalizeValidateSteps(ctx.risk);
    default:
      return buildSingleShotSteps(ctx.taskType, ctx.risk, ctx.defaultTier);
  }
}
