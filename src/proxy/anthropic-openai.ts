/**
 * Anthropic Messages ↔ OpenAI Chat Completions conversion for the proxy.
 */
import type { ChatMessage, ChatMessageToolCall } from "../types.js";
import { isTrivialChitchat } from "../analyzer/task-analyzer.js";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export type AnthropicMessage = {
  role: "user" | "assistant" | "system" | string;
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [k: string]: unknown;
};

/**
 * Bedrock/Anthropic reject role:"system" inside messages[].
 * Lift those into the top-level `system` parameter.
 */
export function normalizeAnthropicSystem(
  messages: AnthropicMessage[],
  system?: unknown
): { messages: AnthropicMessage[]; system?: unknown } {
  const systemParts: unknown[] = [];
  if (system != null && system !== "") {
    if (Array.isArray(system)) systemParts.push(...system);
    else systemParts.push(system);
  }

  const cleaned: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m?.role === "system") {
      if (m.content != null && m.content !== "") systemParts.push(m.content);
      continue;
    }
    cleaned.push(m);
  }

  let mergedSystem: unknown = undefined;
  if (systemParts.length === 1) {
    mergedSystem = systemParts[0];
  } else if (systemParts.length > 1) {
    // Prefer Anthropic content-block arrays when merging heterogeneous system parts.
    const blocks: AnthropicContentBlock[] = [];
    for (const part of systemParts) {
      if (typeof part === "string") {
        if (part) blocks.push({ type: "text", text: part });
      } else if (Array.isArray(part)) {
        for (const b of part) {
          if (b && typeof b === "object") blocks.push(b as AnthropicContentBlock);
        }
      } else if (part && typeof part === "object") {
        blocks.push(part as AnthropicContentBlock);
      }
    }
    mergedSystem = blocks.length > 0 ? blocks : systemParts.map(String).join("\n\n");
  }

  return {
    messages: cleaned,
    ...(mergedSystem != null && mergedSystem !== "" ? { system: mergedSystem } : {}),
  };
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as AnthropicContentBlock;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool_result") {
      parts.push(contentToText(b.content));
    } else {
      const maybe = b as { content?: unknown; text?: unknown };
      if (typeof maybe.text === "string") parts.push(maybe.text);
      else if (typeof maybe.content === "string") parts.push(maybe.content);
      else if (maybe.content != null) parts.push(contentToText(maybe.content));
    }
  }
  return parts.join("\n");
}

/** Convert Anthropic tool defs to OpenAI function tools. */
export function anthropicToolsToOpenAi(tools: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((raw) => {
    const t = (raw ?? {}) as AnthropicTool;
    if (t && typeof t === "object" && (t as { type?: string }).type === "function") {
      return t; // already OpenAI-shaped
    }
    const name = typeof t.name === "string" ? t.name : "tool";
    const description = typeof t.description === "string" ? t.description : undefined;
    const parameters =
      t.input_schema && typeof t.input_schema === "object"
        ? t.input_schema
        : { type: "object", properties: {} };
    return {
      type: "function",
      function: {
        name,
        ...(description ? { description } : {}),
        parameters,
      },
    };
  });
}

/**
 * Latest *human* ask from Anthropic messages.
 * Skips tool_result-only turns and Claude Code `<system-reminder>` text blocks
 * so routing sees "hi" instead of a 10k reminder blob.
 */
export function extractLatestAnthropicUserAsk(
  messages: AnthropicMessage[]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;

    if (typeof m.content === "string") {
      const ask = stripHarnessNoise(m.content);
      if (ask) return ask;
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const toolResults = m.content.filter((b) => b.type === "tool_result");
    const textBlocks = m.content.filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof (b as { text?: unknown }).text === "string"
    );
    // Pure tool_result turns — keep scanning for the real human message.
    if (toolResults.length > 0 && textBlocks.length === 0) continue;

    for (const block of textBlocks) {
      const ask = stripHarnessNoise(block.text);
      if (ask) return ask;
    }
  }
  return "";
}

function stripHarnessNoise(text: string): string {
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system>[\s\S]*?<\/system>/gi, "")
    .replace(/#\s*System Reminders?\b[\s\S]*/i, "")
    .trim();
  return stripped;
}

