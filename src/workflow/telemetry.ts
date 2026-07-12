import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashPrompt } from "../analyzer/task-analyzer.js";
import { expandPath } from "../config/load-config.js";
import type { RouterConfig } from "../types.js";
import type {
  WorkflowPlan,
  WorkflowStepResult,
  WorkflowTelemetryRecord,
  WorkflowValidation,
} from "./types.js";

export function logWorkflowTelemetry(
  config: RouterConfig,
  input: {
    plan: WorkflowPlan;
    steps: WorkflowStepResult[];
    validation: WorkflowValidation;
    promptHash: string;
    sessionId?: string;
    userFeedback?: string;
  }
): string {
  if (!config.telemetry.enabled) return "telemetry-disabled";

  const workflowId = randomUUID();
  const path = expandPath(config.telemetry.logPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const totalLatencyMs = input.steps.reduce((s, x) => s + x.latencyMs, 0);
  const estimatedCostUsd = input.steps.reduce((s, x) => s + x.estimatedCostUsd, 0);

  const record: WorkflowTelemetryRecord = {
    recordType: "workflow",
    workflowId,
    timestamp: new Date().toISOString(),
    promptHash: input.promptHash,
    goal: input.plan.goal,
    pattern: input.plan.pattern,
    mode: input.plan.mode,
    steps: input.steps.map((s) => ({
      stepId: s.stepId,
      name: s.name,
      taskType: input.plan.steps.find((p) => p.id === s.stepId)?.taskType ?? "unknown",
      tier: s.actualTier,
      model: s.model,
      provider: s.routing?.provider ?? "n/a",
      latencyMs: s.latencyMs,
      estimatedCostUsd: s.estimatedCostUsd,
      success: s.status === "passed",
      escalated: s.escalated,
      retries: s.retries,
      validationSummary: s.evaluation?.reason ?? s.status,
    })),
    finalStatus: input.validation.pass
      ? "passed"
      : input.steps.some((s) => s.status === "failed")
        ? "failed"
        : "partial",
    finalConfidence: input.validation.confidence,
    totalLatencyMs,
    estimatedCostUsd,
    sessionId: input.sessionId,
    userFeedback: input.userFeedback,
  };

  appendFileSync(path, JSON.stringify(record) + "\n");
  return workflowId;
}

export function workflowPromptHash(goal: string, system?: string): string {
  return hashPrompt(`${system ?? ""}\n${goal}`);
}
