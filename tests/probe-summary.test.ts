import { describe, expect, it } from "vitest";
import { formatProbeSummary } from "../src/routing/probe-summary.js";
import type { TierProbeStatus } from "../src/provider/probe.js";

describe("formatProbeSummary", () => {
  it("formats a compact one-line probe summary", () => {
    const tiers: TierProbeStatus[] = [
      {
        tier: "local_fast",
        available: true,
        primary: {
          tier: "local_fast",
          slot: "primary",
          available: true,
          latencyMs: 43,
          model: "llama3.2:latest",
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
          latencyMs: 14,
          model: "glm",
          provider: "litellm",
        },
        fallback: {
          tier: "local_strong",
          slot: "fallback",
          available: true,
          latencyMs: 5,
          model: "qwen3:8b",
          provider: "ollama",
        },
      },
    ];

    const summary = formatProbeSummary({ unavailable: new Set(), tiers });
    expect(summary).toContain("local_fast");
    expect(summary).toContain("43ms");
    expect(summary).toContain("fastest:");
    expect(summary).not.toContain("{");
  });
});
