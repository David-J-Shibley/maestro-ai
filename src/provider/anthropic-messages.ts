/**
 * Anthropic Messages API against LiteLLM (and compatible gateways).
 * Used by the proxy to avoid lossy Anthropic→OpenAI→Anthropic conversion.
 */
import type { ModelEndpointConfig } from "../types.js";

export type AnthropicMessagesRequest = {
  model: string;
  messages: unknown[];
  max_tokens: number;
  stream?: boolean;
  system?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: unknown;
  stop_sequences?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  [k: string]: unknown;
};

export type AnthropicSseEvent = {
  event: string;
  data: unknown;
  raw: string;
};

function messagesUrl(endpoint: ModelEndpointConfig): string {
  const base = endpoint.baseUrl.replace(/\/$/, "");
  // baseUrl is typically http://host:4000/v1
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function authHeaders(endpoint: ModelEndpointConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...extra,
  };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
    headers["x-api-key"] = endpoint.apiKey;
  }
  return headers;
}

/** Whether this endpoint should use native Anthropic Messages (LiteLLM). */
export function supportsAnthropicMessages(endpoint: ModelEndpointConfig): boolean {
  return endpoint.provider === "litellm" || endpoint.provider === "openai_compatible";
}

export async function anthropicMessagesCompletion(
  endpoint: ModelEndpointConfig,
  request: AnthropicMessagesRequest,
  options?: { signal?: AbortSignal; headers?: Record<string, string> }
): Promise<Record<string, unknown>> {
  const timeoutMs = endpoint.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const response = await fetch(messagesUrl(endpoint), {
      method: "POST",
      headers: authHeaders(endpoint, options?.headers),
      body: JSON.stringify({ ...request, model: endpoint.model, stream: false }),
      signal: controller.signal,
    });
    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const err = raw.error as { message?: string } | string | undefined;
      const msg =
        typeof err === "string"
          ? err
          : err?.message ?? JSON.stringify(raw).slice(0, 300);
      throw new Error(`Anthropic messages failed ${response.status}: ${msg}`);
    }
    return raw;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Stream Anthropic SSE events from the upstream Messages API.
 * Yields parsed events; caller forwards them to the client.
 */
export async function* anthropicMessagesStream(
  endpoint: ModelEndpointConfig,
  request: AnthropicMessagesRequest,
  options?: { signal?: AbortSignal; headers?: Record<string, string> }
): AsyncGenerator<AnthropicSseEvent> {
  const timeoutMs = endpoint.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(messagesUrl(endpoint), {
      method: "POST",
      headers: authHeaders(endpoint, options?.headers),
      body: JSON.stringify({ ...request, model: endpoint.model, stream: true }),
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
    throw new Error(`Anthropic stream failed ${response.status}: ${text.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";

  try {
    while (true) {
      if (options?.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";

      for (const line of parts) {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed === "") {
          // end of one SSE frame is handled when we see blank after data —
          // we emit on each data line with current event name (Anthropic style)
          continue;
        }
        if (trimmed.startsWith("event:")) {
          eventName = trimmed.slice(6).trim() || "message";
          continue;
        }
        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr) continue;
          let data: unknown = dataStr;
          try {
            data = JSON.parse(dataStr);
          } catch {
            /* keep string */
          }
          yield {
            event: eventName,
            data,
            raw: `event: ${eventName}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
          };
          eventName = "message";
        }
      }
    }
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Rewrite message_start so clients keep seeing their requested model id. */
export function rewriteAnthropicSseModel(
  event: AnthropicSseEvent,
  clientModel: string
): AnthropicSseEvent {
  if (event.event !== "message_start" || !event.data || typeof event.data !== "object") {
    return event;
  }
  const data = event.data as {
    type?: string;
    message?: { model?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  if (!data.message || typeof data.message !== "object") return event;
  const next = {
    ...data,
    message: { ...data.message, model: clientModel },
  };
  return {
    event: event.event,
    data: next,
    raw: `event: ${event.event}\ndata: ${JSON.stringify(next)}\n\n`,
  };
}

export function extractStopReason(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { delta?: { stop_reason?: string | null }; stop_reason?: string | null };
  if (d.delta?.stop_reason) return d.delta.stop_reason;
  if (d.stop_reason) return d.stop_reason;
  return null;
}

export function extractTextDeltaChars(event: string, data: unknown): number {
  if (event !== "content_block_delta" || !data || typeof data !== "object") return 0;
  const delta = (data as { delta?: { type?: string; text?: string } }).delta;
  if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text.length;
  return 0;
}
