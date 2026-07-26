import { describe, expect, it } from "vitest";
import { evaluateResponse } from "../src/evaluator/response-evaluator.js";

describe("ResponseEvaluator", () => {
  it("passes valid non-empty text", () => {
    const result = evaluateResponse("Here is the summary you requested.");
    expect(result.pass).toBe(true);
    expect(result.retryRecommended).toBe(false);
  });

  it("fails empty output", () => {
    const result = evaluateResponse("   ");
    expect(result.pass).toBe(false);
    expect(result.retryRecommended).toBe(true);
    expect(result.escalationRecommended).toBe(true);
  });

  it("fails invisible control-only output", () => {
    const result = evaluateResponse("\u0000\u200B");
    expect(result.pass).toBe(false);
    expect(result.checks.find((c) => c.name === "non_empty")?.pass).toBe(false);
  });

  it("fails when tokens reported but no visible content", () => {
    const result = evaluateResponse("", {
      rawResponse: {
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
        usage: { completion_tokens: 42 },
      },
    });
    expect(result.pass).toBe(false);
    expect(result.checks.find((c) => c.name === "content_integrity")?.pass).toBe(false);
    expect(result.escalationRecommended).toBe(true);
  });

  it("fails invalid JSON when schema required", () => {
    const result = evaluateResponse("not json at all", {
      responseSchema: { type: "object" },
      expectedFormat: "json",
    });
    expect(result.pass).toBe(false);
    expect(result.escalationRecommended).toBe(true);
  });

  it("passes JSON in code fence", () => {
    const result = evaluateResponse('```json\n{"name": "test"}\n```', {
      responseSchema: { type: "object" },
      expectedFormat: "json",
    });
    expect(result.pass).toBe(true);
  });

  it("detects refusal", () => {
    const result = evaluateResponse("I cannot help with that request.", {
      taskAllowed: true,
    });
    expect(result.pass).toBe(false);
    expect(result.escalationRecommended).toBe(true);
  });

  it("flags low-confidence short output for escalation", () => {
    const result = evaluateResponse("I'm not sure.", {
      responseSchema: { type: "object" },
    });
    expect(result.escalationRecommended).toBe(true);
  });

  it("flags truncation (finish_reason=length) with partial content as retry-not-escalate", () => {
    const content = "Here is the beginning of a long answer that was cut off mid-";
    const result = evaluateResponse(content, {
      rawResponse: {
        choices: [{ message: { content }, finish_reason: "length" }],
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.retryRecommended).toBe(true);
    expect(result.escalationRecommended).toBe(false);
    expect(result.checks.find((c) => c.name === "truncation")?.pass).toBe(false);
  });

  it("flags truncation with no content as retry-not-escalate", () => {
    const result = evaluateResponse("", {
      rawResponse: {
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { completion_tokens: 100 },
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.retryRecommended).toBe(true);
    expect(result.escalationRecommended).toBe(false);
  });

  it("does not flag long content containing 'I can't' as a refusal", () => {
    const longText =
      "Here is a detailed analysis of the codebase. ".repeat(20) +
      "Note that I can't guarantee this covers every edge case, but the structure is sound. " +
      "Further analysis continues below. ".repeat(20);
    const result = evaluateResponse(longText, { taskAllowed: true });
    expect(result.pass).toBe(true);
    expect(result.checks.find((c) => c.name === "no_refusal")?.pass).toBe(true);
  });

  it("does not flag a refusal phrase that appears only after the opening", () => {
    const padding = "Here is the analysis you requested. ".repeat(7);
    const content = padding + "I can't continue further without more context.";
    const result = evaluateResponse(content, { taskAllowed: true });
    expect(result.checks.find((c) => c.name === "no_refusal")?.pass).toBe(true);
  });
});
