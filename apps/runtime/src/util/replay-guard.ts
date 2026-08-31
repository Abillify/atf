// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Webhook replay guard (`src/util/replay-guard.ts`)
 *
 * A valid HMAC signature over a request body proves the caller knew the
 * shared secret at some point — it says nothing about WHEN. Without a
 * timestamp and nonce bound into the signed material, an attacker who
 * intercepts (or otherwise obtains) one genuine signed request can replay it
 * unboundedly: each replay re-executes the flow (cost, side effects) and the
 * HMAC check alone has no way to tell it apart from the original.
 *
 * This module provides the two building blocks a caller binds into its own
 * signature computation:
 *
 *   1. {@link isTimestampFresh} — rejects a request whose declared timestamp
 *      falls outside a tolerance window (clock skew is real; a window, not
 *      exact equality, is the correct check).
 *   2. {@link NonceCache} — remembers nonces seen within that same window and
 *      rejects a repeat. Bounded (max entries) and self-sweeping (TTL) so a
 *      public endpoint cannot be used to grow this cache without limit —
 *      the two properties `src/routes/gitops.ts`'s bespoke rate-limit map
 *      lacked before this change.
 *
 * Both together close the replay window: a captured request is unusable once
 * its timestamp ages out, and unusable EVEN WITHIN the window because its
 * nonce has already been consumed.
 *
 * No `any` at module boundaries.
 */

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

/**
 * True when `timestampMs` (the caller-declared signing time, epoch millis) is
 * within `toleranceMs` of `now`. Symmetric — a timestamp slightly in the
 * FUTURE is also rejected, since that only happens from clock skew or a
 * forged value, never a legitimate immediate send.
 */
export function isTimestampFresh(
  timestampMs: number,
  now: number,
  toleranceMs: number,
): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  return Math.abs(now - timestampMs) <= toleranceMs;
}

export interface NonceCacheOptions {
  /** How long a consumed nonce is remembered. Should match the timestamp tolerance. Default 300_000 (5 min). */
  ttlMs?: number;
  /** Upper bound on remembered nonces; oldest-inserted are swept first past this. Default 10_000. */
  maxEntries?: number;
  clock?: Clock;
}

/**
 * Bounded, TTL'd record of recently-consumed nonces, scoped by an arbitrary
 * caller-supplied namespace (e.g. a flow id or webhook source) so one
 * caller's nonce space cannot collide with another's.
 *
 * `consume()` is the whole contract: it atomically checks-and-marks a nonce as
 * used, returning false when it was already seen inside the TTL window (a
 * replay) and true when it is fresh (the request may proceed). There is no
 * separate "check" step — a check-then-mark API invites a caller to skip the
 * mark on some path and silently disable replay protection.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>(); // `${namespace}\u0000${nonce}` -> expiresAt
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;

  constructor(options: NonceCacheOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? 300_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Marks `nonce` (scoped to `namespace`) as used. Returns `false` — reject
   * the request as a replay — when this (namespace, nonce) pair was already
   * consumed and has not yet expired. Returns `true` otherwise, and the pair
   * is now recorded so a second attempt returns `false`.
   */
  consume(namespace: string, nonce: string): boolean {
    const now = this.clock();
    this.sweepExpired(now);
    const key = `${namespace}\u0000${nonce}`;
    const existingExpiry = this.seen.get(key);
    if (existingExpiry !== undefined && now <= existingExpiry) {
      return false; // replay
    }
    this.seen.set(key, now + this.ttlMs);
    this.evictIfOverCapacity();
    return true;
  }

  /** Current entry count (diagnostics/tests). */
  size(): number {
    return this.seen.size;
  }

  /** Removes every expired entry. Runs on every `consume()`, amortised O(1) per call on average. */
  private sweepExpired(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (now > expiresAt) this.seen.delete(key);
      // Map iterates in insertion order; entries are inserted with
      // monotonically non-decreasing expiry under a fixed TTL, so the first
      // still-live entry means the rest are also still live. This makes the
      // sweep O(k) in the number of ALREADY-expired entries, not O(n) total.
      else break;
    }
  }

  private evictIfOverCapacity(): void {
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
