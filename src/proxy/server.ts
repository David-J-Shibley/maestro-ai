/**
 * Transparent proxy for Cursor (OpenAI) and Claude Code (Anthropic).
 *
 * Claude Code uses ANTHROPIC_BASE_URL → POST {base}/v1/messages
 * (do NOT include /v1 in the base URL — Claude appends it).
 *
 * Always echo the client-requested model id; real routed model is in metadata.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "../config/load-config.js";
import { routedLLMCall } from "../routed-llm-call.js";
import type {
  ChatMessage,
  ModelTier,
  RouterConfig,
  RouterOverrides,
  RoutingMode,
} from "../types.js";
import { isRoutingMode } from "../routing/modes.js";
import { PACKAGE_VERSION } from "../version.js";

export interface ProxyServerOptions {
  port?: number;
  host?: string;
  configPath?: string;
  mode?: RoutingMode;
  sessionId?: string;
  /** Cap routing so Claude Code never escalates to Bedrock/premium. */
  maxTier?: ModelTier;
  alwaysPreferLocal?: boolean;
  /** Log each request + errors to stderr (default true). */
  verbose?: boolean;
}

const CLIENT_MODEL_ALIASES = [
  "maestro",
  "maestro-ai",
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-4-6",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-latest",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "global.anthropic.claude-sonnet-4-6",
  "global.anthropic.claude-opus-4-6-v1",
  "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "o4-mini",
  "glm",
  "nemotron",
];

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

function log(...args: unknown[]): void {
  console.error("[maestro-proxy]", ...args);
}

function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (!canWrite(res)) return;
  try {
    const payload = JSON.stringify(body);
    if (!res.headersSent) {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      });
    }
    res.end(payload);
  } catch (err) {
    log("sendJson failed:", err instanceof Error ? err.message : err);
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key, X-Maestro-Mode, Anthropic-Version, Anthropic-Beta"
  );
}

function listModelIds(config: RouterConfig): string[] {
  const fromConfig = new Set<string>();
  for (const tier of Object.keys(config.models) as ModelTier[]) {
    const tc = config.models[tier];
    fromConfig.add(tc.primary.model);
    if (tc.fallback?.model) fromConfig.add(tc.fallback.model);
  }
  return [...new Set([...CLIENT_MODEL_ALIASES, ...fromConfig])];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as AnthropicContentBlock;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool_use") {
      parts.push(`[tool_use ${String(b.name ?? "")} ${JSON.stringify(b.input ?? {})}]`);
    } else if (b.type === "tool_result") {
      parts.push(`[tool_result ${contentToText(b.content)}]`);
    } else {
      const maybe = b as unknown as { content?: unknown };
      if (typeof maybe.content === "string") parts.push(maybe.content);
    }
  }
  return parts.join("\n");
}

function anthropicToChatMessages(
  messages: AnthropicMessage[],
  system?: unknown
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system != null && system !== "") {
    const sys =
      Array.isArray(system)
        ? contentToText(system)
        : typeof system === "string"
          ? system
          : contentToText(system);
    if (sys) out.push({ role: "system", content: sys });
  }
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: contentToText(m.content) });
  }
  return out;
}

function resolveMode(
  req: IncomingMessage,
  options: ProxyServerOptions
): RoutingMode | undefined {
  const modeHeader = req.headers["x-maestro-mode"];
  if (typeof modeHeader === "string" && isRoutingMode(modeHeader)) return modeHeader;
  return options.mode;
}

