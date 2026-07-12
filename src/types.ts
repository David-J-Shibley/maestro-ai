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
  maxRetriesPerTier: number;
  enableEscalation: boolean;
  preferLocal: boolean;
  longContextTokenThreshold: number;
  probeAvailability: boolean;
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
  modelTier?: ModelTier;
  preferLocal?: boolean;
  premiumOnly?: boolean;
  debug?: boolean;
  dryRunRouting?: boolean;
  userFeedback?: string;
  session?: SessionPolicy;
}

export interface RouterConfig {
  models: Record<ModelTier, TierModelConfig>;
  routing: RoutingConfig;
  telemetry: TelemetryConfig;
  /** Optional premium model pool for future rotation */
  premiumPool?: ModelEndpointConfig[];
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
  /** True only when the call actually fell back to a higher tier. */
  escalated?: boolean;
  sessionId?: string;
  userFeedback?: string;
}

export interface RoutedLLMCallResult {
  response: LLMResponse;
  analysis: TaskAnalysis;
  routing: RoutingDecision;
  evaluation: EvaluationResult;
  telemetryId: string;
  escalated: boolean;
  attempts: RoutedAttempt[];
}

export interface RoutedAttempt {
  tier: ModelTier;
  model: string;
  latencyMs?: number;
  error?: string;
  evaluation?: EvaluationResult;
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

export function isLocalTier(tier: ModelTier): boolean {
  return tier === "local_fast" || tier === "local_strong";
}
