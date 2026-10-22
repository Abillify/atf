// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared stream types for the LLM node handler attempt loop.
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged.
 */
import type { ModelMessage, streamText } from "ai";

export type StreamPart = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /**
     * Prompt-cache read tokens (a SUBSET of `inputTokens`, not an addition
     * to it) — verified against a live Bedrock Haiku endpoint, which reports
     * e.g. `{inputTokens: 11697, inputTokenDetails: {cacheReadTokens: 11680,
     * noCacheTokens: 17}}` on a warm prefix.
     *
     * This is the ai@7 `LanguageModelUsage` shape. `cachedInputTokens` below
     * is the older provider-level field name and is kept as a fallback so a
     * provider still emitting it is not silently ignored.
     */
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    /** Legacy/alternate field name for the same quantity. */
    cachedInputTokens?: number;
  };
  error?: unknown;
};

export class StreamErrorSignal extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Streaming state machine of the contract-bound final answer. */
export type FinalAnswerStreamState =
  | "seeking-start"
  | "streaming"
  | "ended"
  | "interrupted";

/** Token accounting of one provider attempt. */
export interface LlmAttemptUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number | undefined;
}

/**
 * The `streamText(...)` result consumed by the attempt stream/postprocess.
 * ai@7.0.143 widens the return type to a union with a low-memory
 * single-consumer variant, returned only when `experimental_lowMemory: true`
 * is passed. ATF never passes that flag, so the full result — the one
 * carrying `response`/`responseMessages` — is the only shape that occurs.
 */
export type LlmStreamResult = Extract<
  ReturnType<typeof streamText>,
  { response: unknown; responseMessages: unknown }
>;

/** Mutable state shared between the candidate head, the attempt stream, the
 * post-processing and the error handler of one LLM node execution. Each
 * field mirrors a `let` of the original single-function implementation. */
export interface LlmAttemptState {
  fullText: string;
  finalAnswerBuffer: string;
  reasoningText: string;
  emittedAny: boolean;
  forcedAnswer: boolean;
  emptyResponseFallbackUsed: boolean;
  textWithoutToolCall: boolean;
  thinkBuf: string;
  inThink: boolean;
  toolPhaseStarted: boolean;
  stepLookahead: string | undefined;
  visibleTextLengthAtLastToolResult: number | undefined;
  lastToolResultForRetry: unknown;
  preambleBuf: string;
  preambleResolved: boolean;
  preambleStartedAt: number;
  loopAborted: boolean;
  outputAborted: boolean;
  repScanAt: number;
  finalAnswerOnly: boolean;
  retryGuidance: ModelMessage | undefined;
  retryContinuation: ModelMessage[] | undefined;
  lastErrMsg: string;
  policySuppressedToolFallback: boolean;
}
