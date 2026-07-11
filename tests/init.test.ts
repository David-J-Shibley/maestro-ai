import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfigFromString } from "../src/config/load-config.js";
import {
  CONFIG_PROFILES,
  profileSourcePath,
  resolveConfigProfile,
} from "../src/config/package-paths.js";
import {
  buildMcpConfig,
  listRequiredOllamaModels,
} from "../src/init/setup.js";

const MINIMAL_CONFIG = `{
  "models": {
    "local_fast": { "primary": { "provider": "ollama", "model": "llama3.2:latest", "baseUrl": "http://localhost:11434/v1" } },
    "local_strong": {
      "primary": { "provider": "litellm", "model": "glm", "baseUrl": "http://localhost:4000/v1" },
      "fallback": { "provider": "ollama", "model": "qwen3:8b", "baseUrl": "http://localhost:11434/v1" }
    },
    "hosted_oss": { "primary": { "provider": "litellm", "model": "qwen", "baseUrl": "http://localhost:4000/v1" } },
    "premium": { "primary": { "provider": "litellm", "model": "sonnet", "baseUrl": "http://localhost:4000/v1" } }
  },
  "routing": { "defaultTier": "local_strong", "maxRetriesPerTier": 1, "enableEscalation": true, "preferLocal": true, "longContextTokenThreshold": 32000, "probeAvailability": false },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`;

describe("config profiles", () => {
  it("lists bundled profiles", () => {
    expect(CONFIG_PROFILES).toContain("default");
    expect(CONFIG_PROFILES).toContain("ollama-only");
    expect(CONFIG_PROFILES).toContain("cloud-only");
  });

  it("resolves profile names", () => {
    expect(resolveConfigProfile("ollama-only")).toBe("ollama-only");
    expect(() => resolveConfigProfile("invalid")).toThrow(/Unknown profile/);
  });

  it("has bundled profile files on disk", () => {
    for (const profile of CONFIG_PROFILES) {
      const path = profileSourcePath(profile);
      expect(path).toContain("config");
    }
  });

  it("ollama-only config uses only ollama providers", () => {
    const raw = profileSourcePath("ollama-only");
    const config = loadConfigFromString(readFileSync(raw, "utf8"));
    for (const tier of Object.values(config.models)) {
      expect(tier.primary.provider).toBe("ollama");
    }
  });
});

describe("init helpers", () => {
  it("lists required ollama models from config", () => {
    const config = loadConfigFromString(MINIMAL_CONFIG);
    const models = listRequiredOllamaModels(config);
    expect(models).toContain("llama3.2:latest");
    expect(models).toContain("qwen3:8b");
    expect(models).not.toContain("glm");
  });

  it("buildMcpConfig includes MAESTRO_CONFIG", () => {
    const mcp = buildMcpConfig("/home/user/.maestro-ai/config.json");
    const servers = mcp.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers["maestro-ai"]?.env.MAESTRO_CONFIG).toBe(
      "/home/user/.maestro-ai/config.json"
    );
  });
});
