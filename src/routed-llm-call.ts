import {
  analyzeTask,
  extractSystemPrompt,
  extractUserPrompt,
  hashPrompt,
} from "./analyzer/task-analyzer.js";
import { loadConfig } from "./config/load-config.js";
import { getPrimaryEndpoint } from "./config/tier-config.js";
import { evaluateResponse, evaluateResponseAsync } from "./evaluator/response-evaluator.js";
import { chatCompletion, ProviderError } from "./provider/openai-compatible.js";
import { probeAllTiers, type TierProbeStatus } from "./provider/probe.js";
import { routeTask } from "./router/model-router.js";
import { estimateCostUsd, logTelemetry } from "./telemetry/logger.js";
import {
  canEscalateWithinBudget,
  resolveBudgetStatus,
} from "./routing/budget.js";
import type {
  EvaluatorContext,
  ModelTier,
  RoutedAttempt,
  RoutedLLMCallInput,
  RoutedLLMCallResult,
  RouterConfig,
  RouterOverrides,
  RoutingDecision,
  TaskAnalysis,
} from "./types.js";
import { nextTier } from "./types.js";

export interface RoutedLLMCallOptions {
  config?: RouterConfig;
  configPath?: string;
  evaluatorContext?: EvaluatorContext;
  overrides?: RouterOverrides;
}

export interface DryRunResult {
  analysis: TaskAnalysis;
  routing: RoutingDecision;
  probe?: Awaited<ReturnType<typeof probeAllTiers>>;
}

function tierStatusMap(
  probe?: Awaited<ReturnType<typeof probeAllTiers>>
): Map<ModelTier, TierProbeStatus> {
  const map = new Map<ModelTier, TierProbeStatus>();
  if (probe?.tiers) {
    for (const t of probe.tiers) map.set(t.tier, t);
  }
  return map;
}

