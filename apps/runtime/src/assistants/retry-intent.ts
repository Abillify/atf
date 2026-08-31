// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { normalizeUserPhrase } from "../graph/require-tool-use.js";

/**
 * A retry may only restore an intent whose tool set is known to be read-only.
 * Do not derive a tool reference from user or model supplied text.
 */
const SAFE_PARKING_READ_INTENTS = {
  status: ["parking/status"],
  availability: ["parking/availability"],
} as const;

export type SafeRetryIntent = keyof typeof SAFE_PARKING_READ_INTENTS;

export interface SafeRetryResolution {
  intent: SafeRetryIntent;
  toolRefs: readonly string[];
}

const RETRY_PHRASES = new Set([
  "retry",
  "again",
  "try again",
  "nochmal",
  "noch mal",
  "noch einmal",
  "erneut",
  "wieder",
  "versuch nochmal",
  "versuchs nochmal",
  "versuch es nochmal",
  "versuch es noch einmal",
  "versuchs wieder",
  "probier es erneut",
  // Common typo observed in Rocket.Chat. It is intentionally an exact match.
  "ry again",
]);

/** True only for an explicit request to repeat the preceding action. */
export function isRetryRequest(query: string): boolean {
  return RETRY_PHRASES.has(normalizeUserPhrase(query));
}

/**
 * Classifies a user request only when it clearly asks for a parking read.
 * Mutating parking operations are deliberately absent from this classifier.
 */
export function classifySafeParkingReadIntent(
  query: string,
): SafeRetryIntent | undefined {
  const normalized = normalizeUserPhrase(query);
  if (!/(?:parkpl(?:atz|ätz)e?|parken|parking)/u.test(normalized)) return undefined;
  if (/(?:frei|verfug|verfüg|verfueg|availability)/u.test(normalized)) {
    return "availability";
  }
  if (
    /(?:wo\s+steh|auf\s+welchem\s+parkplatz|welchen\s+parkplatz|parkplatz\s+.*(?:heute|morgen)|status)/u.test(
      normalized,
    )
  ) {
    return "status";
  }
  return undefined;
}

/**
 * Resolves the last safe, read-only parking intent in the current conversation.
 * The caller supplies only prior user messages from the same assistant scope and
 * conversation; no cross-conversation or semantic-retrieval fallback is allowed.
 */
export function resolveSafeRetryIntent(
  query: string,
  priorUserMessages: readonly string[],
): SafeRetryResolution | undefined {
  if (!isRetryRequest(query)) return undefined;
  for (let index = priorUserMessages.length - 1; index >= 0; index -= 1) {
    const intent = classifySafeParkingReadIntent(priorUserMessages[index] ?? "");
    if (intent !== undefined) {
      return { intent, toolRefs: SAFE_PARKING_READ_INTENTS[intent] };
    }
  }
  return undefined;
}
