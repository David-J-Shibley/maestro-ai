import type {
  AttemptAction,
  AttemptLogEntry,
  EvaluationResult,
  ModelTier,
  RoutedAttempt,
  RoutingDecision,
  ValidationOutcome,
} from "../types.js";

const TIER_LABELS: Record<ModelTier, string> = {
  local_fast: "Local Fast",
  local_strong: "Local Strong",
  hosted_oss: "Hosted OSS",
  premium: "Premium",
};

const CHECK_LABELS: Record<string, string> = {
  non_empty: "empty or incomplete output",
  content_integrity: "incomplete or corrupt output",
  valid_json: "schema check",
  no_refusal: "model refusal",
  markdown_format: "markdown format",
  required_files: "required files",
  tool_calls_valid: "tool call validation",
  tests_pass: "test suite",
  build_pass: "build",
};

export function inferAttemptAction(
  attempt: RoutedAttempt,
  index: number,
  previousTier: ModelTier | null
): AttemptAction {
  if (attempt.action) return attempt.action;
  if (attempt.error) {
    return index === 0 || previousTier === null
      ? "initial"
      : attempt.tier === previousTier
        ? "retry"
        : "escalation";
  }
  if (index === 0) return "initial";
  if (previousTier === null || attempt.tier === previousTier) return "retry";
  return "escalation";
}

export function annotateAttemptActions(attempts: RoutedAttempt[]): RoutedAttempt[] {
  let previousTier: ModelTier | null = null;
  return attempts.map((attempt, index) => ({
    ...attempt,
    action: inferAttemptAction(attempt, index, previousTier),
  }));
}

export function failedCheckNames(evaluation?: EvaluationResult): string[] {
  if (!evaluation) return [];
  return evaluation.checks
    .filter((c) => !c.pass)
    .map((c) => CHECK_LABELS[c.name] ?? c.name);
}

export function humanizeFailedChecks(evaluation?: EvaluationResult): string {
  const names = failedCheckNames(evaluation);
  if (names.length === 0) {
    return evaluation?.reason ?? "validation failed";
  }
  return names.join(", ");
}

export function buildAttemptLog(attempts: RoutedAttempt[]): AttemptLogEntry[] {
  const annotated = annotateAttemptActions(attempts);
  return annotated.map((attempt) => ({
    tier: attempt.tier,
    model: attempt.model,
    action: attempt.action ?? "initial",
    latencyMs: attempt.latencyMs,
    pass: attempt.error ? false : (attempt.evaluation?.pass ?? false),
    failedChecks: attempt.evaluation
      ? attempt.evaluation.checks.filter((c) => !c.pass).map((c) => c.name)
      : undefined,
    reason: attempt.evaluation?.reason,
    error: attempt.error,
  }));
}

export function buildValidationOutcome(input: {
  initialRouting: RoutingDecision;
  finalRouting: RoutingDecision;
  attempts: RoutedAttempt[];
  evaluation: EvaluationResult;
  escalated: boolean;
  maxRetriesPerTier: number;
}): ValidationOutcome {
  const annotated = annotateAttemptActions(input.attempts);
  const whyEscalated = buildWhyEscalated(
    annotated,
    input.initialRouting.tier,
    input.maxRetriesPerTier
  );

  const attemptTrail = annotated.map((attempt) => ({
    tier: attempt.tier,
    model: attempt.model,
    action: attempt.action ?? "initial",
    pass: attempt.error ? false : (attempt.evaluation?.pass ?? false),
    failed_checks: attempt.evaluation
      ? failedCheckNames(attempt.evaluation)
      : undefined,
    reason: attempt.evaluation?.reason,
    error: attempt.error,
  }));

  const summary = buildOutcomeSummary({
    initialRouting: input.initialRouting,
    finalRouting: input.finalRouting,
    escalated: input.escalated,
    evaluation: input.evaluation,
    whyEscalated,
  });

  return {
    initial_tier: input.initialRouting.tier,
    initial_model: input.initialRouting.model,
    final_tier: input.finalRouting.tier,
    final_model: input.finalRouting.model,
    escalated: input.escalated,
    final_pass: input.evaluation.pass,
    summary,
    why_escalated: whyEscalated,
    attempt_trail: attemptTrail,
  };
}

