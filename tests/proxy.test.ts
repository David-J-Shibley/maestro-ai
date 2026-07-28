import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxyServer } from "../src/proxy/server.js";
import { dryRunRoute } from "../src/routed-llm-call.js";
import { chatCompletionWithTools } from "../src/provider/stream.js";
import {
  anthropicMessagesCompletion,
  anthropicMessagesStream,
} from "../src/provider/anthropic-messages.js";

vi.mock("../src/routed-llm-call.js", () => ({
  routedLLMCall: vi.fn(),
  dryRunRoute: vi.fn(async () => ({
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
  })),
}));

vi.mock("../src/provider/stream.js", () => ({
  chatCompletionStream: vi.fn(async function* () {
    yield { content: "hel", done: false, model: "glm" };
    await new Promise((r) => setTimeout(r, 5));
    yield { content: "lo from maestro", done: false, model: "glm" };
    yield { content: "", done: true, model: "glm" };
  }),
  chatCompletionWithTools: vi.fn(async () => ({
    content: "hello from maestro",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    model: "glm",
    latencyMs: 10,
    raw: {},
  })),
}));

vi.mock("../src/provider/anthropic-messages.js", () => ({
  supportsAnthropicMessages: vi.fn(() => true),
  rewriteAnthropicSseModel: vi.fn((ev: { event: string; data: unknown; raw: string }, model: string) => {
    if (ev.event !== "message_start" || !ev.data || typeof ev.data !== "object") return ev;
    const data = ev.data as { message?: { model?: string } };
    if (!data.message) return ev;
    const next = { ...data, message: { ...data.message, model } };
    return {
      event: ev.event,
      data: next,
      raw: `event: ${ev.event}\ndata: ${JSON.stringify(next)}\n\n`,
    };
  }),
  extractStopReason: vi.fn((data: unknown) => {
    if (!data || typeof data !== "object") return null;
    const d = data as { delta?: { stop_reason?: string }; stop_reason?: string };
    return d.delta?.stop_reason ?? d.stop_reason ?? null;
  }),
  extractTextDeltaChars: vi.fn((event: string, data: unknown) => {
    if (event !== "content_block_delta" || !data || typeof data !== "object") return 0;
    const delta = (data as { delta?: { type?: string; text?: string } }).delta;
    return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text.length : 0;
  }),
  anthropicMessagesStream: vi.fn(async function* () {
    yield {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_up",
          type: "message",
          role: "assistant",
          content: [],
          model: "glm",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      raw: "",
    };
    yield {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      raw: "",
    };
    yield {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hel" },
      },
      raw: "",
    };
    await new Promise((r) => setTimeout(r, 5));
    yield {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo from maestro" },
      },
      raw: "",
    };
    yield {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
      raw: "",
    };
    yield {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      raw: "",
    };
    yield {
      event: "message_stop",
      data: { type: "message_stop" },
      raw: "",
    };
  }),
  anthropicMessagesCompletion: vi.fn(async () => ({
    id: "msg_json",
    type: "message",
    role: "assistant",
    model: "glm",
    content: [{ type: "text", text: "json ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  })),
}));

vi.mock("../src/config/tier-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/tier-config.js")>();
  return {
    ...actual,
    getPrimaryEndpoint: vi.fn(() => ({
      provider: "litellm",
      model: "glm",
      baseUrl: "http://localhost:4000/v1",
      apiKey: "sk-test",
    })),
  };
});

async function listen(proxy: ReturnType<typeof createProxyServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    proxy.server.listen(0, "127.0.0.1", () => {
      const addr = proxy.server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
}

describe("maestro proxy", () => {
  const proxies: Array<ReturnType<typeof createProxyServer>> = [];

  afterEach(async () => {
    for (const p of proxies.splice(0)) {
      await p.close().catch(() => undefined);
    }
    vi.mocked(dryRunRoute).mockClear();
    vi.mocked(chatCompletionWithTools).mockClear();
    vi.mocked(anthropicMessagesStream).mockClear();
    vi.mocked(anthropicMessagesCompletion).mockClear();
  });

  it("lists client aliases and echoes requested model (not routed glm)", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const port = await listen(proxy);

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
    expect(chatCompletionWithTools).toHaveBeenCalled();
  });

  it("streams Anthropic deltas live (not one buffered dump)", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const port = await listen(proxy);

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
    expect(sse).toContain('"text":"hel"');
    expect(sse).toContain('"text":"lo from maestro"');
    expect(sse).toContain("event: message_stop");
    expect(dryRunRoute).toHaveBeenCalled();
    expect(anthropicMessagesStream).toHaveBeenCalled();
  });

  it("passes Anthropic tools natively and streams tool_use SSE", async () => {
    vi.mocked(dryRunRoute).mockResolvedValueOnce({
      analysis: {
        taskType: "code_edit",
        difficulty: "medium",
        riskLevel: "medium",
        requiresToolUse: true,
        requiresCodeReasoning: true,
        requiresLongContext: false,
        requiresStructuredOutput: false,
        estimatedComplexityScore: 3,
        confidence: 0.9,
        signals: ["tools_needed"],
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
    } as Awaited<ReturnType<typeof dryRunRoute>>);

    vi.mocked(anthropicMessagesStream).mockImplementationOnce(async function* () {
      yield {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_t",
            type: "message",
            role: "assistant",
            content: [],
            model: "glm",
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        raw: "",
      };
      yield {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call_1", name: "Bash", input: {} },
        },
        raw: "",
      };
      yield {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
        },
        raw: "",
      };
      yield {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: 0 },
        raw: "",
      };
      yield {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 8 },
        },
        raw: "",
      };
      yield {
        event: "message_stop",
        data: { type: "message_stop" },
        raw: "",
      };
    });

    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const port = await listen(proxy);

    const tools = [
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ];

    const streamRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        tools,
        messages: [{ role: "user", content: "list files" }],
        stream: true,
      }),
    });
    expect(streamRes.status).toBe(200);
    const sse = await streamRes.text();
    expect(sse).toContain('"type":"tool_use"');
    expect(sse).toContain('"name":"Bash"');
    expect(sse).toContain("input_json_delta");
    expect(sse).toContain('"stop_reason":"tool_use"');

    const streamCall = vi.mocked(anthropicMessagesStream).mock.calls.at(-1);
    expect(streamCall?.[1]?.tools).toEqual(tools);
    expect(dryRunRoute).toHaveBeenCalledWith(
      expect.objectContaining({ tools: expect.any(Array) }),
      expect.anything()
    );
  });

  it("returns Anthropic tool_use on non-stream completions", async () => {
    vi.mocked(dryRunRoute).mockResolvedValueOnce({
      analysis: {
        taskType: "code_edit",
        difficulty: "medium",
        riskLevel: "medium",
        requiresToolUse: true,
        requiresCodeReasoning: true,
        requiresLongContext: false,
        requiresStructuredOutput: false,
        estimatedComplexityScore: 3,
        confidence: 0.9,
        signals: ["tools_needed"],
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
    } as Awaited<ReturnType<typeof dryRunRoute>>);

    vi.mocked(anthropicMessagesCompletion).mockResolvedValueOnce({
      id: "msg_write",
      type: "message",
      role: "assistant",
      model: "glm",
      content: [
        {
          type: "tool_use",
          id: "call_write",
          name: "Write",
          input: { path: "a.txt", content: "hi" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 5 },
    });

    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const port = await listen(proxy);

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "maestro",
        max_tokens: 64,
        tools: [
          {
            name: "Write",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [{ role: "user", content: "write a file" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const msg = await res.json();
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content).toEqual([
      {
        type: "tool_use",
        id: "call_write",
        name: "Write",
        input: { path: "a.txt", content: "hi" },
      },
    ]);
  });

  it("keeps non-stream JSON responses alive with leading whitespace", async () => {
    vi.mocked(anthropicMessagesCompletion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              id: "msg_json",
              type: "message",
              role: "assistant",
              model: "glm",
              content: [{ type: "text", text: "json ok" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 2 },
            });
          }, 80);
        })
    );

    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" });
    proxies.push(proxy);
    const port = await listen(proxy);

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "maestro",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw.trimStart().startsWith("{")).toBe(true);
    const msg = JSON.parse(raw);
    expect(msg.content[0].text).toBe("json ok");
    expect(msg.model).toBe("maestro");
  });
});
