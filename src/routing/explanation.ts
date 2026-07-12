import type { ModelTier, RoutingDecision, TaskAnalysis, TaskType, ValidationOutcome } from "../types.js";
import { nextTier } from "../types.js";
import { isLocalTier } from "../types.js";
import { formatOutcomeMarkdown } from "./outcome.js";
import { getModeProfile } from "./modes.js";
import type { RoutingMode } from "../types.js";

export interface HistoricalContext {
  sampleSize: number;
  successRate: number;
  taskType: TaskType;
  tier: ModelTier;
}

export interface DecisionExplanation {
  summary: string;
  markdown: string;
  why: string[];
  task: {
    type: TaskType;
    difficulty: string;
    risk: string;
    context_tokens?: number;
    signals?: string[];
  };
  selected: {
    tier: ModelTier;
    model: string;
    provider: string;
    endpoint_source?: string;
  };
  fallback?: {
    tier: ModelTier;
    model?: string;
  };
  cost_note?: string;
  historical?: HistoricalContext;
  policy_notes?: string[];
  /** Active routing mode for this decision */
  mode?: RoutingMode;
  budget_note?: string;
  /** Present after maestro_ask / routedLLMCall when evaluator ran. */
  outcome?: ValidationOutcome;
}

const TIER_LABELS: Record<ModelTier, string> = {
  local_fast: "Local Fast",
  local_strong: "Local Strong",
  hosted_oss: "Hosted OSS",
  premium: "Premium",
};

const TASK_LABELS: Record<TaskType, string> = {
  simple_answer: "Simple answer",
  formatting: "Formatting",
  classification: "Classification",
  summarization: "Summarization",
  rewriting: "Rewriting",
  extraction: "Extraction",
  code_edit: "Code edit",
  debugging: "Debugging",
  refactoring: "Refactoring",
  architecture: "Architecture",
  multi_step: "Multi-step",
  tool_use: "Tool use",
  unknown: "General task",
};

/** Rough relative cost index for explanation (premium = 100). */
const TIER_COST_INDEX: Record<ModelTier, number> = {
  local_fast: 0,
  local_strong: 1,
  hosted_oss: 15,
  premium: 100,
};

export function buildDecisionExplanation(input: {
  routing: RoutingDecision;
  analysis: TaskAnalysis;
  contextTokens?: number;
  historical?: HistoricalContext | null;
  policyNotes?: string[];
  fallbackModel?: string;
  outcome?: ValidationOutcome;
}): DecisionExplanation {
  const { routing, analysis, contextTokens, historical, policyNotes, fallbackModel, outcome } =
    input;

  const why: string[] = [];

  for (const line of routing.debug ?? []) {
    if (line.startsWith("rule:")) {
      why.push(humanizeRule(line.slice(5).trim()));
    } else if (line.startsWith("mode:") || line.startsWith("Mode ")) {
      why.push(line.replace(/^mode:\s*/i, "Mode: "));
    } else if (line.startsWith("policy:") || line.startsWith("Policy:")) {
      why.push(line.replace(/^policy:\s*/i, "Policy: "));
    } else if (line.includes("budget")) {
      why.push(humanizeBudgetLine(line));
    } else if (line.startsWith("override:")) {
      why.push(`Override applied: ${line.slice(9).trim()}`);
    } else if (line.startsWith("hint:")) {
      why.push(`User hint: ${line.slice(5).trim()}`);
    } else if (line.includes("tier_fallback") || line.includes("fallback")) {
      why.push(humanizeFallbackLine(line));
    }
  }

  why.push(...tierFitReasons(analysis, routing.tier));

  if (isLocalTier(routing.tier)) {
    why.push("Runs on localhost (Ollama) — no cloud API cost for inference");
  } else {
    const savings = estimateSavingsVsPremium(routing.tier);
    if (savings > 0) {
      why.push(`Estimated ~${savings}% lower cost than premium tier`);
    }
  }

  if (routing.endpointSource === "tier_fallback") {
    why.push("Primary endpoint unavailable — using configured tier fallback");
  }

  if (historical && historical.sampleSize >= 5) {
    why.push(
      `Historical success rate: ${(historical.successRate * 100).toFixed(0)}% (${historical.sampleSize} similar tasks)`
    );
  }

  if (policyNotes?.length) {
    for (const n of policyNotes) why.push(n);
  }

  const fallbackTier = routing.fallbackTier ?? nextTier(routing.tier);
  const fallback =
    fallbackTier
      ? {
          tier: fallbackTier,
          model: fallbackModel,
        }
      : undefined;

  let budgetNote: string | undefined;
  if (routing.budget) {
    budgetNote = `Session budget: $${routing.budget.remaining_usd.toFixed(2)} remaining of $${routing.budget.budget_usd.toFixed(2)}`;
    why.push(`Budget cap tier: ${routing.budget.cap_tier}`);
  }

  const taskLabel = TASK_LABELS[analysis.taskType] ?? analysis.taskType;
  const modeLabel = routing.mode ? getModeProfile(routing.mode).label : undefined;
  const summary = modeLabel
    ? `${modeLabel} · ${taskLabel} → ${routing.model} (${TIER_LABELS[routing.tier]})`
    : `${taskLabel} → ${routing.model} (${TIER_LABELS[routing.tier]})`;

  const markdown = formatMarkdown({
    analysis,
    routing,
    contextTokens,
    why,
    historical,
    fallback,
    budgetNote,
    outcome,
    modeLabel,
  });

  return {
    summary: outcome?.summary ?? summary,
    markdown,
    why,
    task: {
      type: analysis.taskType,
      difficulty: analysis.difficulty,
      risk: analysis.riskLevel,
      context_tokens: contextTokens,
      signals: analysis.signals.length ? analysis.signals : undefined,
    },
    selected: {
      tier: outcome?.initial_tier ?? routing.tier,
      model: outcome?.initial_model ?? routing.model,
      provider: routing.provider,
      endpoint_source: routing.endpointSource,
    },
    fallback,
    cost_note: isLocalTier(outcome?.initial_tier ?? routing.tier)
      ? "Local inference — no per-token cloud charge"
      : `Cloud tier (${routing.provider})`,
    historical: historical ?? undefined,
    policy_notes: policyNotes?.length ? policyNotes : undefined,
    budget_note: budgetNote,
    mode: routing.mode,
    outcome,
  };
}

