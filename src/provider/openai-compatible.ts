import type {
  ChatMessage,
  LLMResponse,
  LLMUsage,
  ModelEndpointConfig,
  ModelTier,
} from "../types.js";

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: unknown };
  temperature?: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "http" | "empty" | "network" | "unknown",
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function chatCompletion(
  endpoint: ModelEndpointConfig,
  tier: ModelTier,
  request: ChatCompletionRequest
): Promise<LLMResponse> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
  };

  if (request.tools?.length) {
    body.tools = request.tools;
  }

  if (request.responseFormat) {
    body.response_format = request.responseFormat;
  }

  const timeoutMs = endpoint.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Provider returned ${response.status}: ${text.slice(0, 200)}`,
        "http",
        response.status
      );
    }

    const raw = (await response.json()) as ChatCompletionResponse;
    const content = extractContent(raw);

    if (!content.trim()) {
      throw new ProviderError("Empty response content", "empty");
    }

    return {
      content,
      model: raw.model ?? endpoint.model,
      tier,
      usage: mapUsage(raw.usage),
      latencyMs: Date.now() - start,
      raw,
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError(`Request timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new ProviderError(
      err instanceof Error ? err.message : String(err),
      "network"
    );
  } finally {
    clearTimeout(timer);
  }
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function extractContent(raw: ChatCompletionResponse): string {
  const choice = raw.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : "";
}

function mapUsage(usage?: ChatCompletionResponse["usage"]): LLMUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}
