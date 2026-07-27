/**
 * Transparent proxy for Cursor (OpenAI) and Claude Code (Anthropic).
 *
 * Claude Code uses ANTHROPIC_BASE_URL → POST {base}/v1/messages
 * (do NOT include /v1 in the base URL — Claude appends it).
 *
 * Always echo the client-requested model id; real routed model is in metadata.
 */
import { loadConfig } from "../config/load-config.js";
import { getPrimaryEndpoint } from "../config/tier-config.js";
import { dryRunRoute, routedLLMCall } from "../routed-llm-call.js";
import { chatCompletionStream } from "../provider/stream.js";
import type {
  ChatMessage,
  ModelTier,
  RouterConfig,
  RouterOverrides,
  RoutingMode,
} from "../types.js";
import { isRoutingMode } from "../routing/modes.js";
import { PACKAGE_VERSION } from "../version.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

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
    const ok = res.write(chunk);
    // Flush when possible so proxies/clients see bytes promptly.
    const sock = res.socket;
    if (sock && typeof (sock as { setNoDelay?: (v: boolean) => void }).setNoDelay === "function") {
      sock.setNoDelay(true);
    }
    if (!ok && typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
      /* backpressure — still ok */
    }
    return true;
  } catch (err) {
    log("write failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

function startSseHeartbeat(
  res: ServerResponse,
  protocol: "anthropic" | "openai",
  intervalMs = 5_000
): () => void {
  const tick = () => {
    if (!canWrite(res)) return;
    if (protocol === "anthropic") {
      safeWrite(res, `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
    } else {
      // SSE comment — keeps intermediaries/clients from idle-closing.
      safeWrite(res, `: ping ${Date.now()}\n\n`);
    }
  };
  // Immediate keepalive so the first-byte timeout never fires during routing.
  tick();
  const id = setInterval(tick, intervalMs);
  // Unref so heartbeats alone don't keep the process alive in tests.
  if (typeof id === "object" && "unref" in id) {
    (id as NodeJS.Timeout).unref();
  }
  return () => clearInterval(id);
}

/**
 * Claude Code retries with stream:false after stream idle timeout.
 * Keep the socket alive with leading whitespace (valid before JSON.parse).
 */
function beginJsonKeepalive(res: ServerResponse, intervalMs = 5_000): () => void {
  if (!canWrite(res) || res.headersSent) return () => undefined;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const tick = () => {
    safeWrite(res, " \n");
  };
  tick();
  const id = setInterval(tick, intervalMs);
  if (typeof id === "object" && "unref" in id) {
    (id as NodeJS.Timeout).unref();
  }
  return () => clearInterval(id);
}

function endJsonKeepalive(res: ServerResponse, body: unknown): void {
  if (!canWrite(res)) return;
  try {
    res.end(JSON.stringify(body));
  } catch (err) {
    log("endJsonKeepalive failed:", err instanceof Error ? err.message : err);
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function beginOpenAiSse(
  res: ServerResponse,
  opts: { id: string; model: string }
): void {
  if (!canWrite(res) || res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const created = Math.floor(Date.now() / 1000);
  safeWrite(
    res,
    `data: ${JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`
  );
}

function finishOpenAiSse(
  res: ServerResponse,
  opts: { id: string; model: string; content: string; maestro: Record<string, unknown> }
): void {
  if (!canWrite(res)) return;
  const created = Math.floor(Date.now() / 1000);
  safeWrite(
    res,
    `data: ${JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [{ index: 0, delta: { content: opts.content }, finish_reason: null }],
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

function beginAnthropicSse(
  res: ServerResponse,
  opts: { id: string; model: string; inputTokens?: number }
): void {
  if (!canWrite(res) || res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  safeWrite(
    res,
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: opts.id,
        type: "message",
        role: "assistant",
        content: [],
        model: opts.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: opts.inputTokens ?? 0, output_tokens: 0 },
      },
    })}\n\n`
  );
}

function writeAnthropicEvent(res: ServerResponse, event: string, data: unknown): boolean {
  return safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startAnthropicContentBlock(res: ServerResponse): void {
  writeAnthropicEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
}

function writeAnthropicTextDelta(res: ServerResponse, text: string): void {
  if (!text) return;
  writeAnthropicEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function endAnthropicMessage(res: ServerResponse, outputTokens: number): void {
  writeAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeAnthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

/** Fallback when upstream streaming is unavailable — dump full text as deltas. */
function finishAnthropicSse(
  res: ServerResponse,
  opts: {
    content: string;
    outputTokens: number;
  }
): void {
  if (!canWrite(res)) return;
  startAnthropicContentBlock(res);
  const text = opts.content;
  const chunkSize = 48;
  if (!text) {
    writeAnthropicTextDelta(res, "");
  } else {
    for (let i = 0; i < text.length; i += chunkSize) {
      writeAnthropicTextDelta(res, text.slice(i, i + chunkSize));
    }
  }
  endAnthropicMessage(res, opts.outputTokens);
}

function writeAnthropicSseError(res: ServerResponse, message: string): void {
  if (!canWrite(res)) return;
  if (!res.headersSent) {
    sendJson(res, 500, {
      type: "error",
      error: { type: "api_error", message },
    });
    return;
  }
  safeWrite(
    res,
    `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
    })}\n\n`
  );
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

function proxyOverrides(
  req: IncomingMessage,
  options: ProxyServerOptions
): RouterOverrides {
  const session =
    options.sessionId || options.maxTier || options.alwaysPreferLocal
      ? {
          sessionId: options.sessionId,
          maxTier: options.maxTier,
          alwaysPreferLocal: options.alwaysPreferLocal,
        }
      : undefined;
  return {
    mode: resolveMode(req, options),
    preferLocal: options.alwaysPreferLocal,
    session,
  };
}

/** Route once, then stream tokens live from the selected endpoint (no post-buffer). */
async function streamRoutedAnthropic(opts: {
  res: ServerResponse;
  req: IncomingMessage;
  messages: ChatMessage[];
  options: ProxyServerOptions;
  config: RouterConfig;
  clientModel: string;
  provisionalId: string;
  maxTokens?: number;
  started: number;
  verbose: boolean;
}): Promise<void> {
  const {
    res,
    req,
    messages,
    options,
    config,
    clientModel,
    provisionalId,
    maxTokens,
    started,
    verbose,
  } = opts;

  beginAnthropicSse(res, { id: provisionalId, model: clientModel });
  let stopHeartbeat = startSseHeartbeat(res, "anthropic", 5_000);

  try {
    const { routing } = await dryRunRoute(
      { messages, overrides: proxyOverrides(req, options) },
      { config }
    );
    stopHeartbeat();
    stopHeartbeat = () => undefined;

    if (req.aborted || res.destroyed) {
      if (verbose) log("client gone after route decision");
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }

    if (verbose) {
      log(
        `streaming via ${routing.provider}/${routing.model} tier=${routing.tier} ` +
          `(decision ${Date.now() - started}ms)`
      );
    }

    const endpoint = getPrimaryEndpoint(config, routing.tier);
    startAnthropicContentBlock(res);

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.once("aborted", onAbort);
    res.once("close", onAbort);

    let full = "";
    try {
      for await (const chunk of chatCompletionStream(
        endpoint,
        routing.tier,
        { messages, maxTokens },
        { signal: abort.signal }
      )) {
        if (abort.signal.aborted || !canWrite(res)) break;
        if (chunk.content) {
          full += chunk.content;
          writeAnthropicTextDelta(res, chunk.content);
        }
      }
    } finally {
      req.off("aborted", onAbort);
      res.off("close", onAbort);
    }

    if (!canWrite(res)) return;
    const outputTokens = Math.max(1, Math.ceil(full.length / 4));
    if (verbose) {
      log(
        `ok ${Date.now() - started}ms streamed=${full.length}ch routed=${routing.model} tier=${routing.tier}`
      );
    }
    endAnthropicMessage(res, outputTokens);
  } catch (err) {
    stopHeartbeat();
    throw err;
  }
}

async function streamRoutedOpenAi(opts: {
  res: ServerResponse;
  req: IncomingMessage;
  messages: ChatMessage[];
  options: ProxyServerOptions;
  config: RouterConfig;
  clientModel: string;
  provisionalId: string;
  maxTokens?: number;
  started: number;
  verbose: boolean;
}): Promise<void> {
  const {
    res,
    req,
    messages,
    options,
    config,
    clientModel,
    provisionalId,
    maxTokens,
    started,
    verbose,
  } = opts;

  beginOpenAiSse(res, { id: provisionalId, model: clientModel });
  let stopHeartbeat = startSseHeartbeat(res, "openai", 5_000);

  try {
    const { routing } = await dryRunRoute(
      { messages, overrides: proxyOverrides(req, options) },
      { config }
    );
    stopHeartbeat();
    stopHeartbeat = () => undefined;

    if (req.aborted || res.destroyed) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }

    const endpoint = getPrimaryEndpoint(config, routing.tier);
    const created = Math.floor(Date.now() / 1000);
    const maestroMeta = {
      tier: routing.tier,
      routed_model: routing.model,
      provider: routing.provider,
      reason: routing.reason,
    };

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.once("aborted", onAbort);
    res.once("close", onAbort);

    try {
      for await (const chunk of chatCompletionStream(
        endpoint,
        routing.tier,
        { messages, maxTokens },
        { signal: abort.signal }
      )) {
        if (abort.signal.aborted || !canWrite(res)) break;
        if (chunk.content) {
          safeWrite(
            res,
            `data: ${JSON.stringify({
              id: provisionalId,
              object: "chat.completion.chunk",
              created,
              model: clientModel,
              choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
              maestro: maestroMeta,
            })}\n\n`
          );
        }
      }
    } finally {
      req.off("aborted", onAbort);
      res.off("close", onAbort);
    }

    if (!canWrite(res)) return;
    safeWrite(
      res,
      `data: ${JSON.stringify({
        id: provisionalId,
        object: "chat.completion.chunk",
        created,
        model: clientModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    safeWrite(res, "data: [DONE]\n\n");
    try {
      res.end();
    } catch {
      /* ignore */
    }
    if (verbose) {
      log(`ok ${Date.now() - started}ms openai-stream routed=${routing.model}`);
    }
  } catch (err) {
    stopHeartbeat();
    throw err;
  }
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

  // Long Claude Code / Bedrock routes can exceed Node defaults.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 120_000;
  if (typeof server.timeout === "number") server.timeout = 0;

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
            `messages model=${clientModel} stream=${body.stream === true} ` +
              `(raw=${JSON.stringify(body.stream)}) ` +
              `msgs=${body.messages.length} tools=${Array.isArray(body.tools) ? body.tools.length : 0} ` +
              `bodyBytes=${raw.length}`
          );
        }

        if (req.aborted || res.destroyed) {
          if (verbose) log("client gone before route");
          return;
        }

        const chatMessages = anthropicToChatMessages(body.messages, body.system);
        const provisionalId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const wantsStream = body.stream === true;

        if (wantsStream) {
          try {
            await streamRoutedAnthropic({
              res,
              req,
              messages: chatMessages,
              options,
              config,
              clientModel,
              provisionalId,
              maxTokens:
                typeof body.max_tokens === "number" && body.max_tokens > 0
                  ? body.max_tokens
                  : undefined,
              started,
              verbose,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log("messages stream error:", err instanceof Error ? err.stack ?? err.message : err);
            writeAnthropicSseError(res, message);
          }
          return;
        }

        let stopHeartbeat: (() => void) | undefined = beginJsonKeepalive(res, 5_000);

        let result;
        try {
          result = await runRouted(chatMessages, req, options, config);
        } catch (err) {
          stopHeartbeat?.();
          const message = err instanceof Error ? err.message : String(err);
          log("messages error:", err instanceof Error ? err.stack ?? err.message : err);
          if (res.headersSent) {
            endJsonKeepalive(res, {
              type: "error",
              error: { type: "api_error", message },
            });
            return;
          }
          throw err;
        } finally {
          stopHeartbeat?.();
        }

        if (req.aborted || res.destroyed) {
          if (verbose) log("client gone after route");
          if (res.headersSent && canWrite(res)) {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
          return;
        }

        const text = asText(result.response.content);
        const id = `msg_${result.telemetryId ?? provisionalId}`;
        const inputTokens = result.response.usage?.promptTokens ?? 0;
        const outputTokens =
          result.response.usage?.completionTokens ??
          Math.max(1, Math.ceil(text.length / 4));

        if (verbose) {
          log(
            `ok ${Date.now() - started}ms routed=${result.routing.model} tier=${result.routing.tier}`
          );
        }

        endJsonKeepalive(res, {
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
        if (res.headersSent) {
          writeAnthropicSseError(
            res,
            err instanceof Error ? err.message : String(err)
          );
        } else {
          sendJson(res, 500, {
            type: "error",
            error: {
              type: "api_error",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
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

        const provisionalId = `maestro-${Date.now().toString(36)}`;
        if (body.stream) {
          try {
            await streamRoutedOpenAi({
              res,
              req,
              messages: body.messages,
              options,
              config,
              clientModel,
              provisionalId,
              started,
              verbose,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log("chat stream error:", err instanceof Error ? err.stack ?? err.message : err);
            if (res.headersSent) {
              safeWrite(
                res,
                `data: ${JSON.stringify({ error: { message, type: "maestro_proxy_error" } })}\n\n`
              );
              safeWrite(res, "data: [DONE]\n\n");
              try {
                res.end();
              } catch {
                /* ignore */
              }
            } else {
              sendJson(res, 500, {
                error: { message, type: "maestro_proxy_error" },
              });
            }
          }
          return;
        }

        const result = await runRouted(body.messages, req, options, config);
        if (req.aborted || res.destroyed) return;

        const text = asText(result.response.content);
        const id = `maestro-${result.telemetryId ?? provisionalId}`;
        const maestroMeta = {
          tier: result.routing.tier,
          routed_model: result.routing.model,
          provider: result.routing.provider,
          reason: result.routing.reason,
          escalated: result.escalated,
          telemetry_id: result.telemetryId,
        };

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
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "maestro_proxy_error",
            },
          });
        }
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
