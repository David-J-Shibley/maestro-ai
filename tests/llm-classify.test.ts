import { describe, expect, it } from "vitest";
import {
  mergeHeuristicAndLlm,
  parseClassifyJson,
  shouldRunLlmClassify,
} from "../src/analyzer/llm-classify.js";
import type { TaskAnalysis } from "../src/types.js";

function base(over: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    taskType: "simple_answer",
    difficulty: "easy",
    riskLevel: "low",
    requiresToolUse: false,
    toolNeedScore: 0.2,
    requiresCodeReasoning: false,
    requiresLongContext: false,
    requiresStructuredOutput: false,
    confidence: 0.75,
    signals: ["taskType=simple_answer"],
    ...over,
  };
}

describe("llmClassify", () => {
  it("parses JSON even with surrounding prose", () => {
    const p = parseClassifyJson(
      'Sure.\n{"taskType":"code_edit","difficulty":"medium","riskLevel":"medium","requiresToolUse":true,"confidence":0.8}\n'
    );
    expect(p.taskType).toBe("code_edit");
    expect(p.requiresToolUse).toBe(true);
    expect(p.confidence).toBe(0.8);
  });

  it("gates on low confidence / unknown / borderline tools", () => {
    expect(shouldRunLlmClassify(base(), "off")).toBe(false);
    expect(shouldRunLlmClassify(base({ confidence: 0.5 }), "shadow")).toBe(true);
    expect(shouldRunLlmClassify(base({ taskType: "unknown" }), "shadow")).toBe(
      true
    );
    expect(
      shouldRunLlmClassify(base({ toolNeedScore: 0.55, confidence: 0.8 }), "on")
    ).toBe(true);
    expect(
      shouldRunLlmClassify(base({ toolNeedScore: 0.9, confidence: 0.8 }), "shadow")
    ).toBe(false);
  });

  it("shadow keeps heuristic route but records disagreement", () => {
    const merged = mergeHeuristicAndLlm(
      base(),
      {
        taskType: "code_edit",
        difficulty: "hard",
        requiresToolUse: true,
        latencyMs: 40,
      },
      "shadow"
    );
    expect(merged.taskType).toBe("simple_answer");
    expect(merged.requiresToolUse).toBe(false);
    expect(merged.signals.some((s) => s.startsWith("llm_classify_diff="))).toBe(
      true
    );
    expect(merged.signals).toContain("llm_classify=shadow");
  });

  it("on merges tools/types but clamps solo hard→premium", () => {
    const merged = mergeHeuristicAndLlm(
      base({ confidence: 0.7 }),
      {
        taskType: "architecture",
        difficulty: "hard",
        riskLevel: "high",
        requiresToolUse: true,
        confidence: 0.9,
        latencyMs: 30,
      },
      "on"
    );
    expect(merged.taskType).toBe("architecture");
    expect(merged.difficulty).toBe("hard");
    expect(merged.requiresToolUse).toBe(true);
    expect(merged.toolNeedScore).toBeGreaterThanOrEqual(0.7);
    expect(merged.confidence).toBeLessThan(0.65);
    expect(merged.signals).toContain("llm_classify_premium_clamp");
  });

  it("on does not clear strong tool need when LLM says false", () => {
    const merged = mergeHeuristicAndLlm(
      base({ requiresToolUse: true, toolNeedScore: 0.85 }),
      { requiresToolUse: false, latencyMs: 10 },
      "on"
    );
    expect(merged.requiresToolUse).toBe(true);
  });
});
