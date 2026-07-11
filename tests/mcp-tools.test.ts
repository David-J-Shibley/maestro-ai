import { describe, expect, it } from "vitest";
import { handleRouteTool } from "../src/mcp/tools.js";

describe("MCP route tool", () => {
  it("routes simple HTML page to local_fast", async () => {
    const result = await handleRouteTool({
      prompt: "make me a html page that demonstrates what you can do",
    });
    expect(result.tier).toBe("local_fast");
    expect(result.analysis.taskType).toBe("code_edit");
  });

  it("returns full routing report with debug and probe", async () => {
    const result = await handleRouteTool({
      prompt: "Summarize this paragraph in two sentences.",
    });
    expect(result.tier).toBeTruthy();
    expect(result.analysis).toBeTruthy();
    expect(result.debug.length).toBeGreaterThan(0);
    expect(result.probe).toBeTruthy();
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

  it("routes architecture tasks to premium", async () => {
    const result = await handleRouteTool({
      prompt: "Design the architecture for a distributed task queue.",
    });

    expect(result.tier).toBe("premium");
    expect(result.analysis.taskType).toBe("architecture");
  });

  it("honors premium_only override", async () => {
    const result = await handleRouteTool({
      prompt: "Format this list.",
      premium_only: true,
    });

    expect(result.tier).toBe("premium");
  });
});
