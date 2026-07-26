import type { WorkflowExecutionReport, WorkflowPlan, WorkflowStepResult, WorkflowValidation } from "./types.js";

export function formatExecutionReport(
  plan: WorkflowPlan,
  steps: WorkflowStepResult[],
  validation: WorkflowValidation
): WorkflowExecutionReport {
  const totalLatencyMs = steps.reduce((sum, s) => sum + s.latencyMs, 0);
  const estimatedCostUsd = steps.reduce((sum, s) => sum + s.estimatedCostUsd, 0);
  const escalations: string[] = [];

  for (const s of steps) {
    if (s.escalated) {
      escalations.push(`${s.name} escalated to ${s.actualTier}`);
    }
    if (s.retries > 0) {
      escalations.push(`${s.name} retried ${s.retries} time(s)`);
    }
  }

  const failed = steps.filter((s) => s.status === "failed");
  const finalStatus: WorkflowExecutionReport["finalStatus"] = validation.pass
    ? "passed"
    : failed.length > 0 && steps.some((s) => s.status === "passed")
      ? "partial"
      : "failed";

  const tradeoffs: string[] = [];
  if (plan.mode === "cheapest") tradeoffs.push("Cheapest mode minimized steps and tier cost");
  if (plan.mode === "fastest") tradeoffs.push("Fastest mode skipped reflection loops where possible");
  if (plan.mode === "best-quality") tradeoffs.push("Best-quality mode added review and higher-tier steps");
  if (plan.pattern === "parallel-synthesis") {
    tradeoffs.push("Parallel workers increased throughput at higher aggregate cost");
  }

  const stepSummaries = steps.map((s) => ({
    id: s.stepId,
    name: s.name,
    tier: s.actualTier,
    status: s.status,
    escalated: s.escalated,
    retries: s.retries,
    validation: s.evaluation?.pass
      ? "passed"
      : s.status === "skipped"
        ? "skipped"
        : s.evaluation?.reason ?? s.error ?? "failed",
  }));

  const skippedValidation = validation.checks.find((c) => c.name === "tool_validation_skipped");
  const markdown = [
    "Maestro Execution Report",
    "═".repeat(40),
    "",
    "Goal:",
    plan.goal,
    "",
    "Workflow:",
    plan.patternLabel,
    "",
    "Why:",
    plan.why,
    "",
    "Steps:",
    "",
    ...stepSummaries.map(
      (s, i) =>
        `${i + 1}. ${s.name} — ${s.tier} — ${s.status}${s.escalated ? " (escalated)" : ""}`
    ),
    "",
    escalations.length ? `Escalations:\n${escalations.map((e) => `  • ${e}`).join("\n")}\n` : "",
    skippedValidation?.reason ? `Note: ${skippedValidation.reason}\n` : "",
    `Final result: ${finalStatus === "passed" ? "Passed" : finalStatus === "partial" ? "Partial" : "Failed"}.`,
    "",
    `Total latency: ${totalLatencyMs}ms`,
    `Estimated cost: $${estimatedCostUsd.toFixed(4)}`,
    `Confidence: ${(validation.confidence * 100).toFixed(0)}%`,
    tradeoffs.length ? `\nTradeoffs:\n${tradeoffs.map((t) => `  • ${t}`).join("\n")}` : "",
  ].join("\n");

  return {
    markdown,
    goal: plan.goal,
    pattern: plan.pattern,
    patternLabel: plan.patternLabel,
    why: plan.why,
    steps: stepSummaries,
    escalations,
    totalLatencyMs,
    estimatedCostUsd,
    finalStatus,
    finalConfidence: validation.confidence,
    tradeoffs,
  };
}