function buildWhyEscalated(
  attempts: RoutedAttempt[],
  initialTier: ModelTier,
  maxRetriesPerTier: number
): string[] {
  const why: string[] = [];
  const firstEscalationIdx = attempts.findIndex(
    (a, i) => i > 0 && a.tier !== attempts[i - 1]?.tier
  );

  if (firstEscalationIdx < 0) {
    if (attempts.some((a) => a.error)) {
      why.push("Provider error on selected tier — moved to next available tier");
    }
    return why;
  }

  const attemptsBeforeEscalation = attempts.slice(0, firstEscalationIdx);
  const lastFailed = [...attemptsBeforeEscalation]
    .reverse()
    .find((a) => a.error || a.evaluation?.pass === false);

  if (lastFailed?.error) {
    why.push(`Provider error on ${TIER_LABELS[lastFailed.tier]}: ${lastFailed.error}`);
  } else if (lastFailed?.evaluation) {
    const failed = humanizeFailedChecks(lastFailed.evaluation);
    why.push(`${TIER_LABELS[lastFailed.tier]} output failed ${failed}`);
  }

  const retriesOnInitial = attemptsBeforeEscalation.filter(
    (a) => a.tier === initialTier
  ).length;
  if (retriesOnInitial > 1 && maxRetriesPerTier > 0) {
    why.push(
      `Retries on ${TIER_LABELS[initialTier]} exhausted (${maxRetriesPerTier}/${maxRetriesPerTier})`
    );
  } else if (retriesOnInitial > 0) {
    why.push(`${TIER_LABELS[initialTier]} could not produce a passing response`);
  }

  const escalatedTo = attempts[firstEscalationIdx];
  if (escalatedTo) {
    why.push(`Escalated to ${TIER_LABELS[escalatedTo.tier]} for higher-quality output`);
  }

  return why;
}

function buildOutcomeSummary(input: {
  initialRouting: RoutingDecision;
  finalRouting: RoutingDecision;
  escalated: boolean;
  evaluation: EvaluationResult;
  whyEscalated: string[];
}): string {
  const initial = TIER_LABELS[input.initialRouting.tier];
  const finalTier = TIER_LABELS[input.finalRouting.tier];
  const result = input.evaluation.pass ? "passed" : "failed";

  if (!input.escalated) {
    return input.evaluation.pass
      ? `${initial} → ${result}`
      : `${initial} → validation ${result}`;
  }

  return `${initial} → escalated to ${finalTier} → ${result}`;
}

export function formatOutcomeMarkdown(outcome: ValidationOutcome): string {
  const lines = [
    "",
    "**Validation**",
    `- Selected: \`${outcome.initial_model}\` (${TIER_LABELS[outcome.initial_tier]})`,
  ];

  for (const step of outcome.attempt_trail) {
    if (step.action === "initial") {
      if (!step.pass) {
        lines.push(
          `- Validation: failed ${step.failed_checks?.join(", ") ?? step.reason ?? "checks"}`
        );
      } else {
        lines.push("- Validation: passed");
      }
      continue;
    }

    if (step.action === "retry") {
      lines.push("- Action: retry same tier");
      if (!step.pass) {
        lines.push(
          `- Retry: failed ${step.failed_checks?.join(", ") ?? step.reason ?? "checks"}`
        );
      } else {
        lines.push("- Retry: passed");
      }
      continue;
    }

    if (step.action === "escalation" || step.action === "provider_recovery") {
      lines.push(
        `- Escalated to: \`${step.model}\` (${TIER_LABELS[step.tier]})`
      );
      if (step.pass) {
        lines.push("- Escalation attempt: passed");
      } else if (step.error) {
        lines.push(`- Escalation attempt: provider error (${step.error})`);
      } else {
        lines.push(
          `- Escalation attempt: failed ${step.failed_checks?.join(", ") ?? step.reason ?? "checks"}`
        );
      }
    }
  }

  lines.push(`- **Final result:** ${outcome.final_pass ? "passed" : "failed"}`);

  if (outcome.why_escalated.length > 0) {
    lines.push("", "**Why escalated?**");
    for (const w of outcome.why_escalated) {
      lines.push(`- ✓ ${w}`);
    }
  }

  return lines.join("\n");
}
