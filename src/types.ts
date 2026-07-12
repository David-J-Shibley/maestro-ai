export type ModelTier = "local_fast" | "local_strong" | "hosted_oss" | "premium";

export type TaskDifficulty = "easy" | "medium" | "hard";
export type RiskLevel = "low" | "medium" | "high";
export type TaskType =
  | "simple_answer"
  | "formatting"
  | "classification"
  | "summarization"
  | "rewriting"
  | "extraction"
  | "code_edit"
  | "debugging"
  | "refactoring"
  | "architecture"
  | "multi_step"
  | "tool_use"
  | "unknown";

export type QualityPreference = "fast" | "balanced" | "best";

export type RoutingMode =
  | "balanced"
  | "local-only"
  | "cheapest"
  | "fastest"
  | "best-quality"
  | "private";

export interface TaskHints {
  type?: TaskType;
  quality?: QualityPreference;
  risk?: RiskLevel;
  requiresTools?: boolean;
  requiresCodeReasoning?: boolean;
  requiresLongContext?: boolean;
  requiresStructuredOutput?: boolean;
}

export interface TaskAnalysisInput {
  userPrompt: string;
  systemPrompt?: string;
  tools?: unknown[];
  responseSchema?: Record<string, unknown>;
  contextSizeTokens?: number;
  taskHints?: TaskHints;
}

export interface TaskAnalysis {
  taskType: TaskType;
  difficulty: TaskDifficulty;
  riskLevel: RiskLevel;
  requiresToolUse: boolean;
  requiresCodeReasoning: boolean;
  requiresLongContext: boolean;
  requiresStructuredOutput: boolean;
  confidence: number;
  signals: string[];
}

