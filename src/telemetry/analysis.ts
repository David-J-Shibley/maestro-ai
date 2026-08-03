import type { ModelTier, TaskType, TelemetryRecord } from "../types.js";
import { TIER_ORDER } from "../types.js";
import { servedModel, servedTier } from "./records.js";

export interface TierTaskCell {
  taskType: TaskType;
  tier: ModelTier;
  model: string;
  count: number;
  successRate: number;
  escalationRate: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  /** Fraction of records with plain_coerced / plain_fallback outcomes */
  coerceRate?: number;
  /** Among records with userAccepted set */
  acceptanceRate?: number | null;
  avgRating?: number | null;
  difficulty?: import("../types.js").TaskDifficulty;
  requiresToolUse?: boolean;
  mode?: string;
}

export interface TierRecommendation {
  taskType: TaskType;
  recommendedTier: ModelTier;
  recommendedModel: string;
  successRate: number;
  sampleSize: number;
  reason: string;
  alternatives: Array<{
    tier: ModelTier;
    model: string;
    successRate: number;
    count: number;
  }>;
}

export interface LearnedReadiness {
  ready: boolean;
  minSamplesRequired: number;
  totalRecords: number;
  taskTypesWithData: number;
  message: string;
}

export interface RoutingInsights {
  totalRecords: number;
  readiness: LearnedReadiness;
  cells: TierTaskCell[];
  recommendations: TierRecommendation[];
  findings: string[];
  modeComparisons: Array<{
    mode: string;
    successRate: number;
    count: number;
    deltaVsBalanced?: number;
  }>;
}

export interface AnalysisOptions {
  minSamples?: number;
  minRecordsForReadiness?: number;
  difficulty?: import("../types.js").TaskDifficulty;
  requiresToolUse?: boolean;
  mode?: string;
}

const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_MIN_RECORDS = 40;

export function computeRoutingInsights(
  records: TelemetryRecord[],
  options: AnalysisOptions = {}
): RoutingInsights {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const minRecords = options.minRecordsForReadiness ?? DEFAULT_MIN_RECORDS;

  let filtered = records;
  if (options.difficulty) {
    filtered = filtered.filter(
      (r) =>
        (r.difficulty ?? r.taskAnalysis.difficulty) === options.difficulty
    );
  }
  if (options.requiresToolUse != null) {
    filtered = filtered.filter(
      (r) =>
        (r.requiresToolUse ?? r.taskAnalysis.requiresToolUse) ===
        options.requiresToolUse
    );
  }
  if (options.mode) {
    filtered = filtered.filter((r) => r.mode === options.mode);
  }

  const cells = aggregateCells(filtered);
  const recommendations = buildRecommendations(cells, minSamples);
  const findings = buildFindings(cells, recommendations, filtered, minSamples);
  const modeComparisons = compareModes(records);
  const readiness = assessReadiness(records, recommendations, minSamples, minRecords);

  return {
    totalRecords: records.length,
    readiness,
    cells,
    recommendations,
    findings,
    modeComparisons,
  };
}