export const PLAIN_TEXT_ONLY_HINT =
  "Reply in plain natural language only. Do not call tools, do not emit tool-call JSON, " +
  "and do not write files. Just answer the user directly.";

export const PLAIN_TEXT_RETRY_HINT =
  "Your previous reply was invalid tool-call JSON. Reply in 1–2 sentences of plain English only. " +
  "Do not emit JSON, do not call tools, do not write files.";

/**
 * Collapse tool_use / tool_result history into short text so local models
 * don't imitate tool JSON when tools were intentionally omitted.
 */
export function simplifyAnthropicMessagesForPlainReply(
  messages: AnthropicMessage[]
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (typeof m.content === "string") {
      const text = stripHarnessNoise(m.content);
      if (text) out.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      const texts = m.content
        .filter(
          (b): b is { type: "text"; text: string } =>
            b.type === "text" && typeof (b as { text?: unknown }).text === "string"
        )
        .map((b) => stripHarnessNoise(b.text))
        .filter(Boolean);
      const toolNames = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => String((b as { name?: string }).name ?? "tool"));
      const parts = [...texts];
      if (toolNames.length) parts.push(`(used tools: ${toolNames.join(", ")})`);
      if (parts.length) out.push({ role: "assistant", content: parts.join("\n") });
      continue;
    }

    // user
    const texts = m.content
      .filter(
        (b): b is { type: "text"; text: string } =>
          b.type === "text" && typeof (b as { text?: unknown }).text === "string"
      )
      .map((b) => stripHarnessNoise(b.text))
      .filter(Boolean);
    const toolResults = m.content.filter((b) => b.type === "tool_result");
    const parts = [...texts];
    if (toolResults.length) {
      const preview = toolResults
        .slice(0, 3)
        .map((b) => contentToText((b as { content?: unknown }).content ?? ""))
        .map((t) => (t.length > 200 ? `${t.slice(0, 200)}…` : t))
        .filter(Boolean);
      if (preview.length) parts.push(`(tool results: ${preview.join(" | ")})`);
      else parts.push(`(${toolResults.length} tool result(s))`);
    }
    if (parts.length) out.push({ role: "user", content: parts.join("\n") });
  }
  return out;
}

export function mergeAnthropicSystem(system: unknown, extra: string): unknown {
  if (!extra) return system;
  if (system == null || system === "") return extra;
  if (typeof system === "string") return `${system}\n\n${extra}`;
  if (Array.isArray(system)) {
    return [...system, { type: "text", text: extra }];
  }
  return [{ type: "text", text: contentToText(system) }, { type: "text", text: extra }];
}

/** Pull the first balanced `{...}` object out of model text (tolerates trailing junk / missing outer close). */
export function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function looksLikeFakeToolDump(text: string): boolean {
  const s = text.trim();
  return (
    /^\s*\{/.test(s) &&
    /"name"\s*:/.test(s) &&
    (/"parameters"\s*:/.test(s) || /"input"\s*:/.test(s) || /"arguments"\s*:/.test(s))
  );
}

function looksLikeToolMetaJunk(text: string): boolean {
  return (
    /\[\[tool\]\]/i.test(text) ||
    /memory entry for the tool/i.test(text) ||
    /^This is a memory entry/i.test(text.trim())
  );
}

/**
 * Local models often emit fake tool JSON as text, e.g.
 * {"name":"Write","parameters":{"content":"Hello!",...}}
 * Prefer the embedded natural-language content when present.
 * Returns "" when the dump is non-conversational (Memory, meta junk).
 */
export function unwrapFakeToolText(text: string): string {
  const trimmed = text.trim();
  const json = extractBalancedJsonObject(trimmed) ?? (trimmed.startsWith("{") ? trimmed : null);
  if (!json) return text;
  try {
    const parsed = JSON.parse(json) as {
      name?: string;
      parameters?: Record<string, unknown>;
      input?: Record<string, unknown>;
      arguments?: Record<string, unknown> | string;
    };
    if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string") {
      return text;
    }
    // Memory / harness bookkeeping is never a user-facing reply.
    if (/^(Memory|memory)$/i.test(parsed.name)) return "";
    const params =
      parsed.parameters && typeof parsed.parameters === "object"
        ? parsed.parameters
        : parsed.input && typeof parsed.input === "object"
          ? parsed.input
          : typeof parsed.arguments === "object" && parsed.arguments
            ? parsed.arguments
            : typeof parsed.arguments === "string"
              ? (JSON.parse(parsed.arguments) as Record<string, unknown>)
              : null;
    if (!params) return looksLikeFakeToolDump(trimmed) ? "" : text;
    for (const key of ["content", "message", "text", "body"]) {
      const v = params[key];
      if (typeof v === "string" && v.trim()) {
        if (looksLikeToolMetaJunk(v) || looksLikeFakeToolDump(v)) return "";
        return v;
      }
    }
    return looksLikeFakeToolDump(trimmed) ? "" : text;
  } catch {
    return looksLikeFakeToolDump(trimmed) ? "" : text;
  }
}

