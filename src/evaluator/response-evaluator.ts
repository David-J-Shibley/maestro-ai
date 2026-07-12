import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationCheck, EvaluationResult, EvaluatorContext } from "../types.js";
import {
  extractCompletionFromRaw,
  hasMeaningfulContent,
  stripInvisibleAndControl,
} from "../provider/content-extract.js";

const REFUSAL_PATTERNS = [
  /\bi cannot\b/i,
  /\bi can't\b/i,
  /\bi'm unable\b/i,
  /\bi am unable\b/i,
  /\bas an ai\b/i,
  /\bnot able to help\b/i,
  /\bagainst my guidelines\b/i,
];

export function evaluateResponse(
  content: string,
  context: EvaluatorContext = {}
): EvaluationResult {
  const checks: EvaluationCheck[] = [];

  const nonEmpty = checkNonEmpty(content);
  checks.push(nonEmpty);

  const contentIntegrity = checkContentIntegrity(content, context);
  if (contentIntegrity) checks.push(contentIntegrity);

  const refusal = checkRefusal(content, context.taskAllowed ?? true);
  checks.push(refusal);

  let jsonCheck: EvaluationCheck | null = null;
  if (context.responseSchema || context.expectedFormat === "json") {
    jsonCheck = checkValidJson(content);
    checks.push(jsonCheck);
  }

  const formatCheck = checkFormat(content, context.expectedFormat);
  if (formatCheck) checks.push(formatCheck);

  const filesCheck = checkRequiredFiles(context);
  if (filesCheck) checks.push(filesCheck);

  const toolCheck = checkToolCalls(context);
  if (toolCheck) checks.push(toolCheck);

  const pass = checks.every((c) => c.pass);

  const retryRecommended =
    !pass &&
    refusal.pass &&
    (!nonEmpty.pass ||
      (contentIntegrity?.pass === false) ||
      (jsonCheck !== null && !jsonCheck.pass));

  const escalationRecommended =
    !pass &&
    (refusal.pass === false ||
      !nonEmpty.pass ||
      contentIntegrity?.pass === false ||
      (jsonCheck?.pass === false && hasMeaningfulContent(content)) ||
      isLowConfidenceOutput(content) ||
      (toolCheck?.pass === false));

  const failed = checks.filter((c) => !c.pass);
  const reason = pass
    ? "All checks passed"
    : failed.map((c) => c.reason ?? c.name).join("; ");

  return {
    pass,
    reason,
    retryRecommended,
    escalationRecommended,
    checks,
  };
}

export async function evaluateResponseAsync(
  content: string,
  context: EvaluatorContext = {}
): Promise<EvaluationResult> {
  const base = evaluateResponse(content, context);
  const checks = [...base.checks];

  if (context.runTests) {
    try {
      const ok = await context.runTests();
      checks.push({
        name: "tests_pass",
        pass: ok,
        reason: ok ? undefined : "Tests failed",
      });
    } catch (err) {
      checks.push({
        name: "tests_pass",
        pass: false,
        reason: err instanceof Error ? err.message : "Test runner error",
      });
    }
  }

  if (context.runBuild) {
    try {
      const ok = await context.runBuild();
      checks.push({
        name: "build_pass",
        pass: ok,
        reason: ok ? undefined : "Build failed",
      });
    } catch (err) {
      checks.push({
        name: "build_pass",
        pass: false,
        reason: err instanceof Error ? err.message : "Build error",
      });
    }
  }

  const pass = checks.every((c) => c.pass);
  const failed = checks.filter((c) => !c.pass);

  return {
    ...base,
    pass,
    checks,
    reason: pass
      ? "All checks passed"
      : failed.map((c) => c.reason ?? c.name).join("; "),
  };
}

function checkNonEmpty(content: string): EvaluationCheck {
  const pass = hasMeaningfulContent(content);
  return {
    name: "non_empty",
    pass,
    reason: pass ? undefined : "Empty or whitespace-only output",
  };
}

