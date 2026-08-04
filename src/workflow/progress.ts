import type { ModelTier } from "../types.js";
import type {
  WorkflowPatternId,
  WorkflowStepKind,
  WorkflowStepStatus,
} from "./types.js";

export type WorkflowProgressEvent =
  | {
      type: "workflow_started";
      workflowId: string;
      pattern: WorkflowPatternId;
      patternLabel: string;
      goal: string;
      stepCount: number;
      steps: Array<{ id: string; name: string; dependsOn: string[] }>;
    }
  | {
      type: "step_started";
      stepId: string;
      name: string;
      kind: WorkflowStepKind;
      index: number;
      total: number;
      recommendedTier: ModelTier;
    }
  | {
      type: "step_finished";
      stepId: string;
      name: string;
      status: Exclude<WorkflowStepStatus, "pending" | "running">;
      latencyMs: number;
      index: number;
      total: number;
      actualTier?: ModelTier;
      model?: string;
      escalated?: boolean;
      retries?: number;
      error?: string;
    }
  | {
      type: "workflow_finished";
      workflowId: string;
      finalStatus: "passed" | "failed" | "partial";
      totalLatencyMs: number;
      estimatedCostUsd: number;
      finalConfidence: number;
    };

export type WorkflowProgressHandler = (event: WorkflowProgressEvent) => void;

/** Human-readable one-liner for CLI stderr. */
export function formatProgressLine(event: WorkflowProgressEvent): string {
  switch (event.type) {
    case "workflow_started":
      return `[maestro] workflow ${event.patternLabel} — ${event.stepCount} steps`;
    case "step_started":
      return `[maestro] ${event.index}/${event.total} ${event.name} → running (${event.recommendedTier})`;
    case "step_finished": {
      const bits: string[] = [event.status];
      if (event.actualTier) bits.push(event.actualTier);
      if (event.model && event.model !== "n/a") bits.push(event.model);
      if (event.escalated) bits.push("escalated");
      if (event.retries && event.retries > 0) bits.push(`retries=${event.retries}`);
      bits.push(`${event.latencyMs}ms`);
      return `[maestro] ${event.index}/${event.total} ${event.name} → ${bits.join(" · ")}`;
    }
    case "workflow_finished":
      return `[maestro] workflow ${event.finalStatus} — ${event.totalLatencyMs}ms · $${event.estimatedCostUsd.toFixed(4)} · confidence ${(event.finalConfidence * 100).toFixed(0)}%`;
    default:
      return `[maestro] ${(event as { type: string }).type}`;
  }
}

export function emitProgress(
  onProgress: WorkflowProgressHandler | undefined,
  event: WorkflowProgressEvent
): void {
  if (!onProgress) return;
  try {
    onProgress(event);
  } catch {
    // Progress must never break workflow execution
  }
}