/** Turn model text into something Claude Code can show as a normal reply. */
export function coercePlainAssistantText(text: string, fallback: string): string {
  let t = unwrapFakeToolText(text.trim());
  if (!t.trim() || looksLikeFakeToolDump(t) || looksLikeToolMetaJunk(t)) {
    return fallback;
  }
  return t;
}

/** True when a plain-reply completion should be retried once before fallback. */
export function needsPlainReplyRetry(rawText: string, fallback: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return true;
  if (looksLikeFakeToolDump(trimmed)) return true;
  const coerced = coercePlainAssistantText(trimmed, fallback);
  // Coerced to empty/meta → fallback path; retry if dump-like or empty.
  return coerced === fallback;
}

export function plainReplyFallback(ask: string): string {
  const a = ask.trim().toLowerCase();
  if (isTrivialChitchat(ask) || /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool)\b/.test(a)) {
    return "Hello! How can I help you today?";
  }
  if (/stepped away|recap|welcome back|session (?:was )?(?:paused|resumed)/i.test(ask)) {
    return "Welcome back — ready when you are.";
  }
  if (/^\[suggestion mode:/i.test(ask.trim())) {
    return "";
  }
  // Never use a generic greeting for real questions — caller should avoid
  // greeting fallbacks outside chitchat/meta, but keep a non-greeting last resort.
  return "I couldn't produce a clean plain-text answer. Please ask again.";
}

export function anthropicToChatMessages(
  messages: AnthropicMessage[],
  system?: unknown
): ChatMessage[] {
  const normalized = normalizeAnthropicSystem(messages, system);
  const out: ChatMessage[] = [];

  if (normalized.system != null && normalized.system !== "") {
    const sys =
      Array.isArray(normalized.system)
        ? contentToText(normalized.system)
        : typeof normalized.system === "string"
          ? normalized.system
          : contentToText(normalized.system);
    if (sys) out.push({ role: "system", content: sys });
  }

  for (const m of normalized.messages) {
    const blocks = Array.isArray(m.content) ? m.content : null;

    if (blocks) {
      const textBlocks = blocks.filter(
        (b): b is { type: "text"; text: string } =>
          b.type === "text" && typeof (b as { text?: unknown }).text === "string"
      );
      const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
      const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");

      if (toolResultBlocks.length > 0) {
        for (const block of toolResultBlocks) {
          const b = block as {
            type: string;
            tool_use_id?: string;
            content?: unknown;
          };
          out.push({
            role: "tool",
            content: contentToText(b.content ?? ""),
            tool_call_id: b.tool_use_id ?? "",
          });
        }
        if (textBlocks.length > 0) {
          out.push({
            role: "user",
            content: textBlocks.map((b) => b.text).join("\n"),
          });
        }
        continue;
      }

      if (toolUseBlocks.length > 0 && m.role === "assistant") {
        const tool_calls: ChatMessageToolCall[] = toolUseBlocks.map((block) => {
          const b = block as {
            type: string;
            id?: string;
            name?: string;
            input?: unknown;
          };
          return {
            id: b.id ?? `tool_${Math.random().toString(36).slice(2, 10)}`,
            type: "function" as const,
            function: {
              name: b.name ?? "",
              arguments: JSON.stringify(b.input ?? {}),
            },
          };
        });
        out.push({
          role: "assistant",
          content: textBlocks.map((b) => b.text).join("\n"),
          tool_calls,
        });
        continue;
      }
    }

    const role = m.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: contentToText(m.content) });
  }

  return out;
}
