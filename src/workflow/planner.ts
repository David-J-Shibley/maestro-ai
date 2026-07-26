import { randomUUID } from "node:crypto";
import { analyzeTask, extractSystemPrompt, extractUserPrompt } from "../analyzer/task-analyzer.js";
import {
  applyModeToRuntime,
  resolveActiveMode,
  resolveModeConstraints,
  type ModeConstraints,
} from "../routing/modes.js";
import { dryRunRoute } from "../routed-llm-call.js";
import { capTier, floorTier, type ModelTier, type RouterConfig, type TaskAnalysis } from "../types.js";
import { PATTERN_LABELS, patternSteps } from "./patterns.js";
import { buildStepMessages } from "./prompts.js";
import type {
  DryRunWorkflowResult,
  RunWorkflowInput,
  WorkflowPatternId,
  WorkflowPlan,
  WorkflowRequest,
  WorkflowStepPlan,
} from "./types.js";

const ALIASES: Record<string, WorkflowPatternId> = {
  critique: "critique-revise",
  "implement-test-fix": "implement-test-fix",
  "parallel-synthesis": "parallel-synthesis",
  "plan-execute-validate": "plan-execute-validate",
  extract: "extract-normalize-validate",
  single: "single-shot",
};

export function resolveWorkflowPattern(request?: WorkflowRequest): WorkflowPatternId | "auto" {
  if (!request || request === "auto") return "auto";
  if (request in ALIASES) return ALIASES[request]!;
  return request as WorkflowPatternId;
}

const COMPARE_KEYWORDS =
  /\b(compare|versus|vs\.?|difference|contrast|pros and cons|evaluate options)\b/i;
const RESEARCH_KEYWORDS =
  /\b(research|explore|investigate|survey|review multiple|broad analysis)\b/i;
const WRITING_KEYWORDS =
  /\b(rfc|email|strategy doc|product doc|blog post|proposal|memo|documentation)\b/i;

export function selectWorkflowPattern(
  analysis: TaskAnalysis,
  input: RunWorkflowInput,
  modeConstraints: ModeConstraints,
  activeMode: import("../types.js").RoutingMode
): { pattern: WorkflowPatternId; why: string } {
  const explicit = resolveWorkflowPattern(input.workflow);
  if (explicit !== "auto") {
    return {
      pattern: explicit,
      why: `Workflow explicitly requested: ${PATTERN_LABELS[explicit]}`,
    };
  }

  const prompt = input.goal ?? extractUserPrompt(input.messages);

  if (activeMode === "fastest" && analysis.difficulty !== "hard") {
    return {
      pattern: "single-shot",
      why: "Fastest mode avoids multi-step critique and reflection loops",
    };
  }

  if (
    activeMode === "cheapest" &&
    analysis.difficulty === "easy" &&
    analysis.riskLevel === "low"
  ) {
    return {
      pattern: "single-shot",
      why: "Cheapest mode uses a single routed call for simple low-risk tasks",
    };
  }

  if (input.responseSchema || analysis.requiresStructuredOutput) {
    if (analysis.taskType === "extraction") {
      return {
        pattern: "extract-normalize-validate",
        why: "Structured extraction requires extract → normalize → validate pipeline",
      };
    }
  }

  if (
    WRITING_KEYWORDS.test(prompt) &&
    (input.taskHints?.quality === "best" || activeMode === "best-quality")
  ) {
    return {
      pattern: "critique-revise",
      why: "Writing task with best-quality preference uses draft → critique → revise",
    };
  }

  if (
    ["rewriting", "summarization"].includes(analysis.taskType) &&
    (input.taskHints?.quality === "best" || activeMode === "best-quality")
  ) {
    return {
      pattern: "critique-revise",
      why: "Writing or best-quality task benefits from draft → critique → revise",
    };
  }

  if (["code_edit", "debugging", "refactoring"].includes(analysis.taskType)) {
    const mentionsTests =
      /\b(test|tests|spec|jest|vitest|pytest|build|ci\b|tsc|typecheck|compile)\b/i.test(prompt);
    const wantsDepth =
      input.taskHints?.quality === "best" ||
      analysis.difficulty === "hard" ||
      analysis.riskLevel === "high" ||
      mentionsTests ||
      Boolean(input.hasValidationHooks);

    if (wantsDepth) {
      return {
        pattern: "implement-test-fix",
        why: mentionsTests
          ? "Coding task that mentions tests/build uses implement → test → fix"
          : "Hard/high-risk or best-quality coding task uses implement → test → fix",
      };
    }

    return {
      pattern: "single-shot",
      why: "Coding task without test/build hooks uses a single routed call (avoid multi-step theater)",
    };
  }

  if (COMPARE_KEYWORDS.test(prompt) || RESEARCH_KEYWORDS.test(prompt)) {
    const workers = RESEARCH_KEYWORDS.test(prompt) ? 3 : 2;
    return {
      pattern: "parallel-synthesis",
      why: `Comparison/research task uses parallel workers (${workers}) then synthesis`,
    };
  }

  if (
    analysis.taskType === "architecture" ||
    analysis.difficulty === "hard" ||
    analysis.taskType === "multi_step"
  ) {
    return {
      pattern: "plan-execute-validate",
      why: "Complex or architecture task needs plan → execute → validate",
    };
  }

  if (
    analysis.difficulty === "easy" &&
    analysis.riskLevel === "low" &&
    !analysis.requiresStructuredOutput &&
    !analysis.requiresToolUse
  ) {
    return {
      pattern: "single-shot",
      why: "Easy low-risk task does not require decomposition",
    };
  }

  if (activeMode === "best-quality" && analysis.difficulty !== "easy") {
    return {
      pattern: "plan-execute-validate",
      why: "Best-quality mode adds planning and validation for higher assurance",
    };
  }

  return {
    pattern: "single-shot",
    why: "Default single-shot routing for this objective",
  };
}

