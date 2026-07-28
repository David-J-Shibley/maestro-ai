import { describe, expect, it } from "vitest";
import {
  anthropicToChatMessages,
  anthropicToolsToOpenAi,
  coercePlainAssistantText,
  extractLatestAnthropicUserAsk,
  normalizeAnthropicSystem,
  plainReplyFallback,
  unwrapFakeToolText,
} from "../src/proxy/anthropic-openai.js";

describe("anthropic ↔ openai conversion", () => {
  it("converts Anthropic tools to OpenAI function tools", () => {
    expect(
      anthropicToolsToOpenAi([
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ])
    ).toEqual([
      {
        type: "function",
        function: {
          name: "Read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("preserves tool_use and tool_result across turns", () => {
    const messages = anthropicToChatMessages(
      [
        { role: "user", content: "edit foo.ts" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll write it." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Write",
              input: { path: "foo.ts", content: " consoles " },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "Wrote foo.ts",
            },
          ],
        },
      ],
      "You are helpful."
    );

    expect(messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(messages[1]).toEqual({ role: "user", content: "edit foo.ts" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "I'll write it.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: {
            name: "Write",
            arguments: JSON.stringify({ path: "foo.ts", content: " consoles " }),
          },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      content: "Wrote foo.ts",
      tool_call_id: "toolu_1",
    });
  });

  it("lifts role:system messages into top-level system", () => {
    const { messages, system } = normalizeAnthropicSystem(
      [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hi" },
      ],
      "You are Maestro."
    );
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
    expect(system).toEqual([
      { type: "text", text: "You are Maestro." },
      { type: "text", text: "Be concise." },
    ]);
  });

  it("extracts human ask without Claude Code system-reminders", () => {
    expect(
      extractLatestAnthropicUserAsk([
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            {
              type: "text",
              text: "<system-reminder>\nAlways use tools.\n</system-reminder>",
            },
          ],
        },
      ])
    ).toBe("hi");
  });

  it("unwraps fake Write tool JSON into plain text", () => {
    expect(
      unwrapFakeToolText(
        JSON.stringify({
          name: "Write",
          parameters: {
            content: "Hello! How can I help?",
            file_path: "/tmp/claude_message.txt",
          },
        })
      )
    ).toBe("Hello! How can I help?");
  });

  it("drops Memory fake tool dumps instead of showing them", () => {
    const dump =
      '{"name": "Memory", "parameters": {"content": "[[tool]]\\n\\nThis is a memory entry for the tool that created the message.", "metadata": {"type": "feedback"}}}';
    expect(unwrapFakeToolText(dump)).toBe("");
    expect(coercePlainAssistantText(dump, "Hello! How can I help you today?")).toBe(
      "Hello! How can I help you today?"
    );
  });

  it("coerces incomplete fake tool JSON via balanced extract", () => {
    // Missing final closing brace — still extractable / recognizable as dump
    const dump =
      '{"name": "Memory", "parameters": {"content": "[[tool]]\\n\\nThis is a memory entry for the tool that created the message.", "metadata": {"type": "feedback"}}';
    expect(coercePlainAssistantText(dump, "Hello!")).toBe("Hello!");
  });

  it("does not use the old greeting fallback for real questions", () => {
    expect(plainReplyFallback("do you have memory that persists across instances?")).not.toBe(
      "I'm here. What would you like to do next?"
    );
    expect(plainReplyFallback("hi")).toBe("Hello! How can I help you today?");
  });
});
