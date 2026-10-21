// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Recognition of provider "context length exceeded" rejections and the
 * budget factor for the single retry they get.
 *
 * A request rejected because the prompt does not fit the model's context
 * window is deterministic — resending the same payload fails identically —
 * but it is recoverable by shrinking the context budget and truncating the
 * conversation again. The candidate loop therefore retries such an error
 * exactly once with a window of `CONTEXT_RETRY_FACTOR` × the original.
 *
 * Detection is text-based: providers report the condition in prose (OpenAI
 * "This model's maximum context length is N tokens", Anthropic "prompt is
 * too long", vLLM "context_length_exceeded"), sometimes wrapped in SDK
 * error objects. The patterns are deliberately narrow so ordinary 4xx/5xx
 * failures keep their normal error path.
 */

/**
 * Fraction of the resolved context window used by the one retry after a
 * context-length rejection (25 % smaller budget).
 */
export const CONTEXT_RETRY_FACTOR = 0.75;

/** Matches provider messages that reject a request for exceeding the context. */
const CONTEXT_LENGTH_PATTERN =
  /maximum context length|context length (is|of|exceeded)|context_length_exceeded|too many tokens|prompt is too long/iu;

/** Bound on the `cause` walk so a cyclic chain cannot hang detection. */
const MAX_CAUSE_DEPTH = 4;

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "";
  }
}

/**
 * True when `err` is a provider rejection for exceeding the model's context
 * length. Checks the error's own text and its `cause` chain (providers and
 * the AI SDK wrap the original message at varying depths).
 */
export function isContextLengthError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (CONTEXT_LENGTH_PATTERN.test(errorText(current))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
