/**
 * Sanitize Anthropic Messages SSE from LiteLLM / non-Anthropic backends
 * so Claude Code can consume tool_use streams reliably.
 *
 * GLM via LiteLLM commonly emits:
 * - unsigned `thinking` blocks (internal monologue — drop, don't show)
 * - chat-template tokens like `<|assistant|>` / `<|user|>` leaked into text
 * - duplicate `message_start` / `content_block_stop` frames
 * - `provider_specific_fields` on tool_use blocks
 * - tool_use with no preceding text (Claude Code wants visible output)
 * - empty end_turn messages that look like aborts
 */
import type { AnthropicSseEvent } from "../provider/anthropic-messages.js";
import type { AnthropicMessage } from "./anthropic-openai.js";

const DROP_BLOCK_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "reasoning",
]);

export const MUST_USE_TOOLS_HINT =
  "You have tools available. When the user asks you to inspect files/the repo, " +
  "continue prior tool work, or check whether something was done, you MUST call " +
  "tools via tool_use blocks. Do not only narrate what you plan to do in plain text.";

export type SanitizeAnthropicSseState = {
  indexMap: Map<number, number | null>;
  nextClientIndex: number;
  sawMessageStart: boolean;
  lastStopKey: string | null;
  toolNames: string[];
  emittedVisible: boolean;
  /** Prefixed a short "Working…" text before the first tool_use. */
  injectedWorkingText: boolean;
};

export function createSanitizeAnthropicSseState(): SanitizeAnthropicSseState {
  return {
    indexMap: new Map(),
    nextClientIndex: 0,
    sawMessageStart: false,
    lastStopKey: null,
    toolNames: [],
    emittedVisible: false,
    injectedWorkingText: false,
  };
}

