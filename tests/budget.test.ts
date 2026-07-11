import { describe, expect, it } from "vitest";
import {
  applyBudgetToTier,
  canEscalateWithinBudget,
  resolveBudgetStatus,
  tierCapForBudget,
} from "../src/routing/budget.js";
import { routeTask } from "../src/router/model-router.js";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import type { RouterConfig } from "../src/types.js";

const CONFIG_JSON = `{
  "models": {
    "local_fast": { "primary": { "provider": "ollama", "model": "llama", "baseUrl": "http://localhost:11434/v1" } },
    "local_strong": { "primary": { "provider": "ollama", "model": "qwen", "baseUrl": "http://localhost:11434/v1" } },
    "hosted_oss": { "primary": { "provider": "litellm", "model": "qwen-coder", "baseUrl": "http://localhost:4000/v1" } },
    "premium": { "primary": { "provider": "litellm", "model": "sonnet", "baseUrl": "http://localhost:4000/v1" } }
  },
  "routing": {
    "defaultTier": "local_strong",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": true, "logPath": "/tmp/maestro-budget-test.jsonl" }
}`;

function config(): RouterConfig {
  return loadConfigFromString(CONFIG_JSON);
}

describe("budget routing", () => {
  it("caps tier when budget is exhausted", () => {
    const debug: string[] = [];
    const tier = applyBudgetToTier(
      "premium",
      {
        sessionId: "s1",
        budgetUsd: 0.5,
        spentUsd: 0.5,
        remainingUsd: 0,
        capTier: "local_fast",
        enforced: true,
      },
      debug
    );
    expect(tier).toBe("local_fast");
    expect(debug.some((d) => d.includes("budget"))).toBe(true);
  });

  it("tierCapForBudget scales with remaining funds", () => {
    expect(tierCapForBudget(0)).toBe("local_fast");
    expect(tierCapForBudget(0.04)).toBe("local_strong");
    expect(tierCapForBudget(0.10)).toBe("hosted_oss");
    expect(tierCapForBudget(1)).toBe("premium");
  });

  it("blocks escalation beyond budget cap", () => {
    const budget = {
      sessionId: "s1",
      budgetUsd: 0.1,
      spentUsd: 0.09,
      remainingUsd: 0.01,
      capTier: "local_strong" as const,
      enforced: true,
    };
    expect(canEscalateWithinBudget("local_strong", budget)).toBe(true);
    expect(canEscalateWithinBudget("hosted_oss", budget)).toBe(false);
    expect(canEscalateWithinBudget("premium", budget)).toBe(false);
  });

  it("routes architecture to lower tier when budget exhausted", () => {
    const analysis = analyzeTask({
      userPrompt: "Design system architecture for event sourcing with trade-offs.",
    });
    const decision = routeTask({
      analysis,
      config: config(),
      overrides: {
        session: { sessionId: "empty-wallet", budgetUsd: 0.01 },
      },
    });
    expect(decision.tier).not.toBe("premium");
    expect(decision.budget).toBeTruthy();
  });

  it("resolveBudgetStatus returns null without budget", () => {
    expect(resolveBudgetStatus(undefined, config())).toBeNull();
  });
});