export function workerCountForPattern(
  pattern: WorkflowPatternId,
  prompt: string
): number | undefined {
  if (pattern !== "parallel-synthesis") return undefined;
  return RESEARCH_KEYWORDS.test(prompt) ? 3 : 2;
}

export function adjustStepsForMode(
  steps: WorkflowStepPlan[],
  constraints: ModeConstraints,
  activeMode: import("../types.js").RoutingMode
): WorkflowStepPlan[] {
  let adjusted = steps.map((s) => ({ ...s }));

  if (constraints.maxTier) {
    adjusted = adjusted.map((s) => ({
      ...s,
      recommendedTier: capTier(s.recommendedTier, constraints.maxTier!),
    }));
  }
  if (constraints.minTier) {
    adjusted = adjusted.map((s) => ({
      ...s,
      recommendedTier: floorTier(s.recommendedTier, constraints.minTier!),
    }));
  }

  if (activeMode === "cheapest") {
    adjusted = adjusted.map((s) => ({
      ...s,
      recommendedTier: capTier(s.recommendedTier, "local_strong"),
    }));
  }

  if (activeMode === "fastest") {
    adjusted = adjusted.filter(
      (s) => !["critique", "review"].includes(s.id) || !s.optional
    );
  }

  if (activeMode === "best-quality") {
    adjusted = adjusted.map((s) => {
      if (s.id === "review" || s.kind === "synthesis") {
        return { ...s, recommendedTier: floorTier(s.recommendedTier, "hosted_oss") };
      }
      return s;
    });
  }

  return adjusted;
}

export function planWorkflow(
  input: RunWorkflowInput,
  analysis: TaskAnalysis,
  config: RouterConfig
): WorkflowPlan {
  const baseOverrides = input.overrides ?? {};
  if (input.mode) baseOverrides.mode = input.mode;
  const activeMode = resolveActiveMode(baseOverrides, config);
  const runtime = applyModeToRuntime(activeMode, config, baseOverrides);
  const constraints = resolveModeConstraints(activeMode);
  const goal = input.goal ?? extractUserPrompt(input.messages);

  const { pattern, why } = selectWorkflowPattern(
    analysis,
    input,
    constraints,
    activeMode
  );

  const workerCount = workerCountForPattern(pattern, goal);
  let steps = patternSteps(pattern, {
    taskType: analysis.taskType,
    risk: analysis.riskLevel,
    defaultTier: runtime.routing.defaultTier,
    workerCount,
  });

  steps = adjustStepsForMode(steps, constraints, activeMode);

  const constraintNotes: string[] = [];
  if (constraints.maxTier) constraintNotes.push(`max tier: ${constraints.maxTier}`);
  if (constraints.minTier) constraintNotes.push(`min tier: ${constraints.minTier}`);
  if (constraints.preferLocal) constraintNotes.push("prefer local tiers");
  if (activeMode === "private") constraintNotes.push("private mode — localhost only");
  if (activeMode === "local-only") constraintNotes.push("local-only mode enforced");

  return {
    id: randomUUID(),
    pattern,
    patternLabel: PATTERN_LABELS[pattern],
    why,
    goal,
    steps,
    mode: activeMode,
    constraints: constraintNotes,
  };
}

