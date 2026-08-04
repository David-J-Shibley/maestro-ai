import { loadConfig } from "../config/load-config.js";
import { dryRunRoute, routedLLMCall } from "../routed-llm-call.js";
import { clearProbeCache, probeAllTiers } from "../provider/probe.js";
import {
  buildRoutingReport,
  compactRoutingReport,
  enrichAskResponse,
} from "../routing/report.js";
import { runDoctor } from "../doctor/health.js";
import { computeTelemetryStats, loadAllTelemetryRecords, loadTelemetryRecords } from "../telemetry/stats.js";
import { computeRoutingInsights, formatInsightsReport } from "../telemetry/analysis.js";
import { learnedRoutingAvailable } from "../routing/learned.js";
import { recordStructuredFeedback } from "../telemetry/logger.js";
import { buildEvaluatorHooks } from "../evaluator/shell-hooks.js";
import { dryRunWorkflow, runWorkflow } from "../workflow/run-workflow.js";
import type { WorkflowProgressEvent } from "../workflow/progress.js";
import type { ChatMessage, EvaluatorContext, RouterOverrides, SessionPolicy, TaskHints } from "../types.js";
import type {
  AnalyzeToolInput,
  AskToolInput,
  FeedbackToolInput,
  ProbeToolInput,
  RouteToolInput,
  StatsToolInput,
  WorkflowToolInput,
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
    mode: input.mode,
    modelTier: input.model_tier,
    preferLocal: input.prefer_local,
    premiumOnly: input.premium_only,
    debug: input.debug,
    session: buildSessionPolicy(input),
  };
}

function presentReport(report: ReturnType<typeof buildRoutingReport>, debug?: boolean) {
  return debug ? report : compactRoutingReport(report);
}

export async function handleRouteTool(input: RouteToolInput) {
  const messages = buildMessages(input.prompt, input.system_prompt);
  const config = loadConfig(input.config_path);
  const result = await dryRunRoute(
    {
      messages,
      taskHints: buildTaskHints(input),
      overrides: buildOverrides(input),
    },
    { config, forceProbe: input.probe === true }
  );

  const contextTokens = estimateContextTokens(messages);

  const report = buildRoutingReport({
    routing: result.routing,
    analysis: result.analysis,
    probe: result.probe,
    contextTokens,
    config,
    verbose: input.debug === true,
  });

  return presentReport(report, input.debug);
}

function buildAskEvaluatorContext(input: AskToolInput | WorkflowToolInput): EvaluatorContext | undefined {
  const hooks = buildEvaluatorHooks({
    runTests: input.run_tests,
    runBuild: input.run_build,
  });
  if (!hooks.runTests && !hooks.runBuild) return undefined;
  return hooks;
}

