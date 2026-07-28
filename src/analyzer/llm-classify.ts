/**
 * Optional local_fast one-shot task classification.
 *
 * Modes:
 * - off: heuristics only (default)
 * - shadow: call local_fast when uncertain; log disagreements; keep heuristic route
 * - on: merge LLM fields into analysis (fail-soft: never solo-force premium)
 */
import { getPrimaryEndpoint } from "../config/tier-config.js";
import { chatCompletion } from "../provider/openai-compatible.js";
import type {
  ModelTier,
  RiskLevel,
  RouterConfig,
  TaskAnalysis,
  TaskDifficulty,
  TaskType,
} from "../types.js";

export type LlmClassifyMode = "off" | "shadow" | "on";

export interface LlmClassifyResult {
  taskType?: TaskType;
  difficulty?: TaskDifficulty;
  riskLevel?: RiskLevel;
  requiresToolUse?: boolean;
  confidence?: number;
  latencyMs: number;
  error?: string;
  raw?: string;
}

const TASK_TYPES: TaskType[] = [
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
];

const DIFFICULTIES: TaskDifficulty[] = ["easy", "medium", "hard"];
const RISKS: RiskLevel[] = ["low", "medium", "high"];

const CLASSIFY_SYSTEM = `You classify coding-agent user asks for an LLM router.
Reply with ONLY a JSON object (no markdown):
{"taskType":"...","difficulty":"easy|medium|hard","riskLevel":"low|medium|high","requiresToolUse":true|false,"confidence":0.0-1.0}
taskType one of: ${TASK_TYPES.join(", ")}
requiresToolUse=true only if the user needs file/shell/repo tools this turn (not mere chitchat).`;

export function resolveLlmClassifyMode(
  routing: RouterConfig["routing"]
): LlmClassifyMode {
  const raw = routing.llmClassify;
  if (raw === "shadow" || raw === "on" || raw === "off") return raw;
  return "off";
}

/** When heuristics are uncertain enough to justify a cheap local call. */
export function shouldRunLlmClassify(
  analysis: TaskAnalysis,
  mode: LlmClassifyMode
): boolean {
  if (mode === "off") return false;
  if (analysis.confidence < 0.65) return true;
  if (analysis.taskType === "unknown") return true;
  // Borderline tool-need — common Claude Code false +/- zone
  if (analysis.toolNeedScore >= 0.4 && analysis.toolNeedScore < 0.7) return true;
  return false;
}

