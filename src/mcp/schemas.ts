import { z } from "zod";

export const taskTypeSchema = z.enum([
  "simple_answer",
  "formatting",
  "classification",
  "summarization",
  "rewriting",
  "extraction",
  "code_edit",
  "debugging",
  "refactoring",
  "architecture",
  "multi_step",
  "tool_use",
  "unknown",
]);

export const qualitySchema = z.enum(["fast", "balanced", "best"]);
export const riskSchema = z.enum(["low", "medium", "high"]);
export const tierSchema = z.enum(["local_fast", "local_strong", "hosted_oss", "premium"]);
export const modeSchema = z.enum([
  "balanced",
  "local-only",
  "cheapest",
  "fastest",
  "best-quality",
  "private",
]);

export const routeToolInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "The literal work to perform — e.g. 'make an HTML demo page'. Do NOT pass a meta-description of the routing request (avoid words like 'determine routing for...')."
    ),
  system_prompt: z
    .string()
    .optional()
    .describe("Optional system prompt to include in analysis."),
  task_type: taskTypeSchema.optional().describe("Optional task type hint."),
  quality: qualitySchema.optional().describe("Quality preference: fast, balanced, or best."),
  mode: modeSchema
    .optional()
    .describe(
      "Routing mode: balanced (default), local-only, cheapest, fastest, best-quality, or private."
    ),
  risk: riskSchema.optional().describe("Risk level hint."),
  model_tier: tierSchema.optional().describe("Force a specific model tier."),
  prefer_local: z.boolean().optional().describe("Prefer local models when possible."),
  premium_only: z.boolean().optional().describe("Always route to the premium tier."),
  debug: z
    .boolean()
    .optional()
    .describe("Include full debug trace and probe details (default compact report)."),
  probe: z
    .boolean()
    .optional()
    .describe("Force live availability probe on route (overrides dry-run default of no probe)."),
  config_path: z.string().optional().describe("Path to Maestro AI config JSON."),
  session_id: z
    .string()
    .optional()
    .describe("Session ID for budget tracking across multiple calls."),
  max_tier: tierSchema.optional().describe("Session cap: never route above this tier."),
  budget_usd: z
    .number()
    .optional()
    .describe("Session budget (USD). Enforced — caps tier selection and blocks escalation when exhausted."),
  always_prefer_local: z
    .boolean()
    .optional()
    .describe("Session policy: always prefer local tiers when possible."),
});

export const askToolInputSchema = routeToolInputSchema.extend({
  response_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON schema hint — response will be validated as JSON."),
  dry_run: z
    .boolean()
    .optional()
    .describe("If true, return routing decision without calling an LLM."),
  workflow: z
    .enum([
      "auto",
      "single-shot",
      "plan-execute-validate",
      "parallel-synthesis",
      "critique-revise",
      "implement-test-fix",
      "extract-normalize-validate",
      "critique",
      "extract",
      "single",
    ])
    .optional()
    .describe(
      "Optional workflow pattern. When set (or auto), runs multi-step orchestration instead of a single call."
    ),
  dry_run_workflow: z
    .boolean()
    .optional()
    .describe("If true with workflow, preview the plan without executing LLM steps."),
});

export const workflowToolInputSchema = askToolInputSchema.extend({
  workflow: z
    .enum([
      "auto",
      "single-shot",
      "plan-execute-validate",
      "parallel-synthesis",
      "critique-revise",
      "implement-test-fix",
      "extract-normalize-validate",
      "critique",
      "extract",
      "single",
    ])
    .default("auto")
    .describe("Workflow pattern to execute (default auto)."),
});

export const probeToolInputSchema = z.object({
  config_path: z.string().optional().describe("Path to Maestro AI config JSON."),
  force: z.boolean().optional().describe("Bypass probe cache and re-check endpoints."),
});

export const statsToolInputSchema = z.object({
  last: z.number().optional().describe("Number of recent telemetry records to analyze (default 50)."),
  session_id: z.string().optional().describe("Filter stats to a single session."),
  insights: z
    .boolean()
    .optional()
    .describe("Include routing insights and learned-routing readiness in stats output."),
  config_path: z.string().optional().describe("Path to Maestro AI config JSON."),
});

export const analyzeToolInputSchema = statsToolInputSchema.extend({
  min_samples: z
    .number()
    .optional()
    .describe("Minimum samples per task/tier cell for recommendations (default 5)."),
  all: z
    .boolean()
    .optional()
    .describe("Analyze all telemetry records (default true for analyze; stats uses last N)."),
});

export const feedbackToolInputSchema = z.object({
  telemetry_id: z.string().describe("Telemetry ID from a prior maestro_ask response."),
  feedback: z
    .string()
    .min(1)
    .describe("User feedback: e.g. 'good', 'bad', or a short note."),
  session_id: z.string().optional().describe("Optional session ID for correlation."),
  config_path: z.string().optional().describe("Path to Maestro AI config JSON."),
});

export type RouteToolInput = z.infer<typeof routeToolInputSchema>;
export type AskToolInput = z.infer<typeof askToolInputSchema>;
export type WorkflowToolInput = z.infer<typeof workflowToolInputSchema>;
export type ProbeToolInput = z.infer<typeof probeToolInputSchema>;
export type StatsToolInput = z.infer<typeof statsToolInputSchema>;
export type AnalyzeToolInput = z.infer<typeof analyzeToolInputSchema>;
export type FeedbackToolInput = z.infer<typeof feedbackToolInputSchema>;
