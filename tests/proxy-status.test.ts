import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { buildProxyStatusPayload } from "../src/proxy/proxy-status.js";
import { recordProxyRoute, clearRouteLog } from "../src/proxy/route-log.js";
import { resolveHarnessProfile } from "../src/proxy/harness-profile.js";
import { probeAllTiers } from "../src/provider/probe.js";

vi.mock("../src/provider/probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/provider/probe.js")>();
  return {
    ...actual,
    probeAllTiers: vi.fn(actual.probeAllTiers),
  };
});

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

describe("buildProxyStatusPayload", () => {
  beforeEach(() => {
    vi.mocked(probeAllTiers).mockClear();
  });

  it("includes tiers, litellm, and enriched recent routes", async () => {
    clearRouteLog();
    recordProxyRoute({
      tier: "local_strong",
      model: "glm",
      started: Date.now() - 12,
      ask: "refactor auth",
      toolsOmitted: 42,
      forceToolUse: true,
      truncated: false,
    });

    const payload = await buildProxyStatusPayload({
      config: loadConfigFromString(BASE_CONFIG),
      options: { modelTier: "local_strong", model: "glm" },
      host: "127.0.0.1",
      port: 4100,
      profile: resolveHarnessProfile("claude-code"),
      ephemeralSessionId: "test-session",
      version: "1.9.5",
    });

    expect(payload.modelTier).toBe("local_strong");
    expect(payload.model).toBe("glm");
    expect(Array.isArray(payload.tiers)).toBe(true);
    expect((payload.tiers as { tier: string }[]).length).toBe(4);
    expect(payload.litellm).toMatchObject({
      gatewayUp: expect.any(Boolean),
      reachable: expect.any(Boolean),
      processRunning: expect.any(Boolean),
      processDetail: expect.any(String),
      knownConfigPaths: expect.any(Array),
    });
    expect(vi.mocked(probeAllTiers)).toHaveBeenCalledWith(
      expect.anything(),
      { force: true }
    );
    const routes = payload.recentRoutes as Array<Record<string, unknown>>;
    expect(routes.at(-1)).toMatchObject({
      toolsOmitted: 42,
      forceToolUse: true,
      truncated: false,
    });
  });
});