function frame(event: string, data: unknown): AnthropicSseEvent {
  return {
    event,
    data,
    raw: `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  };
}

function asRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : null;
}

export function scrubModelText(text: string): string {
  return text
    .replace(/<\|[^|>]*\|>/g, "")
    .replace(/<\/?s>/gi, "")
    .replace(/\[(?:\/?)(?:INST|SYS)\]/gi, "")
    .replace(
      /\[Your previous response had no visible output\.[^\]]*\]/gi,
      ""
    )
    .replace(/\n{3,}/g, "\n\n");
}

export function scrubAnthropicMessages(
  messages: AnthropicMessage[]
): AnthropicMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { ...m, content: scrubModelText(m.content) };
    }
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          return { ...b, text: scrubModelText(b.text) };
        }
        if (
          (b.type === "thinking" || b.type === "reasoning") &&
          typeof b.thinking === "string"
        ) {
          return { ...b, thinking: scrubModelText(b.thinking) };
        }
        return block;
      }) as AnthropicMessage["content"],
    };
  });
}

function workingTextEvents(
  state: SanitizeAnthropicSseState
): AnthropicSseEvent[] {
  if (state.emittedVisible || state.injectedWorkingText) return [];
  const idx = state.nextClientIndex++;
  state.injectedWorkingText = true;
  state.emittedVisible = true;
  return [
    frame("content_block_start", {
      type: "content_block_start",
      index: idx,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "text_delta", text: "Working on it…" },
    }),
    frame("content_block_stop", {
      type: "content_block_stop",
      index: idx,
    }),
  ];
}

function fallbackTextEvents(
  state: SanitizeAnthropicSseState,
  text: string
): AnthropicSseEvent[] {
  const idx = state.nextClientIndex++;
  state.emittedVisible = true;
  return [
    frame("content_block_start", {
      type: "content_block_start",
      index: idx,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "text_delta", text },
    }),
    frame("content_block_stop", {
      type: "content_block_stop",
      index: idx,
    }),
  ];
}

/**
 * Transform one upstream SSE event. Returns 0..n client events.
 */
export function sanitizeAnthropicSseEvent(
  state: SanitizeAnthropicSseState,
  ev: AnthropicSseEvent
): AnthropicSseEvent[] {
  const data = asRecord(ev.data);

  if (ev.event === "message_start") {
    if (state.sawMessageStart) return [];
    state.sawMessageStart = true;
    return [ev];
  }

  if (ev.event === "content_block_start" && data) {
    const index = typeof data.index === "number" ? data.index : 0;
    const block = asRecord(data.content_block);
    const blockType = typeof block?.type === "string" ? block.type : "";

    // Drop unsigned thinking / reasoning — it's internal monologue, not UX text.
    if (DROP_BLOCK_TYPES.has(blockType)) {
      state.indexMap.set(index, null);
      return [];
    }

    const out: AnthropicSseEvent[] = [];
    let contentBlock: Record<string, unknown> = block ? { ...block } : {};

    if (contentBlock.type === "tool_use") {
      out.push(...workingTextEvents(state));
      const name =
        typeof contentBlock.name === "string" ? contentBlock.name : "";
      if (name) state.toolNames.push(name);
      state.emittedVisible = true;
      delete contentBlock.provider_specific_fields;
      if (typeof contentBlock.id === "string") {
        contentBlock.id = sanitizeToolUseId(contentBlock.id);
      }
      if (contentBlock.input == null) contentBlock.input = {};
    } else if (
      contentBlock.type === "text" &&
      typeof contentBlock.text === "string"
    ) {
      contentBlock = {
        ...contentBlock,
        text: scrubModelText(contentBlock.text),
      };
      if (contentBlock.text) state.emittedVisible = true;
    }

    const clientIndex = state.nextClientIndex++;
    state.indexMap.set(index, clientIndex);
    out.push(
      frame("content_block_start", {
        type: "content_block_start",
        index: clientIndex,
        content_block: contentBlock,
      })
    );
    return out;
  }

  if (ev.event === "content_block_delta" && data) {
    const index = typeof data.index === "number" ? data.index : 0;
    if (!state.indexMap.has(index)) return [ev];
    const clientIndex = state.indexMap.get(index);
    if (clientIndex == null) return [];

    const delta = asRecord(data.delta) ?? {};
    if (
      delta.type === "thinking_delta" ||
      delta.type === "reasoning_delta" ||
      DROP_BLOCK_TYPES.has(String(delta.type ?? "").replace(/_delta$/, ""))
    ) {
      return [];
    }

    let nextDelta: Record<string, unknown> = { ...delta };
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const scrubbed = scrubModelText(delta.text);
      if (!scrubbed) return [];
      nextDelta = { type: "text_delta", text: scrubbed };
      state.emittedVisible = true;
    }

    return [
      frame("content_block_delta", {
        type: "content_block_delta",
        index: clientIndex,
        delta: nextDelta,
      }),
    ];
  }

  if (ev.event === "content_block_stop" && data) {
    const index = typeof data.index === "number" ? data.index : 0;
    if (!state.indexMap.has(index)) return [ev];
    const clientIndex = state.indexMap.get(index);
    if (clientIndex == null) return [];

    const stopKey = `stop:${clientIndex}`;
    if (state.lastStopKey === stopKey) return [];
    state.lastStopKey = stopKey;

    return [
      frame("content_block_stop", {
        type: "content_block_stop",
        index: clientIndex,
      }),
    ];
  }

  if (ev.event === "message_delta" && data) {
    const stop = (data.delta as { stop_reason?: string } | undefined)
      ?.stop_reason;
    const out: AnthropicSseEvent[] = [];

    // Narrated "I'll read the file" with end_turn and no tools — replace with
    // a clear recovery message instead of leaving Claude Code hanging.
    if (
      (stop === "end_turn" || stop == null) &&
      state.toolNames.length === 0 &&
      !state.emittedVisible
    ) {
      out.push(
        ...fallbackTextEvents(
          state,
          "I wasn't able to call tools that turn. Please ask again — e.g. \"read the README in ~/projects/maestro-ai\"."
        )
      );
    }
    out.push(ev);
    return out;
  }

  if (ev.event !== "ping") {
    state.lastStopKey = null;
  }

  return [ev];
}

export function sanitizeToolUseId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || `toolu_${Date.now().toString(36)}`;
}

export function sanitizeAnthropicMessageContent(
  content: unknown
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    if (typeof content === "string") {
      const text = scrubModelText(content);
      return text ? [{ type: "text", text }] : [];
    }
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  let hasTool = false;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = { ...(raw as Record<string, unknown>) };
    const type = String(block.type ?? "");
    if (DROP_BLOCK_TYPES.has(type)) continue;
    if (type === "text" && typeof block.text === "string") {
      const text = scrubModelText(block.text);
      if (text) out.push({ ...block, text });
      continue;
    }
    if (type === "tool_use") {
      hasTool = true;
      delete block.provider_specific_fields;
      if (typeof block.id === "string") block.id = sanitizeToolUseId(block.id);
      if (block.input == null) block.input = {};
    }
    out.push(block);
  }
  if (hasTool && !out.some((b) => b.type === "text")) {
    out.unshift({ type: "text", text: "Working on it…" });
  }
  if (out.length === 0) {
    out.push({
      type: "text",
      text: "I wasn't able to call tools that turn. Please ask again with a specific file or path.",
    });
  }
  return out;
}
