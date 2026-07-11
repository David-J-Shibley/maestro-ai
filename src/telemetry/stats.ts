import { readFileSync, existsSync } from "node:fs";
import { expandPath } from "../config/load-config.js";
import type { ModelTier, TelemetryRecord } from "../types.js";

export interface TelemetryStats {
  total: number;
  successRate: number;
  escalationRate: number;
  avgLatencyMs: number;
  totalEstimatedCostUsd: number;
  tierDistribution: Record<string, number>;
  modelDistribution: Record<string, number>;
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
      recentFailures: [],
    };
  }

  const tierDistribution: Record<string, number> = {};
  const modelDistribution: Record<string, number> = {};
  let successes = 0;
  let escalations = 0;
  let latencySum = 0;
  let costSum = 0;

  for (const r of records) {
    const tier = r.fallbackTier ?? r.selectedTier;
    tierDistribution[tier] = (tierDistribution[tier] ?? 0) + 1;
    modelDistribution[r.selectedModel] = (modelDistribution[r.selectedModel] ?? 0) + 1;
    if (r.success) successes++;
    if (r.fallbackTier && r.fallbackTier !== r.selectedTier) escalations++;
    latencySum += r.latencyMs;
    costSum += r.estimatedCostUsd ?? 0;
  }

  const recentFailures = records
    .filter((r) => !r.success)
    .slice(-10)
    .map((r) => ({
      timestamp: r.timestamp,
      reason: r.evaluatorResult?.reason ?? r.routingReason,
      tier: r.selectedTier,
    }));

  return {
    total: records.length,
    successRate: successes / records.length,
    escalationRate: escalations / records.length,
    avgLatencyMs: latencySum / records.length,
    totalEstimatedCostUsd: costSum,
    tierDistribution,
    modelDistribution,
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

  if (stats.recentFailures.length > 0) {
    lines.push("", "Recent failures:");
    for (const f of stats.recentFailures) {
      lines.push(`  ${f.timestamp} [${f.tier}] ${f.reason.slice(0, 80)}`);
    }
  }

  return lines.join("\n");
}
