import { describe, expect, it } from "vitest";
import {
  anthropicBodyForContextRetry,
  isNativeContextOverflow,
} from "../src/proxy/context-retry.js";

describe("isNativeContextOverflow", () => {
  it("detects bare message_start with no text", () => {
    expect(
      isNativeContextOverflow({
        sawMessageStart: true,
        sawMessageStop: false,
        textChars: 0,
        upstreamError: null,
      })
    ).toBe(true);
  });

  it("ignores successful streams", () => {
    expect(
      isNativeContextOverflow({
        sawMessageStart: true,
        sawMessageStop: true,
        textChars: 12,
        upstreamError: null,
      })
    ).toBe(false);
  });

  it("ignores partial text even when message_stop is missing", () => {
    expect(
      isNativeContextOverflow({
        sawMessageStart: true,
        sawMessageStop: false,
        textChars: 4,
        upstreamError: null,
      })
    ).toBe(false);
  });

  it("detects upstream error with no visible text", () => {
    expect(
      isNativeContextOverflow({
        sawMessageStart: false,
        sawMessageStop: false,
        textChars: 0,
        upstreamError: "context length exceeded",
      })
    ).toBe(true);
  });
});

describe("anthropicBodyForContextRetry", () => {
  it("strips tools and adds plain-text hint", () => {
    const body = anthropicBodyForContextRetry({
      messages: [{ role: "user", content: "hi" }],
      system: "You are helpful",
      tools: [{ name: "Read" }],
      tool_choice: { type: "any" },
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(body.system)).toContain("plain natural language");
  });
});