function safeWrite(res: ServerResponse, chunk: string): boolean {
  if (!canWrite(res)) return false;
  try {
    res.write(chunk);
    return true;
  } catch (err) {
    log("write failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

function writeOpenAiSse(
  res: ServerResponse,
  opts: { id: string; model: string; content: string; maestro: Record<string, unknown> }
): void {
  if (!canWrite(res) || res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  safeWrite(
    res,
    `data: ${JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [{ index: 0, delta: { role: "assistant", content: opts.content }, finish_reason: null }],
      maestro: opts.maestro,
    })}\n\n`
  );
  safeWrite(
    res,
    `data: ${JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`
  );
  safeWrite(res, "data: [DONE]\n\n");
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

/** Anthropic Messages streaming — Claude Code expects this event sequence. */
function writeAnthropicSse(
  res: ServerResponse,
  opts: {
    id: string;
    model: string;
    content: string;
    inputTokens: number;
    outputTokens: number;
  }
): void {
  if (!canWrite(res) || res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const writeEvent = (event: string, data: unknown) => {
    safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent("message_start", {
    type: "message_start",
    message: {
      id: opts.id,
      type: "message",
      role: "assistant",
      content: [],
      model: opts.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: opts.inputTokens, output_tokens: 0 },
    },
  });
  writeEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: opts.content },
  });
  writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  writeEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: opts.outputTokens },
  });
  writeEvent("message_stop", { type: "message_stop" });
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

function asText(content: unknown): string {
  return typeof content === "string" ? content : content == null ? "" : String(content);
}

async function runRouted(
  messages: ChatMessage[],
  req: IncomingMessage,
  options: ProxyServerOptions,
  config: RouterConfig
) {
  const session =
    options.sessionId || options.maxTier || options.alwaysPreferLocal
      ? {
          sessionId: options.sessionId,
          maxTier: options.maxTier,
          alwaysPreferLocal: options.alwaysPreferLocal,
        }
      : undefined;
  const overrides: RouterOverrides = {
    mode: resolveMode(req, options),
    preferLocal: options.alwaysPreferLocal,
    session,
  };
  return routedLLMCall({ messages, overrides }, { config });
}

function installProcessGuards(): void {
  if ((installProcessGuards as unknown as { done?: boolean }).done) return;
  (installProcessGuards as unknown as { done?: boolean }).done = true;

  process.on("uncaughtException", (err) => {
    log("uncaughtException (kept alive):", err);
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection (kept alive):", reason);
  });
}

export function createProxyServer(options: ProxyServerOptions = {}) {
  const port = options.port ?? 4100;
  const host = options.host ?? "127.0.0.1";
  const verbose = options.verbose !== false;
  const config = loadConfig(options.configPath);

  installProcessGuards();

  const server = createServer((req, res) => {
    // Attach early so EPIPE from client abort never becomes unhandled.
    res.on("error", (err) => {
      if (verbose) log("response error:", err.message);
    });
    req.on("error", (err) => {
      if (verbose) log("request error:", err.message);
    });

    void handleRequest(req, res).catch((err) => {
      log("handler crash:", err instanceof Error ? err.stack ?? err.message : err);
      sendJson(res, 500, {
        type: "error",
        error: {
          type: "api_error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (verbose) log(`${req.method} ${path}${url.search}`);

    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      sendJson(res, 200, {
        ok: true,
        service: "maestro-proxy",
        version: PACKAGE_VERSION,
        protocols: ["openai", "anthropic"],
      });
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      const created = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        object: "list",
        data: listModelIds(config).map((id) => ({
          id,
          object: "model",
          created,
          owned_by: "maestro-ai",
        })),
      });
      return;
    }

    // ── Anthropic Messages API (Claude Code) ──────────────────────────
    if (req.method === "POST" && path === "/v1/messages") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as {
          model?: string;
          messages?: AnthropicMessage[];
          system?: unknown;
          stream?: boolean;
          max_tokens?: number;
          tools?: unknown[];
        };

        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          sendJson(res, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: "messages array is required" },
          });
          return;
        }

        const clientModel =
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "claude-sonnet-4-6";

        if (verbose) {
          log(
            `messages model=${clientModel} stream=${Boolean(body.stream)} ` +
              `msgs=${body.messages.length} tools=${Array.isArray(body.tools) ? body.tools.length : 0} ` +
              `bodyBytes=${raw.length}`
          );
        }

        if (req.aborted || res.destroyed) {
          if (verbose) log("client gone before route");
          return;
        }

        const chatMessages = anthropicToChatMessages(body.messages, body.system);
        const result = await runRouted(chatMessages, req, options, config);
        if (req.aborted || res.destroyed) {
          if (verbose) log("client gone after route");
          return;
        }

        const text = asText(result.response.content);
        const id = `msg_${result.telemetryId ?? Date.now()}`;
        const inputTokens = result.response.usage?.promptTokens ?? 0;
        const outputTokens =
          result.response.usage?.completionTokens ??
          Math.max(1, Math.ceil(text.length / 4));

        if (verbose) {
          log(
            `ok ${Date.now() - started}ms routed=${result.routing.model} tier=${result.routing.tier}`
          );
        }

        if (body.stream) {
          writeAnthropicSse(res, {
            id,
            model: clientModel,
            content: text,
            inputTokens,
            outputTokens,
          });
          return;
        }

        sendJson(res, 200, {
          id,
          type: "message",
          role: "assistant",
          model: clientModel,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
          maestro: {
            tier: result.routing.tier,
            routed_model: result.routing.model,
            provider: result.routing.provider,
            reason: result.routing.reason,
            escalated: result.escalated,
            telemetry_id: result.telemetryId,
          },
        });
      } catch (err) {
        log("messages error:", err instanceof Error ? err.stack ?? err.message : err);
        sendJson(res, 500, {
          type: "error",
          error: {
            type: "api_error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      return;
    }

    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      sendJson(res, 200, { input_tokens: 1 });
      return;
    }

    // ── OpenAI Chat Completions (Cursor / generic) ────────────────────
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as {
          model?: string;
          messages?: ChatMessage[];
          stream?: boolean;
        };

        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          sendJson(res, 400, {
            error: { message: "messages array is required", type: "invalid_request_error" },
          });
          return;
        }

        const clientModel =
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "maestro";

        const result = await runRouted(body.messages, req, options, config);
        if (req.aborted || res.destroyed) return;

        const text = asText(result.response.content);
        const id = `maestro-${result.telemetryId ?? Date.now()}`;
        const maestroMeta = {
          tier: result.routing.tier,
          routed_model: result.routing.model,
          provider: result.routing.provider,
          reason: result.routing.reason,
          escalated: result.escalated,
          telemetry_id: result.telemetryId,
        };

        if (body.stream) {
          writeOpenAiSse(res, {
            id,
            model: clientModel,
            content: text,
            maestro: maestroMeta,
          });
          return;
        }

        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: clientModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: result.response.usage
            ? {
                prompt_tokens: result.response.usage.promptTokens ?? 0,
                completion_tokens: result.response.usage.completionTokens ?? 0,
                total_tokens: result.response.usage.totalTokens ?? 0,
              }
            : undefined,
          maestro: maestroMeta,
        });
      } catch (err) {
        log("chat error:", err instanceof Error ? err.stack ?? err.message : err);
        sendJson(res, 500, {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "maestro_proxy_error",
          },
        });
      }
      return;
    }

    sendJson(res, 404, {
      type: "error",
      error: {
        type: "not_found_error",
        message: `Not found: ${path}. Claude Code needs POST /v1/messages (set ANTHROPIC_BASE_URL=http://127.0.0.1:${port} without /v1).`,
      },
    });
  }

  server.on("clientError", (err, socket) => {
    if (verbose) log("clientError:", err.message);
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* ignore */
    }
  });

  return {
    server,
    port,
    host,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve({ host, port }));
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function startProxyServer(options: ProxyServerOptions = {}) {
  const proxy = createProxyServer(options);
  const addr = await proxy.listen();
  return { ...proxy, ...addr };
}
