import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  chatCompletion,
  DEFAULT_MAX_TOKENS,
} from "../src/provider/openai-compatible.js";
import { chatCompletionStream } from "../src/provider/stream.js";
import type { ModelEndpointConfig } from "../src/types.js";

const ENDPOINT: ModelEndpointConfig = {
  provider: "ollama",
  model: "test-model",
  baseUrl: "http://local/v1",
  timeoutMs: 1000,
};

function mockOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => "",
    } as unknown as Response))
  );
}

function lastBody(): Record<string, unknown> {
  const mock = globalThis.fetch as unknown as {
    mock: { calls: unknown[][] };
  };
  const calls = mock.mock.calls;
  const last = calls[calls.length - 1];
  const init = last[1] as { body: string };
  return JSON.parse(init.body);
}

describe("chatCompletion max_tokens", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends max_tokens with the default budget when not specified", async () => {
    mockOk();
    await chatCompletion(ENDPOINT, "local_fast", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(lastBody().max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("respects an explicit maxTokens override", async () => {
    mockOk();
    await chatCompletion(ENDPOINT, "local_fast", {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 2048,
    });
    expect(lastBody().max_tokens).toBe(2048);
  });
});

describe("chatCompletionStream max_tokens", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("stream sends max_tokens with the default budget", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            for (const c of chunks) {
              controller.enqueue(new TextEncoder().encode(c));
            }
            controller.close();
          },
        }),
      } as unknown as Response))
    );

    const gen = chatCompletionStream(ENDPOINT, "local_fast", {
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of gen) {
      // consume the stream
    }

    expect(lastBody().max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });
});

describe("chatCompletionStream max_tokens", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("stream sends max_tokens with the default budget", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            for (const c of chunks) {
              controller.enqueue(new TextEncoder().encode(c));
            }
            controller.close();
          },
        }),
      } as unknown as Response))
    );

    const gen = chatCompletionStream(ENDPOINT, "local_fast", {
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of gen) {
      // consume the stream
    }

    expect(lastBody().max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });
});