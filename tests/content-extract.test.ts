import { describe, expect, it } from "vitest";
import {
  extractCompletionFromRaw,
  hasMeaningfulContent,
  normalizeMessageContent,
} from "../src/provider/content-extract.js";

describe("content extraction", () => {
  it("extracts string content", () => {
    const r = extractCompletionFromRaw({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { completion_tokens: 5 },
    });
    expect(r.content).toBe("hello");
    expect(r.sources).toContain("message.content");
  });

  it("extracts array content parts", () => {
    const r = extractCompletionFromRaw({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "part one" },
              { type: "text", text: "part two" },
            ],
          },
        },
      ],
    });
    expect(r.content).toBe("part one\npart two");
  });

  it("falls back to choice.text", () => {
    const r = extractCompletionFromRaw({
      choices: [{ text: "legacy completion" }],
    });
    expect(r.content).toBe("legacy completion");
  });

  it("falls back to reasoning_content when content empty", () => {
    const r = extractCompletionFromRaw({
      choices: [
        {
          message: { content: null, reasoning_content: "internal reasoning output" },
          finish_reason: "stop",
        },
      ],
      usage: { completion_tokens: 100 },
    });
    expect(r.content).toBe("internal reasoning output");
    expect(r.sources).toContain("message.reasoning_content");
  });
});

describe("hasMeaningfulContent", () => {
  it("rejects whitespace only", () => {
    expect(hasMeaningfulContent("   \n\t  ")).toBe(false);
  });

  it("rejects null bytes and zero-width chars", () => {
    expect(hasMeaningfulContent("\u0000")).toBe(false);
    expect(hasMeaningfulContent("\u200B\u200B")).toBe(false);
  });

  it("accepts real text", () => {
    expect(hasMeaningfulContent("  hello  ")).toBe(true);
  });
});

describe("normalizeMessageContent", () => {
  it("joins text parts", () => {
    expect(
      normalizeMessageContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\nb");
  });
});