export async function classifyWithLocalFast(
  config: RouterConfig,
  userPrompt: string,
  opts?: { timeoutMs?: number; tier?: ModelTier }
): Promise<LlmClassifyResult> {
  const tier = opts?.tier ?? "local_fast";
  const endpoint = {
    ...getPrimaryEndpoint(config, tier),
    timeoutMs: opts?.timeoutMs ?? 2_500,
  };
  const started = Date.now();
  try {
    const response = await chatCompletion(endpoint, tier, {
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM },
        {
          role: "user",
          content: userPrompt.slice(0, 2_000) || "(empty)",
        },
      ],
      maxTokens: 120,
      temperature: 0,
    });
    const parsed = parseClassifyJson(response.content);
    return {
      ...parsed,
      latencyMs: Date.now() - started,
      raw: response.content.slice(0, 400),
    };
  } catch (err) {
    return {
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function parseClassifyJson(text: string): Omit<
  LlmClassifyResult,
  "latencyMs" | "error" | "raw"
> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const out: Omit<LlmClassifyResult, "latencyMs" | "error" | "raw"> = {};
    if (typeof obj.taskType === "string" && TASK_TYPES.includes(obj.taskType as TaskType)) {
      out.taskType = obj.taskType as TaskType;
    }
    if (
      typeof obj.difficulty === "string" &&
      DIFFICULTIES.includes(obj.difficulty as TaskDifficulty)
    ) {
      out.difficulty = obj.difficulty as TaskDifficulty;
    }
    if (typeof obj.riskLevel === "string" && RISKS.includes(obj.riskLevel as RiskLevel)) {
      out.riskLevel = obj.riskLevel as RiskLevel;
    }
    if (typeof obj.requiresToolUse === "boolean") {
      out.requiresToolUse = obj.requiresToolUse;
    }
    if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
      out.confidence = Math.max(0.1, Math.min(1, obj.confidence));
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Shadow: keep heuristic analysis, annotate disagreements.
 * On: merge LLM fields; clamp so LLM alone cannot clear premium gates.
 */
export function mergeHeuristicAndLlm(
  heuristic: TaskAnalysis,
  llm: LlmClassifyResult,
  mode: "shadow" | "on"
): TaskAnalysis {
  const signals = [...heuristic.signals];
  if (llm.error) {
    signals.push(`llm_classify_error=${llm.error.slice(0, 60)}`);
    return { ...heuristic, signals };
  }

  const disagreements: string[] = [];
  if (llm.taskType && llm.taskType !== heuristic.taskType) {
    disagreements.push(`taskType:${heuristic.taskType}->${llm.taskType}`);
  }
  if (llm.difficulty && llm.difficulty !== heuristic.difficulty) {
    disagreements.push(`difficulty:${heuristic.difficulty}->${llm.difficulty}`);
  }
  if (llm.riskLevel && llm.riskLevel !== heuristic.riskLevel) {
    disagreements.push(`risk:${heuristic.riskLevel}->${llm.riskLevel}`);
  }
  if (
    llm.requiresToolUse != null &&
    llm.requiresToolUse !== heuristic.requiresToolUse
  ) {
    disagreements.push(
      `tools:${heuristic.requiresToolUse}->${llm.requiresToolUse}`
    );
  }

  signals.push(`llm_classify_ms=${llm.latencyMs}`);
  if (disagreements.length) {
    signals.push(`llm_classify_diff=${disagreements.join(",")}`);
  } else {
    signals.push("llm_classify_agree");
  }

  if (mode === "shadow") {
    signals.push("llm_classify=shadow");
    return { ...heuristic, signals };
  }

  // --- on: apply merge with fail-soft ---
  signals.push("llm_classify=on");
  let taskType = llm.taskType ?? heuristic.taskType;
  let difficulty = llm.difficulty ?? heuristic.difficulty;
  let riskLevel = llm.riskLevel ?? heuristic.riskLevel;
  let requiresToolUse = heuristic.requiresToolUse;
  let toolNeedScore = heuristic.toolNeedScore;
  let confidence = heuristic.confidence;

  if (llm.requiresToolUse === true) {
    requiresToolUse = true;
    toolNeedScore = Math.max(toolNeedScore, 0.7);
  } else if (llm.requiresToolUse === false && toolNeedScore < 0.7) {
    // Only clear weak tool-need; never drop a strong mid-loop / strong-evidence ask.
    requiresToolUse = false;
  }

  if (typeof llm.confidence === "number") {
    confidence = Math.max(confidence, llm.confidence);
  }

  // Fail-soft: LLM cannot alone drive hard+high-confidence (premium gate).
  if (
    difficulty === "hard" &&
    heuristic.difficulty !== "hard" &&
    confidence >= 0.65
  ) {
    confidence = Math.min(confidence, 0.64);
    signals.push("llm_classify_premium_clamp");
  }

  const requiresCodeReasoning =
    heuristic.requiresCodeReasoning ||
    ["debugging", "refactoring", "architecture", "multi_step"].includes(taskType) ||
    (taskType === "code_edit" && difficulty !== "easy");

  return {
    ...heuristic,
    taskType,
    difficulty,
    riskLevel,
    requiresToolUse,
    toolNeedScore,
    requiresCodeReasoning,
    confidence,
    signals,
  };
}

/** Analyze with optional local_fast classify. */
export async function enrichAnalysisWithLlmClassify(
  analysis: TaskAnalysis,
  userPrompt: string,
  config: RouterConfig
): Promise<TaskAnalysis> {
  const mode = resolveLlmClassifyMode(config.routing);
  if (!shouldRunLlmClassify(analysis, mode)) {
    return analysis;
  }
  const llm = await classifyWithLocalFast(config, userPrompt);
  return mergeHeuristicAndLlm(analysis, llm, mode === "on" ? "on" : "shadow");
}
