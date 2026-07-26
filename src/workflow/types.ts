import type {
  ChatMessage,
  EvaluationResult,
  ModelTier,
  RiskLevel,
  RoutedLLMCallResult,
  RoutingMode,
  TaskAnalysis,
  TaskHints,
  TaskType,
} from "../types.js";

export type WorkflowPatternId =
  | "single-shot"
  | "plan-execute-validate"
  | "parallel-synthesis"
  | "critique-revise"
  | "implement-test-fix"
  | "extract-normalize-validate";

/** CLI / API aliases mapped to pattern ids */
export type WorkflowRequest =
  | "auto"
  | WorkflowPatternId
  | "critique"
  | "implement-test-fix"
  | "parallel-synthesis"
  | "plan-execute-validate"
  | "extract"
  | "single";

export type WorkflowStepKind = "llm" | "tool" | "synthesis";
export type WorkflowStepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface WorkflowFile {
  path: string;
  content: string;
}

export interface StepValidationRequirements {
  requireSchema?: boolean;
  requireNoPlaceholders?: boolean;
  runTests?: boolean;
  runBuild?: boolean;
}

export interface WorkflowStepPlan {
  id: string;
  name: string;
  purpose: string;
  dependsOn: string[];
  expectedOutput: string;
  requiredTools?: string[];
  taskType: TaskType;
  riskLevel: RiskLevel;
  recommendedTier: ModelTier;
  parallelizable: boolean;
  kind: WorkflowStepKind;
  validation: StepValidationRequirements;
  /** Run only when a dependency step failed */
  runOnFailure?: boolean;
  optional?: boolean;
}

export interface WorkflowPlan {
  id: string;
  pattern: WorkflowPatternId;
  patternLabel: string;
  why: string;
  goal: string;
  steps: WorkflowStepPlan[];
  mode: RoutingMode;
  constraints: string[];
}

export interface WorkflowStateSnapshot {
  goal: string;
  files?: WorkflowFile[];
  stepOutputs: Map<string, { content: string; status: string }>;
}

export interface WorkflowArtifact {
  stepId: string;
  name: string;
  content: string;
  mimeType?: string;
}

export interface StepOutput {
  stepId: string;
  content: string;
  status: WorkflowStepStatus;
  routing?: RoutedLLMCallResult["routing"];
  analysis?: TaskAnalysis;
  evaluation?: EvaluationResult;
  latencyMs: number;
  estimatedCostUsd: number;
  escalated: boolean;
  retries: number;
  error?: string;
}

export interface WorkflowStepResult extends StepOutput {
  name: string;
  recommendedTier: ModelTier;
  actualTier: ModelTier;
  model: string;
}

export interface WorkflowValidation {
  pass: boolean;
  confidence: number;
  checks: Array<{ name: string; pass: boolean; reason?: string }>;
  summary: string;
}

export interface WorkflowExecutionReport {
  markdown: string;
  goal: string;
  pattern: WorkflowPatternId;
  patternLabel: string;
  why: string;
  steps: Array<{
    id: string;
    name: string;
    tier: ModelTier;
    status: WorkflowStepStatus;
    escalated: boolean;
    retries: number;
    validation: string;
  }>;
  escalations: string[];
  totalLatencyMs: number;
  estimatedCostUsd: number;
  finalStatus: "passed" | "failed" | "partial";
  finalConfidence: number;
  tradeoffs: string[];
}

export interface WorkflowStepTelemetry {
  stepId: string;
  name: string;
  taskType: TaskType;
  tier: ModelTier;
  model: string;
  provider: string;
  latencyMs: number;
  estimatedCostUsd: number;
  success: boolean;
  escalated: boolean;
  retries: number;
  validationSummary: string;
}

export interface WorkflowTelemetryRecord {
  recordType: "workflow";
  workflowId: string;
  timestamp: string;
  promptHash: string;
  goal: string;
  pattern: WorkflowPatternId;
  mode?: RoutingMode;
  steps: WorkflowStepTelemetry[];
  finalStatus: "passed" | "failed" | "partial";
  finalConfidence: number;
  totalLatencyMs: number;
  estimatedCostUsd: number;
  sessionId?: string;
  userFeedback?: string;
}

export interface RunWorkflowInput {
  messages: ChatMessage[];
  tools?: unknown[];
  files?: WorkflowFile[];
  responseSchema?: Record<string, unknown>;
  taskHints?: TaskHints;
  mode?: RoutingMode;
  workflow?: WorkflowRequest;
  goal?: string;
  /** True when caller provided runTests/runBuild hooks — enables implement-test-fix under auto */
  hasValidationHooks?: boolean;
  overrides?: import("../types.js").RouterOverrides & {
    dryRunWorkflow?: boolean;
  };
}

export interface RunWorkflowResult {
  finalOutput: string;
  workflow: WorkflowPlan;
  steps: WorkflowStepResult[];
  report: WorkflowExecutionReport;
  telemetry: { workflowId: string };
  validation: WorkflowValidation;
  artifacts: Record<string, WorkflowArtifact>;
  analysis?: TaskAnalysis;
  routing?: RoutedLLMCallResult["routing"];
  response?: RoutedLLMCallResult["response"];
}

export interface DryRunWorkflowResult {
  plan: WorkflowPlan;
  stepRoutes: Array<{
    stepId: string;
    name: string;
    recommendedTier: ModelTier;
    predictedTier: ModelTier;
    model: string;
    reason: string;
  }>;
  constraints: string[];
  estimatedLatencyMs?: { min: number; max: number };
  estimatedCostUsd?: { min: number; max: number };
  report: string;
}

export interface StepExecutionContext {
  step: WorkflowStepPlan;
  messages: ChatMessage[];
  taskHints: TaskHints;
  responseSchema?: Record<string, unknown>;
  tools?: unknown[];
  evaluatorContext?: import("../types.js").EvaluatorContext;
}

export type StepRunner = (
  ctx: StepExecutionContext,
  options: import("../routed-llm-call.js").RoutedLLMCallOptions
) => Promise<RoutedLLMCallResult>;
