import { describe, expect, it } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { routeTask } from "../src/router/model-router.js";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import type { ModelTier, RouterConfig } from "../src/types.js";

const BASE_CONFIG = `{
  "models": {
    "local_fast": { "provider": "ollama", "model": "llama3.2:latest", "baseUrl": "http://localhost:11434/v1" },
    "local_strong": { "provider": "litellm", "model": "glm", "baseUrl": "http://localhost:4000/v1", "apiKey": "test" },
    "hosted_oss": { "provider": "litellm", "model": "qwen3-coder-next", "baseUrl": "http://localhost:4000/v1", "apiKey": "test" },
    "premium": { "provider": "litellm", "model": "bedrock/global.anthropic.claude-sonnet-4-6", "baseUrl": "http://localhost:4000/v1", "apiKey": "test" }
  },
  "routing": {
    "defaultTier": "local_strong",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/test-telemetry.jsonl" }
}`;

function config(): RouterConfig {
  return loadConfigFromString(BASE_CONFIG);
}

function route(prompt: string, overrides?: Parameters<typeof routeTask>[0]["overrides"], hints?: Parameters<typeof routeTask>[0]["taskHints"]) {
  const analysis = analyzeTask({ userPrompt: prompt, taskHints: hints });
  return routeTask({ analysis, config: config(), overrides, taskHints: hints });
}

describe("Maestro router", () => {
  it("routes simple rewrite to local_strong", () => {
    const decision = route("Rewrite this email to be more professional.");
    expect(decision.tier).toBe("local_strong");
    expect(decision.model).toBe("glm");
  });

  it("routes formatting to local_fast", () => {
    const decision = route("Format this list as markdown bullet points.");
    expect(decision.tier).toBe("local_fast");
  });

  it("routes debugging to hosted_oss", () => {
    const decision = route("Debug why this API endpoint returns 500 intermittently.");
    expect(decision.tier).toBe("hosted_oss");
  });

  it("routes simple HTML page to local_fast", () => {
    const decision = route("make me a html page that demonstrates what you can do");
    expect(decision.tier).toBe("local_fast");
    expect(decision.model).toBe("llama3.2:latest");
  });

  it("routes design landing page to local_fast not premium", () => {
    const decision = route("design a simple html landing page");
    expect(decision.tier).toBe("local_fast");
  });

  it("falls back to local_fast when litellm tiers are unavailable", () => {
    const analysis = analyzeTask({
      userPrompt: "make me a html page that demonstrates what you can do",
    });
    const unavailable = new Set<ModelTier>([
      "local_strong",
      "hosted_oss",
      "premium",
    ]);
    const decision = routeTask({
      analysis,
      config: config(),
      unavailableTiers: unavailable,
    });
    expect(decision.tier).toBe("local_fast");
    expect(decision.model).toBe("llama3.2:latest");
  });

  it("routes model-router demo meta prompts to local_fast", () => {
    const decision = route(
      "Determine routing for building a demonstration of model-router capabilities including tier selection and architecture overview"
    );
    expect(decision.tier).toBe("local_fast");
  });

  it("routes architecture to premium", () => {
    const decision = route("Design system architecture for event sourcing with trade-offs.");
    expect(decision.tier).toBe("premium");
    expect(decision.model).toBe("bedrock/global.anthropic.claude-sonnet-4-6");
  });

  it("routes production security task to premium", () => {
    const decision = route("Patch this production security vulnerability in auth.");
    expect(decision.tier).toBe("premium");
  });

  it("fail-soft: testing with tool catalog stays off premium", () => {
    const tools = Array.from({ length: 92 }, (_, i) => ({ name: `T${i}` }));
    const analysis = analyzeTask({ userPrompt: "testing", tools });
    const decision = routeTask({
      analysis,
      config: config(),
      userPrompt: "testing",
    });
    expect(analysis.requiresToolUse).toBe(false);
    expect(decision.tier).not.toBe("premium");
    expect(["local_fast", "local_strong"]).toContain(decision.tier);
  });

  it("honors --model-tier override", () => {
    const decision = route("anything", { modelTier: "hosted_oss" });
    expect(decision.tier).toBe("hosted_oss");
  });

  it("honors premium-only override", () => {
    const decision = route("summarize this", { premiumOnly: true });
    expect(decision.tier).toBe("premium");
  });

  it("honors quality=best hint", () => {
    const decision = route("summarize this", undefined, { quality: "best" });
    expect(decision.tier).toBe("premium");
  });

  it("escalates past unavailable tiers", () => {
    const analysis = analyzeTask({ userPrompt: "Format this text." });
    const unavailable = new Set<ModelTier>(["local_fast"]);
    const decision = routeTask({
      analysis,
      config: config(),
      unavailableTiers: unavailable,
    });
    expect(decision.tier).not.toBe("local_fast");
  });

  it("caps tier with session max_tier", () => {
    const analysis = analyzeTask({ userPrompt: "Design system architecture for event sourcing with trade-offs." });
    const decision = routeTask({
      analysis,
      config: config(),
      overrides: { session: { maxTier: "hosted_oss" } },
    });
    expect(decision.tier).toBe("hosted_oss");
  });
});
