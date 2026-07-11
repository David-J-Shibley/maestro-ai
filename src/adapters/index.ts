/**
 * Harness adapters — thin integration wrappers for Maestro AI.
 */
import { dryRunRoute, routedLLMCall, type RoutedLLMCallOptions } from "../routed-llm-call.js";
import type { ChatMessage, ModelTier, RoutedLLMCallInput } from "../types.js";

/** Benchy: route a sub-prompt before invoking claude -p */
export async function benchyRouteSubtask(
  prompt: string,
  options?: RoutedLLMCallOptions
) {
  return dryRunRoute(
    { messages: [{ role: "user", content: prompt }] },
    options
  );
}

/** Benchy: delegate a cheap subtask to Maestro instead of the main agent */
export async function benchyDelegate(
  prompt: string,
  options?: RoutedLLMCallOptions
) {
  return routedLLMCall(
    { messages: [{ role: "user", content: prompt }] },
    options
  );
}

/** Vercel-ai style: resolve tier + model id for @ai-sdk/openai-compatible */
export async function resolveMaestroModel(
  prompt: string,
  options?: RoutedLLMCallOptions
): Promise<{ tier: ModelTier; model: string; baseUrl: string; apiKey?: string }> {
  const { routing } = await dryRunRoute(
    { messages: [{ role: "user", content: prompt }] },
    options
  );
  return {
    tier: routing.tier,
    model: routing.model,
    baseUrl: routing.baseUrl,
    apiKey: undefined,
  };
}

/** Claude Code: suggest shell delegation command */
export function claudeCodeDelegateCommand(prompt: string): string {
  const escaped = prompt.replace(/"/g, '\\"');
  return `npx maestro ask "${escaped}" --json`;
}

export function buildClaudeCodeHookInput(messages: ChatMessage[]): RoutedLLMCallInput {
  return { messages };
}
