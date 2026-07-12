export type {
  ChatMessage,
  EvaluationCheck,
  EvaluationResult,
  EvaluatorContext,
  LLMResponse,
  LLMUsage,
  ModelEndpointConfig,
  ModelTier,
  QualityPreference,
  RiskLevel,
  AttemptAction,
  AttemptLogEntry,
  RoutedAttempt,
  ValidationOutcome,
  RoutedLLMCallInput,
  RoutedLLMCallResult,
  RouterConfig,
  RouterOverrides,
  RoutingConfig,
  RoutingDecision,
  RoutingMode,
  RoutingPolicy,
  SessionPolicy,
  TaskAnalysis,
  TaskAnalysisInput,
  TaskDifficulty,
  TaskHints,
  TaskType,
  TelemetryConfig,
  TelemetryRecord,
  TierModelConfig,
} from "./types.js";

export { TIER_ORDER, capTier, floorTier, isLocalTier, nextTier } from "./types.js";

export {
  analyzeTask,
  extractSystemPrompt,
  extractUserPrompt,
  hashPrompt,
} from "./analyzer/task-analyzer.js";

export { loadConfig, loadConfigFromString, parseRouterConfig, attachPolicy } from "./config/load-config.js";
export {
  applyRoutingPolicy,
  loadPolicy,
  loadPolicyFromString,
  defaultPolicyPath,
  userPolicyPath,
} from "./config/policy.js";
export {
  CONFIG_PROFILES,
  maestroHomeDir,
  packageRoot,
  userConfigPath,
  type ConfigProfile,
} from "./config/package-paths.js";
export {
  getPrimaryEndpoint,
  listEndpointsForTier,
  normalizeTierEntry,
  resolveEndpointForTier,
} from "./config/tier-config.js";

export { evaluateResponse, evaluateResponseAsync } from "./evaluator/response-evaluator.js";

export { chatCompletion, ProviderError } from "./provider/openai-compatible.js";
export { chatCompletionStream, routedLLMStream } from "./provider/stream.js";
export { probeAllTiers, probeEndpoint, probeTier } from "./provider/probe.js";

export { routeTask } from "./router/model-router.js";
export { buildRoutingReport } from "./routing/report.js";
export type { RoutingReport, CallOutcome } from "./routing/report.js";
export {
  buildDecisionExplanation,
  formatExplanationPlain,
} from "./routing/explanation.js";
export type { DecisionExplanation, HistoricalContext } from "./routing/explanation.js";
export {
  annotateAttemptActions,
  buildAttemptLog,
  buildValidationOutcome,
  formatOutcomeMarkdown,
  humanizeFailedChecks,
} from "./routing/outcome.js";
export {
  ROUTING_MODES,
  MODE_PROFILES,
  DEFAULT_ROUTING_MODE,
  applyModeToRuntime,
  applyModeToTier,
  canEscalateWithinMode,
  getModeProfile,
  isRoutingMode,
  resolveActiveMode,
  resolveModeConstraints,
} from "./routing/modes.js";
export type { ModeConstraints, ModeProfile } from "./routing/modes.js";
export {
  applyBudgetToTier,
  canEscalateWithinBudget,
  resolveBudgetStatus,
  tierCapForBudget,
} from "./routing/budget.js";
export type { BudgetStatus } from "./routing/budget.js";

export { dryRunRoute, routedLLMCall } from "./routed-llm-call.js";
export type { RoutedLLMCallOptions, DryRunResult } from "./routed-llm-call.js";

export { estimateCostUsd, logTelemetry, recordUserFeedback } from "./telemetry/logger.js";
export type { FeedbackRecord } from "./telemetry/logger.js";
export {
  computeTelemetryStats,
  formatStatsReport,
  getSessionSpend,
  getHistoricalSuccessRate,
  loadAllTelemetryRecords,
  loadTelemetryRecords,
} from "./telemetry/stats.js";
export type { HistoricalSuccessRate } from "./telemetry/stats.js";

export { runDoctor } from "./doctor/health.js";
export type { DoctorCheck, DoctorReport } from "./doctor/health.js";

export {
  runInit,
  formatInitReport,
  buildMcpConfig,
  listRequiredOllamaModels,
  fetchOllamaModels,
} from "./init/setup.js";
export type { InitOptions, InitReport } from "./init/setup.js";

export { createMaestroMcpServer, createModelRouterMcpServer } from "./mcp/server.js";
export {
  handleAskTool,
  handleDoctorTool,
  handleFeedbackTool,
  handleProbeTool,
  handleRouteTool,
  handleStatsTool,
  buildMessages,
  buildOverrides,
  buildTaskHints,
} from "./mcp/tools.js";
export {
  askToolInputSchema,
  feedbackToolInputSchema,
  probeToolInputSchema,
  routeToolInputSchema,
  statsToolInputSchema,
} from "./mcp/schemas.js";

export {
  benchyDelegate,
  benchyRouteSubtask,
  claudeCodeDelegateCommand,
  resolveMaestroModel,
} from "./adapters/index.js";