export async function handleAskTool(input: AskToolInput) {
  if (input.workflow || input.dry_run_workflow) {
    return handleWorkflowTool({
      ...input,
      workflow: input.workflow ?? "auto",
    });
  }

  const messages = buildMessages(input.prompt, input.system_prompt);
  const config = loadConfig(input.config_path);
  const overrides = {
    ...buildOverrides(input),
    dryRunRouting: input.dry_run ?? false,
  };
  const evaluatorContext = buildAskEvaluatorContext(input);

  const result = await routedLLMCall(
    {
      messages,
      responseSchema: input.response_schema,
      taskHints: buildTaskHints(input),
      overrides,
    },
    { config, evaluatorContext }
  );

  const report = buildRoutingReport({
    routing: result.routing,
    analysis: result.analysis,
    probe: result.probe,
    contextTokens: estimateContextTokens(messages),
    config,
    verbose: input.debug === true,
    callOutcome: input.dry_run
      ? undefined
      : {
          escalated: result.escalated,
          attempts: result.attempts,
          evaluation: result.evaluation,
          initialRouting: result.initialRouting,
          maxRetriesPerTier: config.routing.maxRetriesPerTier,
        },
  });

  if (input.dry_run) {
    return { dry_run: true, routing: presentReport(report, input.debug) };
  }

  const presented = presentReport(report, input.debug);
  if (input.debug) {
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

  return {
    content: result.response.content,
    escalated: result.escalated,
    evaluation: {
      pass: result.evaluation.pass,
      reason: result.evaluation.reason,
    },
    usage: result.response.usage,
    latency_ms: result.response.latencyMs,
    telemetry_id: result.telemetryId,
    routing: presented,
    explanation: (presented as { explanation?: unknown }).explanation ?? report.explanation,
  };
}

export async function handleWorkflowTool(input: WorkflowToolInput) {
  const messages = buildMessages(input.prompt, input.system_prompt);
  const config = loadConfig(input.config_path);
  const overrides = buildOverrides(input);
  const workflow = input.workflow ?? "auto";

  if (input.dry_run_workflow || input.dry_run) {
    const dry = await dryRunWorkflow(
      {
        messages,
        responseSchema: input.response_schema,
        taskHints: buildTaskHints(input),
        overrides,
        workflow,
      },
      { config }
    );
    return {
      dry_run: true,
      workflow: dry.plan.pattern,
      plan: dry.plan,
      step_routes: dry.stepRoutes,
      report: dry.report,
    };
  }

  const progress: WorkflowProgressEvent[] = [];
  const result = await runWorkflow(
    {
      messages,
      responseSchema: input.response_schema,
      taskHints: buildTaskHints(input),
      overrides,
      workflow,
    },
    {
      config,
      evaluatorContext: buildAskEvaluatorContext(input),
      onProgress: (event) => {
        progress.push(event);
      },
    }
  );

  return {
    content: result.finalOutput,
    workflow: result.workflow.pattern,
    why: result.workflow.why,
    steps: result.steps.map((s) => ({
      id: s.stepId,
      name: s.name,
      status: s.status,
      tier: s.actualTier,
      model: s.model,
    })),
    progress,
    validation: result.validation,
    report: input.debug ? result.report : { markdown: result.report.markdown, finalStatus: result.report.finalStatus },
    telemetry_id: result.telemetry.workflowId,
    analysis: result.analysis
      ? {
          taskType: result.analysis.taskType,
          difficulty: result.analysis.difficulty,
          riskLevel: result.analysis.riskLevel,
        }
      : undefined,
  };
}

export async function handleProbeTool(input: ProbeToolInput) {
  const config = loadConfig(input.config_path);
  if (input.force) clearProbeCache();
  const result = await probeAllTiers(config, { force: input.force === true });
  return {
    unavailable: Array.from(result.unavailable),
    results: result.results,
    tiers: result.tiers,
  };
}

export async function handleDoctorTool(input: { config_path?: string }) {
  clearProbeCache();
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
  const result: Record<string, unknown> = {
    limit,
    session_id: input.session_id ?? null,
    log_path: config.telemetry.logPath,
    stats,
    report: formatStatsInline(stats, limit),
  };

  if (input.insights) {
    const minSamples = config.routing.learnedMinSamples ?? 5;
    const insights = computeRoutingInsights(records, { minSamples });
    result.insights = insights;
    result.learned_hints_available = learnedRoutingAvailable(config.telemetry.logPath, {
      minSamples,
    });
    result.insights_report = formatInsightsReport(insights);
  }

  return result;
}

export async function handleAnalyzeTool(input: AnalyzeToolInput) {
  const config = loadConfig(input.config_path);
  const minSamples = input.min_samples ?? config.routing.learnedMinSamples ?? 5;
  const useAll = input.all !== false && input.last === undefined;

  let records = useAll
    ? loadAllTelemetryRecords(config.telemetry.logPath)
    : loadTelemetryRecords(config.telemetry.logPath, input.last ?? 50);

  if (input.session_id) {
    records = records.filter((r) => r.sessionId === input.session_id);
  }

  const insights = computeRoutingInsights(records, { minSamples });

  return {
    log_path: config.telemetry.logPath,
    session_id: input.session_id ?? null,
    records_analyzed: records.length,
    min_samples: minSamples,
    insights,
    report: formatInsightsReport(insights),
    learned_hints_available: learnedRoutingAvailable(config.telemetry.logPath, { minSamples }),
    learned_routing_hints_enabled: config.routing.learnedRoutingHints ?? false,
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
    `Vs premium: $${stats.estimatedPremiumCostUsd.toFixed(4)} → save $${stats.estimatedSavingsUsd.toFixed(4)} (${(stats.savingsRate * 100).toFixed(0)}%)`,
  ];
  if (stats.acceptanceRate != null || stats.avgUserRating != null) {
    const parts: string[] = [];
    if (stats.acceptanceRate != null) parts.push(`accept ${(stats.acceptanceRate * 100).toFixed(0)}%`);
    if (stats.avgUserRating != null) parts.push(`rating ${stats.avgUserRating.toFixed(1)}/5`);
    lines.push(`Feedback: ${parts.join(" | ")}`);
  }
  for (const [tier, count] of Object.entries(stats.tierDistribution)) {
    lines.push(`  ${tier}: ${count}`);
  }
  return lines.join("\n");
}

export async function handleFeedbackTool(input: FeedbackToolInput) {
  const config = loadConfig(input.config_path);
  if (
    input.feedback == null &&
    input.rating == null &&
    input.accepted == null
  ) {
    throw new Error("Provide feedback, rating (1-5), or accepted");
  }
  const feedbackId = recordStructuredFeedback(config, {
    telemetryId: input.telemetry_id,
    feedback: input.feedback,
    sessionId: input.session_id,
    rating: input.rating,
    accepted: input.accepted,
  });
  return {
    ok: true,
    feedback_id: feedbackId,
    telemetry_id: input.telemetry_id,
    rating: input.rating ?? null,
    accepted: input.accepted ?? null,
  };
}

function estimateContextTokens(messages: ChatMessage[]): number {
  const chars = messages.map((m) => m.content).join("\n").length;
  return Math.ceil(chars / 4);
}
