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
});
