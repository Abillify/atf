// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Retry policy as a pure function (requirements 8.9, 8.10).
 *
 * Only 429, 5xx and network errors are retryable, at most 5 times per
 * transfer. The delay is the larger of a valid `Retry-After` and an
 * exponential backoff with full jitter; the backoff ceiling
 * `min(60_000, 1000 * 2^attempt)` is monotonically non-decreasing.
 */

/** Maximum number of retries per transfer (8.9). */
export const MAX_RETRIES = 5;

/** Backoff ceiling in milliseconds. */
export const MAX_BACKOFF_MS = 60_000;

/** Base backoff in milliseconds. */
export const BASE_BACKOFF_MS = 1_000;

export type RetryOutcome =
  | { kind: "http"; status: number; retryAfter?: string }
  | { kind: "network" };

export type RetryDecision = { retry: false } | { retry: true; delayMs: number };

/** True for the retryable status codes (429 and any 5xx). */
export const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

/**
 * Parse a `Retry-After` header into a delay in milliseconds, or `null` when
 * absent or unparseable. Accepts delta-seconds and an HTTP-date
 * (RFC 9110 §10.2.3).
 */
export function parseRetryAfter(
  header: string | undefined,
  now: number,
): number | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  // delta-seconds
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/**
 * Decide whether to retry and for how long to wait.
 *
 * @param attempt - zero-based count of retries already performed.
 * @param outcome - the failure being evaluated.
 * @param now - current epoch milliseconds (for HTTP-date `Retry-After`).
 * @param rand - random source in [0, 1) for jitter.
 */
export function retryDecision(
  attempt: number,
  outcome: RetryOutcome,
  now: number,
  rand: () => number,
): RetryDecision {
  const retryable =
    outcome.kind === "network" ||
    (outcome.kind === "http" && isRetryableStatus(outcome.status));
  if (!retryable) return { retry: false };
  if (attempt >= MAX_RETRIES) return { retry: false };

  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  const jittered = ceiling * (0.5 + rand() / 2);

  const retryAfterMs =
    outcome.kind === "http" ? parseRetryAfter(outcome.retryAfter, now) : null;

  const delayMs =
    retryAfterMs === null ? jittered : Math.max(retryAfterMs, jittered);
  return { retry: true, delayMs };
}
