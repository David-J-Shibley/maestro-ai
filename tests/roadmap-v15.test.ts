import { describe, expect, it } from "vitest";
import { resolveHarnessProfile, isHarnessProfileName } from "../src/proxy/harness-profile.js";
import { applyStickyTierPreference, clearStickyStore, getStickyTier, setStickyTier } from "../src/proxy/session-sticky.js";
import { needsPlainReplyRetry, coercePlainAssistantText } from "../src/proxy/anthropic-openai.js";
import { isPremiumPoolRotationError, listPremiumEndpoints } from "../src/config/premium-pool.js";
import { listEndpointsForTier } from "../src/config/tier-config.js";
import type { RouterConfig } from "../src/types.js";

describe("harness profiles", () => {
  it("defaults to claude-code", () => {
    expect(resolveHarnessProfile().name).toBe("claude-code");
    expect(resolveHarnessProfile().omitToolsWhenOmittable).toBe(true);
  });

  it("recognizes cursor/openai", () => {
    expect(isHarnessProfileName("cursor")).toBe(true);
    expect(resolveHarnessProfile("cursor").omitToolsWhenOmittable).toBe(false);
  });
});

describe("session sticky", () => {
  it("prefers local sticky for easy omittable turns", () => {
    clearStickyStore();
    setStickyTier("s1", "local_strong");
    expect(getStickyTier("s1")).toBe("local_strong");
    const r = applyStickyTierPreference("hosted_oss", "local_strong", {
      requiresToolUse: false,
      difficulty: "easy",
      riskLevel: "low",
    });
    expect(r.applied).toBe(true);
    expect(r.tier).toBe("local_strong");
  });
});

describe("plain reply retry predicate", () => {
  it("retries Memory dumps", () => {
    const dump =
      '{"name":"Memory","parameters":{"content":"[[tool]]","metadata":{"type":"feedback"}}}';
    expect(needsPlainReplyRetry(dump, "Hello!")).toBe(true);
    expect(coercePlainAssistantText(dump, "Hello!")).toBe("Hello!");
  });
});

describe("premium pool", () => {
  it("detects auth rotation errors", () => {
    expect(isPremiumPoolRotationError(new Error("security token expired"))).toBe(true);
    expect(isPremiumPoolRotationError(new Error("HTTP 403"))).toBe(true);
  });

  it("lists premium endpoints including pool", () => {
    const config = {
      models: {
        premium: {
          primary: {
            provider: "litellm",
            model: "bedrock/a",
            baseUrl: "http://localhost:4000/v1",
          },
        },
      },
      premiumPool: [
        {
          provider: "litellm",
          model: "openai/gpt-4o",
          baseUrl: "http://localhost:4000/v1",
        },
      ],
      routing: {},
      telemetry: { enabled: false, logPath: "/tmp/x" },
    } as unknown as RouterConfig;
    expect(listPremiumEndpoints(config).length).toBeGreaterThanOrEqual(2);
    expect(listEndpointsForTier(config, "premium").length).toBeGreaterThanOrEqual(2);
  });
});