export interface ModelEndpointConfig {
  provider: "ollama" | "litellm" | "openai_compatible";
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface RoutingConfig {
  defaultTier: ModelTier;
  /** Operator control plane — default routing mode (v0.7+) */
  defaultMode?: RoutingMode;
  maxRetriesPerTier: number;
  enableEscalation: boolean;
  preferLocal: boolean;
  longContextTokenThreshold: number;
  probeAvailability: boolean;
  /** When true, nudge tier selection using telemetry recommendations (v0.9+) */
  learnedRoutingHints?: boolean;
  learnedMinSamples?: number;
}

export interface TelemetryConfig {
  enabled: boolean;
  logPath: string;
}

export interface TierModelConfig {
  primary: ModelEndpointConfig;
  fallback?: ModelEndpointConfig;
}

export interface SessionPolicy {
  /** Correlate telemetry for budget tracking */
  sessionId?: string;
  maxTier?: ModelTier;
  budgetUsd?: number;
  alwaysPreferLocal?: boolean;
}

export interface RouterOverrides {
  /** Operator routing mode — constrains tier selection and escalation (v0.7+) */
  mode?: RoutingMode;
  modelTier?: ModelTier;
  preferLocal?: boolean;
  premiumOnly?: boolean;
  debug?: boolean;
  dryRunRouting?: boolean;
  /** Workflow orchestration pattern (v1.0+) */
  workflow?:
    | "auto"
    | "single-shot"
    | "plan-execute-validate"
    | "parallel-synthesis"
    | "critique-revise"
    | "implement-test-fix"
    | "extract-normalize-validate"
    | "critique"
    | "extract"
    | "single";
  dryRunWorkflow?: boolean;
  userFeedback?: string;
  session?: SessionPolicy;
}

export interface SensitiveCodePolicy {
  enabled: boolean;
  max_tier: ModelTier;
  reason?: string;
}

export interface PrivacyPolicyRule {
  keywords: string[];
  max_tier: ModelTier;
  reason?: string;
}

export type GuardrailKind = "budget" | "privacy" | "latency";
export type GuardrailAction = "allow" | "warn" | "cap" | "block";

export interface GuardrailResult {
  kind: GuardrailKind;
  action: GuardrailAction;
  message: string;
  detail?: string;
}

export interface GuardrailsPolicy {
  budget?: {
    enabled?: boolean;
    warn_remaining_usd?: number;
  };
  privacy?: {
    enabled?: boolean;
    block_cloud?: boolean;
  };
  latency?: {
    enabled?: boolean;
    target_ms?: number | null;
    prefer_faster_tier?: boolean;
  };
}

export interface RoutingPolicy {
  task_type_tiers?: Partial<Record<TaskType, ModelTier>>;
  privacy?: PrivacyPolicyRule;
  sensitive_code_local_only?: SensitiveCodePolicy;
  latency_target_ms?: number | null;
  guardrails?: GuardrailsPolicy;
}

export interface RouterConfig {
  models: Record<ModelTier, TierModelConfig>;
  routing: RoutingConfig;
  telemetry: TelemetryConfig;
  /** Optional premium model pool for future rotation */
  premiumPool?: ModelEndpointConfig[];
  /** Loaded from policy.json — declarative routing rules */
  policy?: RoutingPolicy | null;
}

export interface RoutingDecision {
  tier: ModelTier;
  model: string;
  baseUrl: string;
  provider: ModelEndpointConfig["provider"];
  reason: string;
  fallbackTier: ModelTier | null;
  requestedTier?: ModelTier;
  fallbackReason?: string;
  endpointSource?: "primary" | "tier_fallback";
  debug?: string[];
  /** Active routing mode for this decision */
  mode?: RoutingMode;
  guardrails?: GuardrailResult[];
  budget?: {
    session_id: string;
    budget_usd: number;
    spent_usd: number;
    remaining_usd: number;
    cap_tier: ModelTier;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface RoutedLLMCallInput {
  messages: ChatMessage[];
  tools?: unknown[];
  responseSchema?: Record<string, unknown>;
  taskHints?: TaskHints;
  /** Override tier selection */
  modelTier?: ModelTier;
  /** CLI/runtime overrides */
  overrides?: RouterOverrides;
}

export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  tier: ModelTier;
  usage?: LLMUsage;
  latencyMs: number;
  raw?: unknown;
}

export interface EvaluatorContext {
  responseSchema?: Record<string, unknown>;
  expectedFormat?: "json" | "text" | "markdown";
  taskAllowed?: boolean;
  requiredFilePaths?: string[];
  workspaceRoot?: string;
  tools?: unknown[];
  rawResponse?: unknown;
  runTests?: () => Promise<boolean>;
  runBuild?: () => Promise<boolean>;
}

export interface EvaluationResult {
  pass: boolean;
  reason: string;
  retryRecommended: boolean;
  escalationRecommended: boolean;
  checks: EvaluationCheck[];
}

export interface EvaluationCheck {
  name: string;
  pass: boolean;
  reason?: string;
}

export interface TelemetryRecord {
  id: string;
  timestamp: string;
  promptHash: string;
  taskAnalysis: TaskAnalysis;
  selectedTier: ModelTier;
  selectedModel: string;
  fallbackTier?: ModelTier;
  fallbackModel?: string;
  latencyMs: number;
  tokenUsage?: LLMUsage;
  estimatedCostUsd?: number;
  success: boolean;
  evaluatorResult?: EvaluationResult;
  routingReason: string;
  attempts: number;
  /** Per-attempt audit trail when evaluator-driven escalation runs. */
  attemptLog?: AttemptLogEntry[];
  /** True only when the call actually fell back to a higher tier. */
  escalated?: boolean;
  /** Routing mode active for this call (v0.7+) */
  mode?: RoutingMode;
  sessionId?: string;
  userFeedback?: string;
}

export interface RoutedLLMCallResult {
  response: LLMResponse;
  analysis: TaskAnalysis;
  /** Tier/model chosen before any evaluator-driven escalation. */
  initialRouting: RoutingDecision;
  routing: RoutingDecision;
  evaluation: EvaluationResult;
  telemetryId: string;
  escalated: boolean;
  attempts: RoutedAttempt[];
}

export type AttemptAction = "initial" | "retry" | "escalation" | "provider_recovery";

export interface RoutedAttempt {
  tier: ModelTier;
  model: string;
  latencyMs?: number;
  error?: string;
  evaluation?: EvaluationResult;
  action?: AttemptAction;
}

export interface AttemptLogEntry {
  tier: ModelTier;
  model: string;
  action: AttemptAction;
  latencyMs?: number;
  pass: boolean;
  failedChecks?: string[];
  reason?: string;
  error?: string;
}

export interface ValidationOutcome {
  initial_tier: ModelTier;
  initial_model: string;
  final_tier: ModelTier;
  final_model: string;
  escalated: boolean;
  final_pass: boolean;
  summary: string;
  why_escalated: string[];
  attempt_trail: Array<{
    tier: ModelTier;
    model: string;
    action: AttemptAction;
    pass: boolean;
    failed_checks?: string[];
    reason?: string;
    error?: string;
  }>;
}

export const TIER_ORDER: ModelTier[] = [
  "local_fast",
  "local_strong",
  "hosted_oss",
  "premium",
];

export function nextTier(tier: ModelTier): ModelTier | null {
  const idx = TIER_ORDER.indexOf(tier);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1] ?? null;
}

export function capTier(tier: ModelTier, maxTier: ModelTier): ModelTier {
  const ti = TIER_ORDER.indexOf(tier);
  const mi = TIER_ORDER.indexOf(maxTier);
  if (ti < 0 || mi < 0) return tier;
  return ti > mi ? maxTier : tier;
}

export function floorTier(tier: ModelTier, minTier: ModelTier): ModelTier {
  const ti = TIER_ORDER.indexOf(tier);
  const mi = TIER_ORDER.indexOf(minTier);
  if (ti < 0 || mi < 0) return tier;
  return ti < mi ? minTier : tier;
}

export function isLocalTier(tier: ModelTier): boolean {
  return tier === "local_fast" || tier === "local_strong";
}
