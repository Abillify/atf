// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Debug trace size limiting (`src/monitoring/debug-trace-limits.ts`)
 *
 * A debug trace of a case-research run grew to several megabytes:
 * `full_prompt` carries up to 180,000 characters of verifier context per node,
 * `tool_calls[].result` the complete `get_document` dumps, and
 * `input_messages` the entire incoming conversation. That makes the trace
 * unusable as a post-mortem artifact (ring buffer heap, JSON export, editor).
 *
 * Rule of this module: **metadata stays complete** — refs, IDs, scores,
 * status, timestamps, token/cost/latency values, the diagnostics timeline and
 * the error structure are never touched. Only the free-form text fields are
 * limited, byte-exact in UTF-8, with a marker that preserves the original size
 * as metadata.
 *
 * No `any` at module boundaries.
 */

import type {
  DebugMessage,
  DebugNodeAttempt,
  DebugNodeTrace,
  DebugToolCall,
  DebugTrace,
  DebugTraceLimits,
} from "../types/debug-trace.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Default budgets in UTF-8 bytes.
 *
 * `llmResultBytes` is deliberately set to 512 bytes: an LLM result in the trace
 * serves identification ("what did the node output"), not full-text archival —
 * the beginning of a response is enough to place it in the diagnostics/error
 * context. Prompts get more room because that is where the system instruction
 * lives, which is what you actually want to read while debugging.
 */
export const DEFAULT_DEBUG_TRACE_LIMITS: DebugTraceLimits = {
  /** `full_response`, `full_reasoning`, `classifier.raw_output`. */
  llmResultBytes: 512,
  /** `full_prompt` (resolved system prompt + conversation). */
  promptBytes: 4_096,
  /** Per entry in `input_messages` (user/system/assistant turn). */
  messageBytes: 2_048,
  /** Per string leaf in `tool_calls[].arguments` / `tool_calls[].result`. */
  toolPayloadBytes: 512,
};

/** Maximum nesting depth traversed while clamping a tool payload. */
const MAX_CLAMP_DEPTH = 12;

/** Maximum number of array elements kept per tool payload level. */
const MAX_CLAMP_ARRAY_ITEMS = 200;

// ---------------------------------------------------------------------------
// Byte-exact truncation
// ---------------------------------------------------------------------------

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes and appends a marker
 * carrying the original size.
 *
 * The boundary is moved back to a codepoint boundary so that no half
 * multi-byte character (and therefore no U+FFFD) ends up in the trace. A text
 * that fits the budget is returned unchanged — short responses stay
 * byte-for-byte intact.
 */
export function clampUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  // Move back to the last complete codepoint boundary <= maxBytes:
  // continuation bytes have the bit pattern 10xxxxxx.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;

  const head = new TextDecoder().decode(bytes.subarray(0, end));
  return `${head}… [truncated: ${bytes.byteLength} bytes in the original, ${maxBytes} bytes in the trace]`;
}

/** Like {@link clampUtf8}, but passes `undefined` through. */
function clampOptional(
  text: string | undefined,
  maxBytes: number,
): string | undefined {
  return text === undefined ? undefined : clampUtf8(text, maxBytes);
}

/**
 * Truncates every string leaf in an arbitrary JSON-like structure without
 * changing the structure itself.
 *
 * This is why tool payloads are limited deeply instead of wholesale: for a RAG
 * result (`{collection, retrieved, chunks:[{id, text, score}]}`), `id`, `score`
 * and `retrieved` are fully preserved as metadata while only `text` is
 * truncated. Serializing the whole payload down to N bytes would instead
 * swallow the trailing hits entirely.
 */
