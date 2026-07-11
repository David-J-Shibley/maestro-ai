import { describe, expect, it } from "vitest";
import { evaluateResponse } from "../src/evaluator/response-evaluator.js";

describe("tool call evaluator", () => {
  it("flags invalid tool call arguments", () => {
    const result = evaluateResponse("", {
      tools: [{ type: "function" }],
      rawResponse: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{ function: { name: "search", arguments: "not-json" } }],
            },
          },
        ],
      },
    });
    expect(result.pass).toBe(false);
    expect(result.escalationRecommended).toBe(true);
  });

  it("passes valid tool calls", () => {
    const result = evaluateResponse("", {
      tools: [{ type: "function" }],
      rawResponse: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{ function: { name: "search", arguments: "{\"q\":\"test\"}" } }],
            },
          },
        ],
      },
    });
    expect(result.checks.find((c) => c.name === "tool_calls_valid")?.pass).toBe(true);
  });
});
