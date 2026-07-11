import { describe, expect, it } from "vitest";
import { resolveEndpointForTier } from "../src/config/tier-config.js";
import { loadConfigFromString } from "../src/config/load-config.js";

describe("tier fallback config", () => {
  const json = `{
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

  it("uses tier fallback when primary unavailable", () => {
    const config = loadConfigFromString(json);
    const resolved = resolveEndpointForTier(config, "local_strong", false, true);
    expect(resolved?.source).toBe("tier_fallback");
    expect(resolved?.endpoint.model).toBe("qwen3:8b");
    expect(resolved?.fallbackReason).toContain("tier fallback");
  });
});
