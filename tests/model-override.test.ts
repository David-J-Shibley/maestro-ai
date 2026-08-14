import { describe, expect, it } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { resolveModelOverride } from "../src/config/model-override.js";

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

describe("resolveModelOverride", () => {
  const config = () => loadConfigFromString(BASE_CONFIG);

  it("finds a configured model across tiers", () => {
    const resolved = resolveModelOverride("qwen3-coder-next", config());
    expect(resolved?.tier).toBe("hosted_oss");
    expect(resolved?.endpoint.model).toBe("qwen3-coder-next");
    expect(resolved?.source).toBe("config");
  });

  it("gateway-swaps unknown models onto the preferred tier", () => {
    const resolved = resolveModelOverride("qwen3-4b", config(), "local_strong");
    expect(resolved?.tier).toBe("local_strong");
    expect(resolved?.endpoint.model).toBe("qwen3-4b");
    expect(resolved?.endpoint.baseUrl).toBe("http://localhost:4000/v1");
    expect(resolved?.source).toBe("gateway_swap");
  });

  it("returns null for empty ids", () => {
    expect(resolveModelOverride("  ", config())).toBeNull();
  });
});
