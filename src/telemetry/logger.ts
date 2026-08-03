import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expandPath } from "../config/load-config.js";
import type { ModelTier, RouterConfig, TelemetryRecord } from "../types.js";

export function logTelemetry(
  config: RouterConfig,
  record: Omit<TelemetryRecord, "id" | "timestamp">
): string {
  if (!config.telemetry.enabled) {
    return "disabled";
  }

  const id = randomUUID();
  const entry: TelemetryRecord = {
    id,
    timestamp: new Date().toISOString(),
    ...record,
  };

  const logPath = config.telemetry.logPath;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");

  return id;
}

/** Per-million-token rates by tier (USD). Shared by cost estimates and savings. */
export const TIER_RATES_PER_MTOK: Record<
  string,
  { input: number; output: number }
> = {
  local_fast: { input: 0, output: 0 },
  local_strong: { input: 0, output: 0 },
  hosted_oss: { input: 0.5, output: 1.5 },
  premium: { input: 3, output: 15 },
};

export function estimateCostUsd(
  tier: string,
  usage?: { promptTokens?: number; completionTokens?: number }
): number | undefined {
  if (!usage?.promptTokens && !usage?.completionTokens) return undefined;

  const rate = TIER_RATES_PER_MTOK[tier];
  if (!rate) return undefined;

  const input = (usage.promptTokens ?? 0) / 1_000_000;
  const output = (usage.completionTokens ?? 0) / 1_000_000;
  return input * rate.input + output * rate.output;
}

/** Counterfactual: same token usage billed at premium rates. */
export function estimatePremiumCostUsd(usage?: {
  promptTokens?: number;
  completionTokens?: number;
}): number | undefined {
  return estimateCostUsd("premium", usage);
}

export interface FeedbackRecord {
  id: string;
  timestamp: string;
  telemetryId: string;
  feedback: string;
  sessionId?: string;
  rating?: number;
  accepted?: boolean;
}

export interface RecordFeedbackInput {
  telemetryId: string;
  feedback?: string;
  sessionId?: string;
  rating?: number;
  accepted?: boolean;
}

function feedbackLogPath(telemetryLogPath: string): string {
  const dir = dirname(expandPath(telemetryLogPath));
  return join(dir, "feedback.jsonl");
}

function normalizeRating(rating?: number): number | undefined {
  if (rating == null || Number.isNaN(rating)) return undefined;
  const n = Math.round(rating);
  if (n < 1 || n > 5) return undefined;
  return n;
}

export function recordUserFeedback(
  config: RouterConfig,
  telemetryId: string,
  feedback: string,
  sessionId?: string,
  structured?: { rating?: number; accepted?: boolean }
): string {
  return recordStructuredFeedback(config, {
    telemetryId,
    feedback,
    sessionId,
    rating: structured?.rating,
    accepted: structured?.accepted,
  });
}

export function recordStructuredFeedback(
  config: RouterConfig,
  input: RecordFeedbackInput
): string {
  const rating = normalizeRating(input.rating);
  const note =
    input.feedback?.trim() ||
    (rating != null ? `rating:${rating}` : "") ||
    (input.accepted != null ? (input.accepted ? "accepted" : "rejected") : "");

  if (!note && rating == null && input.accepted == null) {
    throw new Error("Provide feedback note, rating (1-5), or accepted");
  }

  const id = randomUUID();
  const entry: FeedbackRecord = {
    id,
    timestamp: new Date().toISOString(),
    telemetryId: input.telemetryId,
    feedback: note || (input.accepted ? "accepted" : "feedback"),
    sessionId: input.sessionId,
    rating,
    accepted: input.accepted,
  };

  const path = feedbackLogPath(config.telemetry.logPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");

  if (
    config.telemetry.enabled &&
    input.telemetryId !== "dry-run" &&
    input.telemetryId !== "disabled"
  ) {
    patchTelemetryFeedback(config.telemetry.logPath, input.telemetryId, {
      feedback: entry.feedback,
      rating,
      accepted: input.accepted,
    });
  }

  return id;
}

function patchTelemetryFeedback(
  logPath: string,
  telemetryId: string,
  patch: { feedback: string; rating?: number; accepted?: boolean }
): boolean {
  const path = expandPath(logPath);
  if (!existsSync(path)) return false;

  const lines = readFileSync(path, "utf8").split("\n");
  let patched = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as TelemetryRecord;
      if (record.id === telemetryId) {
        record.userFeedback = patch.feedback;
        if (patch.rating != null) record.userRating = patch.rating;
        if (patch.accepted != null) record.userAccepted = patch.accepted;
        lines[i] = JSON.stringify(record);
        patched = true;
        break;
      }
    } catch {
      // skip
    }
  }

  if (patched) {
    writeFileSync(path, lines.filter((l, i) => i < lines.length - 1 || l).join("\n") + "\n", "utf8");
  }
  return patched;
}

/** Sum attempt costs; fall back to final-tier estimate when attempts lack usage. */
export function sumAttemptCosts(
  attempts: Array<{ tier: ModelTier; usage?: { promptTokens?: number; completionTokens?: number }; estimatedCostUsd?: number }>,
  fallbackTier?: ModelTier,
  fallbackUsage?: { promptTokens?: number; completionTokens?: number }
): number {
  let sum = 0;
  let any = false;
  for (const a of attempts) {
    const cost =
      a.estimatedCostUsd ??
      (a.usage ? estimateCostUsd(a.tier, a.usage) : undefined);
    if (cost != null) {
      sum += cost;
      any = true;
    }
  }
  if (any) return sum;
  return estimateCostUsd(fallbackTier ?? "premium", fallbackUsage) ?? 0;
}
