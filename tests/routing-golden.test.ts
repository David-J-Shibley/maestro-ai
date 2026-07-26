import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/analyzer/task-analyzer.js";
import { loadConfigFromString } from "../src/config/load-config.js";
import { loadPolicyFromString } from "../src/config/policy.js";
import { routeTask } from "../src/router/model-router.js";
import type { ModelTier } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type GoldenCase = {
  id: string;
  prompt: string;
  expectedTier: ModelTier | ModelTier[];
  expectedTaskType?: string;
  notes?: string;
};

const cases = JSON.parse(
  readFileSync(join(__dirname, "fixtures/routing-golden.json"), "utf8")
) as GoldenCase[];

const config = loadConfigFromString(`{
  "models": {
    "local_fast": { "provider": "ollama", "model": "fast", "baseUrl": "http://l/v1" },
    "local_strong": { "provider": "ollama", "model": "strong", "baseUrl": "http://l/v1" },
    "hosted_oss": { "provider": "litellm", "model": "hosted", "baseUrl": "http://l/v1" },
    "premium": { "provider": "litellm", "model": "premium", "baseUrl": "http://l/v1" }
  },
  "routing": {
    "defaultTier": "local_strong",
    "defaultMode": "balanced",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`);

config.policy = loadPolicyFromString(`{
  "task_type_tiers": {
    "summarization": "local_strong",
    "rewriting": "local_strong",
    "extraction": "local_strong",
    "formatting": "local_fast",
    "architecture": "premium",
    "debugging": "hosted_oss",
    "refactoring": "hosted_oss"
  },
  "privacy": {
    "keywords": ["password", "api key", "secret", "credential"],
    "max_tier": "local_strong",
    "detect_secrets": true,
    "reason": "privacy"
  }
}`);

function matchesTier(actual: ModelTier, expected: ModelTier | ModelTier[]): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

describe("routing golden set", () => {
  it(`covers ${cases.length} prompts with expected tiers (no live probe)`, () => {
    const failures: string[] = [];

    for (const c of cases) {
      const analysis = analyzeTask({ userPrompt: c.prompt });
      if (c.expectedTaskType && analysis.taskType !== c.expectedTaskType) {
        failures.push(
          `${c.id}: taskType expected ${c.expectedTaskType}, got ${analysis.taskType}`
        );
      }

      const decision = routeTask({
        analysis,
        config,
        userPrompt: c.prompt,
      });

      if (!matchesTier(decision.tier, c.expectedTier)) {
        failures.push(
          `${c.id}: tier expected ${JSON.stringify(c.expectedTier)}, got ${decision.tier} (${decision.reason})`
        );
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
