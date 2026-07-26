import { describe, expect, it } from "vitest";
import { handleRouteTool } from "../src/mcp/tools.js";

describe("MCP route tool", () => {
  it("routes simple HTML page to local_fast", async () => {
    const result = await handleRouteTool({
      prompt: "make me a html page that demonstrates what you can do",
    });
    expect(result.tier).toBe("local_fast");
    expect(
      "analysis" in result
        ? (result as { analysis: { taskType: string } }).analysis.taskType
        : undefined
    ).toBeTruthy();
  });

  it("returns compact report by default and full report with debug", async () => {
    const compact = await handleRouteTool({
      prompt: "Summarize this paragraph in two sentences.",
    });
    expect(compact.tier).toBeTruthy();
    expect(compact.explanation).toBeTruthy();
    expect((compact as { debug?: unknown }).debug).toBeUndefined();
    expect((compact as { probe?: unknown }).probe).toBeUndefined();

    const full = await handleRouteTool({
      prompt: "Summarize this paragraph in two sentences.",
      debug: true,
    });
    expect(full.tier).toBeTruthy();
    expect(full.analysis).toBeTruthy();
    expect(full.debug.length).toBeGreaterThan(0);
    expect(full.explanation).toBeTruthy();
    expect(full.explanation.why.length).toBeGreaterThan(0);
    expect(full.explanation.markdown).toContain("Maestro Decision");
  });

  it("routes model-router demo meta prompts to local_fast", async () => {
    const result = await handleRouteTool({
      prompt:
        "Determine routing for building a demonstration of model-router capabilities including tier selection and architecture overview",
      debug: true,
    });
    expect(result.tier).toBe("local_fast");
    expect(result.analysis.taskType).toBe("code_edit");
    expect(result.analysis.difficulty).toBe("easy");
  });

  it("routes architecture tasks to premium (intended tier, no live probe)", async () => {
    const result = await handleRouteTool({
      prompt: "Design the architecture for a distributed task queue.",
      debug: true,
    });

    expect(result.tier).toBe("premium");
    expect(result.analysis.taskType).toBe("architecture");
  });

  it("honors premium_only override (intended tier, no live probe)", async () => {
    const result = await handleRouteTool({
      prompt: "Format this list.",
      premium_only: true,
      debug: true,
    });

    expect(result.tier).toBe("premium");
  });
});
