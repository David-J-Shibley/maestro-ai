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
import { dryRunRoute } from "../routed-llm-call.js";
import { chatCompletionStream, chatCompletionWithTools } from "../provider/stream.js";
import type { StreamChunk, StreamToolCallDelta } from "../provider/stream.js";
import {
  anthropicMessagesCompletion,
  anthropicMessagesStream,
  extractStopReason,
  extractTextDeltaChars,
  rewriteAnthropicSseModel,
  supportsAnthropicMessages,
} from "../provider/anthropic-messages.js";
import {
  anthropicToChatMessages,
  anthropicToolsToOpenAi,
  extractLatestAnthropicUserAsk,
  mergeAnthropicSystem,
  normalizeAnthropicSystem,
  PLAIN_TEXT_ONLY_HINT,
  coercePlainAssistantText,
  plainReplyFallback,
  simplifyAnthropicMessagesForPlainReply,
  unwrapFakeToolText,
  type AnthropicMessage,
} from "./anthropic-openai.js";
import {
  isHarnessMetaAsk,
  isTrivialChitchat,
} from "../analyzer/task-analyzer.js";
import {
  resolveHarnessProfile,
  type HarnessProfile,
  type HarnessProfileName,
} from "./harness-profile.js";
import { getRouteLog } from "./route-log.js";
import { getStickyTier, setStickyTier } from "./session-sticky.js";
import {
  completeAnthropicPlainText,
  completeOpenAiPlainText,
  recordPlainReplyTelemetry,
} from "./plain-reply.js";
import { recordUserFeedback } from "../telemetry/logger.js";
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
import { randomUUID } from "node:crypto";

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
  /** Harness behavior profile (default claude-code). */
  profile?: HarnessProfileName | string;
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

/** Converts OpenAI stream chunks into Anthropic Messages SSE (text + tool_use). */
class AnthropicStreamEmitter {
  private nextIndex = 0;
  private textIndex: number | null = null;
  private textClosed = false;
  private readonly tools = new Map<
    number,
    {
      anthropicIndex: number;
      id: string;
      name: string;
      started: boolean;
      pendingArgs: string;
    }
  >();
  private fullText = "";
  private sawToolCalls = false;
  private finishReason: string | null = null;

  constructor(private readonly res: ServerResponse) {}

  handleChunk(chunk: StreamChunk): void {
    if (chunk.finishReason) this.finishReason = chunk.finishReason;

    if (chunk.content) {
      this.ensureTextOpen();
      this.fullText += chunk.content;
      writeAnthropicEvent(this.res, "content_block_delta", {
        type: "content_block_delta",
        index: this.textIndex,
        delta: { type: "text_delta", text: chunk.content },
      });
    }

    if (chunk.toolCallDeltas?.length) {
      this.closeTextIfOpen();
      for (const delta of chunk.toolCallDeltas) {
        this.handleToolDelta(delta);
      }
    }
  }

  private ensureTextOpen(): void {
    if (this.textIndex != null) return;
    this.textIndex = this.nextIndex++;
    writeAnthropicEvent(this.res, "content_block_start", {
      type: "content_block_start",
      index: this.textIndex,
      content_block: { type: "text", text: "" },
    });
  }

  private closeTextIfOpen(): void {
    if (this.textIndex == null || this.textClosed) return;
    writeAnthropicEvent(this.res, "content_block_stop", {
      type: "content_block_stop",
      index: this.textIndex,
    });
    this.textClosed = true;
  }

  private startTool(state: {
    anthropicIndex: number;
    id: string;
    name: string;
    started: boolean;
    pendingArgs: string;
  }): void {
    if (state.started) return;
    writeAnthropicEvent(this.res, "content_block_start", {
      type: "content_block_start",
      index: state.anthropicIndex,
      content_block: {
        type: "tool_use",
        id: state.id,
        name: state.name || "tool",
        input: {},
      },
    });
    state.started = true;
    if (state.pendingArgs) {
      writeAnthropicEvent(this.res, "content_block_delta", {
        type: "content_block_delta",
        index: state.anthropicIndex,
        delta: { type: "input_json_delta", partial_json: state.pendingArgs },
      });
      state.pendingArgs = "";
    }
  }

