import { describe, expect, it } from "vitest";
import {
  anthropicToChatMessages,
  anthropicToolsToOpenAi,
  normalizeAnthropicSystem,
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
});
