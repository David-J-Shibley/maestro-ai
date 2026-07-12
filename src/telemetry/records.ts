import type { ModelTier, TelemetryRecord } from "../types.js";

/** Tier/model that actually served the call (post-escalation). */
export function servedTier(record: TelemetryRecord): ModelTier {
  return record.escalated && record.fallbackTier
    ? record.fallbackTier
    : record.selectedTier;
}

export function servedModel(record: TelemetryRecord): string {
  return record.escalated && record.fallbackModel
    ? record.fallbackModel
    : record.selectedModel;
}
