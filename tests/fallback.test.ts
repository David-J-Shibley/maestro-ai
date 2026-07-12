import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadConfigFromString } from "../src/config/load-config.js";
import { routedLLMCall } from "../src/routed-llm-call.js";
import { ProviderError } from "../src/provider/openai-compatible.js";
import type { RouterConfig } from "../src/types.js";

const CONFIG_JSON = `{
  "models": {
    "local_fast": { "provider": "ollama", "model": "fast", "baseUrl": "http://local/v1", "timeoutMs": 1000 },
    "local_strong": { "provider": "litellm", "model": "strong", "baseUrl": "http://local/v1", "timeoutMs": 1000 },
    "hosted_oss": { "provider": "litellm", "model": "hosted", "baseUrl": "http://local/v1", "timeoutMs": 1000 },
    "premium": { "provider": "litellm", "model": "premium", "baseUrl": "http://local/v1", "timeoutMs": 1000 }
  },
  "routing": {
    "defaultTier": "local_fast",
    "maxRetriesPerTier": 0,
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

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body?: unknown; reject?: Error }>) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const spec = responses[call] ?? responses[responses.length - 1];
    call++;
    if (spec?.reject) throw spec.reject;
    return {
      ok: spec?.ok ?? true,
      status: spec?.status ?? 200,
      json: async () => spec?.body,
      text: async () => JSON.stringify(spec?.body),
    } as Response;
  }));
}

describe("fallback and escalation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("retries invalid JSON then escalates tier", async () => {
    const config = loadConfigFromString(CONFIG_JSON.replace('"maxRetriesPerTier": 0', '"maxRetriesPerTier": 1'));
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
      { config },
    );

    expect(result.escalated).toBe(true);
    expect(result.evaluation.pass).toBe(true);
    expect(result.attempts.length).toBe(3);
    expect(result.attempts[0]?.tier).toBe("local_fast");
    expect(result.attempts[2]?.tier).toBe("local_strong");
  });

  it("escalates on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new ProviderError("timeout", "timeout"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "recovered response" } }],
        }),
        text: async () => "",
      } as Response));

    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Format this list." }],
      },
      { config: makeConfig() }
    );

    expect(result.escalated).toBe(true);
    expect(result.response.content).toBe("recovered response");
  });

  it("escalates on empty provider response", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          choices: [{ message: { content: "" }, finish_reason: "stop" }],
          usage: { completion_tokens: 50 },
        },
      },
      {
        ok: true,
        body: {
          model: "strong",
          choices: [{ message: { content: "recovered after empty glm" } }],
        },
      },
    ]);

    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Summarize this paragraph." }],
      },
      { config: makeConfig() }
    );

    expect(result.escalated).toBe(true);
    expect(result.response.content).toBe("recovered after empty glm");
  });

  it("escalates on invisible-only content", async () => {
    mockFetchSequence([
      {
        ok: true,
        body: {
          choices: [{ message: { content: "\u0000\u200B" }, finish_reason: "stop" }],
        },
      },
      {
        ok: true,
        body: {
          choices: [{ message: { content: "visible recovery" } }],
        },
      },
    ]);

    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Rewrite this sentence." }],
      },
      { config: makeConfig() }
    );

    expect(result.escalated).toBe(true);
    expect(result.response.content).toBe("visible recovery");
  });

  it("dry-run does not call fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Hello" }],
        overrides: { dryRunRouting: true },
      },
      { config: makeConfig() }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.telemetryId).toBe("dry-run");
    expect(result.routing.tier).toBeTruthy();
  });
});

describe("fixtures", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("simple rewrite fixture routes to local_strong", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await routedLLMCall(
      {
        messages: [{ role: "user", content: "Rewrite this sentence to be shorter." }],
        overrides: { dryRunRouting: true },
      },
      { config: makeConfig() }
    );

    expect(result.routing.tier).toBe("local_strong");
  });

  it("architecture fixture routes to premium", async () => {
    const result = await routedLLMCall(
      {
        messages: [
          {
            role: "user",
            content: "Design the architecture for a distributed task queue with trade-offs.",
          },
        ],
        overrides: { dryRunRouting: true },
      },
      { config: makeConfig() }
    );

    expect(result.routing.tier).toBe("premium");
  });
});
