// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Helpers for building LanguageModelV3 mock stream/generate data in tests.
 * ai@6.x upgraded from V1 to V3 provider spec; this file encapsulates the
 * verbose V3 shapes so individual test files stay readable.
 *
 * V3 text streaming requires a text-start → text-delta* → text-end sequence.
 * Without text-start the SDK content-tracker enqueues an error part which the
 * engine stream handler rethrows, aborting the stream after the first delta.
 */
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

/** Build a V3 usage object from flat token counts. */
export function mkUsage(
  inputTokens: number,
  outputTokens: number,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

/** Open a text block — must come before any mkTextDelta with the same id. */
export function mkTextStart(id = "1"): LanguageModelV3StreamPart {
  return { type: "text-start", id } as LanguageModelV3StreamPart;
}

/** Build a V3 text-delta stream part (requires a prior mkTextStart with same id). */
export function mkTextDelta(
  delta: string,
  id = "1",
): LanguageModelV3StreamPart {
  return { type: "text-delta", id, delta } as LanguageModelV3StreamPart;
}

/** Close a text block — must come after all mkTextDelta with the same id. */
export function mkTextEnd(id = "1"): LanguageModelV3StreamPart {
  return { type: "text-end", id } as LanguageModelV3StreamPart;
}

/** Build a V3 finish stream part. */
export function mkFinish(
  inputTokens: number,
  outputTokens: number,
): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: mkUsage(inputTokens, outputTokens),
  } as unknown as LanguageModelV3StreamPart;
}

/** Build a minimal V3 doGenerate result (for classifier / non-streaming use). */
export function mkGenerateResult(
  text: string,
  inputTokens = 1,
  outputTokens = 1,
): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: mkUsage(inputTokens, outputTokens),
    warnings: [],
  } as unknown as LanguageModelV3GenerateResult;
}
