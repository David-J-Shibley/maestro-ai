import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";

describe("TaskAnalyzer", () => {
  it("classifies simple rewrite as easy local task", () => {
    const analysis = analyzeTask({
      userPrompt: "Rewrite this paragraph to be more concise.",
    });

    expect(analysis.taskType).toBe("rewriting");
    expect(analysis.difficulty).toBe("easy");
    expect(analysis.riskLevel).toBe("low");
    expect(analysis.requiresCodeReasoning).toBe(false);
  });

  it("classifies JSON extraction with schema", () => {
    const analysis = analyzeTask({
      userPrompt: "Extract the author and title from this text.",
      responseSchema: { type: "object" },
    });

    expect(analysis.taskType).toBe("extraction");
    expect(analysis.requiresStructuredOutput).toBe(true);
  });

  it("classifies small code edit as medium", () => {
    const analysis = analyzeTask({
      userPrompt: "Fix the off-by-one error in this JavaScript function.",
    });

    expect(analysis.taskType).toBe("code_edit");
    expect(analysis.requiresCodeReasoning).toBe(true);
  });

  it("classifies complex debugging as medium/hard", () => {
    const analysis = analyzeTask({
      userPrompt:
        "Debug this flaky integration test that fails intermittently in CI across multiple modules.",
    });

    expect(analysis.taskType).toBe("debugging");
    expect(["medium", "hard"]).toContain(analysis.difficulty);
  });

  it("classifies simple HTML page as easy code_edit", () => {
    const analysis = analyzeTask({
      userPrompt: "make me a html page that demonstrates what you can do",
    });

    expect(analysis.taskType).toBe("code_edit");
    expect(analysis.difficulty).toBe("easy");
    expect(analysis.requiresCodeReasoning).toBe(false);
    expect(analysis.riskLevel).toBe("low");
  });

  it("does not classify simple landing page design as architecture", () => {
    const analysis = analyzeTask({
      userPrompt: "design a simple html landing page",
    });

    expect(analysis.taskType).toBe("code_edit");
    expect(analysis.difficulty).toBe("easy");
    expect(analysis.taskType).not.toBe("architecture");
  });

  it("does not classify model-router demo meta prompts as architecture", () => {
    const prompts = [
      "Determine routing for building a demonstration of model-router capabilities including tier selection and architecture overview",
      "What model should handle creating a showcase demonstrating model router tier selection architecture",
      "Build an HTML page demonstrating the model router architecture and tier selection",
    ];

    for (const userPrompt of prompts) {
      const analysis = analyzeTask({ userPrompt });
      expect(analysis.taskType).toBe("code_edit");
      expect(analysis.difficulty).toBe("easy");
      expect(analysis.requiresCodeReasoning).toBe(false);
    }
  });

  it("still classifies real system architecture as hard", () => {
    const analysis = analyzeTask({
      userPrompt: "Design the architecture for a multi-tenant SaaS billing system with trade-offs.",
    });

    expect(analysis.taskType).toBe("architecture");
    expect(analysis.difficulty).toBe("hard");
  });

  it("respects task hints", () => {
    const analysis = analyzeTask({
      userPrompt: "do something",
      taskHints: { type: "code_edit", quality: "best", risk: "high" },
    });

    expect(analysis.taskType).toBe("code_edit");
    expect(analysis.difficulty).toBe("hard");
    expect(analysis.riskLevel).toBe("high");
    expect(analysis.confidence).toBeGreaterThan(0.8);
  });

  it("detects tool use from tools array", () => {
    const analysis = analyzeTask({
      userPrompt: "List files",
      tools: [{ type: "function", function: { name: "list_dir" } }],
    });

    expect(analysis.requiresToolUse).toBe(true);
  });

  it("does not treat harness tool catalogs as needing tools for chitchat", () => {
    const tools = Array.from({ length: 92 }, (_, i) => ({
      name: `Tool${i}`,
      input_schema: { type: "object", properties: {} },
    }));
    const analysis = analyzeTask({
      userPrompt: "hi",
      tools,
    });
    expect(analysis.taskType).toBe("simple_answer");
    expect(analysis.difficulty).toBe("easy");
    expect(analysis.requiresToolUse).toBe(false);
    expect(analysis.toolNeedScore).toBe(0);
    expect(analysis.requiresLongContext).toBe(false);
    expect(analysis.signals).toContain("tools_omittable");
  });

  it("treats Claude Code resume/recap prompts as meta (no tools needed)", () => {
    const analysis = analyzeTask({
      userPrompt:
        "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences.",
      tools: Array.from({ length: 92 }, (_, i) => ({ name: `T${i}` })),
    });
    expect(analysis.requiresToolUse).toBe(false);
    expect(analysis.requiresLongContext).toBe(false);
    expect(analysis.signals).toContain("tools_omittable");
  });

  it("keeps tools on for short mid-agent continuations", () => {
    const tools = [{ name: "Read" }];
    const analysis = analyzeTask({
      userPrompt: "ok continue",
      tools,
      recentToolTurns: 3,
    });
    expect(analysis.requiresToolUse).toBe(true);
    expect(analysis.toolNeedScore).toBeGreaterThanOrEqual(0.6);
  });

  it("treats short status pings as chitchat (not code_edit via 'test')", () => {
    const tools = Array.from({ length: 92 }, (_, i) => ({ name: `T${i}` }));
    for (const userPrompt of [
      "testing",
      "hi are you working",
      "are you working",
      "hello there",
    ]) {
      const analysis = analyzeTask({ userPrompt, tools });
      expect(analysis.requiresToolUse).toBe(false);
      expect(analysis.requiresLongContext).toBe(false);
      expect(analysis.taskType).toBe("simple_answer");
      expect(["easy"]).toContain(analysis.difficulty);
    }
  });

  it("still treats real test asks as code work", () => {
    const analysis = analyzeTask({
      userPrompt: "write a unit test for the router",
      tools: [{ name: "Write" }],
    });
    expect(analysis.taskType).toBe("code_edit");
    expect(analysis.requiresToolUse).toBe(true);
  });

  it("does not treat bare code keywords without targets as needing tools", () => {
    const tools = Array.from({ length: 92 }, (_, i) => ({ name: `T${i}` }));
    const analysis = analyzeTask({
      userPrompt: "what is a javascript function",
      tools,
    });
    expect(analysis.requiresToolUse).toBe(false);
  });

  it("fail-soft: testing with tools stays omittable and not code_edit", () => {
    const tools = Array.from({ length: 92 }, (_, i) => ({ name: `T${i}` }));
    const analysis = analyzeTask({ userPrompt: "testing", tools });
    expect(analysis.requiresToolUse).toBe(false);
    expect(analysis.toolNeedScore).toBe(0);
  });
});