  private handleToolDelta(delta: StreamToolCallDelta): void {
    this.sawToolCalls = true;
    let state = this.tools.get(delta.index);
    if (!state) {
      state = {
        anthropicIndex: this.nextIndex++,
        id: delta.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`,
        name: delta.function?.name ?? "",
        started: false,
        pendingArgs: "",
      };
      this.tools.set(delta.index, state);
    } else {
      if (delta.id) state.id = delta.id;
      if (delta.function?.name) state.name = delta.function.name;
    }

    const argPart = delta.function?.arguments;
    if (argPart) {
      if (state.started) {
        writeAnthropicEvent(this.res, "content_block_delta", {
          type: "content_block_delta",
          index: state.anthropicIndex,
          delta: { type: "input_json_delta", partial_json: argPart },
        });
      } else {
        state.pendingArgs += argPart;
      }
    }

    if (!state.started && state.name) {
      this.startTool(state);
    }
  }

  finish(): { outputTokens: number; stopReason: string } {
    this.closeTextIfOpen();
    for (const state of this.tools.values()) {
      this.startTool(state);
      writeAnthropicEvent(this.res, "content_block_stop", {
        type: "content_block_stop",
        index: state.anthropicIndex,
      });
    }

    // Empty assistant reply — still need a text block for some clients
    if (this.textIndex == null && !this.sawToolCalls) {
      writeAnthropicEvent(this.res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      writeAnthropicEvent(this.res, "content_block_stop", {
        type: "content_block_stop",
        index: 0,
      });
    }

    const stopReason =
      this.sawToolCalls || this.finishReason === "tool_calls" ? "tool_use" : "end_turn";
    const outputTokens = Math.max(1, Math.ceil(this.fullText.length / 4));
    writeAnthropicEvent(this.res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    writeAnthropicEvent(this.res, "message_stop", { type: "message_stop" });
    try {
      this.res.end();
    } catch {
      /* ignore */
    }
    return { outputTokens, stopReason };
  }

  get textLength(): number {
    return this.fullText.length;
  }
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

function proxyOverrides(
  req: IncomingMessage,
  options: ProxyServerOptions,
  profile: HarnessProfile
): RouterOverrides {
  const headerSession = headerValue(req, "x-maestro-session-id");
  const sessionId = options.sessionId || headerSession || undefined;
  const stickyTier = getStickyTier(sessionId);
  const session =
    sessionId || options.maxTier || options.alwaysPreferLocal || stickyTier || profile.stickyLocalBias
      ? {
          sessionId: sessionId ?? (profile.stickyLocalBias ? "proxy-ephemeral" : undefined),
          maxTier: options.maxTier,
          alwaysPreferLocal: options.alwaysPreferLocal ?? (profile.stickyLocalBias || undefined),
          stickyTier,
        }
      : undefined;
  return {
    mode: resolveMode(req, options),
    preferLocal: options.alwaysPreferLocal ?? (profile.stickyLocalBias || undefined),
    session,
  };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw[0]) return raw[0].trim();
  return undefined;
}

/** Route once, then stream — prefer native Anthropic Messages via LiteLLM. */
async function streamRoutedAnthropic(opts: {
  res: ServerResponse;
  req: IncomingMessage;
  /** Messages used only for routing analysis (often just the latest human ask). */
  messages: ChatMessage[];
  /** Full converted history for OpenAI-fallback upstream calls. */
  fullMessages?: ChatMessage[];
  tools?: unknown[];
  anthropicBody: {
    messages: AnthropicMessage[];
    system?: unknown;
    tools?: unknown[];
    tool_choice?: unknown;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: unknown;
    metadata?: unknown;
  };
  forwardHeaders?: Record<string, string>;
  options: ProxyServerOptions;
  config: RouterConfig;
  clientModel: string;
  provisionalId: string;
  maxTokens?: number;
  started: number;
  verbose: boolean;
  /** Latest human ask — used to coerce fake tool JSON into a normal reply. */
  ask?: string;
}): Promise<void> {
  const {
    res,
    req,
    messages,
    fullMessages,
    tools,
    anthropicBody,
    forwardHeaders,
    options,
    config,
    clientModel,
    provisionalId,
    maxTokens,
    started,
    verbose,
    ask,
  } = opts;
  const upstreamMessages = fullMessages ?? messages;
  const plainFallback = plainReplyFallback(ask ?? "");
  const profile = resolveHarnessProfile(options.profile);

  // Route before opening SSE so native upstream can own message_start.
  const { routing, analysis } = await dryRunRoute(
    { messages, tools, overrides: proxyOverrides(req, options, profile) },
    { config }
  );

  if (req.aborted || res.destroyed) {
    if (verbose) log("client gone after route decision");
    return;
  }

  // When Claude Code attaches tools but this turn doesn't need them, omit tools.
  // The buffered plain-reply + greeting-fallback path is ONLY for trivial chitchat —
  // real Q&A (and harness meta like suggestion/recap) still omits tools but streams.
  const omitTools =
    profile.omitToolsWhenOmittable && !analysis.requiresToolUse;
  const askText = ask ?? "";
  const softPlain =
    omitTools &&
    Array.isArray(tools) &&
    tools.length > 0 &&
    isTrivialChitchat(askText);
  const plainReply = softPlain;
  const forwardTools = omitTools ? undefined : anthropicBody.tools;
  const forwardOpenAiTools = omitTools ? undefined : tools;

  const endpoint = getPrimaryEndpoint(config, routing.tier);
  const useNative = supportsAnthropicMessages(endpoint);

  if (verbose) {
    log(
      `streaming via ${routing.provider}/${routing.model} tier=${routing.tier} ` +
        `tools=${forwardTools?.length ?? 0}` +
        (tools?.length && !forwardTools ? ` (omitted ${tools.length})` : "") +
        `${plainReply ? " plain=1" : omitTools ? " omit_tools=1" : ""} native=${useNative} reason=${JSON.stringify(routing.reason).slice(0, 80)} ` +
        `(decision ${Date.now() - started}ms)`
    );
  }

  const plainAnthropicBody = plainReply
    ? {
        ...anthropicBody,
        tools: undefined,
        tool_choice: undefined,
        system: mergeAnthropicSystem(anthropicBody.system, PLAIN_TEXT_ONLY_HINT),
        messages: simplifyAnthropicMessagesForPlainReply(anthropicBody.messages),
      }
    : omitTools
      ? {
          ...anthropicBody,
          tools: undefined,
          tool_choice: undefined,
          system: mergeAnthropicSystem(anthropicBody.system, PLAIN_TEXT_ONLY_HINT),
        }
      : { ...anthropicBody, tools: forwardTools };

  if (useNative) {
    if (plainReply) {
      await respondAnthropicPlainText({
        res,
        endpoint,
        anthropicBody: plainAnthropicBody,
        forwardHeaders,
        clientModel,
        provisionalId,
        maxTokens,
        started,
        verbose,
        routedModel: routing.model,
        routedTier: routing.tier,
        fallback: plainFallback,
        config,
        sessionId: proxyOverrides(req, options, profile).session?.sessionId,
        ask,
        hintExtra: profile.plainTextHintExtra,
      });
      return;
    }
    await streamAnthropicNative({
      res,
      req,
      endpoint,
      anthropicBody: plainAnthropicBody,
      forwardHeaders,
      clientModel,
      provisionalId,
      maxTokens,
      started,
      verbose,
      routedModel: routing.model,
      routedTier: routing.tier,
    });
    return;
  }

  // OpenAI-compatible fallback (e.g. Ollama)
  if (plainReply) {
    await respondOpenAiPlainText({
      res,
      endpoint,
      tier: routing.tier,
      messages: [
        { role: "system", content: PLAIN_TEXT_ONLY_HINT },
        ...anthropicToChatMessages(
          simplifyAnthropicMessagesForPlainReply(anthropicBody.messages),
          anthropicBody.system
        ),
      ],
      maxTokens,
      clientModel,
      provisionalId,
      started,
      verbose,
      routedModel: routing.model,
      routedTier: routing.tier,
      fallback: plainFallback,
      config,
      sessionId: proxyOverrides(req, options, profile).session?.sessionId,
      ask,
    });
    return;
  }

  beginAnthropicSse(res, { id: provisionalId, model: clientModel });
  let stopHeartbeat = startSseHeartbeat(res, "anthropic", 5_000);
  stopHeartbeat();
  stopHeartbeat = () => undefined;

  const emitter = new AnthropicStreamEmitter(res);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.once("aborted", onAbort);
  res.once("close", onAbort);

  const openAiMessages = omitTools
    ? [
        { role: "system" as const, content: PLAIN_TEXT_ONLY_HINT },
        ...anthropicToChatMessages(anthropicBody.messages, anthropicBody.system),
      ]
    : upstreamMessages;

  try {
    for await (const chunk of chatCompletionStream(
      endpoint,
      routing.tier,
      { messages: openAiMessages, tools: forwardOpenAiTools, maxTokens },
      { signal: abort.signal }
    )) {
      if (abort.signal.aborted || !canWrite(res)) break;
      emitter.handleChunk(chunk);
    }
  } finally {
    req.off("aborted", onAbort);
    res.off("close", onAbort);
  }

  if (!canWrite(res)) return;
  const { stopReason } = emitter.finish();
  if (verbose) {
    log(
      `ok ${Date.now() - started}ms streamed=${emitter.textLength}ch ` +
        `stop=${stopReason} routed=${routing.model} tier=${routing.tier}` +
        `${omitTools ? " omit_tools=1" : ""}`
    );
  }
}

async function respondAnthropicPlainText(opts: {
  res: ServerResponse;
  endpoint: ReturnType<typeof getPrimaryEndpoint>;
  anthropicBody: {
    messages: AnthropicMessage[];
    system?: unknown;
    max_tokens?: number;
  };
  forwardHeaders?: Record<string, string>;
  clientModel: string;
  provisionalId: string;
  maxTokens?: number;
  started: number;
  verbose: boolean;
  routedModel: string;
  routedTier: string;
  fallback: string;
  config?: RouterConfig;
  sessionId?: string;
  ask?: string;
  hintExtra?: string;
}): Promise<void> {
  const {
    res,
    endpoint,
    anthropicBody,
    forwardHeaders,
    clientModel,
    provisionalId,
    maxTokens,
    started,
    verbose,
    routedModel,
    routedTier,
    fallback,
    config,
    sessionId,
    ask,
    hintExtra,
  } = opts;

  const { text, outcome, plainRetry } = await completeAnthropicPlainText({
    endpoint,
    messages: anthropicBody.messages,
    system: anthropicBody.system,
    maxTokens,
    forwardHeaders,
    fallback,
    plainHint: PLAIN_TEXT_ONLY_HINT,
    hintExtra,
  });
  recordPlainReplyTelemetry({
    config,
    sessionId,
    ask,
    text,
    routedModel,
    routedTier: routedTier as ModelTier,
    started,
    outcome,
    plainRetry,
  });
  emitAnthropicTextMessage(res, {
    id: provisionalId,
    model: clientModel,
    text,
  });
  if (verbose) {
    log(
      `ok ${Date.now() - started}ms streamed=${text.length}ch stop=end_turn ` +
        `routed=${routedModel} tier=${routedTier} plain=1` +
        `${plainRetry ? " plain_retry=1" : ""}` +
        `${outcome !== "ok" ? ` ${outcome}=1` : ""}`
    );
  }
}

async function respondOpenAiPlainText(opts: {
  res: ServerResponse;
  endpoint: ReturnType<typeof getPrimaryEndpoint>;
  tier: ModelTier;
  messages: ChatMessage[];
  maxTokens?: number;
  clientModel: string;
  provisionalId: string;
  started: number;
  verbose: boolean;
  routedModel: string;
  routedTier: string;
  fallback: string;
  config?: RouterConfig;
  sessionId?: string;
  ask?: string;
}): Promise<void> {
  const {
    res,
    endpoint,
    tier,
    messages,
    maxTokens,
    clientModel,
    provisionalId,
    started,
    verbose,
    routedModel,
    routedTier,
    fallback,
    config,
    sessionId,
    ask,
  } = opts;

  const { text, outcome, plainRetry } = await completeOpenAiPlainText({
    endpoint,
    tier,
    messages,
    maxTokens,
    fallback,
  });
  recordPlainReplyTelemetry({
    config,
    sessionId,
    ask,
    text,
    routedModel,
    routedTier: routedTier as ModelTier,
    started,
    outcome,
    plainRetry,
  });
  emitAnthropicTextMessage(res, {
    id: provisionalId,
    model: clientModel,
    text,
  });
  if (verbose) {
    log(
      `ok ${Date.now() - started}ms streamed=${text.length}ch stop=end_turn ` +
        `routed=${routedModel} tier=${routedTier} plain=1` +
        `${plainRetry ? " plain_retry=1" : ""}`
    );
  }
}

function emitAnthropicTextMessage(
  res: ServerResponse,
  opts: { id: string; model: string; text: string }
): void {
  beginAnthropicSse(res, { id: opts.id, model: opts.model });
  writeAnthropicEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  if (opts.text) {
    writeAnthropicEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: opts.text },
    });
  }
  writeAnthropicEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeAnthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: Math.max(1, Math.ceil(opts.text.length / 4)) },
  });
  writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

async function streamAnthropicNative(opts: {
  res: ServerResponse;
  req: IncomingMessage;
  endpoint: ReturnType<typeof getPrimaryEndpoint>;
  anthropicBody: {
    messages: AnthropicMessage[];
    system?: unknown;
    tools?: unknown[];
    tool_choice?: unknown;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: unknown;
    metadata?: unknown;
  };
  forwardHeaders?: Record<string, string>;
  clientModel: string;
  provisionalId: string;
  maxTokens?: number;
  started: number;
  verbose: boolean;
  routedModel: string;
  routedTier: string;
}): Promise<void> {
  const {
    res,
    req,
    endpoint,
    anthropicBody,
    forwardHeaders,
    clientModel,
    provisionalId,
    maxTokens,
    started,
    verbose,
    routedModel,
    routedTier,
  } = opts;

  if (!canWrite(res) || res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Comment keepalives until message_start — Anthropic `ping` before
  // message_start makes Claude Code report "Stream ended without receiving any events".
  let stopHeartbeat = startSseHeartbeat(res, "openai", 5_000);
  const abort = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) abort.abort();
  };
  req.once("aborted", onClientGone);
  req.once("close", onClientGone);

  let stopReason: string | null = null;
  let textChars = 0;
  let sawMessageStart = false;
  let sawMessageStop = false;
  let lastEvent: string | null = null;
  let upstreamError: string | null = null;

  try {
    const normalized = normalizeAnthropicSystem(
      anthropicBody.messages,
      anthropicBody.system
    );
    const upstreamReq = {
      model: endpoint.model,
      messages: normalized.messages,
      max_tokens:
        maxTokens ??
        (typeof anthropicBody.max_tokens === "number" && anthropicBody.max_tokens > 0
          ? anthropicBody.max_tokens
          : 4096),
      stream: true as const,
      ...(normalized.system != null ? { system: normalized.system } : {}),
      ...(anthropicBody.tools ? { tools: anthropicBody.tools } : {}),
      ...(anthropicBody.tool_choice != null
        ? { tool_choice: anthropicBody.tool_choice }
        : {}),
      ...(anthropicBody.temperature != null
        ? { temperature: anthropicBody.temperature }
        : {}),
      ...(anthropicBody.top_p != null ? { top_p: anthropicBody.top_p } : {}),
      ...(anthropicBody.top_k != null ? { top_k: anthropicBody.top_k } : {}),
      ...(anthropicBody.stop_sequences != null
        ? { stop_sequences: anthropicBody.stop_sequences }
        : {}),
      ...(anthropicBody.metadata != null ? { metadata: anthropicBody.metadata } : {}),
    };

    for await (const ev of anthropicMessagesStream(endpoint, upstreamReq, {
      signal: abort.signal,
      headers: forwardHeaders,
    })) {
      if (abort.signal.aborted || !canWrite(res)) break;
      // LiteLLM sometimes emits duplicate message_start frames for OpenAI→Anthropic.
      if (ev.event === "message_start" && lastEvent === "message_start") {
        continue;
      }
      lastEvent = ev.event;
      if (ev.event === "message_start" && !sawMessageStart) {
        stopHeartbeat();
        stopHeartbeat = () => undefined;
        sawMessageStart = true;
      }
      if (ev.event === "message_stop") sawMessageStop = true;
      if (ev.event === "error") {
        const errObj = ev.data as { error?: { message?: string }; message?: string };
        upstreamError =
          errObj?.error?.message ?? errObj?.message ?? "upstream error event";
      }
      const rewritten = rewriteAnthropicSseModel(ev, clientModel);
      const sr = extractStopReason(rewritten.data);
      if (sr) stopReason = sr;
      textChars += extractTextDeltaChars(rewritten.event, rewritten.data);
      const frame =
        rewritten.raw ||
        `event: ${rewritten.event}\ndata: ${JSON.stringify(rewritten.data)}\n\n`;
      safeWrite(res, frame);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    upstreamError = message;
    log("native stream error:", message);
    if (!sawMessageStart && canWrite(res)) {
      writeAnthropicEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: provisionalId,
          type: "message",
          role: "assistant",
          content: [],
          model: clientModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      writeAnthropicSseError(res, message);
      return;
    }
  } finally {
    req.off("aborted", onClientGone);
    req.off("close", onClientGone);
    stopHeartbeat();
  }

  if (abort.signal.aborted && !sawMessageStart) {
    if (canWrite(res)) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    if (verbose) log("client gone before upstream events");
    return;
  }

  // LiteLLM often ends after bare message_start when context length is exceeded.
  if (sawMessageStart && !sawMessageStop && canWrite(res)) {
    const msg =
      upstreamError ??
      `Upstream stream ended early for ${routedModel} (no message_stop). ` +
        `This usually means the prompt exceeded the model's context limit. ` +
        `Try --max-tier premium, a shorter session, or fewer tools.`;
    log("truncated native stream:", msg);
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    writeAnthropicEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    writeAnthropicEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
    writeAnthropicEvent(res, "error", {
      type: "error",
      error: { type: "api_error", message: msg },
    });
    stopReason = "end_turn";
  } else if (!sawMessageStart && canWrite(res)) {
    const msg =
      upstreamError ??
      `No events from upstream ${routedModel}. Check LiteLLM logs / context limits.`;
    log("empty native stream:", msg);
    writeAnthropicEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: provisionalId,
        type: "message",
        role: "assistant",
        content: [],
        model: clientModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    writeAnthropicSseError(res, msg);
    return;
  }

  if (canWrite(res)) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }

  if (verbose) {
    log(
      `ok ${Date.now() - started}ms streamed=${textChars}ch ` +
        `stop=${stopReason ?? "end_turn"} routed=${routedModel} tier=${routedTier} native=1` +
        (sawMessageStop ? "" : " truncated=1")
    );
  }
}

async function streamRoutedOpenAi(opts: {
  res: ServerResponse;
  req: IncomingMessage;
  messages: ChatMessage[];
  tools?: unknown[];
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
    tools,
    options,
    config,
    clientModel,
    provisionalId,
    maxTokens,
    started,
    verbose,
  } = opts;

  const profile = resolveHarnessProfile(options.profile);

  beginOpenAiSse(res, { id: provisionalId, model: clientModel });
  let stopHeartbeat = startSseHeartbeat(res, "openai", 5_000);

  try {
    const { routing } = await dryRunRoute(
      { messages, tools, overrides: proxyOverrides(req, options, profile) },
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

    let sawToolCalls = false;
    let lastFinish: string | null = null;

    try {
      for await (const chunk of chatCompletionStream(
        endpoint,
        routing.tier,
        { messages, tools, maxTokens },
        { signal: abort.signal }
      )) {
        if (abort.signal.aborted || !canWrite(res)) break;
        if (chunk.finishReason) lastFinish = chunk.finishReason;
        if (chunk.toolCallDeltas?.length) sawToolCalls = true;
        if (chunk.content || chunk.toolCallDeltas?.length) {
          safeWrite(
            res,
            `data: ${JSON.stringify({
              id: provisionalId,
              object: "chat.completion.chunk",
              created,
              model: clientModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(chunk.content ? { content: chunk.content } : {}),
                    ...(chunk.toolCallDeltas?.length
                      ? { tool_calls: chunk.toolCallDeltas }
                      : {}),
                  },
                  finish_reason: null,
                },
              ],
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
    const finishReason =
      sawToolCalls || lastFinish === "tool_calls" ? "tool_calls" : "stop";
    safeWrite(
      res,
      `data: ${JSON.stringify({
        id: provisionalId,
        object: "chat.completion.chunk",
        created,
        model: clientModel,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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
  const profile = resolveHarnessProfile(options.profile);
  const config = loadConfig(options.configPath);
  const ephemeralSessionId = options.sessionId ?? `proxy-${randomUUID().slice(0, 8)}`;

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

    if (req.method === "GET" && (path === "/status" || path === "/v1/status")) {
      sendJson(res, 200, {
        ok: true,
        service: "maestro-proxy",
        version: PACKAGE_VERSION,
        host,
        port,
        profile: profile.name,
        mode: options.mode ?? null,
        maxTier: options.maxTier ?? null,
        preferLocal: Boolean(options.alwaysPreferLocal || profile.stickyLocalBias),
        sessionId: options.sessionId ?? ephemeralSessionId,
        recentRoutes: getRouteLog(),
      });
      return;
    }

    if (req.method === "POST" && (path === "/v1/feedback" || path === "/feedback")) {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as {
          sessionId?: string;
          rating?: string | number;
          note?: string;
          feedback?: string;
          lastRequestId?: string;
          telemetryId?: string;
        };
        const feedback =
          body.feedback ||
          body.note ||
          (body.rating != null ? String(body.rating) : "");
        if (!feedback.trim()) {
          sendJson(res, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: "feedback or note required" },
          });
          return;
        }
        const id = recordUserFeedback(
          config,
          body.telemetryId || body.lastRequestId || "proxy-feedback",
          feedback.trim(),
          body.sessionId || options.sessionId || ephemeralSessionId
        );
        sendJson(res, 200, { ok: true, id });
      } catch (err) {
        sendJson(res, 400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
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
          tool_choice?: unknown;
          temperature?: number;
          top_p?: number;
          top_k?: number;
          stop_sequences?: unknown;
          metadata?: unknown;
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
        const openAiTools = anthropicToolsToOpenAi(
          Array.isArray(body.tools) ? body.tools : undefined
        );
        // Claude Code injects system-reminders into user turns; route on the real ask.
        const humanAsk = extractLatestAnthropicUserAsk(body.messages);
        const routeMessages: ChatMessage[] = humanAsk
          ? [{ role: "user", content: humanAsk }]
          : chatMessages;
        const provisionalId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const wantsStream = body.stream === true;
        const maxTokens =
          typeof body.max_tokens === "number" && body.max_tokens > 0
            ? body.max_tokens
            : undefined;
        const anthropicBody = {
          messages: body.messages,
          system: body.system,
          tools: Array.isArray(body.tools) ? body.tools : undefined,
          tool_choice: body.tool_choice,
          max_tokens: body.max_tokens,
          temperature: body.temperature,
          top_p: body.top_p,
          top_k: body.top_k,
          stop_sequences: body.stop_sequences,
          metadata: body.metadata,
        };
        const forwardHeaders: Record<string, string> = {};
        const beta = req.headers["anthropic-beta"];
        if (typeof beta === "string" && beta.trim()) {
          forwardHeaders["anthropic-beta"] = beta;
        } else if (Array.isArray(beta) && beta[0]) {
          forwardHeaders["anthropic-beta"] = beta[0];
        }

        if (verbose && humanAsk) {
          const preview =
            humanAsk.length > 80 ? `${humanAsk.slice(0, 80)}…` : humanAsk;
          log(
            `ask=${JSON.stringify(preview)} meta=${isHarnessMetaAsk(humanAsk)} chitchat=${isTrivialChitchat(humanAsk)}`
          );
        }

        if (wantsStream) {
          try {
            await streamRoutedAnthropic({
              res,
              req,
              messages: routeMessages,
              fullMessages: chatMessages,
              tools: openAiTools,
              anthropicBody,
              forwardHeaders,
              options,
              config,
              clientModel,
              provisionalId,
              maxTokens,
              started,
              verbose,
              ask: humanAsk || undefined,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log("messages stream error:", err instanceof Error ? err.stack ?? err.message : err);
            writeAnthropicSseError(res, message);
          }
          return;
        }

        let stopHeartbeat: (() => void) | undefined = beginJsonKeepalive(res, 5_000);

        try {
          const { routing, analysis } = await dryRunRoute(
            {
              messages: routeMessages,
              tools: openAiTools,
              overrides: proxyOverrides(req, options, profile),
            },
            { config }
          );
          if (req.aborted || res.destroyed) {
            if (verbose) log("client gone after route");
            try {
              res.end();
            } catch {
              /* ignore */
            }
            return;
          }

          const endpoint = getPrimaryEndpoint(config, routing.tier);
          let content: Array<Record<string, unknown>> = [];
          let stopReason = "end_turn";
          let inputTokens = 0;
          let outputTokens = 1;
          const omitTools =
            profile.omitToolsWhenOmittable && !analysis.requiresToolUse;
          const softPlain =
            omitTools &&
            Array.isArray(openAiTools) &&
            openAiTools.length > 0 &&
            isTrivialChitchat(humanAsk || "");
          const plainReply = softPlain;
          const forwardTools = omitTools ? undefined : anthropicBody.tools;
          const forwardOpenAiTools = omitTools ? undefined : openAiTools;

          if (supportsAnthropicMessages(endpoint)) {
            if (plainReply) {
              const { text, outcome, plainRetry } = await completeAnthropicPlainText({
                endpoint,
                messages: simplifyAnthropicMessagesForPlainReply(
                  anthropicBody.messages
                ),
                system: anthropicBody.system,
                maxTokens: maxTokens ?? 4096,
                forwardHeaders,
                fallback: plainReplyFallback(humanAsk || ""),
                plainHint: PLAIN_TEXT_ONLY_HINT,
                hintExtra: profile.plainTextHintExtra,
              });
              content = [{ type: "text", text }];
              stopReason = "end_turn";
              recordPlainReplyTelemetry({
                config,
                sessionId: proxyOverrides(req, options, profile).session?.sessionId,
                ask: humanAsk || undefined,
                text,
                routedModel: routing.model,
                routedTier: routing.tier,
                started,
                outcome,
                plainRetry,
              });
              stopHeartbeat?.();
              stopHeartbeat = undefined;
              inputTokens = 0;
              outputTokens = Math.max(1, Math.ceil(text.length / 4));
            } else {
              const bodyForUpstream = {
                messages: anthropicBody.messages,
                system: omitTools
                  ? mergeAnthropicSystem(anthropicBody.system, PLAIN_TEXT_ONLY_HINT)
                  : anthropicBody.system,
              };
              const normalized = normalizeAnthropicSystem(
                bodyForUpstream.messages,
                bodyForUpstream.system
              );
              const native = await anthropicMessagesCompletion(
                endpoint,
                {
                  model: endpoint.model,
                  messages: normalized.messages,
                  max_tokens: maxTokens ?? 4096,
                  ...(normalized.system != null ? { system: normalized.system } : {}),
                  ...(forwardTools ? { tools: forwardTools } : {}),
                  ...(anthropicBody.tool_choice != null && forwardTools
                    ? { tool_choice: anthropicBody.tool_choice }
                    : {}),
                },
                { headers: forwardHeaders }
              );
              stopHeartbeat?.();
              stopHeartbeat = undefined;

              content = Array.isArray(native.content)
                ? (native.content as Array<Record<string, unknown>>)
                : [{ type: "text", text: asText(native.content) }];
              stopReason =
                typeof native.stop_reason === "string" ? native.stop_reason : "end_turn";
              const usage = native.usage as
                | { input_tokens?: number; output_tokens?: number }
                | undefined;
              inputTokens = usage?.input_tokens ?? 0;
              outputTokens = usage?.output_tokens ?? 1;
            }
          } else {
            const completion = await chatCompletionWithTools(endpoint, routing.tier, {
              messages: plainReply
                ? [
                    { role: "system", content: PLAIN_TEXT_ONLY_HINT },
                    ...anthropicToChatMessages(
                      simplifyAnthropicMessagesForPlainReply(anthropicBody.messages),
                      anthropicBody.system
                    ),
                  ]
                : omitTools
                  ? [
                      { role: "system", content: PLAIN_TEXT_ONLY_HINT },
                      ...anthropicToChatMessages(
                        anthropicBody.messages,
                        anthropicBody.system
                      ),
                    ]
                  : chatMessages,
              tools: forwardOpenAiTools,
              maxTokens,
            });
            stopHeartbeat?.();
            stopHeartbeat = undefined;

            const text = plainReply
              ? coercePlainAssistantText(
                  asText(completion.content),
                  plainReplyFallback(humanAsk || "")
                )
              : unwrapFakeToolText(asText(completion.content));
            if (text) content.push({ type: "text", text });
            if (!plainReply && completion.toolCalls?.length) {
              for (const tc of completion.toolCalls) {
                let input: unknown = {};
                try {
                  input = JSON.parse(tc.function?.arguments || "{}");
                } catch {
                  input = { raw: tc.function?.arguments };
                }
                content.push({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.function?.name ?? "",
                  input,
                });
              }
            }
            if (content.length === 0) content.push({ type: "text", text: "" });
            stopReason =
              !plainReply &&
              (completion.toolCalls?.length || completion.finishReason === "tool_calls")
                ? "tool_use"
                : "end_turn";
            inputTokens = completion.usage?.promptTokens ?? 0;
            outputTokens =
              completion.usage?.completionTokens ??
              Math.max(1, Math.ceil(text.length / 4));
          }

          if (req.aborted || res.destroyed) {
            try {
              res.end();
            } catch {
              /* ignore */
            }
            return;
          }

          if (verbose) {
            log(
              `ok ${Date.now() - started}ms routed=${routing.model} tier=${routing.tier} stop=${stopReason}`
            );
          }

          endJsonKeepalive(res, {
            id: provisionalId,
            type: "message",
            role: "assistant",
            model: clientModel,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
            },
            maestro: {
              tier: routing.tier,
              routed_model: routing.model,
              provider: routing.provider,
              reason: routing.reason,
            },
          });
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
          tools?: unknown[];
          stream?: boolean;
          max_tokens?: number;
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
        const openAiTools =
          Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : undefined;
        const maxTokens =
          typeof body.max_tokens === "number" && body.max_tokens > 0
            ? body.max_tokens
            : undefined;

        const provisionalId = `maestro-${Date.now().toString(36)}`;
        if (body.stream) {
          try {
            await streamRoutedOpenAi({
              res,
              req,
              messages: body.messages,
              tools: openAiTools,
              options,
              config,
              clientModel,
              provisionalId,
              maxTokens,
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

        const { routing } = await dryRunRoute(
          {
            messages: body.messages,
            tools: openAiTools,
            overrides: proxyOverrides(req, options, profile),
          },
          { config }
        );
        if (req.aborted || res.destroyed) return;

        const endpoint = getPrimaryEndpoint(config, routing.tier);
        const completion = await chatCompletionWithTools(endpoint, routing.tier, {
          messages: body.messages,
          tools: openAiTools,
          maxTokens,
        });
        if (req.aborted || res.destroyed) return;

        const text = asText(completion.content);
        const finishReason =
          completion.toolCalls?.length || completion.finishReason === "tool_calls"
            ? "tool_calls"
            : "stop";
        const maestroMeta = {
          tier: routing.tier,
          routed_model: routing.model,
          provider: routing.provider,
          reason: routing.reason,
        };

        sendJson(res, 200, {
          id: provisionalId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: clientModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text || null,
                ...(completion.toolCalls?.length
                  ? { tool_calls: completion.toolCalls }
                  : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage: completion.usage
            ? {
                prompt_tokens: completion.usage.promptTokens ?? 0,
                completion_tokens: completion.usage.completionTokens ?? 0,
                total_tokens: completion.usage.totalTokens ?? 0,
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