function checkContentIntegrity(
  content: string,
  context: EvaluatorContext
): EvaluationCheck | null {
  if (!context.rawResponse) return null;

  const extracted = extractCompletionFromRaw(
    context.rawResponse as Parameters<typeof extractCompletionFromRaw>[0]
  );

  const meaningful = hasMeaningfulContent(content);
  const tokens = extracted.completionTokens ?? 0;

  if (!meaningful && tokens > 0 && !extracted.hadToolCalls) {
    return {
      name: "content_integrity",
      pass: false,
      reason: `Model reported ${tokens} completion tokens but no visible text (possible truncated or alternate response field)`,
    };
  }

  if (!meaningful && extracted.finishReason === "length") {
    return {
      name: "content_integrity",
      pass: false,
      reason: "Response truncated (finish_reason=length) with no usable content",
    };
  }

  const stripped = stripInvisibleAndControl(content);
  if (content.length > 0 && stripped.length === 0) {
    return {
      name: "content_integrity",
      pass: false,
      reason: "Response contains only invisible or control characters",
    };
  }

  return { name: "content_integrity", pass: true };
}

function checkRefusal(content: string, taskAllowed: boolean): EvaluationCheck {
  if (!taskAllowed) {
    return { name: "no_refusal", pass: true };
  }
  const refused = REFUSAL_PATTERNS.some((p) => p.test(content));
  return {
    name: "no_refusal",
    pass: !refused,
    reason: refused ? "Model appears to have refused the task" : undefined,
  };
}

function checkValidJson(content: string): EvaluationCheck {
  const trimmed = content.trim();
  const candidate = extractJsonCandidate(trimmed);

  try {
    JSON.parse(candidate);
    return { name: "valid_json", pass: true };
  } catch {
    return {
      name: "valid_json",
      pass: false,
      reason: "Response is not valid JSON",
    };
  }
}

function extractJsonCandidate(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) return text.slice(arrStart, arrEnd + 1);

  return text;
}

function checkFormat(
  content: string,
  format?: EvaluatorContext["expectedFormat"]
): EvaluationCheck | null {
  if (!format || format === "text") return null;

  if (format === "json") {
    return checkValidJson(content);
  }

  if (format === "markdown") {
    const hasMd = /[#*`\-]|\n\n/.test(content);
    return {
      name: "markdown_format",
      pass: hasMd || content.length > 20,
      reason: hasMd ? undefined : "Expected markdown-like formatting",
    };
  }

  return null;
}

function checkRequiredFiles(context: EvaluatorContext): EvaluationCheck | null {
  if (!context.requiredFilePaths?.length || !context.workspaceRoot) return null;

  const missing = context.requiredFilePaths.filter((rel) => {
    const full = join(context.workspaceRoot!, rel);
    return !existsSync(full);
  });

  if (missing.length === 0) {
    const modified = context.requiredFilePaths.some((rel) => {
      const full = join(context.workspaceRoot!, rel);
      try {
        const stat = readFileSync(full);
        return stat.length > 0;
      } catch {
        return false;
      }
    });
    return {
      name: "required_files",
      pass: modified,
      reason: modified ? undefined : "Required files exist but appear empty",
    };
  }

  return {
    name: "required_files",
    pass: false,
    reason: `Missing files: ${missing.join(", ")}`,
  };
}

function isLowConfidenceOutput(content: string): boolean {
  const visible = stripInvisibleAndControl(content);
  const lower = visible.toLowerCase();
  return (
    visible.length < 20 ||
    /\bi('m| am) not sure\b/.test(lower) ||
    /\bunable to determine\b/.test(lower) ||
    /\bpartial\b/.test(lower)
  );
}

function checkToolCalls(context: EvaluatorContext): EvaluationCheck | null {
  if (!context.tools?.length || !context.rawResponse) return null;

  const raw = context.rawResponse as {
    choices?: Array<{
      message?: { tool_calls?: unknown[]; content?: string | null };
      finish_reason?: string;
    }>;
  };

  const choice = raw.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;
  const finishReason = choice?.finish_reason;

  if (finishReason === "tool_calls" && (!toolCalls || toolCalls.length === 0)) {
    return {
      name: "tool_calls_valid",
      pass: false,
      reason: "finish_reason=tool_calls but no tool_calls in response",
    };
  }

  if (toolCalls?.length) {
    const invalid = toolCalls.some((tc) => {
      const call = tc as { function?: { name?: string; arguments?: string } };
      if (!call.function?.name) return true;
      if (call.function.arguments) {
        try {
          JSON.parse(call.function.arguments);
        } catch {
          return true;
        }
      }
      return false;
    });
    if (invalid) {
      return {
        name: "tool_calls_valid",
        pass: false,
        reason: "Tool call missing name or has invalid JSON arguments",
      };
    }
  }

  return { name: "tool_calls_valid", pass: true };
}
