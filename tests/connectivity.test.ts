import { describe, expect, it, beforeEach } from "vitest";
import {
  applyOfflineLocalOnlyOverrides,
  checkInternet,
  clearConnectivityCache,
  isOfflineFromProbe,
  resolveConnectivity,
} from "../src/provider/connectivity.js";
import type { ModelTier, RouterConfig } from "../src/types.js";

function baseConfig(over: Partial<RouterConfig["routing"]> = {}): RouterConfig {
  return {
    models: {
      local_fast: {
        primary: {
          provider: "ollama",
          model: "llama",
          baseUrl: "http://localhost:11434/v1",
        },
      },
      local_strong: {
        primary: {
          provider: "ollama",
          model: "qwen",
          baseUrl: "http://localhost:11434/v1",
        },
      },
      hosted_oss: {
        primary: {
          provider: "litellm",
          model: "qwen-cloud",
          baseUrl: "http://localhost:4000/v1",
        },
      },
      premium: {
        primary: {
          provider: "litellm",
          model: "claude",
          baseUrl: "http://localhost:4000/v1",
        },
      },
    },
    routing: {
      defaultTier: "local_strong",
      maxRetriesPerTier: 1,
      enableEscalation: true,
      preferLocal: true,
      longContextTokenThreshold: 32000,
      probeAvailability: true,
      offlineLocalOnly: true,
      ...over,
    },
    telemetry: { enabled: false, logPath: "/tmp/x" },
  };
}

describe("connectivity / offline local-only", () => {
  beforeEach(() => {
    clearConnectivityCache();
  });

  it("checkInternet treats successful fetch as online", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 204 }) as unknown as Response;
    const r = await checkInternet(500, fetchImpl as typeof fetch);
    expect(r.online).toBe(true);
  });

  it("checkInternet is offline when all fetches fail", async () => {
    const fetchImpl = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = await checkInternet(200, fetchImpl as typeof fetch);
    expect(r.online).toBe(false);
    expect(r.reason).toBe("no internet");
  });

  it("isOfflineFromProbe when cloud down and local up", () => {
    const unavailable = new Set<ModelTier>(["hosted_oss", "premium"]);
    expect(
      isOfflineFromProbe(unavailable, ["local_fast", "local_strong"])
    ).toBe(true);
  });

  it("isOfflineFromProbe false when a cloud tier is up", () => {
    const unavailable = new Set<ModelTier>(["premium"]);
    expect(
      isOfflineFromProbe(unavailable, ["local_fast", "hosted_oss"])
    ).toBe(false);
  });

  it("isOfflineFromProbe false when locals are also down", () => {
    const unavailable = new Set<ModelTier>([
      "hosted_oss",
      "premium",
      "local_fast",
      "local_strong",
    ]);
    expect(isOfflineFromProbe(unavailable, [])).toBe(false);
  });

  it("resolveConnectivity forces local-only when internet fails", async () => {
    const fetchImpl = async () => {
      throw new Error("offline");
    };
    const status = await resolveConnectivity(baseConfig(), null, {
      force: true,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(status.online).toBe(false);
    expect(status.localOnlyForced).toBe(true);
    expect(status.reason).toBe("no internet");
  });

  it("resolveConnectivity uses probe when internet ok but cloud down", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 204 }) as unknown as Response;
    const status = await resolveConnectivity(
      baseConfig(),
      {
        unavailable: new Set<ModelTier>(["hosted_oss", "premium"]),
        results: [],
        tiers: [
          {
            tier: "local_fast",
            available: true,
            primary: {
              tier: "local_fast",
              slot: "primary",
              available: true,
              model: "llama",
              provider: "ollama",
            },
          },
          {
            tier: "local_strong",
            available: true,
            primary: {
              tier: "local_strong",
              slot: "primary",
              available: true,
              model: "qwen",
              provider: "ollama",
            },
          },
          {
            tier: "hosted_oss",
            available: false,
            primary: {
              tier: "hosted_oss",
              slot: "primary",
              available: false,
              model: "qwen-cloud",
              provider: "litellm",
            },
          },
          {
            tier: "premium",
            available: false,
            primary: {
              tier: "premium",
              slot: "primary",
              available: false,
              model: "claude",
              provider: "litellm",
            },
          },
        ],
      },
      { force: true, fetchImpl: fetchImpl as typeof fetch }
    );
    expect(status.online).toBe(false);
    expect(status.source).toBe("probe");
    expect(status.localOnlyForced).toBe(true);
  });

  it("applyOfflineLocalOnlyOverrides caps maxTier at local_strong", () => {
    const { overrides, forced, note } = applyOfflineLocalOnlyOverrides(
      { session: { maxTier: "premium" } },
      {
        online: false,
        reason: "no internet",
        source: "internet",
        localOnlyForced: true,
      },
      baseConfig()
    );
    expect(forced).toBe(true);
    expect(overrides.session?.maxTier).toBe("local_strong");
    expect(overrides.preferLocal).toBe(true);
    expect(note).toContain("offline → local-only");
  });

  it("respects offlineLocalOnly: false", () => {
    const { forced } = applyOfflineLocalOnlyOverrides(
      {},
      {
        online: false,
        reason: "no internet",
        source: "internet",
        localOnlyForced: true,
      },
      baseConfig({ offlineLocalOnly: false })
    );
    expect(forced).toBe(false);
  });
});
