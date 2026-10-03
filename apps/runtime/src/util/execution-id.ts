// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Execution-id normalisation (`src/util/execution-id.ts`)
 *
 * The OpenAI-compatible chat endpoints report an execution through the
 * response `id` field as `chatcmpl-<executionId>` (see
 * `routes/chat/streaming.ts`), while every monitoring store — execution
 * history, debug-trace ring, optimizer — keys on the BARE execution uuid.
 * Operators naturally copy the id they saw in the API response (or the
 * `X-Execution-Id`-adjacent chat `id`) into the debug/explain lookups, which
 * then 404 on the prefixed form.
 *
 * `normalizeExecutionId` accepts either form and returns the canonical bare
 * uuid so the monitoring plane is forgiving about which identifier an
 * operator pastes. It is intentionally narrow: only the exact
 * `chatcmpl-replay-` / `chatcmpl-` prefixes (longest first) are stripped;
 * anything else passes through untouched, so a genuinely unknown id still
 * 404s with the original string in the error message.
 */

/** Prefixes stripped from a caller-supplied execution id, longest first. */
const EXECUTION_ID_PREFIXES = ["chatcmpl-replay-", "chatcmpl-"] as const;

/**
 * Strip an OpenAI-style `chatcmpl-` response-id prefix, returning the bare
 * execution uuid used as the canonical monitoring key. Ids without a known
 * prefix are returned unchanged (after trimming).
 */
export function normalizeExecutionId(executionId: string): string {
  const trimmed = executionId.trim();
  for (const prefix of EXECUTION_ID_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}
