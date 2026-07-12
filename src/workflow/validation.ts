import { evaluateResponse } from "../evaluator/response-evaluator.js";
import type { RunWorkflowInput, WorkflowPlan, WorkflowStepResult, WorkflowValidation } from "./types.js";

export function validateWorkflowOutput(
  plan: WorkflowPlan,
  input: RunWorkflowInput,
  steps: WorkflowStepResult[],
  finalOutput: string
): WorkflowValidation {
  const checks: WorkflowValidation["checks"] = [];

  const requiredSteps = plan.steps.filter((s) => !s.optional && !s.runOnFailure);
  const completedRequired = requiredSteps.filter((s) => {
    const result = steps.find((r) => r.stepId === s.id);
    return result && (result.status === "passed" || result.status === "skipped");
  });
  checks.push({
    name: "required_steps_completed",
    pass: completedRequired.length === requiredSteps.length,
    reason:
      completedRequired.length === requiredSteps.length
        ? undefined
        : `Missing steps: ${requiredSteps
            .filter((s) => !completedRequired.find((c) => c.id === s.id))
            .map((s) => s.id)
            .join(", ")}`,
  });

  const depsSatisfied = plan.steps.every((s) => {
    const result = steps.find((r) => r.stepId === s.id);
    if (!result || result.status === "skipped") return true;
    return s.dependsOn.every((dep) => {
      const depResult = steps.find((r) => r.stepId === dep);
      return depResult && depResult.status !== "pending" && depResult.status !== "running";
    });
  });
  checks.push({
    name: "dependencies_satisfied",
    pass: depsSatisfied,
    reason: depsSatisfied ? undefined : "Step dependencies not satisfied",
  });

  const contentEval = evaluateResponse(finalOutput, {
    responseSchema: input.responseSchema,
    expectedFormat: input.responseSchema ? "json" : "text",
  });
  checks.push({
    name: "final_output_valid",
    pass: contentEval.pass && finalOutput.trim().length > 0,
    reason: finalOutput.trim() ? contentEval.reason : "Final output is empty",
  });

  if (input.responseSchema) {
    checks.push({
      name: "schema_valid",
      pass: contentEval.checks.find((c) => c.name === "valid_json")?.pass ?? contentEval.pass,
      reason: "Final output must match response schema",
    });
  }

  const placeholderCheck = !/\bTODO\b|\bFIXME\b|\[placeholder\]/i.test(finalOutput);
  checks.push({
    name: "no_unresolved_placeholders",
    pass: placeholderCheck,
    reason: placeholderCheck ? undefined : "Final output contains placeholders",
  });

  const pass = checks.every((c) => c.pass);
  const passedCount = checks.filter((c) => c.pass).length;
  const confidence = pass ? 0.9 : passedCount / checks.length;

  return {
    pass,
    confidence,
    checks,
    summary: pass
      ? "Workflow completed successfully"
      : checks
          .filter((c) => !c.pass)
          .map((c) => c.reason ?? c.name)
          .join("; "),
  };
}
