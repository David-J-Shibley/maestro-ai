import { loadConfig } from "../config/load-config.js";
import { dryRunRoute, routedLLMCall } from "../routed-llm-call.js";
import { probeAllTiers } from "../provider/probe.js";
import { buildRoutingReport, enrichAskResponse } from "../routing/report.js";
import { runDoctor } from "../doctor/health.js";
import { computeTelemetryStats, loadTelemetryRecords } from "../telemetry/stats.js";
import { recordUserFeedback } from "../telemetry/logger.js";
import type { ChatMessage, RouterOverrides, SessionPolicy, TaskHints } from "../types.js";
import type {
  AskToolInput,
  FeedbackToolInput,
  ProbeToolInput,
  RouteToolInput,
  StatsToolInput,
} from "./schemas.js";

export function buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

export function buildTaskHints(input: RouteToolInput): TaskHints | undefined {
  if (!input.task_type && !input.quality && !input.risk) return undefined;
  return {
    type: input.task_type,
    quality: input.quality,
    risk: input.risk,
  };
}

export function buildSessionPolicy(input: RouteToolInput): SessionPolicy | undefined {
  if (
    input.max_tier === undefined &&
    input.budget_usd === undefined &&
    input.always_prefer_local === undefined &&
    input.session_id === undefined
  ) {
    return undefined;
  }
  return {
    maxTier: input.max_tier,
    budgetUsd: input.budget_usd,
    alwaysPreferLocal: input.always_prefer_local,
    sessionId: input.session_id,
  };
}

export function buildOverrides(input: RouteToolInput): RouterOverrides {
  return {
    modelTier: input.model_tier,
    preferLocal: input.prefer_local,
    premiumOnly: input.premium_only,
    debug: input.debug,
    session: buildSessionPolicy(input),
  };
}

export async function handleRouteTool(input: RouteToolInput) {
  const messages = buildMessages(input.prompt, input.system_prompt);
  const result = await dryRunRoute(
    {
      messages,
      taskHints: buildTaskHints(input),
      overrides: buildOverrides(input),
    },
    { configPath: input.config_path }
  );

  return buildRoutingReport({
    routing: result.routing,
    analysis: result.analysis,
    probe: result.probe,
  });
}

export async function handleAskTool(input: AskToolInput) {
  const messages = buildMessages(input.prompt, input.system_prompt);
  const overrides = {
    ...buildOverrides(input),
    dryRunRouting: input.dry_run ?? false,
  };

  const result = await routedLLMCall(
    {
      messages,
      responseSchema: input.response_schema,
      taskHints: buildTaskHints(input),
      overrides,
    },
    { configPath: input.config_path }
  );

  const report = buildRoutingReport({
    routing: result.routing,
    analysis: result.analysis,
    probe: result.probe,
  });

  if (input.dry_run) {
    return { dry_run: true, routing: report };
  }

  return enrichAskResponse(
    {
      content: result.response.content,
      escalated: result.escalated,
      evaluation: {
        pass: result.evaluation.pass,
        reason: result.evaluation.reason,
        retry_recommended: result.evaluation.retryRecommended,
        escalation_recommended: result.evaluation.escalationRecommended,
        checks: result.evaluation.checks,
      },
      usage: result.response.usage,
      latency_ms: result.response.latencyMs,
      attempts: result.attempts,
      telemetry_id: result.telemetryId,
    },
    report
  );
}

export async function handleProbeTool(input: ProbeToolInput) {
  const config = loadConfig(input.config_path);
  const result = await probeAllTiers(config);
  return {
    unavailable: Array.from(result.unavailable),
    results: result.results,
    tiers: result.tiers,
  };
}

export async function handleDoctorTool(input: { config_path?: string }) {
  return runDoctor(input.config_path);
}

export async function handleStatsTool(input: StatsToolInput) {
  const config = loadConfig(input.config_path);
  const limit = input.last ?? 50;
  let records = loadTelemetryRecords(config.telemetry.logPath, limit);

  if (input.session_id) {
    records = records.filter((r) => r.sessionId === input.session_id);
  }

  const stats = computeTelemetryStats(records);
  return {
    limit,
    session_id: input.session_id ?? null,
    log_path: config.telemetry.logPath,
    stats,
    report: formatStatsInline(stats, limit),
  };
}

function formatStatsInline(
  stats: ReturnType<typeof computeTelemetryStats>,
  limit: number
): string {
  const lines = [
    `Records: ${stats.total} (last ${limit})`,
    `Success: ${(stats.successRate * 100).toFixed(1)}% | Escalation: ${(stats.escalationRate * 100).toFixed(1)}%`,
    `Avg latency: ${stats.avgLatencyMs.toFixed(0)}ms | Est. cost: $${stats.totalEstimatedCostUsd.toFixed(4)}`,
  ];
  for (const [tier, count] of Object.entries(stats.tierDistribution)) {
    lines.push(`  ${tier}: ${count}`);
  }
  return lines.join("\n");
}

export async function handleFeedbackTool(input: FeedbackToolInput) {
  const config = loadConfig(input.config_path);
  const feedbackId = recordUserFeedback(
    config,
    input.telemetry_id,
    input.feedback,
    input.session_id
  );
  return {
    ok: true,
    feedback_id: feedbackId,
    telemetry_id: input.telemetry_id,
  };
}