export async function routedLLMCall(
  input: RoutedLLMCallInput,
  options: RoutedLLMCallOptions = {}
): Promise<RoutedLLMCallResult & { probe?: DryRunResult["probe"] }> {
  const config = options.config ?? loadConfig(options.configPath);
  const overrides = mergeOverrides(input.overrides, options.overrides);

  const userPrompt = extractUserPrompt(input.messages);
  const systemPrompt = extractSystemPrompt(input.messages);

  const analysis = analyzeTask({
    userPrompt,
    systemPrompt,
    tools: input.tools,
    responseSchema: input.responseSchema,
    taskHints: input.taskHints,
  });

  let probe: Awaited<ReturnType<typeof probeAllTiers>> | undefined;
  let unavailable = new Set<ModelTier>();
  if (config.routing.probeAvailability) {
    probe = await probeAllTiers(config);
    unavailable = probe.unavailable;
  }

  const statuses = tierStatusMap(probe);
  const budget = resolveBudgetStatus(overrides?.session, config);

  let decision = routeTask({
    analysis,
    config,
    overrides,
    taskHints: input.taskHints,
    unavailableTiers: unavailable,
    tierStatuses: statuses,
    userPrompt,
  });

  if (input.modelTier) {
    decision = routeTask({
      analysis,
      config,
      overrides: { ...overrides, modelTier: input.modelTier },
      taskHints: input.taskHints,
      unavailableTiers: unavailable,
      tierStatuses: statuses,
      userPrompt,
    });
  }

  if (overrides.dryRunRouting) {
    return { ...dryRunResult(analysis, decision), probe };
  }

  const attempts: RoutedAttempt[] = [];
  let currentTier = decision.tier;
  let escalated = false;
  let lastResponse = null as Awaited<ReturnType<typeof chatCompletion>> | null;
  let lastEvaluation = evaluateResponse("", options.evaluatorContext ?? {});
  let totalAttempts = 0;
  const maxAttempts =
    config.routing.enableEscalation ? 4 * (config.routing.maxRetriesPerTier + 1) : 1;

  while (totalAttempts < maxAttempts) {
    const tierStatus = statuses.get(currentTier);
    const endpoint =
      tierStatus?.effective?.endpoint ?? getPrimaryEndpoint(config, currentTier);
    const attempt: RoutedAttempt = { tier: currentTier, model: endpoint.model };

    try {
      const response = await chatCompletion(endpoint, currentTier, {
        messages: input.messages,
        tools: input.tools,
        responseFormat: input.responseSchema
          ? { type: "json_object" }
          : undefined,
      });

      attempt.latencyMs = response.latencyMs;
      attempts.push(attempt);
      lastResponse = response;

      const evalContext: EvaluatorContext = {
        ...options.evaluatorContext,
        responseSchema: input.responseSchema,
        expectedFormat: input.responseSchema ? "json" : options.evaluatorContext?.expectedFormat,
        tools: input.tools,
        rawResponse: response.raw,
      };

      const evaluation =
        options.evaluatorContext?.runTests || options.evaluatorContext?.runBuild
          ? await evaluateResponseAsync(response.content, evalContext)
          : evaluateResponse(response.content, evalContext);

      attempt.evaluation = evaluation;
      lastEvaluation = evaluation;
      totalAttempts++;

      if (evaluation.pass) break;

      const emptyOrCorrupt =
        !evaluation.checks.find((c) => c.name === "non_empty")?.pass ||
        evaluation.checks.find((c) => c.name === "content_integrity")?.pass === false;

      if (emptyOrCorrupt && config.routing.enableEscalation) {
        const next = nextTier(currentTier);
        if (next && next !== currentTier && canEscalateWithinBudget(next, budget)) {
          currentTier = next;
          escalated = true;
          continue;
        }
      }

      if (evaluation.retryRecommended && totalAttempts <= config.routing.maxRetriesPerTier) {
        continue;
      }

      if (evaluation.escalationRecommended && config.routing.enableEscalation) {
        const next = nextTier(currentTier);
        if (next && next !== currentTier) {
          if (!canEscalateWithinBudget(next, budget)) {
            break;
          }
          currentTier = next;
          escalated = true;
          continue;
        }
      }

      break;
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : String(err);
      attempt.latencyMs = 0;
      attempts.push(attempt);
      totalAttempts++;

      const shouldEscalate =
        config.routing.enableEscalation &&
        (err instanceof ProviderError
          ? err.code === "timeout" ||
            err.code === "http" ||
            err.code === "network" ||
            err.code === "empty"
          : true);

      if (shouldEscalate) {
        const next = nextTier(currentTier);
        if (next && next !== currentTier) {
          if (!canEscalateWithinBudget(next, budget)) {
            throw err;
          }
          currentTier = next;
          escalated = true;
          continue;
        }
      }

      throw err;
    }
  }

  if (!lastResponse) {
    throw new Error("No LLM response produced");
  }

  const finalStatus = statuses.get(currentTier);
  const finalEndpoint =
    finalStatus?.effective?.endpoint ?? getPrimaryEndpoint(config, currentTier);

  const promptHash = hashPrompt(`${systemPrompt}\n${userPrompt}`);
  const sessionId =
    overrides?.session?.sessionId ??
    (overrides?.session?.budgetUsd !== undefined ? "anonymous" : undefined);

  const telemetryId = logTelemetry(config, {
    promptHash,
    taskAnalysis: analysis,
    selectedTier: decision.tier,
    selectedModel: decision.model,
    fallbackTier: escalated ? currentTier : decision.fallbackTier ?? undefined,
    fallbackModel: escalated ? finalEndpoint.model : undefined,
    latencyMs: lastResponse.latencyMs,
    tokenUsage: lastResponse.usage,
    estimatedCostUsd: estimateCostUsd(currentTier, lastResponse.usage),
    success: lastEvaluation.pass,
    evaluatorResult: lastEvaluation,
    routingReason: decision.reason,
    attempts: totalAttempts,
    escalated,
    sessionId,
    userFeedback: overrides?.userFeedback,
  });

  return {
    response: lastResponse,
    analysis,
    routing: {
      ...decision,
      tier: currentTier,
      model: finalEndpoint.model,
      baseUrl: finalEndpoint.baseUrl,
      provider: finalEndpoint.provider,
      reason: escalated
        ? `${decision.reason} (escalated to ${currentTier})`
        : decision.reason,
      fallbackReason:
        finalStatus?.effective?.fallbackReason ?? decision.fallbackReason,
      endpointSource: finalStatus?.effective?.source ?? decision.endpointSource,
    },
    evaluation: lastEvaluation,
    telemetryId,
    escalated,
    attempts,
    probe,
  };
}

export async function dryRunRoute(
  input: RoutedLLMCallInput,
  options: RoutedLLMCallOptions = {}
): Promise<DryRunResult> {
  const config = options.config ?? loadConfig(options.configPath);
  const overrides = mergeOverrides(input.overrides, options.overrides);

  const userPrompt = extractUserPrompt(input.messages);

  const analysis = analyzeTask({
    userPrompt,
    systemPrompt: extractSystemPrompt(input.messages),
    tools: input.tools,
    responseSchema: input.responseSchema,
    taskHints: input.taskHints,
  });

  let unavailable = new Set<ModelTier>();
  let probe: Awaited<ReturnType<typeof probeAllTiers>> | undefined;

  if (config.routing.probeAvailability) {
    probe = await probeAllTiers(config);
    unavailable = probe.unavailable;
  }

  const routing = routeTask({
    analysis,
    config,
    overrides,
    taskHints: input.taskHints,
    unavailableTiers: unavailable,
    tierStatuses: tierStatusMap(probe),
    userPrompt,
  });

  return { analysis, routing, probe };
}

function mergeOverrides(
  a?: RouterOverrides,
  b?: RouterOverrides
): RouterOverrides {
  return { ...a, ...b };
}

function dryRunResult(
  analysis: TaskAnalysis,
  routing: RoutingDecision
): RoutedLLMCallResult {
  return {
    response: {
      content: "",
      model: routing.model,
      tier: routing.tier,
      latencyMs: 0,
    },
    analysis,
    routing,
    evaluation: {
      pass: true,
      reason: "Dry run — no LLM call made",
      retryRecommended: false,
      escalationRecommended: false,
      checks: [],
    },
    telemetryId: "dry-run",
    escalated: false,
    attempts: [],
  };
}
