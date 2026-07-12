import { readFileSync, existsSync } from "node:fs";
import { expandPath } from "../config/load-config.js";
import type { ModelTier, TelemetryRecord, TaskType } from "../types.js";

export interface TelemetryStats {
  total: number;
  successRate: number;
  escalationRate: number;
  avgLatencyMs: number;
  totalEstimatedCostUsd: number;
  tierDistribution: Record<string, number>;
  modelDistribution: Record<string, number>;
  modeDistribution: Record<string, number>;
  modeSuccessRates: Record<string, { successRate: number; count: number }>;
  recentFailures: Array<{ timestamp: string; reason: string; tier: string }>;
}

export function loadTelemetryRecords(
  logPath: string,
  limit = 50
): TelemetryRecord[] {
  return loadAllTelemetryRecords(logPath).slice(-limit);
}

export function loadAllTelemetryRecords(logPath: string): TelemetryRecord[] {
  const path = expandPath(logPath);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const records: TelemetryRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TelemetryRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function getSessionSpend(logPath: string, sessionId: string): number {
  return loadAllTelemetryRecords(logPath)
    .filter((r) => r.sessionId === sessionId)
    .reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
}

export interface HistoricalSuccessRate {
  sampleSize: number;
  successRate: number;
  taskType: TaskType;
  tier: ModelTier;
}

export function getHistoricalSuccessRate(
  logPath: string,
  taskType: TaskType,
  tier: ModelTier,
  options: { minSamples?: number; limit?: number } = {}
): HistoricalSuccessRate | null {
  const minSamples = options.minSamples ?? 5;
  const limit = options.limit ?? 500;

  const records = loadAllTelemetryRecords(logPath).slice(-limit);
  const matching = records.filter((r) => {
    if (r.taskAnalysis.taskType !== taskType) return false;
    const servedTier =
      r.escalated && r.fallbackTier ? r.fallbackTier : r.selectedTier;
    return servedTier === tier;
  });

  if (matching.length < minSamples) return null;

  const successes = matching.filter((r) => r.success).length;
  return {
    sampleSize: matching.length,
    successRate: successes / matching.length,
    taskType,
    tier,
  };
}

export function computeTelemetryStats(
  records: TelemetryRecord[]
): TelemetryStats {
  if (records.length === 0) {
    return {
      total: 0,
      successRate: 0,
      escalationRate: 0,
      avgLatencyMs: 0,
      totalEstimatedCostUsd: 0,
      tierDistribution: {},
      modelDistribution: {},
      modeDistribution: {},
      modeSuccessRates: {},
      recentFailures: [],
    };
  }

  const tierDistribution: Record<string, number> = {};
  const modelDistribution: Record<string, number> = {};
  const modeDistribution: Record<string, number> = {};
  const modeSuccessBuckets: Record<string, { successes: number; total: number }> = {};
  let successes = 0;
  let escalations = 0;
  let latencySum = 0;
  let costSum = 0;

  for (const r of records) {
    // Attribute to the tier/model that actually served the call: the fallback
    // when it escalated, otherwise the originally selected tier/model. Do NOT
    // use fallbackTier's mere presence — it is set whenever a fallback is
    // configured, even if the call succeeded on the primary.
    const tier = r.escalated && r.fallbackTier ? r.fallbackTier : r.selectedTier;
    const model = r.escalated && r.fallbackModel ? r.fallbackModel : r.selectedModel;
    tierDistribution[tier] = (tierDistribution[tier] ?? 0) + 1;
    modelDistribution[model] = (modelDistribution[model] ?? 0) + 1;
    const modeKey = r.mode ?? "balanced";
    modeDistribution[modeKey] = (modeDistribution[modeKey] ?? 0) + 1;
    const bucket = modeSuccessBuckets[modeKey] ?? { successes: 0, total: 0 };
    bucket.total++;
    if (r.success) bucket.successes++;
    modeSuccessBuckets[modeKey] = bucket;
    if (r.success) successes++;
    if (r.escalated) escalations++;
    latencySum += r.latencyMs;
    costSum += r.estimatedCostUsd ?? 0;
  }

  const modeSuccessRates: Record<string, { successRate: number; count: number }> = {};
  for (const [mode, bucket] of Object.entries(modeSuccessBuckets)) {
    modeSuccessRates[mode] = {
      successRate: bucket.total > 0 ? bucket.successes / bucket.total : 0,
      count: bucket.total,
    };
  }

  const recentFailures = records
    .filter((r) => !r.success)
    .slice(-10)
    .map((r) => ({
      timestamp: r.timestamp,
      reason: r.evaluatorResult?.reason ?? r.routingReason,
      tier: r.escalated && r.fallbackTier ? r.fallbackTier : r.selectedTier,
    }));

  return {
    total: records.length,
    successRate: successes / records.length,
    escalationRate: escalations / records.length,
    avgLatencyMs: latencySum / records.length,
    totalEstimatedCostUsd: costSum,
    tierDistribution,
    modelDistribution,
    modeDistribution,
    modeSuccessRates,
    recentFailures,
  };
}

export function formatStatsReport(stats: TelemetryStats, limit: number): string {
  const lines = [
    `Maestro AI telemetry (last ${stats.total} of ${limit} records)`,
    "═".repeat(48),
    `Success rate:     ${(stats.successRate * 100).toFixed(1)}%`,
    `Escalation rate:  ${(stats.escalationRate * 100).toFixed(1)}%`,
    `Avg latency:      ${stats.avgLatencyMs.toFixed(0)}ms`,
    `Est. total cost:  $${stats.totalEstimatedCostUsd.toFixed(4)}`,
    "",
    "Tier distribution:",
  ];

  for (const [tier, count] of Object.entries(stats.tierDistribution)) {
    lines.push(`  ${tier.padEnd(14)} ${count}`);
  }

  if (Object.keys(stats.modeDistribution).length > 0) {
    lines.push("", "Mode distribution:");
    for (const [mode, count] of Object.entries(stats.modeDistribution)) {
      const rate = stats.modeSuccessRates[mode];
      const pct = rate ? ` (${(rate.successRate * 100).toFixed(0)}% success)` : "";
      lines.push(`  ${mode.padEnd(14)} ${count}${pct}`);
    }
  }

  if (stats.recentFailures.length > 0) {
    lines.push("", "Recent failures:");
    for (const f of stats.recentFailures) {
      lines.push(`  ${f.timestamp} [${f.tier}] ${f.reason.slice(0, 80)}`);
    }
  }

  return lines.join("\n");
}