export async function dryRunWorkflowPlan(
  input: RunWorkflowInput,
  config: RouterConfig
): Promise<DryRunWorkflowResult> {
  const userPrompt = input.goal ?? extractUserPrompt(input.messages);
  const analysis = analyzeTask({
    userPrompt,
    systemPrompt: extractSystemPrompt(input.messages),
    tools: input.tools,
    responseSchema: input.responseSchema,
    taskHints: input.taskHints,
  });

  const plan = planWorkflow(input, analysis, config);
  const stepRoutes: DryRunWorkflowResult["stepRoutes"] = [];
  const state = {
    goal: plan.goal,
    files: input.files,
    stepOutputs: new Map<string, { content: string; status: "passed" }>(),
    artifacts: {},
  };

  for (const step of plan.steps) {
    if (step.kind === "tool") {
      stepRoutes.push({
        stepId: step.id,
        name: step.name,
        recommendedTier: step.recommendedTier,
        predictedTier: step.recommendedTier,
        model: "tool-execution",
        reason: "Tool step — no model routing",
      });
      state.stepOutputs.set(step.id, { content: "[tool step]", status: "passed" });
      continue;
    }

    const messages = buildStepMessages(step, state, input.messages);
    const route = await dryRunRoute(
      {
        messages,
        tools: input.tools,
        responseSchema: step.validation.requireSchema ? input.responseSchema : undefined,
        taskHints: {
          type: step.taskType,
          risk: step.riskLevel,
          quality: input.taskHints?.quality,
        },
        overrides: input.overrides,
      },
      { config }
    );

    stepRoutes.push({
      stepId: step.id,
      name: step.name,
      recommendedTier: step.recommendedTier,
      predictedTier: route.routing.tier,
      model: route.routing.model,
      reason: route.routing.reason,
    });
    state.stepOutputs.set(step.id, { content: `[dry-run ${step.id}]`, status: "passed" });
  }

  const tierCost: Record<ModelTier, number> = {
    local_fast: 0,
    local_strong: 0.001,
    hosted_oss: 0.01,
    premium: 0.05,
  };

  const costs = stepRoutes.map((s) => tierCost[s.predictedTier] ?? 0.01);
  const latencies = stepRoutes.map((s) =>
    s.predictedTier === "local_fast" ? 500 : s.predictedTier === "premium" ? 8000 : 2000
  );

  const report = formatDryRunReport(plan, stepRoutes);

  return {
    plan,
    stepRoutes,
    constraints: plan.constraints,
    estimatedLatencyMs: {
      min: latencies.reduce((a, b) => a + b, 0) * 0.7,
      max: latencies.reduce((a, b) => a + b, 0) * 1.5,
    },
    estimatedCostUsd: {
      min: costs.reduce((a, b) => a + b, 0) * 0.5,
      max: costs.reduce((a, b) => a + b, 0) * 2,
    },
    report,
  };
}

function formatDryRunReport(
  plan: WorkflowPlan,
  routes: DryRunWorkflowResult["stepRoutes"]
): string {
  const lines = [
    "Maestro Workflow Dry Run",
    "═".repeat(40),
    `Goal: ${plan.goal}`,
    `Pattern: ${plan.patternLabel}`,
    `Why: ${plan.why}`,
    "",
    "Planned steps:",
  ];
  for (const r of routes) {
    lines.push(
      `  ${r.name} — recommended ${r.recommendedTier}, predicted ${r.predictedTier} (${r.model})`
    );
  }
  if (plan.constraints.length) {
    lines.push("", "Policy constraints:", ...plan.constraints.map((c) => `  • ${c}`));
  }
  return lines.join("\n");
}
