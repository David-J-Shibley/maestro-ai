import { evaluateResponse, evaluateResponseAsync } from "../evaluator/response-evaluator.js";
import { estimateCostUsd } from "../telemetry/logger.js";
import { routedLLMCall, type RoutedLLMCallOptions } from "../routed-llm-call.js";
import type { EvaluatorContext, RouterConfig } from "../types.js";
import { executionLevels, shouldSkipStep } from "./dag.js";
import { buildStepMessages, getFinalOutput } from "./prompts.js";
import type {
  RunWorkflowInput,
  StepRunner,
  StepOutput,
  WorkflowPlan,
  WorkflowStateSnapshot,
  WorkflowStepPlan,
  WorkflowStepResult,
} from "./types.js";

export interface ExecuteWorkflowOptions extends RoutedLLMCallOptions {
  stepRunner?: StepRunner;
  evaluatorContext?: EvaluatorContext;
}

const defaultStepRunner: StepRunner = async (ctx, options) => {
  return routedLLMCall(
    {
      messages: ctx.messages,
      tools: ctx.tools,
      responseSchema: ctx.responseSchema,
      taskHints: ctx.taskHints,
      overrides: options.overrides,
    },
    options
  );
};

export async function executeWorkflow(
  plan: WorkflowPlan,
  input: RunWorkflowInput,
  config: RouterConfig,
  options: ExecuteWorkflowOptions = {}
): Promise<{
  steps: WorkflowStepResult[];
  finalOutput: string;
  artifacts: Record<string, import("./types.js").WorkflowArtifact>;
  state: WorkflowStateSnapshot;
}> {
  const runner = options.stepRunner ?? defaultStepRunner;
  const levels = executionLevels(plan.steps);
  const state: WorkflowStateSnapshot = {
    goal: plan.goal,
    files: input.files,
    stepOutputs: new Map(),
  };
  const stepResults = new Map<string, StepOutput>();
  const artifacts: Record<string, import("./types.js").WorkflowArtifact> = {};

  const baseOptions: RoutedLLMCallOptions = {
    config,
    configPath: options.configPath,
    evaluatorContext: options.evaluatorContext,
    overrides: input.overrides,
  };

  for (const level of levels) {
    const toRun: WorkflowStepPlan[] = [];

    for (const step of level) {
      if (shouldSkipStep(step, stepResults)) {
        const skipped: StepOutput = {
          stepId: step.id,
          content: "",
          status: "skipped",
          latencyMs: 0,
          estimatedCostUsd: 0,
          escalated: false,
          retries: 0,
        };
        stepResults.set(step.id, skipped);
        state.stepOutputs.set(step.id, { content: "", status: "skipped" });
        continue;
      }
      toRun.push(step);
    }

    const parallel = toRun.filter((s) => s.parallelizable);
    const sequential = toRun.filter((s) => !s.parallelizable);

    for (const step of sequential) {
      await runOneStep(step, input, state, stepResults, artifacts, runner, baseOptions, options.evaluatorContext);
    }

    if (parallel.length > 0) {
      await Promise.all(
        parallel.map((step) =>
          runOneStep(step, input, state, stepResults, artifacts, runner, baseOptions, options.evaluatorContext)
        )
      );
    }
  }

  const steps = plan.steps
    .map((s) => toStepResult(s, stepResults.get(s.id)))
    .filter((s): s is WorkflowStepResult => s !== null);

  const finalOutput = getFinalOutput(plan, state);

  return { steps, finalOutput, artifacts, state };
}

