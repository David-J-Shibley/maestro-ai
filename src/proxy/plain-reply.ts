import type { ModelEndpointConfig, ModelTier, RouterConfig } from "../types.js";
import { hashPrompt } from "../analyzer/task-analyzer.js";
import {
  anthropicMessagesCompletion,
} from "../provider/anthropic-messages.js";
import { chatCompletionWithTools } from "../provider/stream.js";
import type { ChatMessage } from "../types.js";
import { logTelemetry } from "../telemetry/logger.js";
import { setStickyTier } from "./session-sticky.js";
import { pushRouteLog } from "./route-log.js";
import {
  coercePlainAssistantText,
  mergeAnthropicSystem,
  needsPlainReplyRetry,
  normalizeAnthropicSystem,
  PLAIN_TEXT_RETRY_HINT,
  type AnthropicMessage,
} from "./anthropic-openai.js";

export type PlainOutcome = "ok" | "plain_retry_ok" | "plain_coerced" | "plain_fallback";

function asText(content: unknown): string {
  return typeof content === "string" ? content : content == null ? "" : String(content);
}

function extractNativeText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  return asText(content);
}

export async function completeAnthropicPlainText(opts: {
  endpoint: ModelEndpointConfig;
  messages: AnthropicMessage[];
  system?: unknown;
  maxTokens?: number;
  forwardHeaders?: Record<string, string>;
  fallback: string;
  hintExtra?: string;
  plainHint: string;
}): Promise<{ text: string; outcome: PlainOutcome; plainRetry: boolean }> {
  const systemWithHint = mergeAnthropicSystem(
    opts.system,
    [opts.plainHint, opts.hintExtra].filter(Boolean).join("\n")
  );

  const once = async (system: unknown) => {
    const norm = normalizeAnthropicSystem(opts.messages, system);
    const native = await anthropicMessagesCompletion(
      opts.endpoint,
      {
        model: opts.endpoint.model,
        messages: norm.messages,
        max_tokens: opts.maxTokens ?? 1024,
        ...(norm.system != null ? { system: norm.system } : {}),
      },
      { headers: opts.forwardHeaders }
    );
    return extractNativeText(native.content);
  };

  let rawText = await once(systemWithHint);
  let plainRetry = false;
  let outcome: PlainOutcome = "ok";

  if (needsPlainReplyRetry(rawText, opts.fallback)) {
    plainRetry = true;
    rawText = await once(mergeAnthropicSystem(systemWithHint, PLAIN_TEXT_RETRY_HINT));
    outcome = needsPlainReplyRetry(rawText, opts.fallback)
      ? "plain_fallback"
      : "plain_retry_ok";
  }

  const text = coercePlainAssistantText(rawText, opts.fallback);
  if (outcome === "ok" && text === opts.fallback) {
    outcome =
      !rawText.trim() || needsPlainReplyRetry(rawText, opts.fallback)
        ? "plain_fallback"
        : "plain_coerced";
  }
  return { text, outcome, plainRetry };
}

export async function completeOpenAiPlainText(opts: {
  endpoint: ModelEndpointConfig;
  tier: ModelTier;
  messages: ChatMessage[];
  maxTokens?: number;
  fallback: string;
}): Promise<{ text: string; outcome: PlainOutcome; plainRetry: boolean }> {
  const once = async (msgs: ChatMessage[]) => {
    const completion = await chatCompletionWithTools(opts.endpoint, opts.tier, {
      messages: msgs,
      maxTokens: opts.maxTokens ?? 1024,
    });
    return asText(completion.content);
  };

  let rawText = await once(opts.messages);
  let plainRetry = false;
  let outcome: PlainOutcome = "ok";

  if (needsPlainReplyRetry(rawText, opts.fallback)) {
    plainRetry = true;
    rawText = await once([
      ...opts.messages,
      { role: "system", content: PLAIN_TEXT_RETRY_HINT },
    ]);
    outcome = needsPlainReplyRetry(rawText, opts.fallback)
      ? "plain_fallback"
      : "plain_retry_ok";
  }

  const text = coercePlainAssistantText(rawText, opts.fallback);
  if (outcome === "ok" && text === opts.fallback) {
    outcome = "plain_fallback";
  }
  return { text, outcome, plainRetry };
}

export function recordPlainReplyTelemetry(opts: {
  config?: RouterConfig;
  sessionId?: string;
  ask?: string;
  text: string;
  routedModel: string;
  routedTier: ModelTier;
  started: number;
  outcome: PlainOutcome;
  plainRetry: boolean;
}): void {
  if (opts.sessionId) setStickyTier(opts.sessionId, opts.routedTier);
  pushRouteLog({
    at: new Date().toISOString(),
    ask: opts.ask?.slice(0, 80),
    tier: opts.routedTier,
    model: opts.routedModel,
    plain: true,
    latencyMs: Date.now() - opts.started,
    coerced: opts.outcome === "plain_coerced" || opts.outcome === "plain_fallback",
    plainRetry: opts.plainRetry,
    outcome: opts.outcome,
  });
  if (!opts.config) return;
  logTelemetry(opts.config, {
    promptHash: hashPrompt(opts.ask ?? opts.text),
    taskAnalysis: {
      taskType: "simple_answer",
      difficulty: "easy",
      riskLevel: "low",
      requiresToolUse: false,
      toolNeedScore: 0,
      requiresCodeReasoning: false,
      requiresLongContext: false,
      requiresStructuredOutput: false,
      confidence: 0.9,
      signals: ["proxy_plain"],
    },
    selectedTier: opts.routedTier,
    selectedModel: opts.routedModel,
    latencyMs: Date.now() - opts.started,
    success: true,
    routingReason: "proxy plain reply",
    attempts: opts.plainRetry ? 2 : 1,
    sessionId: opts.sessionId,
    outcome: opts.outcome,
  });
}
