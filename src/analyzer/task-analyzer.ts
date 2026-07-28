import { createHash } from "node:crypto";
import type {
  RiskLevel,
  TaskAnalysis,
  TaskAnalysisInput,
  TaskDifficulty,
  TaskHints,
  TaskType,
} from "../types.js";

const CODE_KEYWORDS = [
  "refactor",
  "debug",
  "implement",
  "function",
  "class",
  "typescript",
  "javascript",
  "python",
  "compile",
  "test",
  "bug",
  "fix",
  "api",
  "endpoint",
  "module",
  "import",
];

const ARCHITECTURE_KEYWORDS = [
  "architecture",
  "system design",
  "trade-off",
  "tradeoff",
  "scalability",
  "microservice",
  "migration plan",
];

const SIMPLE_UI_PATTERNS = [
  /\b(html|css|web)\s*page\b/,
  /\blanding\s*page\b/,
  /\bdemo\s*page\b/,
  /\b(single|simple|static)\s+(html|web)\b/,
  /\bmake\b.*\b(html|web)\b/,
  /\bbuild\b.*\b(html|web)\b/,
  /\bcreate\b.*\b(html|web)\b/,
  /\bbuild\b.*\bdemonstration\b/,
  /\bdemonstration\s+page\b/,
];

const TOOL_TASK_TYPES: TaskType[] = [
  "code_edit",
  "debugging",
  "refactoring",
  "architecture",
  "multi_step",
  "tool_use",
];

/** Verbs that imply the harness should actually call a tool. */
const TOOL_ACTION_RE =
  /\b(list|read|write|edit|create|delete|run|bash|execute|search|find|open|fix|implement|debug|refactor|test|commit|push|install|mkdir|rm\b|mv\b|cp\b|cat\b|grep|curl|wget)\b/i;

/** Paths, filenames, or other concrete tool targets. */
const TOOL_TARGET_RE =
  /(?:\/[\w.-]+)+|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|md|json|ya?ml|toml|css|scss|html|sh|sql|env)\b|`[^`\n]+`|\b(?:file|files|directory|folder|repo|codebase|package\.json|src\/|tests?\/)\b/i;

const CODE_FENCE_RE = /```/;

/** Imperative strong enough to justify tools without relying on task-type alone. */
export function hasStrongToolEvidence(ask: string): boolean {
  const t = ask.trim();
  if (!t) return false;
  const hasVerb = TOOL_ACTION_RE.test(t);
  const hasTarget = TOOL_TARGET_RE.test(t) || CODE_FENCE_RE.test(t);
  if (hasVerb && hasTarget) return true;
  // Multi-word imperative without extension still counts (e.g. "list open files")
  if (hasVerb && t.split(/\s+/).length >= 4) return true;
  return false;
}