function aggregateCells(records: TelemetryRecord[]): TierTaskCell[] {
  const buckets = new Map<
    string,
    {
      taskType: TaskType;
      tier: ModelTier;
      model: string;
      difficulty?: import("../types.js").TaskDifficulty;
      requiresToolUse?: boolean;
      mode?: string;
      total: number;
      successes: number;
      escalations: number;
      coerces: number;
      latencySum: number;
      costSum: number;
      accepted: number;
      acceptedKnown: number;
      ratingSum: number;
      ratingCount: number;
    }
  >();

  for (const record of records) {
    const tier = servedTier(record);
    const model = servedModel(record);
    const taskType = record.taskAnalysis.taskType;
    const difficulty = record.difficulty ?? record.taskAnalysis.difficulty;
    const requiresToolUse =
      record.requiresToolUse ?? record.taskAnalysis.requiresToolUse;
    const mode = record.mode;
    const key = `${taskType}:${difficulty}:${requiresToolUse}:${mode ?? "_"}:${tier}:${model}`;

    const bucket = buckets.get(key) ?? {
      taskType,
      tier,
      model,
      difficulty,
      requiresToolUse,
      mode,
      total: 0,
      successes: 0,
      escalations: 0,
      coerces: 0,
      latencySum: 0,
      costSum: 0,
      accepted: 0,
      acceptedKnown: 0,
      ratingSum: 0,
      ratingCount: 0,
    };

    bucket.total++;
    if (record.success) bucket.successes++;
    if (record.escalated) bucket.escalations++;
    if (
      record.outcome === "plain_coerced" ||
      record.outcome === "plain_fallback"
    ) {
      bucket.coerces++;
    }
    bucket.latencySum += record.latencyMs;
    bucket.costSum += record.totalEstimatedCostUsd ?? record.estimatedCostUsd ?? 0;
    if (record.userAccepted != null) {
      bucket.acceptedKnown++;
      if (record.userAccepted) bucket.accepted++;
    }
    if (record.userRating != null) {
      bucket.ratingSum += record.userRating;
      bucket.ratingCount++;
    }
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((b) => ({
      taskType: b.taskType,
      tier: b.tier,
      model: b.model,
      count: b.total,
      successRate: b.successes / b.total,
      escalationRate: b.escalations / b.total,
      avgLatencyMs: b.latencySum / b.total,
      avgCostUsd: b.costSum / b.total,
      coerceRate: b.coerces / b.total,
      acceptanceRate: b.acceptedKnown > 0 ? b.accepted / b.acceptedKnown : null,
      avgRating: b.ratingCount > 0 ? b.ratingSum / b.ratingCount : null,
      difficulty: b.difficulty,
      requiresToolUse: b.requiresToolUse,
      mode: b.mode,
    }))
    .sort((a, b) => b.count - a.count);
}

/** Blend success with user acceptance/rating when available. */
function effectiveQuality(cell: TierTaskCell): number {
  let score = cell.successRate;
  if (cell.acceptanceRate != null) {
    score = score * 0.6 + cell.acceptanceRate * 0.4;
  } else if (cell.avgRating != null) {
    score = score * 0.7 + (cell.avgRating / 5) * 0.3;
  }
  return score;
}

function buildRecommendations(
  cells: TierTaskCell[],
  minSamples: number
): TierRecommendation[] {
  const byTask = new Map<TaskType, TierTaskCell[]>();
  for (const cell of cells) {
    const list = byTask.get(cell.taskType) ?? [];
    list.push(cell);
    byTask.set(cell.taskType, list);
  }

  const recommendations: TierRecommendation[] = [];

  for (const [taskType, taskCells] of byTask) {
    const eligible = taskCells.filter((c) => c.count >= minSamples);
    if (eligible.length === 0) continue;

    const sorted = [...eligible].sort((a, b) => {
      const scoreA = effectiveQuality(a);
      const scoreB = effectiveQuality(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const tierDiff =
        TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      if (tierDiff !== 0) return tierDiff;
      return b.count - a.count;
    });

    const best = sorted[0]!;
    const feedbackNote =
      best.acceptanceRate != null
        ? `, ${(best.acceptanceRate * 100).toFixed(0)}% accepted`
        : best.avgRating != null
          ? `, avg rating ${best.avgRating.toFixed(1)}/5`
          : "";
    recommendations.push({
      taskType,
      recommendedTier: best.tier,
      recommendedModel: best.model,
      successRate: best.successRate,
      sampleSize: best.count,
      reason: `${(best.successRate * 100).toFixed(0)}% success over ${best.count} ${taskType} calls on ${best.tier}${feedbackNote}`,
      alternatives: sorted.slice(1, 4).map((c) => ({
        tier: c.tier,
        model: c.model,
        successRate: c.successRate,
        count: c.count,
      })),
    });
  }

  return recommendations.sort((a, b) => b.sampleSize - a.sampleSize);
}

function buildFindings(
  cells: TierTaskCell[],
  recommendations: TierRecommendation[],
  records: TelemetryRecord[],
  minSamples: number
): string[] {
  const findings: string[] = [];

  for (const rec of recommendations) {
    const alts = rec.alternatives.filter((a) => a.count >= minSamples);
    for (const alt of alts) {
      const delta = (rec.successRate - alt.successRate) * 100;
      if (Math.abs(delta) >= 10) {
        findings.push(
          `${rec.taskType}: ${rec.recommendedTier} succeeds ${delta.toFixed(0)}% more often than ${alt.tier} (${rec.sampleSize} vs ${alt.count} calls)`
        );
      }
    }
  }

  const modeComparisons = compareModes(records);
  const balanced = modeComparisons.find((m) => m.mode === "balanced");
  if (balanced && balanced.count >= minSamples) {
    for (const mode of modeComparisons) {
      if (mode.mode === "balanced" || mode.count < minSamples) continue;
      const delta = (mode.successRate - balanced.successRate) * 100;
      if (Math.abs(delta) >= 10) {
        const dir = delta > 0 ? "better" : "worse";
        findings.push(
          `Mode ${mode.mode} is ${Math.abs(delta).toFixed(0)}% ${dir} than balanced (${mode.count} calls)`
        );
      }
    }
  }

  const highEscalation = cells.filter(
    (c) => c.count >= minSamples && c.escalationRate >= 0.3
  );
  for (const cell of highEscalation.slice(0, 3)) {
    findings.push(
      `${cell.taskType} on ${cell.tier} escalates ${(cell.escalationRate * 100).toFixed(0)}% of the time (n=${cell.count})`
    );
  }

  const highCoerce = cells.filter(
    (c) => c.count >= minSamples && (c.coerceRate ?? 0) >= 0.25
  );
  for (const cell of highCoerce.slice(0, 3)) {
    findings.push(
      `${cell.taskType} on ${cell.tier} needed plain-reply coercion ${(
        (cell.coerceRate ?? 0) * 100
      ).toFixed(0)}% of the time (n=${cell.count})`
    );
  }

  const lowAccept = cells.filter(
    (c) =>
      c.count >= minSamples &&
      c.acceptanceRate != null &&
      c.acceptanceRate < 0.5
  );
  for (const cell of lowAccept.slice(0, 2)) {
    findings.push(
      `${cell.taskType} on ${cell.tier} accepted only ${((cell.acceptanceRate ?? 0) * 100).toFixed(0)}% of the time (n=${cell.count})`
    );
  }

  return [...new Set(findings)].slice(0, 12);
}

function compareModes(
  records: TelemetryRecord[]
): RoutingInsights["modeComparisons"] {
  const buckets = new Map<string, { successes: number; total: number }>();

  for (const record of records) {
    const mode = record.mode ?? "balanced";
    const bucket = buckets.get(mode) ?? { successes: 0, total: 0 };
    bucket.total++;
    if (record.success) bucket.successes++;
    buckets.set(mode, bucket);
  }

  const balancedBucket = buckets.get("balanced");
  const balancedRate =
    balancedBucket && balancedBucket.total > 0
      ? balancedBucket.successes / balancedBucket.total
      : undefined;

  return [...buckets.entries()]
    .map(([mode, b]) => ({
      mode,
      successRate: b.total > 0 ? b.successes / b.total : 0,
      count: b.total,
      deltaVsBalanced:
        balancedRate !== undefined && mode !== "balanced"
          ? b.total > 0
            ? b.successes / b.total - balancedRate
            : undefined
          : undefined,
    }))
    .sort((a, b) => b.count - a.count);
}

function assessReadiness(
  records: TelemetryRecord[],
  recommendations: TierRecommendation[],
  minSamples: number,
  minRecords: number
): LearnedReadiness {
  const taskTypes = new Set(records.map((r) => r.taskAnalysis.taskType));
  const ready =
    records.length >= minRecords && recommendations.length >= 3;

  let message: string;
  if (ready) {
    message = `Telemetry ready for learned routing hints (${records.length} records, ${recommendations.length} task recommendations)`;
  } else if (records.length < minRecords) {
    message = `Need ~${minRecords}+ telemetry records for learned routing (have ${records.length})`;
  } else {
    message = `Need more per-task samples (min ${minSamples}) across task types (have ${taskTypes.size} types, ${recommendations.length} recommendations)`;
  }

  return {
    ready,
    minSamplesRequired: minSamples,
    totalRecords: records.length,
    taskTypesWithData: taskTypes.size,
    message,
  };
}

export function formatInsightsReport(insights: RoutingInsights): string {
  const lines = [
    "Maestro AI — Telemetry Routing Analysis",
    "═".repeat(48),
    insights.readiness.message,
    `Records analyzed: ${insights.totalRecords}`,
    "",
  ];

  if (insights.findings.length > 0) {
    lines.push("Key findings:");
    for (const f of insights.findings) {
      lines.push(`  • ${f}`);
    }
    lines.push("");
  }

  if (insights.recommendations.length > 0) {
    lines.push("Recommendations by task type:");
    for (const rec of insights.recommendations) {
      lines.push(
        `  ${rec.taskType.padEnd(16)} → ${rec.recommendedTier} (${rec.recommendedModel}) — ${rec.reason}`
      );
    }
    lines.push("");
  }

  if (insights.modeComparisons.length > 1) {
    lines.push("Mode comparison:");
    for (const m of insights.modeComparisons) {
      const delta =
        m.deltaVsBalanced !== undefined
          ? ` (${m.deltaVsBalanced >= 0 ? "+" : ""}${(m.deltaVsBalanced * 100).toFixed(0)}% vs balanced)`
          : "";
      lines.push(
        `  ${m.mode.padEnd(14)} ${(m.successRate * 100).toFixed(0)}% success (${m.count} calls)${delta}`
      );
    }
  }

  return lines.join("\n");
}
