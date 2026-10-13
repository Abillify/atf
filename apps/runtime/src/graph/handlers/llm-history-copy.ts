// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Require-tool-use history-copy guard.
 *
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged. Detects when a model reproduces a plain historical assistant
 * answer instead of doing the requested tool work.
 */
import type { ModelMessage } from "ai";

export const HISTORY_COPY_MIN_CHARS = 40;
export const HISTORY_COPY_MIN_SHARED_TOKENS = 8;

/**
 * Decoded inline-image bytes we are willing to keep shipping in a prompt before
 * it becomes a trace-level warning. A single phone photo is ~2–4 MB, so this
 * fires on the first attachment — which is exactly when the cost of re-sending
 * it on every turn of a long conversation starts to matter.
 */
export const PROMPT_INLINE_IMAGE_WARN_BYTES = 1_500_000;

export function normalizeHistoryCopyText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Finds a plain historical assistant answer that the current text substantially
 * reproduces. This deliberately ignores structured assistant tool-call messages:
 * removing one side of a tool pair would make the provider history invalid.
 */
export function findCopiedAssistantHistoryIndex(
  text: string,
  messages: readonly ModelMessage[],
): number | undefined {
  const normalized = normalizeHistoryCopyText(text);
  if (normalized.length < HISTORY_COPY_MIN_CHARS) return undefined;

  const currentTokens = new Set(normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || typeof message.content !== "string") {
      continue;
    }
    const historical = normalizeHistoryCopyText(message.content);
    if (historical.length < HISTORY_COPY_MIN_CHARS) continue;
    if (
      normalized === historical ||
      normalized.includes(historical) ||
      historical.includes(normalized)
    ) {
      return index;
    }

    const historicalTokens = new Set(
      historical.match(/[\p{L}\p{N}_-]+/gu) ?? [],
    );
    let shared = 0;
    for (const token of currentTokens) {
      if (historicalTokens.has(token)) shared += 1;
    }
    const smallerSize = Math.min(currentTokens.size, historicalTokens.size);
    const unionSize = currentTokens.size + historicalTokens.size - shared;
    if (
      shared >= HISTORY_COPY_MIN_SHARED_TOKENS &&
      smallerSize > 0 &&
      shared / smallerSize >= 0.5 &&
      unionSize > 0 &&
      shared / unionSize >= 0.25
    ) {
      return index;
    }
  }
  return undefined;
}