/** Pure chitchat — tools may be present in the harness payload but aren't needed. */
export function isTrivialChitchat(prompt: string): boolean {
  const t = prompt.trim().toLowerCase().replace(/[!?.…]+$/g, "").trim();
  if (!t || t.length > 80) return false;
  // Exact short greetings / acks
  if (
    /^(hi|hello|hey|yo|sup|howdy|hiya|thanks|thank you|thx|ty|ok|okay|k|yes|no|yep|nope|cool|great|good (morning|afternoon|evening|night)|what's up|whats up|how are you)$/i.test(
      t
    )
  ) {
    return true;
  }
  // Soft status / ping phrases (not real work)
  if (
    /^(hi|hello|hey)\b.{0,40}$/i.test(t) &&
    !TOOL_ACTION_RE.test(t) &&
    !/\b(bug|error|file|code|implement|refactor|debug)\b/i.test(t)
  ) {
    // "hi are you working", "hello there", "hey you up?"
    return true;
  }
  if (
    /^(testing|test|ping|poke|you (there|up|working)|are you (there|up|working|ok|okay)|still (there|working)|status check)\b[.!?]*$/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function hasKeyword(haystack: string, keyword: string): boolean {
  // Word-boundary match so "testing" does not hit keyword "test".
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Claude Code / harness meta prompts (resume, recap) — should not escalate to premium
 * just because the tool catalog is attached.
 */
export function isHarnessMetaAsk(prompt: string): boolean {
  if (isTrivialChitchat(prompt)) return true;
  const t = prompt.trim().toLowerCase();
  if (t.length > 500) {
    // Still catch Claude Code suggestion-mode prefixes in long blobs.
    if (/^\[suggestion mode:/i.test(prompt.trim())) return true;
    return false;
  }
  return (
    /^\[suggestion mode:/i.test(t) ||
    /^the user stepped away\b/i.test(t) ||
    (/\bis coming back\b/i.test(t) && /\brecap\b/i.test(t)) ||
    /^recap\b/i.test(t) ||
    /\brecap (the )?(conversation|session|chat)\b/i.test(t) ||
    /^summarize (what we|the conversation|this session)\b/i.test(t)
  );
}

/** Signals of real system-design work — not demo pages or router showcases. */
const SYSTEM_ARCHITECTURE_SIGNALS = [
  /\bsystem\s+design\b/,
  /\bscalab/i,
  /\bmicroservice/,
  /\bmulti-tenant/,
  /\bdistributed\s+(system|architecture)\b/,
  /\btrade-?off/,
  /\bmigration\s+plan/,
  /\bevent\s+sourcing/,
  /\bproduction\s+architecture\b/,
];

const DEMO_SHOWCASE_PATTERNS = [
  /\b(demo|demonstration|showcase)\b/,
  /\bmodel[- ]?router\b/,
  /\bmaestro(?:\s*ai)?\b/,
  /\btier\s+selection\b/,
  /\brouting\s+(decision|demo|overview)\b/,
  /\barchitecture\s+overview\b/,
  /\b(showcase|show|explain)\b.*\b(router|routing|tier)/,
];

const SIMPLE_KEYWORDS = [
  "summarize",
  "summary",
  "rewrite",
  "rephrase",
  "extract",
  "classify",
  "format",
  "convert",
  "translate",
  "list",
  "bullet",
];

const HIGH_RISK_KEYWORDS = [
  "production",
  "security",
  "auth",
  "payment",
  "delete",
  "migration",
  "deploy",
  "credential",
  "secret",
  "vulnerability",
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isSimpleUiTask(lower: string): boolean {
  return SIMPLE_UI_PATTERNS.some((p) => p.test(lower));
}

function isDemoShowcaseTask(lower: string): boolean {
  if (SYSTEM_ARCHITECTURE_SIGNALS.some((p) => p.test(lower))) return false;
  if (isSimpleUiTask(lower)) return true;
  return DEMO_SHOWCASE_PATTERNS.some((p) => p.test(lower));
}

function isTrivialCodeTask(lower: string): boolean {
  return isSimpleUiTask(lower) || isDemoShowcaseTask(lower);
}

function isArchitectureTask(lower: string): boolean {
  if (isTrivialCodeTask(lower)) return false;
  if (/\b(system\s+)?architecture\b/.test(lower)) return true;
  if (ARCHITECTURE_KEYWORDS.some((k) => lower.includes(k))) return true;
  if (/\bdesign\s+(pattern|document|review|system)\b/.test(lower)) return true;
  if (/\bdesign\b/.test(lower) && !/\b(html|landing|demo|ui|web|page|css)\b/.test(lower)) {
    return true;
  }
  return false;
}

function detectTaskType(prompt: string, hints?: TaskHints): TaskType {
  if (hints?.type) return hints.type;

  const lower = prompt.toLowerCase();

  if (isTrivialCodeTask(lower)) return "code_edit";
  if (isArchitectureTask(lower)) return "architecture";
  if (/\b(debug|fix bug|troubleshoot)\b/.test(lower)) return "debugging";
  if (/\b(refactor)\b/.test(lower)) return "refactoring";
  if (/\b(implement|add feature|write.*function|code edit)\b/.test(lower)) return "code_edit";
  if (/\b(summarize|summary|tl;dr)\b/.test(lower)) return "summarization";
  if (/\b(rewrite|rephrase|paraphrase)\b/.test(lower)) return "rewriting";
  if (/\b(extract|parse|pull out)\b/.test(lower)) return "extraction";
  if (/\b(classify|categorize|label)\b/.test(lower)) return "classification";
  if (/\b((re)?format|markdown|yaml|json schema|csv)\b/.test(lower)) return "formatting";
  if (isHarnessMetaAsk(prompt)) return "simple_answer";
  if (SIMPLE_KEYWORDS.some((k) => hasKeyword(lower, k))) return "simple_answer";
  if (CODE_KEYWORDS.some((k) => hasKeyword(lower, k))) return "code_edit";

  return "unknown";
}

function detectDifficulty(
  prompt: string,
  taskType: TaskType,
  contextTokens: number,
  hints?: TaskHints
): TaskDifficulty {
  if (hints?.quality === "best") return "hard";
  if (hints?.quality === "fast") return "easy";

  const lower = prompt.toLowerCase();
  const wordCount = prompt.split(/\s+/).length;

  if (
    taskType === "architecture" ||
    taskType === "multi_step" ||
    contextTokens > 32000 ||
    /\b(multi-?step|complex|comprehensive|entire codebase)\b/.test(lower)
  ) {
    return "hard";
  }

  if (
    taskType === "debugging" ||
    taskType === "refactoring" ||
    (taskType === "code_edit" && !isTrivialCodeTask(lower)) ||
    wordCount > 120 ||
    contextTokens > 8000
  ) {
    return "medium";
  }

  if (
    taskType === "summarization" ||
    taskType === "rewriting" ||
    taskType === "extraction" ||
    taskType === "classification" ||
    taskType === "formatting" ||
    taskType === "simple_answer" ||
    (taskType === "code_edit" && isTrivialCodeTask(lower)) ||
    wordCount < 40
  ) {
    return "easy";
  }

  return "medium";
}

function detectRisk(prompt: string, hints?: TaskHints): RiskLevel {
  if (hints?.risk) return hints.risk;

  const lower = prompt.toLowerCase();
  if (HIGH_RISK_KEYWORDS.some((k) => hasKeyword(lower, k))) return "high";
  if (CODE_KEYWORDS.some((k) => hasKeyword(lower, k))) return "medium";
  return "low";
}

export function analyzeTask(input: TaskAnalysisInput): TaskAnalysis {
  const signals: string[] = [];
  const userPrompt = input.userPrompt ?? "";
  const systemPrompt = input.systemPrompt ?? "";
  // Difficulty/task type should follow the *user's ask*, not the tool catalog size.
  // Harnesses like Claude Code attach 50–100 tools on every turn (including "hi").
  const combined = `${systemPrompt}\n${userPrompt}`;
  const promptTokens = estimateTokens(combined);

  const toolCount = Array.isArray(input.tools) ? input.tools.length : 0;
  const toolCatalogTokens =
    toolCount > 0
      ? estimateTokens(JSON.stringify(input.tools).slice(0, 400_000))
      : 0;
  const contextTokens = input.contextSizeTokens ?? promptTokens;
  const requestTokens = promptTokens + toolCatalogTokens;
  const taskType = detectTaskType(userPrompt, input.taskHints);
  signals.push(`taskType=${taskType}`);

  const toolsAvailable = toolCount > 0;
  if (toolsAvailable) signals.push(`tools_available=${toolCount}`);
  if (toolCount >= 20) signals.push(`large_tool_catalog=${toolCount}`);

  // Tools *present* ≠ tools *needed*. Claude Code always sends its catalog.
  const toolNeedScore = computeToolNeedScore({
    userPrompt,
    taskType,
    toolsAvailable,
    recentToolTurns: input.recentToolTurns ?? 0,
    hintRequiresTools: input.taskHints?.requiresTools,
  });
  const threshold = input.toolNeedThreshold ?? 0.55;
  const requiresToolUse =
    input.taskHints?.requiresTools ?? toolNeedScore >= threshold;
  signals.push(`toolNeedScore=${toolNeedScore.toFixed(2)}`);
  if (requiresToolUse) signals.push("tools_needed");
  else if (toolsAvailable) signals.push("tools_omittable");
  if ((input.recentToolTurns ?? 0) > 0) {
    signals.push(`recent_tool_turns=${input.recentToolTurns}`);
  }

  const requiresStructuredOutput =
    input.taskHints?.requiresStructuredOutput ??
    Boolean(input.responseSchema);
  if (requiresStructuredOutput) signals.push("structured_output");

  // Long-context for *routing*: prompt size, or tool catalog only when tools are needed.
  const requiresLongContext =
    input.taskHints?.requiresLongContext ??
    (contextTokens > 32_000 || (requiresToolUse && requestTokens > 32_000));
  if (requiresLongContext) signals.push("long_context");

  const requiresCodeReasoning =
    input.taskHints?.requiresCodeReasoning ??
    ([
      "debugging",
      "refactoring",
      "architecture",
      "multi_step",
    ].includes(taskType) ||
      (taskType === "code_edit" && !isTrivialCodeTask(userPrompt.toLowerCase())));
  if (requiresCodeReasoning) signals.push("code_reasoning");

  const difficulty = detectDifficulty(
    userPrompt,
    taskType,
    contextTokens,
    input.taskHints
  );
  signals.push(`difficulty=${difficulty}`);

  const riskLevel = detectRisk(userPrompt, input.taskHints);
  signals.push(`risk=${riskLevel}`);

  let confidence = 0.75;
  if (taskType === "unknown") confidence -= 0.2;
  if (input.taskHints?.type) confidence += 0.1;
  if (input.taskHints?.quality === "best") confidence += 0.05;
  confidence = Math.max(0.1, Math.min(1, confidence));

  return {
    taskType,
    difficulty,
    riskLevel,
    requiresToolUse,
    toolNeedScore,
    requiresCodeReasoning,
    requiresLongContext,
    requiresStructuredOutput,
    confidence,
    signals,
  };
}

const DEFAULT_TOOL_NEED_THRESHOLD = 0.6;

export function computeToolNeedScore(opts: {
  userPrompt: string;
  taskType: TaskType;
  toolsAvailable: boolean;
  recentToolTurns?: number;
  hintRequiresTools?: boolean;
}): number {
  if (opts.hintRequiresTools === true) return 1;
  if (opts.hintRequiresTools === false) return 0;
  if (!opts.toolsAvailable) return 0;

  const ask = opts.userPrompt;
  const recent = opts.recentToolTurns ?? 0;

  // Resume / recap / soft pings — never need tools.
  if (isHarnessMetaAsk(ask) && !isTrivialChitchat(ask)) return 0;

  if (isTrivialChitchat(ask)) {
    const t = ask.trim().toLowerCase().replace(/[!?.…]+$/g, "").trim();
    // Mid-agent bare acks may continue a tool loop; other pings never need tools.
    const midSessionAck = /^(ok|okay|k|yes|yep|nope|cool|great)$/i.test(t);
    if (!midSessionAck || recent === 0) return 0;
  }

  // Evidence-based scoring — task type alone must not clear the threshold.
  let score = 0;
  const strong = hasStrongToolEvidence(ask);
  const weakVerb = !strong && TOOL_ACTION_RE.test(ask);
  const hasTarget = TOOL_TARGET_RE.test(ask) || CODE_FENCE_RE.test(ask);

  if (strong) score += 0.55;
  else if (weakVerb) score += 0.2;
  if (hasTarget) score += 0.15;

  // Task type is a mild hint only when paired with some verb/target evidence.
  if (TOOL_TASK_TYPES.includes(opts.taskType) && (strong || weakVerb || hasTarget)) {
    score += 0.15;
  }

  // Mid-agent session: short continuations keep tools on.
  if (recent > 0) {
    score += Math.min(0.35, 0.15 + recent * 0.04);
    if (ask.trim().length <= 40 && (strong || midSessionContinuation(ask))) {
      score = Math.max(score, 0.65);
    }
  }

  return Math.max(0, Math.min(1, score));
}

function midSessionContinuation(ask: string): boolean {
  const t = ask.trim().toLowerCase().replace(/[!?.…]+$/g, "").trim();
  return /^(ok|okay|k|yes|yep|continue|go on|keep going|next|proceed)\b/.test(t);
}

/** Count tool_use / tool_result activity in the last `window` messages. */
export function countRecentToolTurns(
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>,
  window = 12
): number {
  const slice = messages.slice(-window);
  let count = 0;
  for (const m of slice) {
    if (m.role === "assistant") {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        count++;
        continue;
      }
      if (Array.isArray(m.content)) {
        if (m.content.some((b) => (b as { type?: string }).type === "tool_use")) {
          count++;
        }
      }
    } else if (m.role === "user" || m.role === "tool") {
      if (m.role === "tool") {
        count++;
        continue;
      }
      if (Array.isArray(m.content)) {
        if (m.content.some((b) => (b as { type?: string }).type === "tool_result")) {
          count++;
        }
      }
    }
  }
  return count;
}

export { DEFAULT_TOOL_NEED_THRESHOLD };

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Latest user turn only — better for Claude Code / multi-turn harness routing. */
export function extractLatestUserPrompt(
  messages: { role: string; content: string }[]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return m.content ?? "";
  }
  return "";
}

export function extractUserPrompt(messages: { role: string; content: string }[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  return userMessages.map((m) => m.content).join("\n");
}

export function extractSystemPrompt(messages: { role: string; content: string }[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}