export function clampPayload(
  value: unknown,
  maxBytes: number,
  depth = 0,
): unknown {
  if (typeof value === "string") return clampUtf8(value, maxBytes);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_CLAMP_DEPTH) return "[truncated: nested too deeply]";

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_CLAMP_ARRAY_ITEMS)
      .map((item) => clampPayload(item, maxBytes, depth + 1));
    return value.length > MAX_CLAMP_ARRAY_ITEMS
      ? [
          ...kept,
          `[truncated: ${value.length - MAX_CLAMP_ARRAY_ITEMS} more of ${value.length} elements]`,
        ]
      : kept;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clampPayload(entry, maxBytes, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trace elements
// ---------------------------------------------------------------------------

function clampToolCall(
  call: DebugToolCall,
  limits: DebugTraceLimits,
): DebugToolCall {
  return {
    ...call,
    arguments: clampPayload(call.arguments, limits.toolPayloadBytes),
    result:
      call.result === null
        ? null
        : clampPayload(call.result, limits.toolPayloadBytes),
  };
}

function clampMessage(
  message: DebugMessage,
  limits: DebugTraceLimits,
): DebugMessage {
  const content =
    typeof message.content === "string"
      ? clampUtf8(message.content, limits.messageBytes)
      : (clampPayload(message.content, limits.messageBytes) as unknown[]);
  return {
    ...message,
    content,
    ...(message.tool_calls !== undefined
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            function: {
              ...call.function,
              arguments: clampUtf8(
                call.function.arguments,
                limits.toolPayloadBytes,
              ),
            },
          })),
        }
      : {}),
  };
}

function clampDebugAttempt(
  attempt: DebugNodeAttempt,
  limits: DebugTraceLimits,
): DebugNodeAttempt {
  const prompt = clampOptional(attempt.full_prompt, limits.promptBytes);
  const response = clampOptional(attempt.full_response, limits.llmResultBytes);
  const reasoning = clampOptional(
    attempt.full_reasoning,
    limits.llmResultBytes,
  );
  return {
    ...attempt,
    ...(prompt !== undefined ? { full_prompt: prompt } : {}),
    ...(response !== undefined ? { full_response: response } : {}),
    ...(reasoning !== undefined ? { full_reasoning: reasoning } : {}),
    tool_calls: (attempt.tool_calls ?? []).map((call) =>
      clampToolCall(call, limits),
    ),
    ...(attempt.classifier !== undefined
      ? {
          classifier: {
            ...attempt.classifier,
            raw_output: clampUtf8(
              attempt.classifier.raw_output,
              limits.llmResultBytes,
            ),
          },
        }
      : {}),
  };
}

/**
 * Limits the free-text fields of a node record. All remaining fields (status,
 * timings, sequence, model, tokens, cost, tool selection, groundedness,
 * diagnostics, error structure) are carried over unchanged.
 */
export function clampDebugNode(
  node: DebugNodeTrace,
  limits: DebugTraceLimits = DEFAULT_DEBUG_TRACE_LIMITS,
): DebugNodeTrace {
  const promptClamped = clampOptional(node.full_prompt, limits.promptBytes);
  const responseClamped = clampOptional(
    node.full_response,
    limits.llmResultBytes,
  );
  const reasoningClamped = clampOptional(
    node.full_reasoning,
    limits.llmResultBytes,
  );
  return {
    ...node,
    ...(promptClamped !== undefined ? { full_prompt: promptClamped } : {}),
    ...(responseClamped !== undefined ? { full_response: responseClamped } : {}),
    ...(reasoningClamped !== undefined
      ? { full_reasoning: reasoningClamped }
      : {}),
    tool_calls: (node.tool_calls ?? []).map((call) =>
      clampToolCall(call, limits),
    ),
    ...(node.attempts !== undefined
      ? {
          attempts: node.attempts.map((attempt) =>
            clampDebugAttempt(attempt, limits),
          ),
        }
      : {}),
    ...(node.classifier !== undefined
      ? {
          classifier: {
            ...node.classifier,
            raw_output: clampUtf8(
              node.classifier.raw_output,
              limits.llmResultBytes,
            ),
          },
        }
      : {}),
  };
}

/**
 * Limits a complete trace body (context + input messages + already present
 * nodes) and records the applied budgets as metadata, so that a reader does not
 * mistake a truncated trace for a complete one.
 */
export function clampDebugTrace(
  trace: DebugTrace,
  limits: DebugTraceLimits = DEFAULT_DEBUG_TRACE_LIMITS,
): DebugTrace {
  return {
    ...trace,
    input_messages: trace.input_messages.map((message) =>
      clampMessage(message, limits),
    ),
    nodes: trace.nodes.map((node) => clampDebugNode(node, limits)),
    limits: { ...limits },
  };
}
