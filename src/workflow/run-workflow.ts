import {
  analyzeTask,
  extractSystemPrompt,
  extractUserPrompt,
} from "../analyzer/task-analyzer.js";
import { loadConfig } from "../config/load-config.js";
import {
  applyModeToRuntime,
  resolveActiveMode,
} from "../routing/modes.js";
import { estimateCostUsd } from "../telemetry/logger.js";
import { routedLLMCall, type RoutedLLMCallOptions } from "../routed-llm-call.js";
import type { RouterConfig } from "../types.js";
import { dryRunWorkflowPlan, planWorkflow } from "./planner.js";
import { executeWorkflow, type ExecuteWorkflowOptions } from "./executor.js";
import { formatExecutionReport } from "./report.js";
import { logWorkflowTelemetry, workflowPromptHash } from "./telemetry.js";
import { validateWorkflowOutput } from "./validation.js";
import type {
  DryRunWorkflowResult,
  RunWorkflowInput,
  RunWorkflowResult,
} from "./types.js";

export interface RunWorkflowOptions extends RoutedLLMCallOptions, ExecuteWorkflowOptions {}

export async function runWorkflow(
  input: RunWorkflowInput,
  options: RunWorkflowOptions = {}
): Promise<RunWorkflowResult> {
  const config = options.config ?? loadConfig(options.configPath);
  const userPrompt = input.goal ?? extractUserPrompt(input.messages);
  const systemPrompt = extractSystemPrompt(input.messages);

  const analysis = analyzeTask({
    userPrompt,
    systemPrompt,
    tools: input.tools,
    responseSchema: input.responseSchema,
    taskHints: input.taskHints,
  });

  const baseOverrides = input.overrides ?? {};
  if (input.mode) baseOverrides.mode = input.mode;
  const activeMode = resolveActiveMode(baseOverrides, config);
  const runtime = applyModeToRuntime(activeMode, config, baseOverrides);
  const effectiveInput = { ...input, overrides: runtime.overrides };

  const plan = planWorkflow(effectiveInput, analysis, config);

  if (plan.pattern === "single-shot") {
    return runSingleShot(effectiveInput, analysis, config, options, plan);
  }

  const { steps, finalOutput, artifacts } = await executeWorkflow(
    plan,
    effectiveInput,
    config,
    options
  );

  const validation = validateWorkflowOutput(plan, effectiveInput, steps, finalOutput);
  const report = formatExecutionReport(plan, steps, validation);

  const sessionId =
    effectiveInput.overrides?.session?.sessionId ??
    (effectiveInput.overrides?.session?.budgetUsd !== undefined ? "anonymous" : undefined);

  const workflowId = logWorkflowTelemetry(config, {
    plan,
    steps,
    validation,
    promptHash: workflowPromptHash(userPrompt, systemPrompt),
    sessionId,
    userFeedback: effectiveInput.overrides?.userFeedback,
  });

  return {
    finalOutput,
    workflow: plan,
    steps,
    report,
    telemetry: { workflowId },
    validation,
    artifacts,
    analysis,
  };
}

async function runSingleShot(
  input: RunWorkflowInput,
  analysis: import("../types.js").TaskAnalysis,
  config: RouterConfig,
  options: RunWorkflowOptions,
  plan: import("./types.js").WorkflowPlan
): Promise<RunWorkflowResult> {
  const result = await routedLLMCall(
    {
      messages: input.messages,
      tools: input.tools,
      responseSchema: input.responseSchema,
      taskHints: input.taskHints,
      overrides: input.overrides,
    },
    options
  );

  const step = plan.steps[0]!;
  const steps: import("./types.js").WorkflowStepResult[] = [
    {
      stepId: step.id,
      name: step.name,
      content: result.response.content,
      status: result.evaluation.pass ? "passed" : "failed",
      routing: result.routing,
      analysis: result.analysis,
      evaluation: result.evaluation,
      latencyMs: result.response.latencyMs,
      estimatedCostUsd: estimateCostUsd(result.routing.tier, result.response.usage) ?? 0,
      escalated: result.escalated,
      retries: result.attempts.filter((a) => a.action === "retry").length,
      recommendedTier: step.recommendedTier,
      actualTier: result.routing.tier,
      model: result.routing.model,
    },
  ];

  const validation = validateWorkflowOutput(plan, input, steps, result.response.content);
  const report = formatExecutionReport(plan, steps, validation);

  const userPrompt = input.goal ?? extractUserPrompt(input.messages);
  const workflowId = logWorkflowTelemetry(config, {
    plan,
    steps,
    validation,
    promptHash: workflowPromptHash(userPrompt, extractSystemPrompt(input.messages)),
    sessionId: input.overrides?.session?.sessionId,
    userFeedback: input.overrides?.userFeedback,
  });

  return {
    finalOutput: result.response.content,
    workflow: plan,
    steps,
    report,
    telemetry: { workflowId },
    validation,
    artifacts: {
      execute: {
        stepId: "execute",
        name: "Execute",
        content: result.response.content,
      },
    },
    analysis: result.analysis,
    routing: result.routing,
    response: result.response,
  };
}

export async function dryRunWorkflow(
  input: RunWorkflowInput,
  options: RoutedLLMCallOptions = {}
): Promise<DryRunWorkflowResult> {
  const config = options.config ?? loadConfig(options.configPath);
  return dryRunWorkflowPlan(input, config);
}
