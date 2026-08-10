import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleRouteTool } from "../src/mcp/tools.js";

/** Isolated config — do not use ~/.maestro-ai (offlineLocalOnly caps premium on CI/dev machines). */
const TEST_CONFIG = {
  models: {
    local_fast: {
      primary: { provider: "ollama", model: "llama3.2:latest", baseUrl: "http://localhost:11434/v1" },
    },
    local_strong: {
      primary: {
        provider: "litellm",
        model: "glm",
        baseUrl: "http://localhost:4000/v1",
        apiKey: "test",
      },
    },
    hosted_oss: {
      primary: {
        provider: "litellm",
        model: "qwen3-coder-next",
        baseUrl: "http://localhost:4000/v1",
        apiKey: "test",
      },
    },
    premium: {
      primary: {
        provider: "litellm",
        model: "bedrock/global.anthropic.claude-sonnet-4-6",
        baseUrl: "http://localhost:4000/v1",
        apiKey: "test",
      },
    },
  },
  routing: {
    defaultTier: "local_strong",
    maxRetriesPerTier: 1,
    enableEscalation: true,
    preferLocal: true,
    longContextTokenThreshold: 32000,
    probeAvailability: false,
    offlineLocalOnly: false,
    learnedRoutingHints: false,
  },
  telemetry: { enabled: false, logPath: "/tmp/maestro-mcp-test-telemetry.jsonl" },
};

function testConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "maestro-mcp-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(TEST_CONFIG));
  return configPath;
}

describe("MCP route tool", () => {
  const config_path = testConfigPath();

  it("routes simple HTML page to local_fast", async () => {
    const result = await handleRouteTool({
      prompt: "make me a html page that demonstrates what you can do",
      config_path,
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
      config_path,
    });
    expect(compact.tier).toBeTruthy();
    expect(compact.explanation).toBeTruthy();
    expect((compact as { debug?: unknown }).debug).toBeUndefined();
    expect((compact as { probe?: unknown }).probe).toBeUndefined();

    const full = await handleRouteTool({
      prompt: "Summarize this paragraph in two sentences.",
      debug: true,
      config_path,
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
      config_path,
    });
    expect(result.tier).toBe("local_fast");
    expect(result.analysis.taskType).toBe("code_edit");
    expect(result.analysis.difficulty).toBe("easy");
  });

  it("routes architecture tasks to premium (intended tier, no live probe)", async () => {
    const result = await handleRouteTool({
      prompt: "Design the architecture for a distributed task queue.",
      debug: true,
      config_path,
    });

    expect(result.tier).toBe("premium");
    expect(result.analysis.taskType).toBe("architecture");
  });

  it("honors premium_only override (intended tier, no live probe)", async () => {
    const result = await handleRouteTool({
      prompt: "Format this list.",
      premium_only: true,
      debug: true,
      config_path,
    });

    expect(result.tier).toBe("premium");
  });
});
