import { mergeAnthropicSystem, PLAIN_TEXT_ONLY_HINT } from "./anthropic-openai.js";

/** Snapshot after consuming a native Anthropic SSE upstream stream. */
export type NativeStreamSnapshot = {
  sawMessageStart: boolean;
  sawMessageStop: boolean;
  textChars: number;
  upstreamError: string | null;
};

/**
 * Context overflow on tool-heavy Claude Code turns often yields bare
 * `message_start` (or an empty stream) with zero text before `message_stop`.
 */
export function isNativeContextOverflow(snapshot: NativeStreamSnapshot): boolean {
  if (snapshot.textChars > 0) return false;
  if (snapshot.sawMessageStop) return false;
  return snapshot.sawMessageStart || snapshot.upstreamError != null;
}

export function anthropicBodyForContextRetry<T extends {
  tools?: unknown[];
  tool_choice?: unknown;
  system?: unknown;
}>(body: T): T {
  return {
    ...body,
    tools: undefined,
    tool_choice: undefined,
    system: mergeAnthropicSystem(body.system, PLAIN_TEXT_ONLY_HINT),
  };
}
