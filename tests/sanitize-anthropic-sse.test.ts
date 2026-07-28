import { describe, expect, it } from "vitest";
import {
  createSanitizeAnthropicSseState,
  sanitizeAnthropicMessageContent,
  sanitizeAnthropicSseEvent,
  sanitizeToolUseId,
  scrubAnthropicMessages,
  scrubModelText,
} from "../src/proxy/sanitize-anthropic-sse.js";
import type { AnthropicSseEvent } from "../src/provider/anthropic-messages.js";

function ev(event: string, data: unknown): AnthropicSseEvent {
  return { event, data, raw: "" };
}

describe("sanitizeAnthropicSse", () => {
  it("drops thinking, injects Working text before tool_use, remaps indices", () => {
    const state = createSanitizeAnthropicSseState();
    const out: AnthropicSseEvent[] = [];
    const upstream = [
      ev("message_start", {
        type: "message_start",
        message: { id: "msg_1", model: "glm", content: [] },
      }),
      ev("message_start", {
        type: "message_start",
        message: { id: "msg_1", model: "glm", content: [] },
      }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "The user is getting frustrated.",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-123-abc",
          name: "Bash",
          input: {},
          provider_specific_fields: null,
        },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }),
      ev("message_stop", { type: "message_stop" }),
    ];

    for (const e of upstream) {
      out.push(...sanitizeAnthropicSseEvent(state, e));
    }

    expect(out.filter((e) => e.event === "message_start")).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("frustrated");
    expect(JSON.stringify(out)).not.toContain('"thinking"');

    const text = out.find(
      (e) =>
        e.event === "content_block_delta" &&
        JSON.stringify(e.data).includes("Working on it")
    );
    expect(text).toBeTruthy();
    expect(state.toolNames).toEqual(["Bash"]);
  });

  it("injects fallback text on empty end_turn", () => {
    const state = createSanitizeAnthropicSseState();
    const out: AnthropicSseEvent[] = [];
    for (const e of [
      ev("message_start", {
        type: "message_start",
        message: { id: "msg_1", model: "glm", content: [] },
      }),
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }),
      ev("message_stop", { type: "message_stop" }),
    ]) {
      out.push(...sanitizeAnthropicSseEvent(state, e));
    }
    expect(state.emittedVisible).toBe(true);
    expect(JSON.stringify(out)).toContain("wasn't able to call tools");
  });

  it("scrubs leaked chat-template tokens from text", () => {
    expect(
      scrubModelText(
        "<|assistant|>Let me read the README.<|user|>look in the repo"
      )
    ).toBe("Let me read the README.look in the repo");
  });

  it("scrubs tokens from conversation history", () => {
    const cleaned = scrubAnthropicMessages([
      {
        role: "assistant",
        content: "<|assistant|>Hello<|user|>there",
      },
    ]);
    expect(cleaned[0]!.content).toBe("Hellothere");
  });

  it("sanitizes tool ids to Anthropic-safe charset", () => {
    expect(sanitizeToolUseId("call:1.2")).toBe("call_1_2");
  });

  it("drops thinking from non-stream content and prefixes Working for tools", () => {
    const cleaned = sanitizeAnthropicMessageContent([
      { type: "thinking", thinking: "The user is frustrated" },
      {
        type: "tool_use",
        id: "call-1",
        name: "Read",
        input: { path: "a.ts" },
        provider_specific_fields: null,
      },
    ]);
    expect(cleaned[0]).toEqual({ type: "text", text: "Working on it…" });
    expect(cleaned[1]).toMatchObject({ type: "tool_use", name: "Read" });
    expect(JSON.stringify(cleaned)).not.toContain("frustrated");
  });
});
