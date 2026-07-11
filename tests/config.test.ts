import { describe, expect, it } from "vitest";
import { loadConfigFromString, interpolateEnv } from "../src/config/load-config.js";

describe("config parsing", () => {
  const json = `{
    "models": {
      "local_fast": { "provider": "ollama", "model": "llama3.2:latest", "baseUrl": "http://localhost:11434/v1" },
      "local_strong": { "provider": "litellm", "model": "glm", "baseUrl": "http://localhost:4000/v1", "apiKey": "\${TEST_KEY:-fallback-key}" },
      "hosted_oss": { "provider": "litellm", "model": "qwen3-coder-next", "baseUrl": "http://localhost:4000/v1", "apiKey": "k" },
      "premium": { "provider": "litellm", "model": "bedrock/global.anthropic.claude-sonnet-4-6", "baseUrl": "http://localhost:4000/v1", "apiKey": "k" }
    },
    "routing": {
      "defaultTier": "local_strong",
      "maxRetriesPerTier": 1,
      "enableEscalation": true,
      "preferLocal": true,
      "longContextTokenThreshold": 32000,
      "probeAvailability": true
    },
    "telemetry": { "enabled": true, "logPath": "\${MAESTRO_TELEMETRY_PATH:-~/.maestro-ai/telemetry.jsonl}" }
  }`;

  it("parses valid config", () => {
    const config = loadConfigFromString(json);
    expect(config.models.local_strong.primary.model).toBe("glm");
    expect(config.routing.defaultTier).toBe("local_strong");
    expect(config.telemetry.logPath).toContain(".maestro-ai");
  });

  it("interpolates env vars with defaults", () => {
    delete process.env.TEST_KEY;
    expect(interpolateEnv("${TEST_KEY:-fallback-key}")).toBe("fallback-key");
  });

  it("parses primary/fallback tier config", () => {
    const withFallback = `{
      "models": {
        "local_fast": { "primary": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" } },
        "local_strong": {
          "primary": { "provider": "litellm", "model": "glm", "baseUrl": "http://l/v1" },
          "fallback": { "provider": "ollama", "model": "qwen3:8b", "baseUrl": "http://l/v1" }
        },
        "hosted_oss": { "primary": { "provider": "litellm", "model": "h", "baseUrl": "http://l/v1" } },
        "premium": { "primary": { "provider": "litellm", "model": "p", "baseUrl": "http://l/v1" } }
      },
      "routing": { "defaultTier": "local_strong", "maxRetriesPerTier": 1, "enableEscalation": true, "preferLocal": true, "longContextTokenThreshold": 32000, "probeAvailability": true },
      "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
    }`;
    const config = loadConfigFromString(withFallback);
    expect(config.models.local_strong.fallback?.model).toBe("qwen3:8b");
  });

  it("throws on missing tier", () => {
    expect(() =>
      loadConfigFromString('{"models": {}, "routing": {"defaultTier": "local_fast"}}')
    ).toThrow(/local_fast/);
  });
});
