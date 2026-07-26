import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxyServer } from "../src/proxy/server.js";

vi.mock("../src/routed-llm-call.js", () => ({
  routedLLMCall: vi.fn(async () => ({
    response: {
      content: "hello from maestro",
      model: "glm",
      tier: "local_strong",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      latencyMs: 10,
      raw: {},
    },
    analysis: {
      taskType: "simple_answer",
      difficulty: "easy",
      riskLevel: "low",
      requiresToolUse: false,
      requiresCodeReasoning: false,
      requiresLongContext: false,
      requiresStructuredOutput: false,
      estimatedComplexityScore: 1,
      confidence: 0.9,
      signals: [],
      promptHash: "x",
    },
    routing: {
      tier: "local_strong",
      model: "glm",
      provider: "litellm",
      baseUrl: "http://localhost:4000/v1",
      reason: "test",
      fallbackTier: null,
      debug: [],
    },
    initialRouting: {
      tier: "local_strong",
      model: "glm",
      provider: "litellm",
      baseUrl: "http://localhost:4000/v1",
      reason: "test",
      fallbackTier: null,
      debug: [],
    },
    evaluation: {
      pass: true,
      reason: "ok",
      retryRecommended: false,
      escalationRecommended: false,
      checks: [],
    },
    escalated: false,
    attempts: [],
    telemetryId: "tel-1",
  })),
}));

describe("maestro proxy", () => {
  const proxies: Array<ReturnType<typeof createProxyServer>> = [];

  afterEach(async () => {
    for (const p of proxies.splice(0)) {
      await p.close().catch(() => undefined);
    }
  });

  it("lists client aliases and echoes requested model (not routed glm)", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const { port } = await new Promise<{ port: number }>((resolve, reject) => {
      proxy.server.listen(0, "127.0.0.1", () => {
        const addr = proxy.server.address();
        if (addr && typeof addr === "object") resolve({ port: addr.port });
        else reject(new Error("no port"));
      });
    });

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then((r) => r.json());
    const ids = (models.data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain("maestro");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("glm");

    const completion = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    }).then((r) => r.json());

    expect(completion.model).toBe("claude-sonnet-4-6");
    expect(completion.choices[0].message.content).toBe("hello from maestro");
    expect(completion.maestro.routed_model).toBe("glm");
  });

  it("serves Anthropic /v1/messages for Claude Code (echoes model, streams SSE)", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const { port } = await new Promise<{ port: number }>((resolve, reject) => {
      proxy.server.listen(0, "127.0.0.1", () => {
        const addr = proxy.server.address();
        if (addr && typeof addr === "object") resolve({ port: addr.port });
        else reject(new Error("no port"));
      });
    });

    const msg = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test",
      },
      body: JSON.stringify({
        model: "maestro",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    }).then(async (r) => {
      expect(r.status).toBe(200);
      return r.json();
    });

    expect(msg.type).toBe("message");
    expect(msg.model).toBe("maestro");
    expect(msg.content[0].text).toBe("hello from maestro");
    expect(msg.maestro.routed_model).toBe("glm");

    const streamRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stream: true,
      }),
    });
    expect(streamRes.status).toBe(200);
    const sse = await streamRes.text();
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: content_block_delta");
    expect(sse).toContain('"model":"claude-sonnet-4-6"');
    expect(sse).toContain("hello from maestro");
    expect(sse).toContain("event: message_stop");
  });
});
