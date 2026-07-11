import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expandPath } from "../config/load-config.js";
import type { RouterConfig, TelemetryRecord } from "../types.js";

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

export function estimateCostUsd(
  tier: string,
  usage?: { promptTokens?: number; completionTokens?: number }
): number | undefined {
  if (!usage?.promptTokens && !usage?.completionTokens) return undefined;

  const rates: Record<string, { input: number; output: number }> = {
    local_fast: { input: 0, output: 0 },
    local_strong: { input: 0, output: 0 },
    hosted_oss: { input: 0.5, output: 1.5 },
    premium: { input: 3, output: 15 },
  };

  const rate = rates[tier];
  if (!rate) return undefined;

  const input = (usage.promptTokens ?? 0) / 1_000_000;
  const output = (usage.completionTokens ?? 0) / 1_000_000;
  return input * rate.input + output * rate.output;
}

export interface FeedbackRecord {
  id: string;
  timestamp: string;
  telemetryId: string;
  feedback: string;
  sessionId?: string;
}

function feedbackLogPath(telemetryLogPath: string): string {
  const dir = dirname(expandPath(telemetryLogPath));
  return join(dir, "feedback.jsonl");
}

export function recordUserFeedback(
  config: RouterConfig,
  telemetryId: string,
  feedback: string,
  sessionId?: string
): string {
  const id = randomUUID();
  const entry: FeedbackRecord = {
    id,
    timestamp: new Date().toISOString(),
    telemetryId,
    feedback,
    sessionId,
  };

  const path = feedbackLogPath(config.telemetry.logPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");

  if (config.telemetry.enabled && telemetryId !== "dry-run" && telemetryId !== "disabled") {
    patchTelemetryFeedback(config.telemetry.logPath, telemetryId, feedback);
  }

  return id;
}

function patchTelemetryFeedback(
  logPath: string,
  telemetryId: string,
  feedback: string
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
        record.userFeedback = feedback;
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