function humanizeRule(rule: string): string {
  if (rule.includes("summarization")) return "Summarization and rewriting tasks suit local/strong models";
  if (rule.includes("medium difficulty coding")) return "Medium coding tasks route to hosted OSS coder models";
  if (rule.includes("hard/high-risk")) return "Hard or high-risk work needs the premium tier";
  if (rule.includes("simple HTML")) return "Simple UI/HTML demos are handled by the fast local tier";
  if (rule.includes("preferLocal")) return "Prefer-local policy favors on-machine models";
  if (rule.includes("default tier")) return `Default tier applied: ${rule.split(":").pop()?.trim()}`;
  return rule.charAt(0).toUpperCase() + rule.slice(1);
}

function humanizeBudgetLine(line: string): string {
  return `Budget enforcement: ${line.replace(/^budget:\s*/i, "")}`;
}

function humanizeFallbackLine(line: string): string {
  return `Infrastructure fallback: ${line}`;
}

function tierFitReasons(analysis: TaskAnalysis, tier: ModelTier): string[] {
  const reasons: string[] = [];
  if (tier === "hosted_oss" && analysis.requiresCodeReasoning) {
    reasons.push("Code-specialized model for programming tasks");
  }
  if (tier === "local_fast" && analysis.difficulty === "easy") {
    reasons.push("Short, low-risk task fits the fastest local model");
  }
  if (tier === "local_strong" && ["summarization", "rewriting", "extraction"].includes(analysis.taskType)) {
    reasons.push("Language task well-suited to local strong tier");
  }
  if (tier === "premium" && analysis.taskType === "architecture") {
    reasons.push("Architecture and system design benefit from premium reasoning");
  }
  if (analysis.requiresLongContext) {
    reasons.push("Long context requirement considered in tier selection");
  }
  if (analysis.requiresToolUse) {
    reasons.push("Tool use detected — tier supports tool-capable models");
  }
  return reasons;
}

function estimateSavingsVsPremium(tier: ModelTier): number {
  const premium = TIER_COST_INDEX.premium;
  const current = TIER_COST_INDEX[tier];
  if (premium <= 0) return 0;
  return Math.round((1 - current / premium) * 100);
}

function formatMarkdown(input: {
  analysis: TaskAnalysis;
  routing: RoutingDecision;
  contextTokens?: number;
  why: string[];
  historical?: HistoricalContext | null;
  fallback?: { tier: ModelTier; model?: string };
  budgetNote?: string;
  outcome?: ValidationOutcome;
  modeLabel?: string;
}): string {
  const lines = [
    "🎼 Maestro Decision",
    "",
  ];

  if (input.modeLabel) {
    lines.push(`**Mode:** ${input.modeLabel}`, "");
  }

  lines.push(
    "**Task**",
    `- Type: ${TASK_LABELS[input.analysis.taskType]}`,
    `- Difficulty: ${input.analysis.difficulty}`,
    `- Risk: ${input.analysis.riskLevel}`,
  );

  if (input.contextTokens) {
    lines.push(`- Context: ~${input.contextTokens.toLocaleString()} tokens`);
  }

  lines.push(
    "",
    "**Selected**",
    `- Model: \`${input.outcome?.initial_model ?? input.routing.model}\` (${TIER_LABELS[input.outcome?.initial_tier ?? input.routing.tier]})`,
    `- Provider: ${input.routing.provider}`,
  );

  if (input.routing.endpointSource) {
    lines.push(`- Endpoint: ${input.routing.endpointSource}`);
  }

  lines.push("", "**Why?**");
  for (const w of input.why) {
    lines.push(`- ✓ ${w}`);
  }

  if (input.fallback && !input.outcome?.escalated) {
    lines.push(
      "",
      "**Fallback** (if evaluation fails or endpoint down)",
      `- Tier: ${TIER_LABELS[input.fallback.tier]}${input.fallback.model ? ` (\`${input.fallback.model}\`)` : ""}`
    );
  }

  if (input.outcome) {
    lines.push(formatOutcomeMarkdown(input.outcome));
  }

  if (input.budgetNote) {
    lines.push("", `**Budget:** ${input.budgetNote}`);
  }

  return lines.join("\n");
}

export function formatExplanationPlain(explanation: DecisionExplanation): string {
  return explanation.markdown;
}
