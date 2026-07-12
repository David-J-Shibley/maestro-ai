/** Shared content extraction and meaningful-text checks for provider + evaluator. */

export type ChatCompletionChoice = {
  message?: {
    content?: string | null | ContentPart[];
    tool_calls?: unknown[];
    reasoning_content?: string | null;
    reasoning?: string | null;
  };
  text?: string;
  finish_reason?: string;
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: string; text?: string; [key: string]: unknown };

export interface ExtractedCompletion {
  content: string;
  finishReason?: string;
  completionTokens?: number;
  hadToolCalls: boolean;
  sources: string[];
}

export function extractCompletionFromRaw(raw: {
  choices?: ChatCompletionChoice[];
  usage?: { completion_tokens?: number };
}): ExtractedCompletion {
  const choice = raw.choices?.[0];
  const sources: string[] = [];
  let content = "";

  if (choice?.message?.content !== undefined && choice.message.content !== null) {
    const extracted = normalizeMessageContent(choice.message.content);
    if (extracted) {
      content = extracted;
      sources.push("message.content");
    }
  }

  if (!content && typeof choice?.text === "string") {
    content = choice.text;
    sources.push("choice.text");
  }

  if (!content && choice?.message?.reasoning_content) {
    content = choice.message.reasoning_content;
    sources.push("message.reasoning_content");
  }

  if (!content && choice?.message?.reasoning) {
    content = choice.message.reasoning;
    sources.push("message.reasoning");
  }

  const toolCalls = choice?.message?.tool_calls;
  const hadToolCalls = Boolean(toolCalls?.length);

  return {
    content,
    finishReason: choice?.finish_reason,
    completionTokens: raw.usage?.completion_tokens,
    hadToolCalls,
    sources,
  };
}

export function normalizeMessageContent(
  content: string | null | ContentPart[]
): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "object" && part !== null && part.type === "text" && part.text) {
        return part.text;
      }
      if (typeof part === "object" && part !== null && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Strip control chars and zero-width junk; true if user-visible text remains. */
export function hasMeaningfulContent(content: string): boolean {
  const cleaned = stripInvisibleAndControl(content);
  return cleaned.length > 0;
}

export function stripInvisibleAndControl(content: string): string {
  return content
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/g, "")
    .trim();
}

export function describeEmptyResponse(extracted: ExtractedCompletion): string {
  const parts = ["No meaningful content in model response"];
  if (extracted.completionTokens && extracted.completionTokens > 0) {
    parts.push(`completion_tokens=${extracted.completionTokens} (output may be in an unsupported field)`);
  }
  if (extracted.finishReason) {
    parts.push(`finish_reason=${extracted.finishReason}`);
  }
  if (extracted.sources.length) {
    parts.push(`checked: ${extracted.sources.join(", ")}`);
  }
  if (extracted.hadToolCalls) {
    parts.push("response contained tool_calls only");
  }
  return parts.join("; ");
}
