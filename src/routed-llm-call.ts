import {
  analyzeTask,
  countRecentToolTurns,
  extractLatestUserPrompt,
  extractSystemPrompt,
  extractUserPrompt,
  hashPrompt,
} from "./analyzer/task-analyzer.js";
import { enrichAnalysisWithLlmClassify } from "./analyzer/llm-classify.js";
import { loadConfig } from "./config/load-config.js";
import { getPrimaryEndpoint } from "./config/tier-config.js";
import {
  isPremiumPoolRotationError,
  listPremiumEndpoints,
  orderPremiumEndpoints,
} from "./config/premium-pool.js";
import { evaluateResponse, evaluateResponseAsync } from "./evaluator/response-evaluator.js";
import { chatCompletion, DEFAULT_MAX_TOKENS, ProviderError } from "./provider/openai-compatible.js";
import { probeAllTiers, type TierProbeStatus } from "./provider/probe.js";
import {
  applyOfflineLocalOnlyOverrides,
  resolveConnectivity,
  type ConnectivityStatus,
} from "./provider/connectivity.js";
import { routeTask } from "./router/model-router.js";
import { annotateAttemptActions, buildAttemptLog } from "./routing/outcome.js";
import {
  applyModeToRuntime,
  canEscalateWithinMode,
  resolveActiveMode,
} from "./routing/modes.js";
import { estimateCostUsd, logTelemetry, sumAttemptCosts } from "./telemetry/logger.js";
import {
  canEscalateWithinBudget,
  resolveBudgetStatus,
  tierCapForBudget,
  type BudgetStatus,
} from "./routing/budget.js";
import type {
  AttemptAction,
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
import { setStickyTier } from "./proxy/session-sticky.js";

export interface RoutedLLMCallOptions {
  config?: RouterConfig;
  configPath?: string;
  evaluatorContext?: EvaluatorContext;
  overrides?: RouterOverrides;
  /** Force a live probe even on dry-run routes */
  forceProbe?: boolean;
}

export interface DryRunResult {
  analysis: TaskAnalysis;
  routing: RoutingDecision;
  probe?: Awaited<ReturnType<typeof probeAllTiers>>;
  connectivity?: ConnectivityStatus;
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
): Promise<
  RoutedLLMCallResult & {
    probe?: DryRunResult["probe"];
    connectivity?: ConnectivityStatus;
  }
> {
  const config = options.config ?? loadConfig(options.configPath);
  const baseOverrides = mergeOverrides(input.overrides, options.overrides);
  const activeMode = resolveActiveMode(baseOverrides, config);
  const runtime = applyModeToRuntime(activeMode, config, baseOverrides);
  const overrides = runtime.overrides;
  const effectiveConfig: RouterConfig = { ...config, routing: runtime.routing };
  let modeConstraints = runtime.constraints;

  const userPrompt = extractLatestUserPrompt(input.messages);
  const systemPrompt = extractSystemPrompt(input.messages);

  let analysis = analyzeTask({
    userPrompt,
    systemPrompt,
    tools: input.tools,
    responseSchema: input.responseSchema,
    taskHints: input.taskHints,
    recentToolTurns:
      input.recentToolTurns ?? countRecentToolTurns(input.messages),
  });
  analysis = await enrichAnalysisWithLlmClassify(
    analysis,
    userPrompt,
    effectiveConfig
  );

  let probe: Awaited<ReturnType<typeof probeAllTiers>> | undefined;
  let unavailable = new Set<ModelTier>();
  if (effectiveConfig.routing.probeAvailability) {
    probe = await probeAllTiers(effectiveConfig);
    unavailable = probe.unavailable;
  }

  const connectivity = await resolveConnectivity(effectiveConfig, probe);
  const offlineApplied = applyOfflineLocalOnlyOverrides(
    overrides,
    connectivity,
    effectiveConfig
  );
  const routeOverrides = offlineApplied.overrides;
  if (offlineApplied.forced) {
    modeConstraints = {
      ...modeConstraints,
      maxTier: "local_strong",
      preferLocal: true,
      notes: [
        ...modeConstraints.notes,
        ...(offlineApplied.note ? [offlineApplied.note] : []),
      ],
    };
  }

  const statuses = tierStatusMap(probe);
  let budget = resolveBudgetStatus(routeOverrides?.session, effectiveConfig);

  let decision = routeTask({
    analysis,
    config: effectiveConfig,
    overrides: routeOverrides,
    taskHints: input.taskHints,
    unavailableTiers: unavailable,
    tierStatuses: statuses,
    userPrompt,
  });

  if (input.modelTier) {
    decision = routeTask({
      analysis,
      config: effectiveConfig,
      overrides: { ...routeOverrides, modelTier: input.modelTier },
      taskHints: input.taskHints,
      unavailableTiers: unavailable,
      tierStatuses: statuses,
      userPrompt,
    });
  }

  if (offlineApplied.forced && offlineApplied.note) {
    decision = {
      ...decision,
      reason: `${decision.reason}; ${offlineApplied.note}`,
      debug: [...(decision.debug ?? []), offlineApplied.note],
    };
  }

  const initialRouting = { ...decision };

  if (routeOverrides.dryRunRouting) {
    return {
      ...dryRunResult(analysis, decision, initialRouting),
      probe,
      connectivity,
    } as RoutedLLMCallResult & {
      probe?: DryRunResult["probe"];
      connectivity?: ConnectivityStatus;
    };
  }

  const attempts: RoutedAttempt[] = [];
  let currentTier = decision.tier;
  let escalated = false;
  let lastResponse = null as Awaited<ReturnType<typeof chatCompletion>> | null;
  let lastEvaluation = evaluateResponse("", options.evaluatorContext ?? {});
  let totalAttempts = 0;
  let tierAttemptCount = 0;
  const maxRetriesPerTier = effectiveConfig.routing.maxRetriesPerTier;

  // Truncation (finish_reason=length) is a parameter problem: retry the SAME
  // tier with a larger max_tokens rather than escalating to a tier that will
  // truncate the same way. Bounded so a model that always hits the cap can't
  // loop forever.
  let currentMaxTokens = DEFAULT_MAX_TOKENS;
  let truncationRetries = 0;
  const MAX_TRUNCATION_RETRIES = 2;
  const MAX_TOKENS_CAP = 32768;

  // Truncation retries are same-tier and safe, so they run even when escalation
  // is disabled. Normal same-tier retries stay gated on enableEscalation below.
  const maxAttempts = effectiveConfig.routing.enableEscalation
    ? 4 * (maxRetriesPerTier + 1)
    : 1 + MAX_TRUNCATION_RETRIES;

  while (totalAttempts < maxAttempts) {
    const tierStatus = statuses.get(currentTier);
    const endpoint =
      tierStatus?.effective?.endpoint ?? getPrimaryEndpoint(effectiveConfig, currentTier);
    const action: AttemptAction =
      totalAttempts === 0 ? "initial" : tierAttemptCount > 0 ? "retry" : "escalation";
    const attempt: RoutedAttempt = {
      tier: currentTier,
      model: endpoint.model,
      action,
    };

    try {
      const response = await chatCompletion(endpoint, currentTier, {
        messages: input.messages,
        tools: input.tools,
        responseFormat: input.responseSchema
          ? { type: "json_object" }
          : undefined,
        maxTokens: currentMaxTokens,
      });

      attempt.latencyMs = response.latencyMs;
      attempt.usage = response.usage;
      attempt.estimatedCostUsd = estimateCostUsd(currentTier, response.usage);
      attempts.push(attempt);
      lastResponse = response;
      tierAttemptCount++;
      totalAttempts++;

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

      if (evaluation.pass) break;

      if (evaluation.truncated && truncationRetries < MAX_TRUNCATION_RETRIES) {
        currentMaxTokens = Math.min(currentMaxTokens * 2, MAX_TOKENS_CAP);
        truncationRetries++;
        continue;
      }

      if (
        evaluation.retryRecommended &&
        effectiveConfig.routing.enableEscalation &&
        tierAttemptCount <= maxRetriesPerTier
      ) {
        continue;
      }

      if (evaluation.escalationRecommended && effectiveConfig.routing.enableEscalation) {
        const next = nextTier(currentTier);
        if (next && next !== currentTier) {
          budget = refreshBudget(budget, overrides?.session, effectiveConfig, attempts);
          if (
            !canEscalateWithinBudget(next, budget) ||
            !canEscalateWithinMode(next, modeConstraints)
          ) {
            break;
          }
          currentTier = next;
          tierAttemptCount = 0;
          escalated = true;
          continue;
        }
      }

      break;
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : String(err);
      attempt.latencyMs = 0;
      attempts.push(attempt);
      tierAttemptCount++;
      totalAttempts++;

      const shouldEscalate =
        effectiveConfig.routing.enableEscalation &&
        (err instanceof ProviderError
          ? err.code === "timeout" ||
            err.code === "http" ||
            err.code === "network" ||
            err.code === "empty"
          : true);

      if (shouldEscalate) {
        // Premium pool rotation before leaving the premium tier.
        if (
          currentTier === "premium" &&
          isPremiumPoolRotationError(err) &&
          (effectiveConfig.premiumPool?.length ?? 0) > 0
        ) {
          const pool = listPremiumEndpoints(effectiveConfig);
          const ordered = orderPremiumEndpoints(pool);
          const failedModel = endpoint.model;
          const nextEp = ordered.find((ep) => ep.model !== failedModel);
          if (nextEp) {
            // Mutate effective endpoint for this tier for remaining attempts.
            const status = statuses.get("premium");
            if (status) {
              status.effective = {
                tier: "premium",
                endpoint: nextEp,
                source: "premium_pool",
                fallbackReason: `premium rotated to pool (${nextEp.provider}/${nextEp.model})`,
              };
            }
            tierAttemptCount = 0;
            continue;
          }
        }

        const next = nextTier(currentTier);
        if (next && next !== currentTier) {
          budget = refreshBudget(budget, overrides?.session, effectiveConfig, attempts);
          if (
            !canEscalateWithinBudget(next, budget) ||
            !canEscalateWithinMode(next, modeConstraints)
          ) {
            throw err;
          }
          currentTier = next;
          tierAttemptCount = 0;
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

  const finalAttempts = annotateAttemptActions(attempts);
  const attemptLog = buildAttemptLog(finalAttempts);
  const totalCost = sumAttemptCosts(finalAttempts, currentTier, lastResponse.usage);
  const finalAttemptCost = estimateCostUsd(currentTier, lastResponse.usage);

  const finalStatus = statuses.get(currentTier);
  const finalEndpoint =
    finalStatus?.effective?.endpoint ?? getPrimaryEndpoint(effectiveConfig, currentTier);

  const promptHash = hashPrompt(`${systemPrompt}\n${userPrompt}`);
  const sessionId =
    overrides?.session?.sessionId ??
    (overrides?.session?.budgetUsd !== undefined ? "anonymous" : undefined);

  const telemetryId = logTelemetry(effectiveConfig, {
    promptHash,
    taskAnalysis: analysis,
    selectedTier: initialRouting.tier,
    selectedModel: initialRouting.model,
    fallbackTier: escalated ? currentTier : initialRouting.fallbackTier ?? undefined,
    fallbackModel: escalated ? finalEndpoint.model : undefined,
    latencyMs: lastResponse.latencyMs,
    tokenUsage: lastResponse.usage,
    estimatedCostUsd: finalAttemptCost ?? totalCost,
    totalEstimatedCostUsd: totalCost,
    success: lastEvaluation.pass,
    evaluatorResult: lastEvaluation,
    routingReason: initialRouting.reason,
    attempts: totalAttempts,
    attemptLog,
    escalated,
    mode: activeMode,
    sessionId,
    userFeedback: overrides?.userFeedback,
    difficulty: analysis.difficulty,
    requiresToolUse: analysis.requiresToolUse,
    outcome: "ok",
  });

  if (sessionId && sessionId !== "anonymous") {
    setStickyTier(sessionId, currentTier);
  }

  return {
    response: lastResponse,
    analysis,
    initialRouting,
    routing: {
      ...decision,
      tier: currentTier,
      model: finalEndpoint.model,
      baseUrl: finalEndpoint.baseUrl,
      provider: finalEndpoint.provider,
      reason: escalated
        ? `${initialRouting.reason} (escalated to ${currentTier})`
        : initialRouting.reason,
      fallbackReason:
        finalStatus?.effective?.fallbackReason ?? decision.fallbackReason,
      endpointSource: finalStatus?.effective?.source ?? decision.endpointSource,
    },
    evaluation: lastEvaluation,
    telemetryId,
    escalated,
    attempts: finalAttempts,
    probe,
    connectivity,
  };
}

export async function dryRunRoute(
  input: RoutedLLMCallInput,
  options: RoutedLLMCallOptions = {}
): Promise<DryRunResult> {
  const config = options.config ?? loadConfig(options.configPath);
  const baseOverrides = mergeOverrides(input.overrides, options.overrides);
  const activeMode = resolveActiveMode(baseOverrides, config);
  const runtime = applyModeToRuntime(activeMode, config, baseOverrides);
  const overrides = runtime.overrides;
  const effectiveConfig: RouterConfig = { ...config, routing: runtime.routing };

  const userPrompt = extractLatestUserPrompt(input.messages);

  let analysis = analyzeTask({
    userPrompt,
    systemPrompt: extractSystemPrompt(input.messages),
    tools: input.tools,
    responseSchema: input.responseSchema,
    taskHints: input.taskHints,
    recentToolTurns:
      input.recentToolTurns ?? countRecentToolTurns(input.messages),
  });
  analysis = await enrichAnalysisWithLlmClassify(
    analysis,
    userPrompt,
    effectiveConfig
  );

  let unavailable = new Set<ModelTier>();
  let probe: Awaited<ReturnType<typeof probeAllTiers>> | undefined;

  // Dry-run defaults to intended tier (no live probe) so agents see routing intent.
  // Opt in via routing.probeOnDryRun, overrides.debug, or options.forceProbe.
  const shouldProbe =
    effectiveConfig.routing.probeAvailability &&
    (options.forceProbe === true ||
      effectiveConfig.routing.probeOnDryRun === true ||
      overrides.debug === true);

  if (shouldProbe) {
    probe = await probeAllTiers(effectiveConfig);
    unavailable = probe.unavailable;
  }

  const connectivity = await resolveConnectivity(effectiveConfig, probe);
  const offlineApplied = applyOfflineLocalOnlyOverrides(
    overrides,
    connectivity,
    effectiveConfig
  );
  const routeOverrides = offlineApplied.overrides;

  let routing = routeTask({
    analysis,
    config: effectiveConfig,
    overrides: routeOverrides,
    taskHints: input.taskHints,
    unavailableTiers: unavailable,
    tierStatuses: tierStatusMap(probe),
    userPrompt,
  });

  if (offlineApplied.forced && offlineApplied.note) {
    routing = {
      ...routing,
      reason: `${routing.reason}; ${offlineApplied.note}`,
      debug: [...(routing.debug ?? []), offlineApplied.note],
    };
  }

  return { analysis, routing, probe, connectivity };
}

export function mergeOverrides(
  a?: RouterOverrides,
  b?: RouterOverrides
): RouterOverrides {
  if (!a) return { ...b };
  if (!b) return { ...a };
  return {
    ...a,
    ...b,
    session:
      a.session || b.session
        ? {
            ...a.session,
            ...b.session,
          }
        : undefined,
  };
}

/** Recompute remaining budget including in-flight attempt costs not yet logged. */
function refreshBudget(
  budget: BudgetStatus | null,
  session: RouterOverrides["session"] | undefined,
  config: RouterConfig,
  attempts: RoutedAttempt[]
): BudgetStatus | null {
  if (!budget || session?.budgetUsd === undefined) return budget;
  const base = resolveBudgetStatus(session, config);
  if (!base) return budget;
  const inFlight = sumAttemptCosts(attempts);
  const spentUsd = base.spentUsd + inFlight;
  const remainingUsd = Math.max(0, base.budgetUsd - spentUsd);
  return {
    ...base,
    spentUsd,
    remainingUsd,
    capTier: tierCapForBudget(remainingUsd),
  };
}

function dryRunResult(
  analysis: TaskAnalysis,
  routing: RoutingDecision,
  initialRouting: RoutingDecision
): RoutedLLMCallResult {
  return {
    response: {
      content: "",
      model: routing.model,
      tier: routing.tier,
      latencyMs: 0,
    },
    analysis,
    initialRouting,
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
