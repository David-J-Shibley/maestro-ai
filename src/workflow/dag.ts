import type { WorkflowStepPlan } from "./types.js";

/** Group steps into execution levels for parallel execution within each level. */
export function executionLevels(steps: WorkflowStepPlan[]): WorkflowStepPlan[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const remaining = new Set(steps.map((s) => s.id));
  const completed = new Set<string>();
  const levels: WorkflowStepPlan[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((s) => s.dependsOn.every((d) => completed.has(d)));

    if (ready.length === 0) {
      throw new Error("Workflow graph has a cycle or missing dependency");
    }

    levels.push(ready);
    for (const s of ready) {
      remaining.delete(s.id);
      completed.add(s.id);
    }
  }

  return levels;
}

export function shouldSkipStep(
  step: WorkflowStepPlan,
  stepResults: Map<string, { status: string }>
): boolean {
  for (const dep of step.dependsOn) {
    const depResult = stepResults.get(dep);
    if (depResult?.status === "failed" && !step.runOnFailure) {
      return true;
    }
  }

  if (!step.runOnFailure) return false;

  const deps = step.dependsOn;
  const anyFailed = deps.some((d) => stepResults.get(d)?.status === "failed");
  const anyPassed = deps.some((d) => stepResults.get(d)?.status === "passed");

  if (step.id === "fix") {
    return !anyFailed;
  }

  if (step.id === "review" && step.dependsOn.includes("fix")) {
    const fix = stepResults.get("fix");
    if (fix?.status === "skipped" || fix === undefined) {
      const validate = stepResults.get("validate");
      return validate?.status === "failed";
    }
  }

  return step.optional === true && !anyFailed && anyPassed;
}
