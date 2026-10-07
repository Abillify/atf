// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * gcra.ts
 *
 * The Generic Cell Rate Algorithm — a token bucket expressed as a single
 * monotonic value ("Theoretical Arrival Time", TAT), which makes it trivially
 * atomic in a backend like Redis: one key, one compare-and-set.
 *
 *   - `limit`   = burst capacity (cells)
 *   - `burstMs` = refill window: one cell is released every `burstMs / limit`
 *
 * A request with `cost` cells succeeds when the TAT (after crediting the
 * elapsed refill) leaves room; otherwise the response carries the retry delay.
 *
 * Time is always supplied by the caller (or the backend's clock) so memory
 * and Redis implementations share one test surface.
 */

export interface GcraState {
  /** Theoretical Arrival Time in microseconds. */
  tatUs: number;
}

export interface GcraDecision {
  allowed: boolean;
  /** Remaining burst capacity after this decision (0 when denied). */
  remaining: number;
  /** Milliseconds until a cell is available; 0 when allowed. */
  retryAfterMs: number;
  /** Reset window in ms until the bucket is completely full. */
  resetAfterMs: number;
  /** Updated state to persist (only meaningful when allowed or stored anyway). */
  state: GcraState;
}

export interface GcraConfig {
  /** Maximum burst size (cells). Must be ≥ 1. */
  limit: number;
  /** Refill window in milliseconds — `limit` cells accumulate over this span. */
  burstMs: number;
}

const US_PER_MS = 1000;

/**
 * Pure GCRA check. `nowUs` is the current time in microseconds. The emission
 * interval is `burstMs * 1000 / limit` microseconds per cell.
 */
export function gcraCheck(
  config: GcraConfig,
  state: GcraState | null,
  nowUs: number,
  cost = 1,
): GcraDecision {
  if (config.limit < 1) throw new Error("GCRA limit must be >= 1");
  if (config.burstMs <= 0) throw new Error("GCRA burstMs must be > 0");
  if (cost < 1) throw new Error("GCRA cost must be >= 1");

  const emissionUs = (config.burstMs * US_PER_MS) / config.limit;
  const fillUs = config.limit * emissionUs; // total window length

  // Standard GCRA: the TAT never lags behind the clock; a missing or stale
  // state therefore means "bucket completely full". The delay of the new
  // arrival (newTat - now) must fit into the window (fillUs).
  const tatBase = state === null ? nowUs : Math.max(state.tatUs, nowUs);
  const newTat = tatBase + cost * emissionUs;
  const delayUs = newTat - nowUs;
  if (delayUs > fillUs) {
    // Denied: do not move the TAT (the failed request costs nothing). The
    // request would fit at time newTat - fillUs, hence the retry delay.
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((newTat - fillUs - nowUs) / US_PER_MS),
      resetAfterMs: Math.ceil(Math.max(0, tatBase - nowUs) / US_PER_MS),
      state: { tatUs: tatBase },
    };
  }
  const remainingRaw = Math.floor((fillUs - delayUs) / emissionUs);
  return {
    allowed: true,
    remaining: Math.max(0, Math.min(config.limit - 1, remainingRaw)),
    retryAfterMs: 0,
    resetAfterMs: Math.ceil(Math.max(0, newTat - nowUs) / US_PER_MS),
    state: { tatUs: newTat },
  };
}

/** Rate-limit decision surfaced by backends (limits for response headers). */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetAfterMs: number;
}

/**
 * What to do when the backing store fails. `open` lets traffic through
 * (availability first), `closed` rejects it (protection first).
 */
export type FailMode = "open" | "closed";

export interface RateLimitBackend {
  /**
   * Atomically apply one GCRA step for `key`. Implementations must ensure the
   * read-modify-write is atomic (Redis: Lua; memory: single-threaded JS).
   */
  take(key: string, config: GcraConfig, cost: number): Promise<RateLimitResult>;
}
