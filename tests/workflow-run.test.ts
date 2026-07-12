import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { dryRunWorkflow } from "../src/workflow/run-workflow.js";
import { runWorkflow } from "../src/workflow/run-workflow.js";

const CONFIG = loadConfigFromString(`{
  "models": {
    "local_fast": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1", "timeoutMs": 1000 },
    "local_strong": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1", "timeoutMs": 1000 },
    "hosted_oss": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1", "timeoutMs": 1000 },
    "premium": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1", "timeoutMs": 1000 }
  },
  "routing": {
    "defaultTier": "local_strong",
    "maxRetriesPerTier": 0,
    "enableEscalation": false,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`);

describe("workflow dry-run", () => {
  it("returns planned steps and predicted tiers", async () => {
    const dry = await dryRunWorkflow(
      {
        messages: [{ role: "user", content: "Compare file A and file B" }],
        workflow: "parallel-synthesis",
      },
      { config: CONFIG }
    );

    expect(dry.plan.pattern).toBe("parallel-synthesis");
    expect(dry.stepRoutes.length).toBeGreaterThan(2);
    expect(dry.report).toContain("Maestro Workflow Dry Run");
  });
});

describe("workflow runWorkflow single-shot", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("delegates easy tasks to routedLLMCall", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "formatted list" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
        text: async () => "{}",
      }))
    );

    const result = await runWorkflow(
      {
        messages: [{ role: "user", content: "Format this list" }],
        workflow: "auto",
      },
      { config: CONFIG }
    );

    expect(result.workflow.pattern).toBe("single-shot");
    expect(result.finalOutput).toContain("formatted");
    expect(result.response).toBeTruthy();
  });
});
