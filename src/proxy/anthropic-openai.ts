/**
 * Anthropic Messages ↔ OpenAI Chat Completions conversion for the proxy.
 */
import type { ChatMessage, ChatMessageToolCall } from "../types.js";

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
 * Convert Anthropic messages to OpenAI chat messages, preserving tool_use / tool_result.
 */
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
