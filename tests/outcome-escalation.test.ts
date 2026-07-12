import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { routedLLMCall } from "../src/routed-llm-call.js";
import { buildValidationOutcome, formatOutcomeMarkdown } from "../src/routing/outcome.js";
import { buildRoutingReport } from "../src/routing/report.js";
import { routedLLMCall } from "../src/routed-llm-call.js";
import type { RouterConfig, RoutingDecision } from "../src/types.js";

const CONFIG_JSON = `{
  "models": {
    "local_fast": { "provider": "ollama", "model": "fast", "baseUrl": "http://local/v1", "timeoutMs": 1000 },
    "local_strong": { "provider": "litellm", "model": "strong", "baseUrl": "http://local/v1", "timeoutMs": 1000 },
    "hosted_oss": { "provider": "litellm", "model": "hosted", "baseUrl": "http://local/v1", "timeoutMs": 1000 },
    "premium": { "provider": "litellm", "model": "premium", "baseUrl": "http://local/v1", "timeoutMs": 1000 }
  },
  "routing": {
    "defaultTier": "local_fast",
    "maxRetriesPerTier": 1,
    "enableEscalation": true,
    "preferLocal": true,
    "longContextTokenThreshold": 32000,
    "probeAvailability": false
  },
  "telemetry": { "enabled": false, "logPath": "/tmp/t.jsonl" }
}`;

function makeConfig(): RouterConfig {
  return loadConfigFromString(CONFIG_JSON);
}

const INITIAL_ROUTING: RoutingDecision = {
  tier: "local_fast",
  model: "fast",
  baseUrl: "http://local/v1",
  provider: "ollama",
  reason: "simple task",
  fallbackTier: "local_strong",
};

function mockFetchSequence(responses: Array<{ ok: boolean; body?: unknown }>) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const spec = responses[call] ?? responses[responses.length - 1];
    call++;
    return {
      ok: spec?.ok ?? true,
      status: 200,
      json: async () => spec?.body,
      text: async () => JSON.stringify(spec?.body),
    } as Response;
  }));
}

describe("buildValidationOutcome", () => {
  it("formats the killer escalation report", () => {
    const outcome = buildValidationOutcome({
      initialRouting: INITIAL_ROUTING,
      finalRouting: {
        ...INITIAL_ROUTING,
        tier: "local_strong",
        model: "strong",
        reason: "escalated",
      },
      attempts: [
        {
          tier: "local_fast",
          model: "fast",
          action: "initial",
          evaluation: {
            pass: false,
            reason: "Response is not valid JSON",
            retryRecommended: true,
            escalationRecommended: true,
            checks: [
              { name: "non_empty", pass: true },
              { name: "valid_json", pass: false, reason: "Response is not valid JSON" },
            ],
          },
        },
        {
          tier: "local_fast",
          model: "fast",
          action: "retry",
          evaluation: {
            pass: false,
            reason: "Response is not valid JSON",
            retryRecommended: true,
            escalationRecommended: true,
            checks: [
              { name: "non_empty", pass: true },
              { name: "valid_json", pass: false, reason: "Response is not valid JSON" },
            ],
          },
        },
        {
          tier: "local_strong",
          model: "strong",
          action: "escalation",
          evaluation: {
            pass: true,
            reason: "All checks passed",
            retryRecommended: false,
            escalationRecommended: false,
            checks: [{ name: "valid_json", pass: true }],
          },
        },
      ],
      evaluation: {
        pass: true,
        reason: "All checks passed",
        retryRecommended: false,
        escalationRecommended: false,
        checks: [],
      },
      escalated: true,
      maxRetriesPerTier: 1,
    });

    const markdown = formatOutcomeMarkdown(outcome);

    expect(outcome.summary).toContain("escalated");
    expect(outcome.final_pass).toBe(true);
    expect(outcome.why_escalated.length).toBeGreaterThan(0);
    expect(markdown).toContain("Selected: `fast`");
    expect(markdown).toContain("failed schema check");
    expect(markdown).toContain("retry same tier");
    expect(markdown).toContain("Escalated to: `strong`");
    expect(markdown).toContain("Final result:** passed");
  });
});

describe("evaluator-driven escalation flow", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("retries same tier then escalates on schema failure", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          choices: [{ message: { content: "not-json" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
      {
        ok: true,
        body: {
          choices: [{ message: { content: "still-not-json" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
      {
        ok: true,
        body: {
          model: "strong",
          choices: [{ message: { content: '{"ok": true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    ]);

    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Extract data as JSON" }],
        responseSchema: { type: "object" },
        modelTier: "local_fast",
      },
      { config: makeConfig() }
    );

    expect(result.escalated).toBe(true);
    expect(result.evaluation.pass).toBe(true);
    expect(result.initialRouting.tier).toBe("local_fast");
    expect(result.routing.tier).toBe("local_strong");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]?.action).toBe("initial");
    expect(result.attempts[1]?.action).toBe("retry");
    expect(result.attempts[2]?.action).toBe("escalation");
  });

  it("builds full report with validation outcome after routed call", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          choices: [{ message: { content: "bad" } }],
        },
      },
      {
        ok: true,
        body: {
          choices: [{ message: { content: "still bad" } }],
        },
      },
      {
        ok: true,
        body: {
          choices: [{ message: { content: '{"value": 1}' } }],
        },
      },
    ]);

    const config = makeConfig();
    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Return JSON with a value field" }],
        responseSchema: { type: "object", properties: { value: { type: "number" } } },
        modelTier: "local_fast",
      },
      { config }
    );

    const report = buildRoutingReport({
      routing: result.routing,
      analysis: result.analysis,
      config,
      callOutcome: {
        escalated: result.escalated,
        attempts: result.attempts,
        evaluation: result.evaluation,
        initialRouting: result.initialRouting,
        maxRetriesPerTier: config.routing.maxRetriesPerTier,
      },
    });

    expect(report.explanation.outcome).toBeDefined();
    expect(report.explanation.outcome?.final_pass).toBe(true);
    expect(report.explanation.markdown).toContain("**Validation**");
    expect(report.explanation.markdown).toContain("Why escalated?");
  });
});
