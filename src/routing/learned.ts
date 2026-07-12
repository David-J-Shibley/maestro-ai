import type { ModelTier, TaskType } from "../types.js";
import { TIER_ORDER } from "../types.js";
import {
  computeRoutingInsights,
  type AnalysisOptions,
  type TierRecommendation,
} from "../telemetry/analysis.js";
import { loadAllTelemetryRecords } from "../telemetry/stats.js";

export type LearnedConfidence = "low" | "medium" | "high";

export interface LearnedTierSuggestion {
  tier: ModelTier;
  model: string;
  successRate: number;
  sampleSize: number;
  confidence: LearnedConfidence;
  source: "telemetry";
  reason: string;
}

export function learnedRoutingAvailable(
  logPath: string,
  options: AnalysisOptions = {}
): boolean {
  const records = loadAllTelemetryRecords(logPath);
  const insights = computeRoutingInsights(records, options);
  return insights.readiness.ready;
}

export function suggestTierFromTelemetry(
  logPath: string,
  taskType: TaskType,
  options: AnalysisOptions = {}
): LearnedTierSuggestion | null {
  const records = loadAllTelemetryRecords(logPath);
  const insights = computeRoutingInsights(records, options);
  const rec = insights.recommendations.find((r) => r.taskType === taskType);
  if (!rec) return null;

  return recommendationToSuggestion(rec);
}

export function getTierRecommendation(
  logPath: string,
  taskType: TaskType,
  options: AnalysisOptions = {}
): TierRecommendation | null {
  const records = loadAllTelemetryRecords(logPath);
  const insights = computeRoutingInsights(records, options);
  return insights.recommendations.find((r) => r.taskType === taskType) ?? null;
}

export function recommendationToSuggestion(
  rec: TierRecommendation
): LearnedTierSuggestion {
  return {
    tier: rec.recommendedTier,
    model: rec.recommendedModel,
    successRate: rec.successRate,
    sampleSize: rec.sampleSize,
    confidence: confidenceFromSample(rec.sampleSize, rec.successRate),
    source: "telemetry",
    reason: rec.reason,
  };
}

export function confidenceFromSample(
  sampleSize: number,
  successRate: number
): LearnedConfidence {
  if (sampleSize >= 20 && (successRate >= 0.85 || successRate <= 0.5)) {
    return "high";
  }
  if (sampleSize >= 10) return "medium";
  if (sampleSize >= 5) return "low";
  return "low";
}

/** Apply a telemetry suggestion only when confidence is sufficient and tier order allows. */
export function shouldApplyLearnedHint(
  currentTier: ModelTier,
  suggestion: LearnedTierSuggestion,
  minConfidence: LearnedConfidence = "medium"
): boolean {
  const order = ["low", "medium", "high"];
  if (order.indexOf(suggestion.confidence) < order.indexOf(minConfidence)) {
    return false;
  }

  const currentIdx = TIER_ORDER.indexOf(currentTier);
  const suggestedIdx = TIER_ORDER.indexOf(suggestion.tier);
  if (currentIdx < 0 || suggestedIdx < 0) return false;

  // Nudge when telemetry shows meaningfully better outcomes on another tier.
  return (
    suggestion.tier !== currentTier &&
    suggestion.successRate >= 0.7 &&
    Math.abs(suggestedIdx - currentIdx) <= 2
  );
}
