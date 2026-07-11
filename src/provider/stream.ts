import type {
  ChatMessage,
  LLMResponse,
  ModelEndpointConfig,
  ModelTier,
} from "../types.js";
import { chatCompletion, type ChatCompletionRequest } from "./openai-compatible.js";

export interface StreamChunk {
  content: string;
  done: boolean;
  model?: string;
  usage?: LLMResponse["usage"];
}

export async function* chatCompletionStream(
  endpoint: ModelEndpointConfig,
  tier: ModelTier,
  request: ChatCompletionRequest
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
    stream: true,
  };

  if (request.tools?.length) body.tools = request.tools;
  if (request.responseFormat) body.response_format = request.responseFormat;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Stream failed ${response.status}: ${text.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
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
        yield { content: "", done: true, model: endpoint.model };
        return;
      }
      try {
        const parsed = JSON.parse(data) as {
          model?: string;
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          yield { content: delta, done: false, model: parsed.model ?? endpoint.model };
        }
      } catch {
        // ignore parse errors in stream chunks
      }
    }
  }

  yield { content: "", done: true, model: endpoint.model };
}

export async function routedLLMStream(
  endpoint: ModelEndpointConfig,
  tier: ModelTier,
  messages: ChatMessage[],
  tools?: unknown[]
): Promise<AsyncGenerator<StreamChunk>> {
  return chatCompletionStream(endpoint, tier, { messages, tools });
}
