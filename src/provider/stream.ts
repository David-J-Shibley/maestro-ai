import type {
  ChatMessage,
  ChatMessageToolCall,
  LLMResponse,
  ModelEndpointConfig,
  ModelTier,
} from "../types.js";
import {
  DEFAULT_MAX_TOKENS,
  type ChatCompletionRequest,
} from "./openai-compatible.js";

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface StreamChunk {
  content: string;
  done: boolean;
  model?: string;
  usage?: LLMResponse["usage"];
  /** Incremental OpenAI-style tool call patches */
  toolCallDeltas?: StreamToolCallDelta[];
  finishReason?: string | null;
}

export async function* chatCompletionStream(
  endpoint: ModelEndpointConfig,
  _tier: ModelTier,
  request: ChatCompletionRequest,
  options?: { signal?: AbortSignal }
): AsyncGenerator<StreamChunk> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };

  if (request.tools?.length) body.tools = request.tools;
  if (request.responseFormat) body.response_format = request.responseFormat;

  const timeoutMs = endpoint.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
    const text = await response.text().catch(() => "");
    throw new Error(`Stream failed ${response.status}: ${text.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastFinish: string | null | undefined;

  try {
    while (true) {
      if (options?.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield {
            content: "",
            done: true,
            model: endpoint.model,
            finishReason: lastFinish ?? null,
          };
          return;
        }
        try {
          const parsed = JSON.parse(data) as {
            model?: string;
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: StreamToolCallDelta[];
              };
              finish_reason?: string | null;
            }>;
          };
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) lastFinish = choice.finish_reason;
          const delta = choice?.delta?.content ?? "";
          const toolCallDeltas = choice?.delta?.tool_calls;
          if (delta || (toolCallDeltas && toolCallDeltas.length > 0)) {
            yield {
              content: delta || "",
              done: false,
              model: parsed.model ?? endpoint.model,
              toolCallDeltas,
              finishReason: choice?.finish_reason ?? null,
            };
          }
        } catch {
          // ignore parse errors in stream chunks
        }
      }
    }

    yield {
      content: "",
      done: true,
      model: endpoint.model,
      finishReason: lastFinish ?? null,
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function routedLLMStream(
  endpoint: ModelEndpointConfig,
  tier: ModelTier,
  messages: ChatMessage[],
  tools?: unknown[],
  maxTokens?: number,
  options?: { signal?: AbortSignal }
): Promise<AsyncGenerator<StreamChunk>> {
  return chatCompletionStream(endpoint, tier, { messages, tools, maxTokens }, options);
}

/** Non-stream completion that preserves tool_calls for the proxy. */
export async function chatCompletionWithTools(
  endpoint: ModelEndpointConfig,
  _tier: ModelTier,
  request: ChatCompletionRequest
): Promise<{
  content: string;
  toolCalls?: ChatMessageToolCall[];
  finishReason?: string | null;
  usage?: LLMResponse["usage"];
  model: string;
  latencyMs: number;
  raw?: unknown;
}> {
  const started = Date.now();
  // Reuse chatCompletion for text path when no tools — but we need raw tool_calls.
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (request.tools?.length) body.tools = request.tools;
  if (request.responseFormat) body.response_format = request.responseFormat;

  const timeoutMs = endpoint.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = (await response.json().catch(() => ({}))) as {
      model?: string;
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          tool_calls?: ChatMessageToolCall[];
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(
        `Completion failed ${response.status}: ${raw.error?.message ?? JSON.stringify(raw).slice(0, 200)}`
      );
    }
    const choice = raw.choices?.[0];
    const content = choice?.message?.content ?? "";
    return {
      content: typeof content === "string" ? content : "",
      toolCalls: choice?.message?.tool_calls,
      finishReason: choice?.finish_reason ?? null,
      usage: raw.usage
        ? {
            promptTokens: raw.usage.prompt_tokens,
            completionTokens: raw.usage.completion_tokens,
            totalTokens: raw.usage.total_tokens,
          }
        : undefined,
      model: raw.model ?? endpoint.model,
      latencyMs: Date.now() - started,
      raw,
    };
  } finally {
    clearTimeout(timer);
  }
}