async function runOneStep(
  step: WorkflowStepPlan,
  input: RunWorkflowInput,
  state: WorkflowStateSnapshot,
  stepResults: Map<string, StepOutput>,
  artifacts: Record<string, import("./types.js").WorkflowArtifact>,
  runner: StepRunner,
  baseOptions: RoutedLLMCallOptions,
  evaluatorContext?: EvaluatorContext
): Promise<void> {
  const started = Date.now();

  if (step.kind === "tool") {
    const needsTests = step.validation.runTests && evaluatorContext?.runTests;
    const needsBuild = step.validation.runBuild && evaluatorContext?.runBuild;

    if (!needsTests && !needsBuild) {
      const skipped: StepOutput = {
        stepId: step.id,
        content: "Tool validation skipped — no test/build runners provided",
        status: "skipped",
        latencyMs: 0,
        estimatedCostUsd: 0,
        escalated: false,
        retries: 0,
      };
      stepResults.set(step.id, skipped);
      state.stepOutputs.set(step.id, { content: skipped.content, status: "skipped" });
      return;
    }
    const evalCtx: EvaluatorContext = {
      ...evaluatorContext,
      runTests: needsTests ? evaluatorContext?.runTests : undefined,
      runBuild: needsBuild ? evaluatorContext?.runBuild : undefined,
    };

    const evaluation =
      evalCtx.runTests || evalCtx.runBuild
        ? await evaluateResponseAsync("", evalCtx)
        : evaluateResponse("", evalCtx);

    const output: StepOutput = {
      stepId: step.id,
      content: evaluation.pass ? "Tool validation passed" : evaluation.reason,
      status: evaluation.pass ? "passed" : "failed",
      evaluation,
      latencyMs: Date.now() - started,
      estimatedCostUsd: 0,
      escalated: false,
      retries: 0,
    };
    stepResults.set(step.id, output);
    state.stepOutputs.set(step.id, { content: output.content, status: output.status });
    return;
  }

  const messages = buildStepMessages(step, state, input.messages);
  const taskHints = {
    type: step.taskType,
    risk: step.riskLevel,
    quality: input.taskHints?.quality,
  };

  const stepEvalCtx: EvaluatorContext = {
    ...evaluatorContext,
    responseSchema: step.validation.requireSchema ? input.responseSchema : undefined,
    expectedFormat: step.validation.requireSchema ? "json" : evaluatorContext?.expectedFormat,
  };

  let result;
  try {
    result = await runner(
      {
        step,
        messages,
        taskHints,
        responseSchema: step.validation.requireSchema ? input.responseSchema : undefined,
        tools: input.tools,
        evaluatorContext: stepEvalCtx,
      },
      baseOptions
    );
  } catch (err) {
    const output: StepOutput = {
      stepId: step.id,
      content: "",
      status: "failed",
      latencyMs: Date.now() - started,
      estimatedCostUsd: 0,
      escalated: false,
      retries: 0,
      error: err instanceof Error ? err.message : String(err),
    };
    stepResults.set(step.id, output);
    state.stepOutputs.set(step.id, { content: "", status: "failed" });
    return;
  }

  let evaluation = result.evaluation;
  if (step.validation.requireNoPlaceholders) {
    evaluation = applyPlaceholderCheck(result.response.content, evaluation);
  }

  const retries = result.attempts.filter((a) => a.action === "retry").length;
  const output: StepOutput = {
    stepId: step.id,
    content: result.response.content,
    status: evaluation.pass ? "passed" : "failed",
    routing: result.routing,
    analysis: result.analysis,
    evaluation,
    latencyMs: result.response.latencyMs,
    estimatedCostUsd: estimateCostUsd(result.routing.tier, result.response.usage) ?? 0,
    escalated: result.escalated,
    retries,
  };

  stepResults.set(step.id, output);
  state.stepOutputs.set(step.id, { content: output.content, status: output.status });

  artifacts[step.id] = {
    stepId: step.id,
    name: step.name,
    content: output.content,
    mimeType: step.validation.requireSchema ? "application/json" : "text/plain",
  };
}

function applyPlaceholderCheck(
  content: string,
  evaluation: import("../types.js").EvaluationResult
): import("../types.js").EvaluationResult {
  const placeholderPatterns = [
    /\bTODO\b/i,
    /\bFIXME\b/i,
    /\[placeholder\]/i,
    /\{\{[^}]+\}\}/,
    /<insert\b/i,
  ];
  const hasPlaceholder = placeholderPatterns.some((p) => p.test(content));
  if (!hasPlaceholder) return evaluation;

  const checks = [
    ...evaluation.checks,
    {
      name: "no_placeholders",
      pass: false,
      reason: "Output contains unresolved placeholders",
    },
  ];
  return {
    ...evaluation,
    pass: false,
    checks,
    reason: `${evaluation.reason}; unresolved placeholders`,
    retryRecommended: true,
  };
}

function toStepResult(
  step: WorkflowStepPlan,
  output?: StepOutput
): WorkflowStepResult | null {
  if (!output) return null;
  return {
    ...output,
    name: step.name,
    recommendedTier: step.recommendedTier,
    actualTier: output.routing?.tier ?? step.recommendedTier,
    model: output.routing?.model ?? "n/a",
  };
}
